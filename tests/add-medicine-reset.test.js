const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/addMedicine/index.js");
const templatePath = path.join(__dirname, "../miniprogram/pages/addMedicine/index.wxml");

function loadMedicinePage(wx, api = {}) {
  let definition = null;
  const app = api.app || { globalData: { deviceId: api.deviceId || "" } };
  const source = fs.readFileSync(pagePath, "utf8");
  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(request) {
      if (request.includes("expiry")) {
        return {
          expiryView: () => ({}),
          formatExpiryMonth: value => value,
          normalizeExpiryDate: value => value,
        };
      }
      if (request.includes("cabinetSlots")) {
        return require(path.join(__dirname, "../miniprogram/utils/cabinetSlots"));
      }
      if (request.includes("cabinetView")) {
        return require(path.join(__dirname, "../miniprogram/utils/cabinetView"));
      }
      if (request.includes("utils/api")) {
        return Object.assign({}, api, {
          getCapabilitiesStrict: api.getCapabilitiesStrict || (async () => ({ capabilities: {} })),
          getCabinetSlotsStrict: api.getCabinetSlotsStrict || api.getCabinetSlots,
        });
      }
      if (request.includes("utils/realtime")) {
        return api.realtime || { subscribe: () => () => {} };
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
      return {};
    },
    wx,
    getApp() {
      return app;
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
  }, { filename: pagePath });
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

function attachSetData(page) {
  page.setData = updates => {
    Object.entries(updates).forEach(([key, value]) => {
      const parts = key.split(".");
      let target = page.data;
      parts.slice(0, -1).forEach(part => {
        target = target[part];
      });
      target[parts.at(-1)] = value;
    });
  };
}

test("medicine editor displays the explicit inventory fact instead of deriving it from quantity", async () => {
  const page = loadMedicinePage({}, {
    getDevice: async () => ({ online: true }),
    getCapabilitiesStrict: async () => ({ capabilities: { explicitInventoryState: "v1" } }),
    getCabinetSlotsStrict: async () => [{
      slot: 1,
      name: "预扣为零但还有药",
      quantity: 0,
      inventoryState: "STOCKED",
      expireDate: "2028-01",
      expiryPrecision: "month",
    }],
  });
  attachSetData(page);

  await page.load();

  assert.equal(page.data.inventoryState.inventoryState, "STOCKED");
  assert.equal(page.data.inventoryState.isStocked, true);
  assert.equal(page.data.inventoryState.isDepleted, false);
});

test("marking a refill records STOCKED intent without rewriting the observed remote fact", () => {
  const page = loadMedicinePage({});
  page.data = {
    deviceId: "box-1",
    hasLoadedSlot: true,
    initialLoading: false,
    loadError: "",
    saving: false,
    form: { quantity: "0" },
    inventoryPolicy: { explicitInventoryStateSupported: true, legacyMode: false },
    inventoryState: {
      inventoryState: "DEPLETED",
      isStocked: false,
      isDepleted: true,
      isInventoryUnknown: false,
    },
    inventoryIntent: "",
  };
  page.app.globalData.deviceId = "box-1";
  attachSetData(page);

  page.markRefilled();

  assert.equal(page.data.form.quantity, "1");
  assert.equal(page.data.inventoryIntent, "STOCKED");
  assert.equal(page.data.inventoryState.inventoryState, "DEPLETED");
  assert.equal(page.data.inventoryState.isDepleted, true);
});

test("a supported refill submits STOCKED semantics and stays pending until the box confirms it", async () => {
  let submitted = null;
  const navigations = [];
  const page = loadMedicinePage({
    showLoading() {},
    hideLoading() {},
    showToast() {},
    switchTab(options) {
      navigations.push(options);
    },
  }, {
    deviceId: "box-1",
    async saveMedicine(form) {
      submitted = form;
      return { command: { _id: "refill-pending", status: "pending" } };
    },
  });
  page.data = {
    deviceId: "box-1",
    slotIndex: 0,
    hasLoadedSlot: true,
    initialLoading: false,
    loadError: "",
    saving: false,
    form: {
      name: "布洛芬",
      spec: "10片",
      quantity: "1",
      expireDate: "2028-08",
      expiryPrecision: "month",
    },
    baseMedicine: { name: "布洛芬", inventoryState: "DEPLETED" },
    inventoryPolicy: { explicitInventoryStateSupported: true, legacyMode: false },
    inventoryState: { inventoryState: "DEPLETED", isDepleted: true },
    inventoryIntent: "STOCKED",
    inventoryUpdateStatus: "draft",
  };
  attachSetData(page);

  await page.submit();

  assert.equal(submitted.inventoryState, "STOCKED");
  assert.equal(page.data.inventoryUpdateStatus, "pending");
  assert.equal(page.data.inventoryState.inventoryState, "DEPLETED");
  assert.deepEqual(navigations, []);
});

test("a command acknowledgement alone cannot promote the observed inventory fact", async () => {
  const page = loadMedicinePage({
    showLoading() {},
    hideLoading() {},
    showToast() {},
    switchTab() {
      throw new Error("a refill acknowledgement must stay on the editor");
    },
  }, {
    deviceId: "box-1",
    saveMedicine: async () => ({ command: { _id: "refill-done", status: "done" } }),
  });
  page.data = {
    deviceId: "box-1",
    slotIndex: 0,
    hasLoadedSlot: true,
    initialLoading: false,
    loadError: "",
    saving: false,
    form: {
      name: "布洛芬",
      spec: "10片",
      quantity: "1",
      expireDate: "2028-08",
      expiryPrecision: "month",
    },
    baseMedicine: { name: "布洛芬", inventoryState: "DEPLETED" },
    inventoryPolicy: { explicitInventoryStateSupported: true, legacyMode: false },
    inventoryState: { inventoryState: "DEPLETED", isDepleted: true },
    inventoryIntent: "STOCKED",
    inventoryUpdateStatus: "draft",
  };
  attachSetData(page);

  await page.submit();

  assert.equal(page.data.inventoryUpdateStatus, "pending");
  assert.equal(page.data.inventoryState.inventoryState, "DEPLETED");
});

test("a failed refill keeps the observed fact and intent available for retry", async () => {
  const page = loadMedicinePage({
    showLoading() {},
    hideLoading() {},
    showToast() {},
    switchTab() {
      throw new Error("failed refill must not navigate away");
    },
  }, {
    deviceId: "box-1",
    saveMedicine: async () => {
      throw new Error("command rejected");
    },
  });
  page.data = {
    deviceId: "box-1",
    slotIndex: 0,
    hasLoadedSlot: true,
    initialLoading: false,
    loadError: "",
    saving: false,
    form: {
      name: "布洛芬",
      spec: "10片",
      quantity: "1",
      expireDate: "2028-08",
      expiryPrecision: "month",
    },
    baseMedicine: { name: "布洛芬", inventoryState: "DEPLETED" },
    inventoryPolicy: { explicitInventoryStateSupported: true, legacyMode: false },
    inventoryState: { inventoryState: "DEPLETED", isDepleted: true },
    inventoryIntent: "STOCKED",
    inventoryUpdateStatus: "draft",
  };
  attachSetData(page);

  await page.submit();

  assert.equal(page.data.inventoryUpdateStatus, "failed");
  assert.equal(page.data.inventoryIntent, "STOCKED");
  assert.equal(page.data.inventoryState.inventoryState, "DEPLETED");
  assert.equal(page.data.saving, false);
});

test("a fresh STOCKED snapshot completes a pending refill without replacing the local draft", async () => {
  let readCount = 0;
  const page = loadMedicinePage({}, {
    deviceId: "box-1",
    getDevice: async () => ({ online: true }),
    getCapabilitiesStrict: async () => ({ capabilities: { explicitInventoryState: "v1" } }),
    getCabinetSlotsStrict: async () => {
      readCount += 1;
      return [{
        slot: 1,
        name: "布洛芬",
        spec: readCount === 1 ? "远端规格" : "远端新规格",
        quantity: readCount === 1 ? 0 : 1,
        inventoryState: readCount === 1 ? "DEPLETED" : "STOCKED",
        inventoryStateRevision: readCount,
        expireDate: "2028-08",
        expiryPrecision: "month",
      }];
    },
  });
  attachSetData(page);

  await page.load();
  page.onInput({ currentTarget: { dataset: { key: "spec" } }, detail: { value: "本地草稿规格" } });
  page.markRefilled();
  page.setData({ inventoryUpdateStatus: "pending" });

  await page.load();

  assert.equal(page.data.inventoryState.inventoryState, "STOCKED");
  assert.equal(page.data.inventoryIntent, "");
  assert.equal(page.data.inventoryUpdateStatus, "succeeded");
  assert.equal(page.data.form.spec, "本地草稿规格");
});

test("medicine editor discards an old-device draft and re-gates on cabinet switch", async () => {
  const lateOldSnapshot = deferred();
  const failedNewSnapshot = deferred();
  const readScopes = [];
  let oldReads = 0;
  let newReads = 0;
  const page = loadMedicinePage({ showToast() {} }, {
    deviceId: "box-a",
    getDevice: async deviceId => ({ deviceId, online: true }),
    getCabinetSlotsStrict(deviceId) {
      readScopes.push(deviceId);
      const requestedDeviceId = deviceId || (oldReads < 2 ? "box-a" : "box-b");
      if (requestedDeviceId === "box-a") {
        oldReads += 1;
        if (oldReads === 1) {
          return Promise.resolve([{
            id: "box-a-slot-1",
            name: "A 箱药品",
            quantity: 1,
            expireDate: "2028-01",
            expiryPrecision: "month",
          }]);
        }
        return lateOldSnapshot.promise;
      }
      newReads += 1;
      if (newReads === 1) return failedNewSnapshot.promise;
      return Promise.resolve([{
        id: "box-b-slot-1",
        name: "B 箱药品",
        quantity: 1,
        expireDate: "2029-02",
        expiryPrecision: "month",
      }]);
    },
  });
  attachSetData(page);

  await page.load();
  page.onInput({ currentTarget: { dataset: { key: "name" } }, detail: { value: "A 箱本地草稿" } });
  page.setData({ currentStep: 3 });
  const oldRefresh = page.load();

  page.app.globalData.deviceId = "box-b";
  const switchedLoad = page.load();
  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.form.name, "");
  assert.deepEqual(Object.assign({}, page.data.baseMedicine), {});
  assert.equal(page.data.currentStep, 1);
  assert.equal(page.data.hasLoadedSlot, false);
  assert.equal(page.data.initialLoading, true);

  failedNewSnapshot.reject(new Error("new cabinet unavailable"));
  await switchedLoad;
  assert.equal(page.data.hasLoadedSlot, false);
  assert.equal(page.data.initialLoading, false);
  assert.match(page.data.loadError, /仓位数据/);
  assert.equal(page.data.form.name, "");
  assert.equal(page.data.isStale, false);

  lateOldSnapshot.resolve([{
    id: "late-box-a-slot-1",
    name: "迟到的 A 箱药品",
    quantity: 1,
    expireDate: "2030-01",
  }]);
  await oldRefresh;
  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.form.name, "");
  assert.match(page.data.loadError, /仓位数据/);

  await page.retryLoad();
  assert.equal(page.data.hasLoadedSlot, true);
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.form.name, "B 箱药品");
  assert.deepEqual(readScopes, ["box-a", "box-a", "box-b", "box-b"]);
});

test("medicine submit requires a successful snapshot for the currently active cabinet", async () => {
  const boxBSnapshot = deferred();
  const toasts = [];
  const navigations = [];
  const saveScopes = [];
  let page;
  page = loadMedicinePage({
    showLoading() {},
    hideLoading() {},
    showToast(options) {
      toasts.push(options);
    },
    switchTab(options) {
      navigations.push(options);
    },
  }, {
    deviceId: "box-a",
    getDevice: async deviceId => ({ deviceId, online: true }),
    getCabinetSlotsStrict(deviceId) {
      if (deviceId === "box-a") return Promise.resolve([]);
      return boxBSnapshot.promise;
    },
    async saveMedicine(form) {
      saveScopes.push({
        form,
        pageDeviceId: page.data.deviceId,
        activeDeviceId: page.app.globalData.deviceId,
      });
    },
  });
  attachSetData(page);

  await page.load();
  page.setData({
    form: {
      name: "A 箱草稿",
      spec: "",
      quantity: "1",
      expireDate: "2028-01",
      expiryPrecision: "month",
    },
  });
  page.app.globalData.deviceId = "box-b";

  await page.submit();
  assert.equal(saveScopes.length, 0);
  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.hasLoadedSlot, false);
  assert.equal(page.data.form.name, "");
  assert.match(toasts.at(-1).title, /药箱已切换/);

  boxBSnapshot.resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.hasLoadedSlot, true);
  page.setData({
    form: {
      name: "B 箱药品",
      spec: "家庭装",
      quantity: "1",
      expireDate: "2029-02",
      expiryPrecision: "month",
    },
  });

  await page.submit();
  assert.equal(saveScopes.length, 1);
  assert.equal(saveScopes[0].pageDeviceId, "box-b");
  assert.equal(saveScopes[0].activeDeviceId, "box-b");
  assert.equal(saveScopes[0].form.name, "B 箱药品");
  assert.deepEqual(Array.from(navigations, item => item.url), ["/pages/cabinet/index"]);
});

test("a submission completed after switching cabinets closes loading without rebuilding stale UI", async () => {
  const saveResult = deferred();
  const toasts = [];
  const navigations = [];
  let showLoadingCount = 0;
  let hideLoadingCount = 0;
  const page = loadMedicinePage({
    showLoading() {
      showLoadingCount += 1;
    },
    hideLoading() {
      hideLoadingCount += 1;
    },
    showToast(options) {
      toasts.push(options);
    },
    switchTab(options) {
      navigations.push(options);
    },
  }, {
    deviceId: "box-a",
    getDevice: async deviceId => ({ deviceId, online: true }),
    getCabinetSlotsStrict: async () => [],
    saveMedicine: () => saveResult.promise,
  });
  attachSetData(page);

  await page.load();
  page.setData({
    form: {
      name: "A 箱药品",
      spec: "",
      quantity: "1",
      expireDate: "2028-01",
      expiryPrecision: "month",
    },
  });
  const submitting = page.submit();
  await Promise.resolve();
  assert.equal(showLoadingCount, 1);

  page.app.globalData.deviceId = "box-b";
  await page.load();
  saveResult.resolve({ ok: true });
  await submitting;

  assert.equal(hideLoadingCount, 1);
  assert.equal(page.data.deviceId, "box-b");
  assert.equal(toasts.some(item => /已提交/.test(item.title)), false);
  assert.deepEqual(Array.from(navigations), []);
});

test("a reset confirmation opened on the old cabinet cannot restore its draft after switching", async () => {
  let resetModal = null;
  const page = loadMedicinePage({
    showModal(options) {
      resetModal = options;
    },
  }, {
    deviceId: "box-a",
    getDevice: async deviceId => ({ deviceId, online: true }),
    getCabinetSlotsStrict: async deviceId => deviceId === "box-a" ? [{
      id: "box-a-slot-1",
      name: "A 箱药品",
      quantity: 1,
      expireDate: "2028-01",
      expiryPrecision: "month",
    }] : [],
  });
  attachSetData(page);

  await page.load();
  page.onInput({ currentTarget: { dataset: { key: "name" } }, detail: { value: "A 箱未保存草稿" } });
  page.clearForm();
  assert.ok(resetModal);

  page.app.globalData.deviceId = "box-b";
  await page.load();
  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.form.name, "");

  resetModal.success({ confirm: true });
  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.form.name, "");
  assert.deepEqual(Object.assign({}, page.data.baseMedicine), {});
});

test("medicine editor stays read-only until the selected slot snapshot is ready", async () => {
  const cabinetSnapshot = deferred();
  let saveCount = 0;
  const page = loadMedicinePage({
    showLoading() {},
    hideLoading() {},
    showToast() {},
    switchTab() {},
  }, {
    getDevice: async () => ({ online: true }),
    getCabinetSlots: () => cabinetSnapshot.promise,
    saveMedicine: async () => {
      saveCount += 1;
    },
  });
  page.setData = next => Object.assign(page.data, next);

  const loading = page.load();
  assert.equal(page.data.initialLoading, true);

  page.onInput({ currentTarget: { dataset: { key: "name" } }, detail: { value: "未加载草稿" } });
  assert.equal(page.data.form.name, "");

  page.data.form = {
    name: "不应提交",
    spec: "",
    quantity: "1",
    expireDate: "2028-01",
    expiryPrecision: "month",
  };
  page.nextStep();
  assert.equal(page.data.currentStep, 1);
  await page.submit();
  assert.equal(saveCount, 0);

  cabinetSnapshot.resolve([{
    id: "slot-1",
    name: "阿司匹林",
    spec: "100mg*30",
    quantity: 8,
    expireDate: "2028-01",
    expiryPrecision: "month",
  }]);
  await loading;

  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.form.name, "阿司匹林");
});

test("background slot refresh keeps the medicine draft entered after the initial snapshot", async () => {
  const backgroundSnapshot = deferred();
  let cabinetReadCount = 0;
  const page = loadMedicinePage({}, {
    getDevice: async () => ({ online: true }),
    getCabinetSlots() {
      cabinetReadCount += 1;
      if (cabinetReadCount === 1) {
        return Promise.resolve([{
          id: "slot-1",
          name: "阿司匹林",
          spec: "100mg*30",
          quantity: 8,
          expireDate: "2028-01",
          expiryPrecision: "month",
        }]);
      }
      return backgroundSnapshot.promise;
    },
  });
  attachSetData(page);

  await page.load();
  page.onInput({ currentTarget: { dataset: { key: "name" } }, detail: { value: "阿司匹林（家用）" } });
  const refreshing = page.load();
  page.onInput({ currentTarget: { dataset: { key: "spec" } }, detail: { value: "本地草稿规格" } });

  backgroundSnapshot.resolve([{
    id: "slot-1",
    name: "远端旧名称",
    spec: "远端旧规格",
    quantity: 6,
    expireDate: "2029-01",
    expiryPrecision: "month",
  }]);
  await refreshing;

  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.form.name, "阿司匹林（家用）");
  assert.equal(page.data.form.spec, "本地草稿规格");
  assert.equal(page.data.baseMedicine.name, "阿司匹林");
});

test("medicine editor renders an explicit loading surface instead of the empty form", () => {
  const template = fs.readFileSync(templatePath, "utf8");
  assert.match(template, /wx:if="\{\{initialLoading\}\}"[^>]*aria-label="正在读取仓位药品"/);
  assert.match(template, /正在读取仓位药品…/);
  assert.match(template, /<block wx:else>[\s\S]*class="medicine-flow"/);
});

test("medicine editor exposes a retry error and unlocks only after a real empty snapshot", async () => {
  let shouldFail = true;
  let saveCount = 0;
  const page = loadMedicinePage({
    showLoading() {},
    hideLoading() {},
    showToast() {},
    switchTab() {},
  }, {
    getDevice: async () => ({ online: true }),
    getCabinetSlotsStrict: async () => {
      if (shouldFail) throw new Error("snapshot unavailable");
      return [];
    },
    saveMedicine: async () => {
      saveCount += 1;
    },
  });
  attachSetData(page);

  await page.load();

  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.hasLoadedSlot, false);
  assert.match(page.data.loadError, /仓位数据/);
  page.onInput({ currentTarget: { dataset: { key: "name" } }, detail: { value: "不应写入" } });
  assert.equal(page.data.form.name, "");
  page.data.form = {
    name: "不应提交",
    spec: "",
    quantity: "1",
    expireDate: "2028-01",
    expiryPrecision: "month",
  };
  page.nextStep();
  assert.equal(page.data.currentStep, 1);
  await page.submit();
  assert.equal(saveCount, 0);
  page.data.form = {
    name: "",
    spec: "",
    quantity: "1",
    expireDate: "",
    expiryPrecision: "month",
  };

  const template = fs.readFileSync(templatePath, "utf8");
  assert.match(template, /wx:elif="\{\{loadError\}\}"/);
  assert.match(template, /bindtap="retryLoad"/);

  shouldFail = false;
  const retrying = page.retryLoad();
  assert.equal(page.data.initialLoading, true);
  assert.equal(page.data.loadError, "");
  await retrying;

  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.hasLoadedSlot, true);
  assert.equal(page.data.form.name, "");
});

test("medicine editor preserves a same-device slot snapshot but blocks submission until its stale data is retried", async () => {
  let readCount = 0;
  let saveCount = 0;
  const toasts = [];
  const page = loadMedicinePage({
    showLoading() {},
    hideLoading() {},
    showToast(options) {
      toasts.push(options);
    },
    switchTab() {},
  }, {
    deviceId: "box-1",
    getDevice: async () => ({ online: true }),
    getCabinetSlotsStrict: async () => {
      readCount += 1;
      if (readCount === 1) {
        return [{
          slot: 1,
          name: "已同步药品",
          quantity: 1,
          expireDate: "2028-01",
          expiryPrecision: "month",
        }];
      }
      if (readCount === 3) {
        return [{
          slot: 1,
          name: "已同步药品",
          quantity: 1,
          expireDate: "2028-01",
          expiryPrecision: "month",
        }];
      }
      throw new Error("refresh unavailable");
    },
    saveMedicine: async () => {
      saveCount += 1;
    },
  });
  attachSetData(page);

  await page.load();
  page.setData({
    form: {
      name: "本地修改",
      spec: "",
      quantity: "1",
      expireDate: "2028-01",
      expiryPrecision: "month",
    },
  });
  await page.load();

  assert.equal(page.data.form.name, "本地修改");
  assert.equal(page.data.hasLoadedSlot, true);
  assert.equal(page.data.isStale, true);
  assert.match(page.data.refreshError, /上次成功读取/);
  assert.equal(page.data.loadError, "");

  await page.submit();
  assert.equal(saveCount, 0);
  assert.match(toasts.at(-1).title, /重新读取/);

  await page.retryLoad();
  assert.equal(page.data.isStale, false);
  assert.equal(page.data.refreshError, "");
  await page.submit();
  assert.equal(saveCount, 1);

  const template = fs.readFileSync(templatePath, "utf8");
  assert.match(template, /wx:if="\{\{isStale\}\}"/);
  assert.match(template, /bindtap="retryLoad"/);
  assert.match(template, /disabled="\{\{saving \|\| isStale \|\| inventoryUpdateStatus === 'pending'\}\}"/);
  assert.match(template, /isStale \? '重新读取后提交'/);
});

test("overlapping initial reads keep the editor gated until a slot snapshot succeeds", async () => {
  const failedRead = deferred();
  const successfulRead = deferred();
  let readCount = 0;
  const page = loadMedicinePage({}, {
    getDevice: async () => ({ online: true }),
    getCabinetSlots() {
      readCount += 1;
      return readCount === 1 ? failedRead.promise : successfulRead.promise;
    },
  });
  attachSetData(page);

  const firstLoad = page.load();
  const secondLoad = page.load();
  failedRead.reject(new Error("temporary network failure"));
  await firstLoad;

  assert.equal(page.data.initialLoading, true);
  page.onInput({ currentTarget: { dataset: { key: "name" } }, detail: { value: "抢先输入" } });
  assert.equal(page.data.form.name, "");

  successfulRead.resolve([{
    id: "slot-1",
    name: "布洛芬",
    quantity: 2,
    expireDate: "2028-08",
    expiryPrecision: "month",
  }]);
  await secondLoad;

  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.form.name, "布洛芬");
});

test("resetting a partly edited medicine restores the synced draft only after confirmation", () => {
  let modal = null;
  const page = loadMedicinePage({
    showModal(options) {
      modal = options;
    },
  });
  page.data = {
    deviceId: "",
    slotIndex: 0,
    hasLoadedSlot: true,
    initialLoading: false,
    loadError: "",
    form: { name: "阿司匹林", quantity: "5", expireDate: "2028-01", expiryPrecision: "month" },
    expiryConflict: false,
    baseMedicine: {
      id: "slot-1",
      name: "阿司匹林",
      spec: "100mg*30",
      quantity: 8,
      expireDate: "2028-01",
      expiryPrecision: "month",
      lowStockLine: 2,
    },
  };
  const updates = [];
  page.setData = next => {
    updates.push(next);
    Object.assign(page.data, next);
  };

  page.clearForm();
  assert.ok(modal);
  assert.equal(updates.length, 0);
  assert.match(modal.content, /不会改变药箱中已同步的药品/);

  modal.success({ confirm: false });
  assert.equal(updates.length, 0);

  modal.success({ confirm: true });
  assert.equal(updates.length, 1);
  assert.equal(page.data.form.name, "阿司匹林");
  assert.equal(page.data.form.quantity, "8");
  assert.equal(page.data.baseMedicine.id, "slot-1");
});

test("medicine maintenance keeps the draft while moving through its three steps", () => {
  const page = loadMedicinePage({});
  page.data = {
    deviceId: "",
    hasLoadedSlot: true,
    initialLoading: false,
    loadError: "",
    currentStep: 1,
    form: {
      name: "阿司匹林",
      spec: "100mg*30",
      quantity: "1",
      expireDate: "2028-01",
      expiryPrecision: "month",
    },
  };
  page.setData = next => Object.assign(page.data, next);

  page.nextStep();
  assert.equal(page.data.currentStep, 2);
  assert.equal(page.data.form.name, "阿司匹林");
  assert.equal(page.data.form.expireDate, "2028-01");

  page.nextStep();
  assert.equal(page.data.currentStep, 3);
  assert.equal(page.data.form.spec, "100mg*30");

  page.previousStep();
  assert.equal(page.data.currentStep, 2);
  page.previousStep();
  assert.equal(page.data.currentStep, 1);
  page.previousStep();
  assert.equal(page.data.currentStep, 1);
});

test("medicine maintenance validates the visible step before moving forward", async () => {
  const toasts = [];
  const page = loadMedicinePage({
    showToast(options) {
      toasts.push(options);
    },
  });
  page.data = {
    deviceId: "",
    hasLoadedSlot: true,
    initialLoading: false,
    loadError: "",
    currentStep: 1,
    saving: false,
    form: {
      name: "",
      spec: "",
      quantity: "1",
      expireDate: "",
      expiryPrecision: "month",
    },
  };
  page.setData = next => Object.assign(page.data, next);

  page.nextStep();
  assert.equal(page.data.currentStep, 1);
  assert.equal(toasts.length, 1);

  page.data.form.name = "阿司匹林";
  page.nextStep();
  assert.equal(page.data.currentStep, 2);

  page.nextStep();
  assert.equal(page.data.currentStep, 2);
  assert.equal(toasts.length, 2);

  page.data.form.expireDate = "2028-01";
  page.nextStep();
  assert.equal(page.data.currentStep, 3);

  page.data.form.name = "";
  await page.submit();
  assert.equal(page.data.currentStep, 1);

  page.data.form.name = "阿司匹林";
  page.data.form.expireDate = "";
  await page.submit();
  assert.equal(page.data.currentStep, 2);
});

test("medicine editor activation waits for the authorized device and avoids realtime's duplicate immediate load", async () => {
  const ready = deferred();
  const scopes = [];
  const subscriptions = [];
  const app = {
    globalData: { deviceId: "", deviceSessionResolved: false },
    waitForDeviceSession: () => ready.promise,
  };
  const page = loadMedicinePage({}, {
    app,
    getDevice: async deviceId => {
      scopes.push(deviceId);
      return { deviceId, online: true };
    },
    getCabinetSlotsStrict: async () => [],
    realtime: {
      subscribe(callback, key, options) {
        subscriptions.push({ callback, key, options });
        return () => {};
      },
    },
  });
  page.data = Object.assign({}, page.data);
  attachSetData(page);
  page.onLoad({ slot: 1 });

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
