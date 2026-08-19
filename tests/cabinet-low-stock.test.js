const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/cabinet/index.js");

function loadCabinetPage(slots, apiOverrides = {}) {
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
          getCabinetSlotsStrict: apiOverrides.getCabinetSlotsStrict || (async () => slots),
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
      if (request.includes("utils/carePage")) {
        return require(path.join(__dirname, "../miniprogram/utils/carePage"));
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

test("cabinet clears the old device immediately and ignores its late snapshot after a switch", async () => {
  const lateOldSnapshot = deferred();
  const newSnapshot = deferred();
  const readScopes = [];
  let oldReads = 0;
  const page = loadCabinetPage([], {
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
  assert.equal(page.data.slots[0].name, "A 箱药品");

  const oldRefresh = page.load();
  page.app.globalData.deviceId = "box-b";
  const switchedLoad = page.load();

  assert.equal(page.data.deviceId, "box-b");
  assert.deepEqual(Array.from(page.data.slots), []);
  assert.equal(page.data.carePage.phase.kind, "loading");
  assert.equal(page.data.carePage.focus, null);

  newSnapshot.reject(new Error("new device snapshot unavailable"));
  await switchedLoad;
  assert.equal(page.data.carePage.phase.kind, "error");
  assert.deepEqual(Array.from(page.data.slots), []);
  assert.equal(page.data.isStale, false);

  lateOldSnapshot.resolve([{ slot: 2, name: "迟到的 A 箱药品", quantity: 1, expireDate: "2099-01" }]);
  await oldRefresh;
  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.carePage.phase.kind, "error");
  assert.deepEqual(Array.from(page.data.slots), []);
  assert.deepEqual(readScopes, ["box-a", "box-a", "box-b"]);
});

test("cabinet legacy mode treats only a positive quantity as confirmed stock", async () => {
  const page = loadCabinetPage([
    { slot: 1, name: "阿司匹林", quantity: 1, lowStockLine: 1, unit: "盒", expireDate: "2099-01" },
    { slot: 2, name: "维生素", quantity: 0, lowStockLine: 1, unit: "盒", expireDate: "2099-01" },
    { slot: 3, name: "阿莫西林", quantity: null, expireDate: "2099-01" },
  ]);

  await page.load();
  assert.equal(page.data.depletedCount, 0);
  assert.equal(page.data.inventoryUnknownCount, 2);
  assert.equal(page.data.slots[0].inventoryState, "STOCKED");
  assert.equal(page.data.slots[0].isDepleted, false);
  assert.equal(page.data.slots[0].stockText, "药箱显示有药");
  assert.equal(page.data.slots[1].isDepleted, false);
  assert.equal(page.data.slots[1].inventoryState, "UNKNOWN");
  assert.match(page.data.slots[1].stockText, /待药箱确认/);
  assert.equal(page.data.slots[2].isDepleted, false);
  assert.equal(page.data.slots[2].inventoryState, "UNKNOWN");
  assert.deepEqual(Array.from(page.data.prioritySlots, item => item.slot), []);
});

test("cabinet shows UNKNOWN inventory without counting it as refill work or all-clear", async () => {
  const page = loadCabinetPage([{
    slot: 1,
    name: "库存待确认药品",
    quantity: 0,
    inventoryState: "UNKNOWN",
    expireDate: "2099-01",
  }], {
    getCapabilitiesStrict: async () => ({
      capabilities: { explicitInventoryState: "v1" },
    }),
  });

  await page.load();

  assert.equal(page.data.depletedCount, 0);
  assert.equal(page.data.inventoryUnknownCount, 1);
  assert.match(page.data.carePage.focus.title, /库存待确认/);
  assert.match(page.data.carePage.sections[0].items[0].supporting, /待药箱确认/);
  assert.deepEqual(page.data.carePage.sections[0].items[0].state, {
    kind: "muted",
    label: "库存待确认",
  });
});

test("cabinet overview keeps every priority slot when the working set is below its cap", async () => {
  const page = loadCabinetPage([
    { slot: 1, name: "常规药品", quantity: 1, expireDate: "2099-01" },
    { slot: 2, name: "已经过期", quantity: 1, expireDate: "2000-01" },
    { slot: 3, name: "已确认无药", quantity: 0, inventoryState: "DEPLETED", expireDate: "2099-01" },
    { slot: 4, name: "另一条常规药", quantity: 1, expireDate: "2099-01" },
  ]);

  await page.load();

  assert.equal(page.data.stockCount, 4);
  assert.equal(page.data.expiredCount, 1);
  assert.equal(page.data.depletedCount, 1);
  assert.equal(page.data.prioritySlots.length, 2);
  assert.deepEqual(Array.from(page.data.prioritySlots, item => item.slot), [2, 3]);
});

test("a depleted slot with an old expiry stays behind medicine that is actually expired", async () => {
  const page = loadCabinetPage([
    { slot: 1, name: "空仓旧药", quantity: 0, inventoryState: "DEPLETED", expireDate: "2000-01" },
    { slot: 2, name: "仍有药但已过期", quantity: 1, expireDate: "2001-01" },
  ]);

  await page.load();

  assert.equal(page.data.expiredCount, 1);
  assert.equal(page.data.depletedCount, 1);
  assert.deepEqual(Array.from(page.data.prioritySlots, item => item.slot), [2, 1]);
});

test("cabinet overview fills a short risk list with registered medicines, without displacing risks", async () => {
  const page = loadCabinetPage([
    { slot: 1, name: "常规药品", quantity: 1, expireDate: "2099-01" },
    { slot: 2, name: "已经过期", quantity: 1, expireDate: "2000-01" },
    { slot: 3, name: "已确认无药", quantity: 0, inventoryState: "DEPLETED", expireDate: "2099-01" },
    { slot: 4, name: "待补有效期", quantity: 1, expireDate: "" },
    { slot: 5, name: "另一种常规药", quantity: 1, expireDate: "2099-01" },
  ]);

  await page.load();

  assert.deepEqual(Array.from(page.data.prioritySlots, item => item.slot), [2, 3, 4]);
  assert.deepEqual(Array.from(page.data.overviewSlots, item => item.slot), [2, 3, 4, 1]);
});

test("cabinet overview keeps a useful first-screen working set of up to four priority slots", async () => {
  const page = loadCabinetPage([
    { slot: 1, name: "常规药品", quantity: 1, expireDate: "2099-01" },
    { slot: 2, name: "已过期一", quantity: 1, expireDate: "2000-01" },
    { slot: 3, name: "已确认无药一", quantity: 0, inventoryState: "DEPLETED", expireDate: "2099-01" },
    { slot: 4, name: "已过期二", quantity: 1, expireDate: "2001-01" },
    { slot: 5, name: "已确认无药二", quantity: 0, inventoryState: "DEPLETED", expireDate: "2099-01" },
    { slot: 6, name: "待补有效期", quantity: 1, expireDate: "" },
  ]);

  await page.load();

  assert.equal(page.data.prioritySlots.length, 4);
  assert.deepEqual(Array.from(page.data.prioritySlots, item => item.slot), [2, 4, 3, 5]);
});

test("zero-value cabinet facts are informative rather than empty navigation targets", async () => {
  const page = loadCabinetPage([]);

  await page.load();

  assert.equal(page.data.carePage.overview.every(item => item.action === null), true);
});

test("cabinet shows a retryable error instead of an empty cabinet when its first snapshot fails", async () => {
  let shouldFail = true;
  const page = loadCabinetPage([], {
    getCabinetSlotsStrict: async () => {
      if (shouldFail) throw new Error("snapshot unavailable");
      return [];
    },
  });

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "error");
  assert.match(page.data.carePage.phase.message, /药品数据/);
  assert.equal(page.data.carePage.phase.action.id, "cabinet.retry");

  shouldFail = false;
  const retrying = page.onCarePageAction({ detail: page.data.carePage.phase.action });
  assert.equal(page.data.carePage.phase.kind, "loading");
  await retrying;

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.carePage.focus.title, "还没有登记药品");
});

test("cabinet retains a same-device snapshot and offers an honest retry after a refresh failure", async () => {
  let readCount = 0;
  const page = loadCabinetPage([], {
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

  assert.equal(page.data.slots[0].name, "已同步药品");
  assert.equal(page.data.hasLoadedSnapshot, true);
  assert.equal(page.data.isStale, true);
  assert.match(page.data.refreshError, /上次成功读取/);
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.carePage.focus.action.id, "cabinet.retry");
});

test("cabinet overview keeps the complete medicine list behind a dedicated navigation entry", () => {
  const page = loadCabinetPage([]);

  page.goMedicineList();

  assert.deepEqual(Array.from(page.navigations, item => item.url), ["/pages/medicineList/index"]);
});

test("an overview medicine keeps its direct edit action", () => {
  const page = loadCabinetPage([]);

  page.editOverviewSlot({ currentTarget: { dataset: { slot: 6 } } });

  assert.deepEqual(Array.from(page.navigations, item => item.url), ["/pages/addMedicine/index?slot=6"]);
});

test("cabinet exposes its loading, maintenance and navigation flows through the care screen interface", async () => {
  const page = loadCabinetPage([
    { slot: 1, name: "仍有药但已过期", quantity: 1, expireDate: "2000-01" },
    { slot: 2, name: "已确认无药", quantity: 0, inventoryState: "DEPLETED", expireDate: "2099-01" },
  ]);

  assert.equal(page.data.carePage.phase.kind, "loading");

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.id, "cabinet.focus.edit");
  assert.equal(page.data.carePage.focus.action.payload.slot, 1);
  assert.equal(page.data.carePage.overview.length, 4);
  assert.equal(page.data.carePage.sections[0].items.length, 2);
  assert.equal(page.data.carePage.sections[0].items[0].action.payload.slot, 1);

  page.onCarePageAction({ detail: page.data.carePage.focus.action });
  page.onCarePageAction({ detail: { id: "cabinet.filter.expired", payload: { filter: "expired" } } });
  page.onCarePageAction({ detail: { id: "cabinet.edit.2", payload: { slot: 2 } } });
  page.onCarePageAction({ detail: { id: "cabinet.all", payload: {} } });

  assert.deepEqual(Array.from(page.navigations, item => item.url), [
    "/pages/addMedicine/index?slot=1",
    "/pages/medicineList/index?filter=expired",
    "/pages/addMedicine/index?slot=2",
    "/pages/medicineList/index",
  ]);

  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/cabinet/index.wxml"), "utf8");
  assert.match(layout, /<care-screen\s+model="\{\{carePage\}\}"\s+bind:action="onCarePageAction"\s*\/>/);
});

test("cabinet registration selects the first empty physical slot", async () => {
  const page = loadCabinetPage([
    { slot: 1, name: "常规药品", quantity: 1, expireDate: "2099-01" },
    { slot: 2, name: "", quantity: 0, expireDate: "" },
  ]);

  await page.load();

  assert.equal(page.data.carePage.focus.action.id, "cabinet.register");
  assert.equal(page.data.carePage.focus.activation, "button");
  assert.equal(page.data.carePage.focus.action.payload.slot, 2);
  page.onCarePageAction({ detail: page.data.carePage.focus.action });
  assert.deepEqual(Array.from(page.navigations, item => item.url), ["/pages/addMedicine/index?slot=2"]);
});

test("a full healthy cabinet offers the complete medicine list instead of false registration", async () => {
  const slots = Array.from({ length: 23 }, (_, index) => ({
    slot: index + 1,
    name: `药品 ${index + 1}`,
    quantity: 1,
    expireDate: "2099-01",
  }));
  const page = loadCabinetPage(slots);

  await page.load();

  assert.equal(page.data.carePage.focus.action.id, "cabinet.focus.all");
  assert.equal(page.data.carePage.focus.activation, "button");
  assert.equal(page.data.carePage.focus.action.label, "查看全部药品");
  page.onCarePageAction({ detail: page.data.carePage.focus.action });
  assert.deepEqual(Array.from(page.navigations, item => item.url), ["/pages/medicineList/index"]);
});

test("cabinet activation waits for the authorized device and disables realtime's duplicate immediate read", async () => {
  const ready = deferred();
  const scopes = [];
  const subscriptions = [];
  const app = {
    globalData: { deviceId: "", deviceSessionResolved: false },
    waitForDeviceSession: () => ready.promise,
  };
  const page = loadCabinetPage([], {
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
