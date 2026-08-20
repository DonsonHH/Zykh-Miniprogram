const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/medicineList/index.js");
const root = path.join(__dirname, "..");

function loadMedicineList(slots, apiOverrides = {}) {
  let definition = null;
  const navigations = [];
  const app = apiOverrides.app || { globalData: { deviceId: apiOverrides.deviceId || "" } };
  const source = fs.readFileSync(pagePath, "utf8");
  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(request) {
      if (request.includes("utils/api")) {
        return {
          getDevice: apiOverrides.getDevice || (async () => ({ online: true })),
          getCapabilitiesStrict: apiOverrides.getCapabilitiesStrict || (async () => ({ capabilities: {} })),
          getCabinetSlots: apiOverrides.getCabinetSlots || (async () => slots),
          getCabinetSlotsStrict: apiOverrides.getCabinetSlotsStrict
            || apiOverrides.getCabinetSlots
            || (async () => slots),
        };
      }
      if (request.includes("utils/realtime")) {
        return apiOverrides.realtime || { subscribe: () => () => {} };
      }
      if (request.includes("utils/deviceSession")) {
        return {
          runAfterDeviceSessionReady(callback) {
            if (app.globalData.deviceSessionResolved !== true
              && typeof app.waitForDeviceSession === "function") {
              return Promise.resolve(app.waitForDeviceSession()).then(callback);
            }
            return callback();
          },
        };
      }
      if (request.includes("utils/cabinetView")) {
        return require(path.join(__dirname, "../miniprogram/utils/cabinetView"));
      }
      if (request.includes("utils/cabinetSlots")) {
        return require(path.join(__dirname, "../miniprogram/utils/cabinetSlots"));
      }
      throw new Error(`unexpected module ${request}`);
    },
    wx: {
      navigateTo(options) {
        navigations.push(options);
      },
    },
    getApp() {
      return app;
    },
    console: { warn() {} },
  }, { filename: pagePath });
  definition.data = Object.assign({}, definition.data);
  definition.setData = next => Object.assign(definition.data, next);
  definition.navigations = navigations;
  definition.app = app;
  return definition;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("medicine list clears old rows and drops late reads when the active cabinet changes", async () => {
  const lateOldSnapshot = deferred();
  const newSnapshot = deferred();
  const readScopes = [];
  let oldReads = 0;
  const page = loadMedicineList([], {
    deviceId: "box-a",
    getDevice: async deviceId => ({ deviceId, online: true }),
    getCabinetSlotsStrict(deviceId) {
      readScopes.push(deviceId);
      const requestedDeviceId = deviceId || (oldReads < 2 ? "box-a" : "box-b");
      if (requestedDeviceId === "box-a") {
        oldReads += 1;
        if (oldReads === 1) {
          return Promise.resolve([{ slot: 1, name: "A 箱药品", quantity: 1, expireDate: "2099-01" }]);
        }
        return lateOldSnapshot.promise;
      }
      return newSnapshot.promise;
    },
  });

  await page.load();
  assert.equal(page.data.deviceId, "box-a");
  assert.equal(page.data.viewSlots[0].name, "A 箱药品");

  const oldRefresh = page.load();
  page.app.globalData.deviceId = "box-b";
  const switchedLoad = page.load();

  assert.equal(page.data.deviceId, "box-b");
  assert.deepEqual(Array.from(page.data.slots), []);
  assert.deepEqual(Array.from(page.data.viewSlots), []);
  assert.equal(page.data.primarySlot, 0);
  assert.equal(page.data.initialLoading, true);
  assert.equal(page.data.loadError, "");

  newSnapshot.reject(new Error("new cabinet unavailable"));
  await switchedLoad;
  assert.equal(page.data.initialLoading, false);
  assert.match(page.data.loadError, /药品数据/);
  assert.deepEqual(Array.from(page.data.viewSlots), []);
  assert.equal(page.data.isStale, false);

  lateOldSnapshot.resolve([{ slot: 2, name: "迟到的 A 箱药品", quantity: 1, expireDate: "2099-01" }]);
  await oldRefresh;
  assert.equal(page.data.deviceId, "box-b");
  assert.match(page.data.loadError, /药品数据/);
  assert.deepEqual(Array.from(page.data.viewSlots), []);
  assert.deepEqual(readScopes, ["box-a", "box-a", "box-b"]);
});

test("a slow first medicine snapshot shows only an explicit loading face until it arrives", async () => {
  const snapshot = deferred();
  const page = loadMedicineList([], {
    getCabinetSlots: () => snapshot.promise,
  });

  const loading = page.load();
  await Promise.resolve();

  assert.equal(page.data.initialLoading, true);
  assert.equal(page.data.viewSlots.length, 0);

  snapshot.resolve([
    { slot: 1, name: "常用药品", quantity: 1, expireDate: "2099-01" },
  ]);
  await loading;

  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.viewSlots.length, 1);

  const layout = fs.readFileSync(path.join(root, "miniprogram/pages/medicineList/index.wxml"), "utf8");
  assert.match(layout, /wx:if="\{\{initialLoading\}\}"[^>]*class="[^"]*ui-loading[^"]*"/);
  assert.match(layout, /正在读取药品清单…/);
  assert.match(layout, /<block wx:else>[\s\S]*?\{\{viewSlots\.length\}\}[^<]*种药品/);
  assert.match(layout, /<block wx:else>[\s\S]*?bindtap="goAddMedicine"/);
});

test("medicine list shows a retryable error until a real empty snapshot succeeds", async () => {
  let shouldFail = true;
  const page = loadMedicineList([], {
    getCabinetSlotsStrict: async () => {
      if (shouldFail) throw new Error("snapshot unavailable");
      return [];
    },
  });

  await page.load();

  assert.equal(page.data.initialLoading, false);
  assert.match(page.data.loadError, /药品数据/);
  assert.deepEqual(Array.from(page.data.viewSlots), []);
  assert.equal(page.data.primarySlot, 0);

  const layout = fs.readFileSync(path.join(root, "miniprogram/pages/medicineList/index.wxml"), "utf8");
  assert.match(layout, /wx:elif="\{\{loadError\}\}"/);
  assert.match(layout, /bindtap="retryLoad"/);

  shouldFail = false;
  const retrying = page.retryLoad();
  assert.equal(page.data.initialLoading, true);
  assert.equal(page.data.loadError, "");
  await retrying;

  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.loadError, "");
  assert.deepEqual(Array.from(page.data.viewSlots), []);
  assert.match(page.data.emptyText, /还没有登记药品/);
});

test("medicine list keeps the last same-device rows visible and marks them stale after a refresh failure", async () => {
  let readCount = 0;
  const page = loadMedicineList([], {
    getCabinetSlotsStrict: async () => {
      readCount += 1;
      if (readCount === 1) {
        return [{ slot: 1, name: "已同步药品", quantity: 1, expireDate: "2099-01" }];
      }
      throw new Error("refresh unavailable");
    },
  });

  await page.load();
  await page.load();

  assert.equal(page.data.viewSlots[0].name, "已同步药品");
  assert.equal(page.data.hasLoadedSnapshot, true);
  assert.equal(page.data.isStale, true);
  assert.match(page.data.refreshError, /上次成功读取/);
  assert.equal(page.data.loadError, "");

  const layout = fs.readFileSync(path.join(root, "miniprogram/pages/medicineList/index.wxml"), "utf8");
  assert.match(layout, /wx:if="\{\{isStale\}\}"/);
  assert.match(layout, /bindtap="retryLoad"/);
});

test("full medicine list keeps filtering and opens the selected slot for maintenance", async () => {
  const page = loadMedicineList([
    { slot: 1, name: "常规药品", quantity: 1, expireDate: "2099-01" },
    { slot: 2, name: "已经过期", quantity: 1, expireDate: "2000-01" },
    { slot: 3, name: "已确认无药", quantity: 0, inventoryState: "DEPLETED", expireDate: "2099-01" },
  ]);

  await page.load();
  assert.deepEqual(Array.from(page.data.viewSlots, item => item.slot), [2, 1, 3]);

  page.setFilter({ currentTarget: { dataset: { filter: "depleted" } } });
  assert.deepEqual(Array.from(page.data.viewSlots, item => item.slot), [3]);

  page.selectSlot({ currentTarget: { dataset: { slot: 3 } } });
  assert.deepEqual(Array.from(page.navigations, item => item.url), ["/pages/addMedicine/index?slot=3"]);
});

test("medicine list filters explicit depletion and keeps missing supported state UNKNOWN", async () => {
  const page = loadMedicineList([{
    slot: 1,
    name: "预扣为零但还有药",
    quantity: 0,
    inventoryState: "STOCKED",
    expireDate: "2099-01",
  }, {
    slot: 2,
    name: "明确已用完",
    quantity: 8,
    inventoryState: "DEPLETED",
    expireDate: "2099-01",
  }, {
    slot: 3,
    name: "契约缺字段",
    quantity: 1,
    expireDate: "2099-01",
  }], {
    getCapabilitiesStrict: async () => ({ capabilities: { explicitInventoryState: "v1" } }),
  });

  await page.load();

  assert.equal(page.data.depletedCount, 1);
  assert.equal(page.data.inventoryUnknownCount, 1);
  assert.equal(page.data.slots.find(item => item.slot === 1).isDepleted, false);
  assert.equal(page.data.slots.find(item => item.slot === 3).inventoryState, "UNKNOWN");
  assert.equal(page.data.slots.find(item => item.slot === 3).contractIssue, "explicit_inventory_state_missing");
  page.setFilter({ currentTarget: { dataset: { filter: "depleted" } } });
  assert.deepEqual(Array.from(page.data.viewSlots, item => item.slot), [2]);
});

test("medicine list renders UNKNOWN inventory as a neutral confirmation state", () => {
  const layout = fs.readFileSync(path.join(root, "miniprogram/pages/medicineList/index.wxml"), "utf8");

  assert.match(layout, /item\.isInventoryUnknown\s*\?\s*'ui-row-mark--notice'/);
  assert.match(layout, /item\.isInventoryUnknown\s*\?\s*'ui-status--muted'/);
  assert.match(layout, /item\.isInventoryUnknown\s*\?\s*'库存待确认'/);
});

test("a risk number on the cabinet overview opens the corresponding filtered medicine list", async () => {
  const page = loadMedicineList([
    { slot: 1, name: "常规药品", quantity: 1, expireDate: "2099-01" },
    { slot: 2, name: "已经过期", quantity: 1, expireDate: "2000-01" },
  ]);

  page.onLoad({ filter: "expired" });
  await page.load();

  assert.equal(page.data.filter, "expired");
  assert.deepEqual(Array.from(page.data.viewSlots, item => item.slot), [2]);
});

test("the full list registers into the first empty slot and hides registration when all slots are occupied", async () => {
  const partial = loadMedicineList([
    { slot: 1, name: "常规药品", quantity: 1, expireDate: "2099-01" },
    { slot: 2, name: "", quantity: 0, expireDate: "" },
  ]);
  await partial.load();

  assert.equal(partial.data.primarySlot, 2);
  partial.goAddMedicine();
  assert.deepEqual(Array.from(partial.navigations, item => item.url), ["/pages/addMedicine/index?slot=2"]);

  const full = loadMedicineList(Array.from({ length: 23 }, (_, index) => ({
    slot: index + 1,
    name: `药品 ${index + 1}`,
    quantity: 1,
    expireDate: "2099-01",
  })));
  await full.load();

  assert.equal(full.data.primarySlot, 0);
  full.goAddMedicine();
  assert.deepEqual(Array.from(full.navigations), []);
  const layout = fs.readFileSync(path.join(root, "miniprogram/pages/medicineList/index.wxml"), "utf8");
  assert.match(layout, /wx:if="\{\{primarySlot\}\}"[^>]*class="cabinet-primary"/);
});

test("three-box library ships a compact overview and a dedicated full list", () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, "miniprogram/app.json"), "utf8"));
  const overview = fs.readFileSync(path.join(root, "miniprogram/pages/library/index.wxml"), "utf8");
  const overviewLogic = fs.readFileSync(path.join(root, "miniprogram/pages/library/index.js"), "utf8");
  const overviewConfig = JSON.parse(fs.readFileSync(path.join(root, "miniprogram/pages/library/index.json"), "utf8"));
  const list = fs.readFileSync(path.join(root, "miniprogram/pages/libraryList/index.wxml"), "utf8");

  assert.ok(app.pages.includes("pages/library/index"));
  assert.ok(app.pages.includes("pages/libraryList/index"));
  assert.equal(app.pages.includes("pages/cabinet/index"), false);
  assert.equal(app.pages.includes("pages/medicineList/index"), false);
  assert.equal(overviewConfig.usingComponents["care-screen"], "/components/careScreen/index");
  assert.match(overview, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/);
  assert.match(overviewLogic, /items:\s*\(summary\.boxes \|\| \[\]\)\.map/);
  assert.match(overviewLogic, /detailAction:\s*summary\.medicineCount/);
  assert.match(overviewLogic, /id:\s*"library\.all"/);
  assert.match(overviewLogic, /id:\s*"library\.attention"/);
  assert.doesNotMatch(`${overview}\n${overviewLogic}`, /OPEN_CABINET|DISPENSE|23\s*仓/);
  assert.match(list, /wx:for="\{\{viewMedicines\}\}"/);
  assert.match(list, /storageBoxLabel/);
});

test("cabinet overview and medicine list remove duplicated explanatory copy", () => {
  const overview = fs.readFileSync(path.join(root, "miniprogram/pages/cabinet/index.wxml"), "utf8");
  const list = fs.readFileSync(path.join(root, "miniprogram/pages/medicineList/index.wxml"), "utf8");

  assert.match(overview, /<care-screen model="\{\{carePage\}\}"/);
  assert.doesNotMatch(overview, /<app-header|eyebrow=|subtitle=/);
  assert.doesNotMatch(overview, /先处理需要维护的药品/);
  assert.doesNotMatch(overview, /药箱概览/);
  assert.doesNotMatch(overview, /仓内有药与已确认无药/);
  assert.doesNotMatch(overview, /只显示最需要处理的两项/);
  assert.doesNotMatch(overview, /药箱当前没有需要维护的药品/);

  assert.match(list, /eyebrow=""/);
  assert.match(list, /subtitle=""/);
  assert.doesNotMatch(list, /搜索、筛选并维护/);
  assert.doesNotMatch(list, /class="ui-kicker"/);
});

test("cabinet registration actions share readable height and vertical alignment", () => {
  const careStyles = fs.readFileSync(path.join(root, "miniprogram/components/careScreen/index.wxss"), "utf8");
  const listStyles = fs.readFileSync(path.join(root, "miniprogram/pages/medicineList/index.wxss"), "utf8");
  const sharedAction = careStyles.match(/\.care-primary\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const listAction = listStyles.match(/\.cabinet-primary\s*\{([\s\S]*?)\n\}/)?.[1] || "";

  for (const action of [sharedAction, listAction]) {
    assert.match(action, /display:\s*flex/);
    assert.match(action, /align-items:\s*center/);
    assert.match(action, /min-height:\s*(?:88|92)rpx/);
  }
  assert.match(sharedAction, /justify-content:\s*space-between/);
  assert.match(listAction, /justify-content:\s*center/);
  assert.match(sharedAction, /width:\s*100%/);
  assert.match(listAction, /margin:\s*0/);
  assert.match(listAction, /box-shadow:/);
  assert.match(listStyles, /\.cabinet-list-summary\s*\{[\s\S]*?align-items:\s*center/);
});

test("medicine list activation waits for the authorized device and leaves the first refresh to onShow", async () => {
  const ready = deferred();
  const scopes = [];
  const subscriptions = [];
  const app = {
    globalData: { deviceId: "", deviceSessionResolved: false },
    waitForDeviceSession: () => ready.promise,
  };
  const page = loadMedicineList([], {
    app,
    getDevice: async deviceId => {
      scopes.push(deviceId);
      return { deviceId, online: true };
    },
    realtime: {
      subscribe(callback, key, options) {
        subscriptions.push({ callback, key, options });
        return () => {};
      },
    },
  });

  const activation = page.onShow();
  assert.deepEqual(scopes, []);
  assert.equal(subscriptions.length, 0);

  app.globalData.deviceId = "authorized-box";
  app.globalData.deviceSessionResolved = true;
  ready.resolve({ availability: "ready" });
  await activation;

  assert.deepEqual(scopes, ["authorized-box"]);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].options.immediate, false);
});
