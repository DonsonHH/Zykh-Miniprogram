const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/ai/index.js");
const templatePath = path.join(__dirname, "../miniprogram/pages/ai/index.wxml");
const historyPagePath = path.join(__dirname, "../miniprogram/pages/ai/history/index.js");
const historyTemplatePath = path.join(__dirname, "../miniprogram/pages/ai/history/index.wxml");
const historyConfigPath = path.join(__dirname, "../miniprogram/pages/ai/history/index.json");
const inquiryApi = require("../miniprogram/utils/api");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function loadInquiryPage(api, wx = {}, app = { globalData: { deviceId: "station-default" } }) {
  let definition = null;
  api.getSnapshotStrict = api.getSnapshotStrict || api.getSnapshot;
  api.shouldShowInquiryForServiceUsers = api.shouldShowInquiryForServiceUsers || inquiryApi.shouldShowInquiryForServiceUsers;
  const source = fs.readFileSync(pagePath, "utf8");
  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(modulePath) {
      if (modulePath.includes("utils/dateTime")) {
        return require(path.join(__dirname, "../miniprogram/utils/dateTime"));
      }
      if (modulePath.includes("utils/carePage")) {
        return require(path.join(__dirname, "../miniprogram/utils/carePage"));
      }
      if (modulePath.includes("utils/offlinePageCache")) {
        return require(path.join(__dirname, "../miniprogram/utils/offlinePageCache"));
      }
      if (modulePath.includes("utils/realtime")) return { subscribe: () => () => {} };
      if (modulePath.includes("utils/deviceSession")) {
        return {
          runAfterDeviceSessionReady(callback) {
            return app.globalData.deviceSessionResolved !== true && typeof app.waitForDeviceSession === "function"
              ? Promise.resolve(app.waitForDeviceSession()).then(callback)
              : callback();
          },
        };
      }
      if (modulePath.includes("modules/personaVisibility")) {
        return require(path.join(__dirname, "../miniprogram/modules/personaVisibility"));
      }
      return api;
    },
    getApp() {
      return app;
    },
    wx,
  }, { filename: pagePath });
  return definition;
}

function loadInquiryHistoryPage(api, app = { globalData: { deviceId: "station-default" } }) {
  let definition = null;
  api.getSnapshotStrict = api.getSnapshotStrict || api.getSnapshot;
  api.shouldShowInquiryForServiceUsers = api.shouldShowInquiryForServiceUsers || inquiryApi.shouldShowInquiryForServiceUsers;
  const source = fs.readFileSync(historyPagePath, "utf8");
  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(modulePath) {
      if (modulePath.includes("utils/dateTime")) {
        return require(path.join(__dirname, "../miniprogram/utils/dateTime"));
      }
      if (modulePath.includes("utils/carePage")) {
        return require(path.join(__dirname, "../miniprogram/utils/carePage"));
      }
      if (modulePath.includes("utils/offlinePageCache")) {
        return require(path.join(__dirname, "../miniprogram/utils/offlinePageCache"));
      }
      if (modulePath.includes("utils/realtime")) return { subscribe: () => () => {} };
      if (modulePath.includes("utils/deviceSession")) {
        return {
          runAfterDeviceSessionReady(callback) {
            return app.globalData.deviceSessionResolved !== true && typeof app.waitForDeviceSession === "function"
              ? Promise.resolve(app.waitForDeviceSession()).then(callback)
              : callback();
          },
        };
      }
      if (modulePath.includes("modules/personaVisibility")) {
        return require(path.join(__dirname, "../miniprogram/modules/personaVisibility"));
      }
      return api;
    },
    getApp() {
      return app;
    },
  }, { filename: historyPagePath });
  return definition;
}

test("the inquiry tab clears the previous medication box before its scoped read completes", async () => {
  const app = { globalData: { deviceId: "station-b" } };
  const readScopes = [];
  let resolveSnapshot;
  const page = loadInquiryPage({
    getSnapshotStrict: options => {
      readScopes.push(options.deviceId);
      return new Promise(resolve => { resolveSnapshot = resolve; });
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => rows.length ? [{ personKey: "b", personName: "B", inquiries: rows }] : [],
  }, {}, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-a",
    inquiryGroups: [{ personKey: "a", inquiries: [{ id: "old-a" }] }],
    initialLoading: false,
    hasLoaded: true,
    loadError: "old error",
    stale: true,
    processVisible: true,
    activeInquiry: { id: "old-a", detailLoading: true },
  });
  page.setData = next => Object.assign(page.data, next);

  page.onShow();

  assert.equal(page.data.deviceId, "station-b");
  assert.equal(page.data.inquiryGroups.length, 0);
  assert.equal(page.data.initialLoading, true);
  assert.equal(page.data.hasLoaded, false);
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.stale, false);
  assert.equal(page.data.processVisible, false);
  assert.equal(page.data.activeInquiry, null);
  assert.deepEqual(readScopes, ["station-b"]);

  resolveSnapshot({ inquiries: [{ id: "new-b" }], commands: [], serviceUsers: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.inquiryGroups[0].inquiries[0].id, "new-b");
});

test("the inquiry tab waits for cold-start device authorization before reading a scope", async () => {
  const session = deferred();
  const app = {
    globalData: { deviceId: "", deviceSessionResolved: false },
    waitForDeviceSession: () => session.promise,
  };
  const page = loadInquiryPage({}, {}, app);
  page.data = Object.assign({}, page.data);
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  let subscriptions = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => { subscriptions += 1; };

  const showing = page.onShow();
  assert.equal(loads, 0);
  app.globalData.deviceId = "authorized-box";
  app.globalData.deviceSessionResolved = true;
  session.resolve({ availability: "ready" });
  await showing;

  assert.equal(loads, 1);
  assert.equal(subscriptions, 1);
  assert.equal(page.data.deviceId, "authorized-box");
});

test("a late inquiry-tab success from the previous medication box is discarded", async () => {
  const app = { globalData: { deviceId: "station-a" } };
  let resolveA;
  const page = loadInquiryPage({
    getSnapshotStrict: ({ deviceId }) => {
      if (deviceId === "station-a") return new Promise(resolve => { resolveA = resolve; });
      return Promise.resolve({ inquiries: [{ id: "new-b" }], commands: [], serviceUsers: [] });
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => rows.length ? [{ personKey: rows[0].id, inquiries: rows }] : [],
  }, {}, app);
  page.data = Object.assign({}, page.data, { deviceId: "station-a" });
  page.setData = next => Object.assign(page.data, next);

  const oldRead = page.load();
  app.globalData.deviceId = "station-b";
  await page.onShow();
  resolveA({ inquiries: [{ id: "late-a" }], commands: [], serviceUsers: [] });
  await oldRead;

  assert.equal(page.data.deviceId, "station-b");
  assert.deepEqual(Array.from(page.data.inquiryGroups[0].inquiries, item => item.id), ["new-b"]);
  assert.equal(page.data.stale, false);
  assert.equal(page.data.loadError, "");
});

test("a late inquiry-tab failure from the previous medication box cannot mark the new box stale", async () => {
  const app = { globalData: { deviceId: "station-a" } };
  let rejectA;
  const page = loadInquiryPage({
    getSnapshotStrict: ({ deviceId }) => {
      if (deviceId === "station-a") {
        return new Promise((resolve, reject) => { rejectA = reject; });
      }
      return Promise.resolve({ inquiries: [{ id: "new-b" }], commands: [], serviceUsers: [] });
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => rows.length ? [{ personKey: rows[0].id, inquiries: rows }] : [],
  }, {}, app);
  page.data = Object.assign({}, page.data, { deviceId: "station-a", hasLoaded: true });
  page.setData = next => Object.assign(page.data, next);

  const oldRead = page.load();
  app.globalData.deviceId = "station-b";
  await page.onShow();
  rejectA(new Error("late station-a failure"));
  await oldRead;

  assert.equal(page.data.deviceId, "station-b");
  assert.deepEqual(Array.from(page.data.inquiryGroups[0].inquiries, item => item.id), ["new-b"]);
  assert.equal(page.data.stale, false);
  assert.equal(page.data.loadError, "");
});

test("inquiry history clears the previous medication box before its scoped 60-row read completes", async () => {
  const app = { globalData: { deviceId: "station-history-b" } };
  const readOptions = [];
  let resolveSnapshot;
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: options => {
      readOptions.push(options);
      return new Promise(resolve => { resolveSnapshot = resolve; });
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => rows.length ? [{ personKey: "b", inquiries: rows }] : [],
  }, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-history-a",
    inquiryGroups: [{ personKey: "a", inquiries: [{ id: "old-history-a" }] }],
    initialLoading: false,
    hasLoaded: true,
    loadError: "old history error",
    stale: true,
    processVisible: true,
    activeInquiry: { id: "old-history-a", detailLoading: true },
  });
  page.setData = next => Object.assign(page.data, next);

  page.onShow();

  assert.equal(page.data.deviceId, "station-history-b");
  assert.equal(page.data.inquiryGroups.length, 0);
  assert.equal(page.data.initialLoading, true);
  assert.equal(page.data.hasLoaded, false);
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.stale, false);
  assert.equal(page.data.processVisible, false);
  assert.equal(page.data.activeInquiry, null);
  assert.equal(readOptions.length, 1);
  assert.equal(readOptions[0].deviceId, "station-history-b");
  assert.equal(readOptions[0].inquiryLimit, 60);

  resolveSnapshot({ inquiries: [{ id: "new-history-b" }], commands: [], serviceUsers: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.inquiryGroups[0].inquiries[0].id, "new-history-b");
});

test("late inquiry-history success from the previous medication box is discarded", async () => {
  const app = { globalData: { deviceId: "station-history-a" } };
  let resolveA;
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: ({ deviceId }) => {
      if (deviceId === "station-history-a") return new Promise(resolve => { resolveA = resolve; });
      return Promise.resolve({ inquiries: [{ id: "history-b" }], commands: [], serviceUsers: [] });
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => rows.length ? [{ personKey: rows[0].id, inquiries: rows }] : [],
  }, app);
  page.data = Object.assign({}, page.data, { deviceId: "station-history-a" });
  page.setData = next => Object.assign(page.data, next);

  const oldRead = page.load();
  app.globalData.deviceId = "station-history-b";
  await page.onShow();
  resolveA({ inquiries: [{ id: "late-history-a" }], commands: [], serviceUsers: [] });
  await oldRead;

  assert.equal(page.data.deviceId, "station-history-b");
  assert.deepEqual(Array.from(page.data.inquiryGroups[0].inquiries, item => item.id), ["history-b"]);
  assert.equal(page.data.stale, false);
  assert.equal(page.data.loadError, "");
});

test("late inquiry-history failure from the previous medication box cannot mark the new box stale", async () => {
  const app = { globalData: { deviceId: "station-history-a" } };
  let rejectA;
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: ({ deviceId }) => {
      if (deviceId === "station-history-a") {
        return new Promise((resolve, reject) => { rejectA = reject; });
      }
      return Promise.resolve({ inquiries: [{ id: "history-b" }], commands: [], serviceUsers: [] });
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => rows.length ? [{ personKey: rows[0].id, inquiries: rows }] : [],
  }, app);
  page.data = Object.assign({}, page.data, { deviceId: "station-history-a", hasLoaded: true });
  page.setData = next => Object.assign(page.data, next);

  const oldRead = page.load();
  app.globalData.deviceId = "station-history-b";
  await page.onShow();
  rejectA(new Error("late station-history-a failure"));
  await oldRead;

  assert.equal(page.data.deviceId, "station-history-b");
  assert.deepEqual(Array.from(page.data.inquiryGroups[0].inquiries, item => item.id), ["history-b"]);
  assert.equal(page.data.stale, false);
  assert.equal(page.data.loadError, "");
});

test("the inquiry tab reads a process from the medication box shown by the page", async () => {
  const app = { globalData: { deviceId: "station-detail-a" } };
  let detailDeviceId = "";
  const page = loadInquiryPage({
    getInquiryDetail: async (record, options) => {
      detailDeviceId = options && options.deviceId;
      return {
        id: record.id,
        messages: [{ id: "turn-a", role: "assistant", content: "detail from A" }],
      };
    },
  }, {}, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-detail-a",
    inquiryGroups: [{ inquiries: [{ id: "detail-a", conversationReady: true }] }],
  });
  page.setData = next => Object.assign(page.data, next);

  await page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });

  assert.equal(detailDeviceId, "station-detail-a");
  assert.equal(page.data.activeInquiry.messages[0].content, "detail from A");
});

test("inquiry history reads a process from the medication box shown by the page", async () => {
  const app = { globalData: { deviceId: "station-history-detail-a" } };
  let detailDeviceId = "";
  const page = loadInquiryHistoryPage({
    getInquiryDetail: async (record, options) => {
      detailDeviceId = options && options.deviceId;
      return {
        id: record.id,
        messages: [{ id: "history-turn-a", role: "assistant", content: "history detail from A" }],
      };
    },
  }, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-history-detail-a",
    inquiryGroups: [{ inquiries: [{ id: "history-detail-a", conversationReady: true }] }],
  });
  page.setData = next => Object.assign(page.data, next);

  await page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });

  assert.equal(detailDeviceId, "station-history-detail-a");
  assert.equal(page.data.activeInquiry.messages[0].content, "history detail from A");
});

test("a late inquiry-tab process cannot reopen after the medication box changes", async () => {
  const app = { globalData: { deviceId: "station-detail-a" } };
  let resolveDetailA;
  const page = loadInquiryPage({
    getSnapshotStrict: async () => ({ inquiries: [], commands: [], serviceUsers: [] }),
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: () => [],
    getInquiryDetail: () => new Promise(resolve => { resolveDetailA = resolve; }),
  }, {}, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-detail-a",
    hasLoaded: true,
    inquiryGroups: [{ inquiries: [{ id: "detail-a", conversationReady: true }] }],
  });
  page.setData = next => Object.assign(page.data, next);

  const oldDetail = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });
  app.globalData.deviceId = "station-detail-b";
  await page.onShow();
  resolveDetailA({
    id: "detail-a",
    messages: [{ id: "late-a", role: "assistant", content: "late detail from A" }],
  });
  await oldDetail;

  assert.equal(page.data.deviceId, "station-detail-b");
  assert.equal(page.data.processVisible, false);
  assert.equal(page.data.activeInquiry, null);
  assert.equal(page.data.inquiryGroups.length, 0);
});

test("a late inquiry-tab process cannot replace the detail selected afterward", async () => {
  const app = { globalData: { deviceId: "station-detail" } };
  const resolvers = {};
  const page = loadInquiryPage({
    getInquiryDetail: record => new Promise(resolve => { resolvers[record.id] = resolve; }),
  }, {}, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-detail",
    inquiryGroups: [{ inquiries: [
      { id: "detail-first", conversationReady: true },
      { id: "detail-second", conversationReady: true },
    ] }],
  });
  page.setData = next => Object.assign(page.data, next);

  const first = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });
  const second = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 1 } } });
  resolvers["detail-second"]({
    id: "detail-second",
    messages: [{ id: "turn-second", role: "assistant", content: "second detail" }],
  });
  await second;
  resolvers["detail-first"]({
    id: "detail-first",
    messages: [{ id: "turn-first", role: "assistant", content: "late first detail" }],
  });
  await first;

  assert.equal(page.data.activeInquiry.id, "detail-second");
  assert.equal(page.data.activeInquiry.messages[0].content, "second detail");
});

test("a late inquiry-tab process failure cannot add an error to the detail selected afterward", async () => {
  const app = { globalData: { deviceId: "station-detail" } };
  const requests = {};
  const page = loadInquiryPage({
    getInquiryDetail: record => new Promise((resolve, reject) => { requests[record.id] = { resolve, reject }; }),
  }, {}, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-detail",
    inquiryGroups: [{ inquiries: [
      { id: "detail-first", conversationReady: true },
      { id: "detail-second", conversationReady: true },
    ] }],
  });
  page.setData = next => Object.assign(page.data, next);

  const first = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });
  const second = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 1 } } });
  requests["detail-second"].resolve({
    id: "detail-second",
    messages: [{ id: "turn-second", role: "assistant", content: "second detail" }],
  });
  await second;
  requests["detail-first"].reject(new Error("late first failure"));
  await first;

  assert.equal(page.data.activeInquiry.id, "detail-second");
  assert.equal(page.data.activeInquiry.processError, "");
  assert.equal(page.data.activeInquiry.messages[0].content, "second detail");
});

test("a late inquiry-history process cannot reopen after the medication box changes", async () => {
  const app = { globalData: { deviceId: "station-history-detail-a" } };
  let resolveDetailA;
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: async () => ({ inquiries: [], commands: [], serviceUsers: [] }),
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: () => [],
    getInquiryDetail: () => new Promise(resolve => { resolveDetailA = resolve; }),
  }, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-history-detail-a",
    hasLoaded: true,
    inquiryGroups: [{ inquiries: [{ id: "history-detail-a", conversationReady: true }] }],
  });
  page.setData = next => Object.assign(page.data, next);

  const oldDetail = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });
  app.globalData.deviceId = "station-history-detail-b";
  await page.onShow();
  resolveDetailA({
    id: "history-detail-a",
    messages: [{ id: "late-history-a", role: "assistant", content: "late history detail from A" }],
  });
  await oldDetail;

  assert.equal(page.data.deviceId, "station-history-detail-b");
  assert.equal(page.data.processVisible, false);
  assert.equal(page.data.activeInquiry, null);
  assert.equal(page.data.inquiryGroups.length, 0);
});

test("a late inquiry-history process cannot replace the detail selected afterward", async () => {
  const app = { globalData: { deviceId: "station-history-detail" } };
  const resolvers = {};
  const page = loadInquiryHistoryPage({
    getInquiryDetail: record => new Promise(resolve => { resolvers[record.id] = resolve; }),
  }, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-history-detail",
    inquiryGroups: [{ inquiries: [
      { id: "history-detail-first", conversationReady: true },
      { id: "history-detail-second", conversationReady: true },
    ] }],
  });
  page.setData = next => Object.assign(page.data, next);

  const first = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });
  const second = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 1 } } });
  resolvers["history-detail-second"]({
    id: "history-detail-second",
    messages: [{ id: "history-turn-second", role: "assistant", content: "history second detail" }],
  });
  await second;
  resolvers["history-detail-first"]({
    id: "history-detail-first",
    messages: [{ id: "history-turn-first", role: "assistant", content: "late history first detail" }],
  });
  await first;

  assert.equal(page.data.activeInquiry.id, "history-detail-second");
  assert.equal(page.data.activeInquiry.messages[0].content, "history second detail");
});

test("a late inquiry-history failure cannot add an error to the detail selected afterward", async () => {
  const app = { globalData: { deviceId: "station-history-detail" } };
  const requests = {};
  const page = loadInquiryHistoryPage({
    getInquiryDetail: record => new Promise((resolve, reject) => { requests[record.id] = { resolve, reject }; }),
  }, app);
  page.data = Object.assign({}, page.data, {
    deviceId: "station-history-detail",
    inquiryGroups: [{ inquiries: [
      { id: "history-detail-first", conversationReady: true },
      { id: "history-detail-second", conversationReady: true },
    ] }],
  });
  page.setData = next => Object.assign(page.data, next);

  const first = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });
  const second = page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 1 } } });
  requests["history-detail-second"].resolve({
    id: "history-detail-second",
    messages: [{ id: "history-turn-second", role: "assistant", content: "history second detail" }],
  });
  await second;
  requests["history-detail-first"].reject(new Error("late history first failure"));
  await first;

  assert.equal(page.data.activeInquiry.id, "history-detail-second");
  assert.equal(page.data.activeInquiry.processError, "");
  assert.equal(page.data.activeInquiry.messages[0].content, "history second detail");
});

test("the inquiry detail API honors an explicit medication-box scope even after the active binding changes", async () => {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  const cloudScopes = [];
  global.getApp = () => ({ globalData: { deviceId: "station-current-b" } });
  global.wx = {
    cloud: {
      callFunction: async ({ data }) => {
        cloudScopes.push(data.data.deviceId);
        return {
          result: {
            inquiry_id: "explicit-detail-a",
            messages: [{ id: "explicit-turn-a", role: "assistant", content: "explicit A detail" }],
          },
        };
      },
    },
  };

  try {
    const detail = await inquiryApi.getInquiryDetail(
      { id: "explicit-detail-a", inquiryId: "explicit-detail-a" },
      { deviceId: "station-explicit-a" },
    );

    assert.deepEqual(cloudScopes, ["station-explicit-a"]);
    assert.equal(detail.messages[0].content, "explicit A detail");
  } finally {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
});

test("an available inquiry process is loaded on demand while keeping saved inquiry details visible", async () => {
  const template = fs.readFileSync(templatePath, "utf8");
  assert.match(template, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/);
  assert.match(template, /activeInquiry\.detailLines/);
  assert.match(template, /activeInquiry\.messages/);
  assert.match(template, /activeInquiry\.processError/);
  assert.doesNotMatch(template, /bindtap="viewInquiryProcess"|<app-header/);
  assert.doesNotMatch(template, /inquiry-intro/);
  assert.doesNotMatch(template, /先看风险，再安排下一步/);
  assert.doesNotMatch(template, /未关联成员/);

  let detailRequests = 0;
  const page = loadInquiryPage({
    getInquiryDetail: async () => {
      detailRequests += 1;
      return {
        id: "inquiry-1",
        messages: [{ id: "message-1", role: "assistant", roleText: "AI 回复", content: "请补充是否发热。" }],
        conversationReady: true,
      };
    },
  });
  page.data = {
    inquiryGroups: [{
      inquiries: [{
        id: "inquiry-1",
        personName: "妈妈",
        topic: "头痛",
        summary: "已建议先观察症状并补充水分。",
        detailLines: [{ label: "风险提示", value: "暂无紧急风险" }],
        conversationReady: true,
      }],
    }],
  };
  page.setData = next => Object.assign(page.data, next);

  await page.onCarePageAction({
    detail: {
      id: "inquiry.open.0.0",
      payload: { groupIndex: 0, recordIndex: 0 },
    },
  });

  assert.equal(detailRequests, 1);
  assert.equal(page.data.processVisible, true);
  assert.equal(page.data.activeInquiry.id, "inquiry-1");
  assert.equal(page.data.activeInquiry.summary, "已建议先观察症状并补充水分。");
  assert.equal(page.data.activeInquiry.messages[0].content, "请补充是否发热。");

  page.closeInquiryProcess();
  assert.equal(page.data.processVisible, false);
  assert.equal(page.data.activeInquiry, null);
});

test("a summary without a synchronized process opens without a detail request", async () => {
  let detailRequests = 0;
  const page = loadInquiryPage({
    getInquiryDetail: async () => {
      detailRequests += 1;
      return null;
    },
  });
  page.data = {
    inquiryGroups: [{
      inquiries: [{
        id: "inquiry-summary-only",
        personName: "妈妈",
        topic: "头痛",
        summary: "建议观察。",
        detailLines: [],
        conversationReady: false,
      }],
    }],
  };
  page.setData = next => Object.assign(page.data, next);

  await page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });

  assert.equal(detailRequests, 0);
  assert.equal(page.data.processVisible, true);
  assert.equal(page.data.activeInquiry.processUnavailable, false);
});

test("inquiry pages keep compact chrome and resilient process bubbles", () => {
  const templates = [templatePath, historyTemplatePath].map(file => fs.readFileSync(file, "utf8"));
  templates.forEach(template => {
    assert.doesNotMatch(template, /\bsubtitle=/);
    assert.doesNotMatch(template, /inquiry-sheet-subtitle/);
    assert.doesNotMatch(template, /activeInquiry\.personName\}\}\s*·\s*\{\{activeInquiry\.topic/);
    assert.doesNotMatch(template, /inquiry-summary-block/);
    assert.doesNotMatch(template, /inquiry-sheet-risk/);
    assert.doesNotMatch(template, /activeInquiry\.processUnavailable/);
    assert.match(template, /activeInquiry\.detailLines/);
    assert.match(template, /activeInquiry\.messages/);
  });

  assert.doesNotMatch(templates[0], /inquiry-overview-head/);
  assert.doesNotMatch(templates[1], /inquiry-history-note/);

  const pageStyles = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/ai/index.wxss"), "utf8");
  const historyStyles = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/ai/history/index.wxss"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../miniprogram/styles/inquiry-detail.wxss"), "utf8");
  assert.match(pageStyles, /@import "\.\.\/\.\.\/styles\/inquiry-detail\.wxss"/);
  assert.match(historyStyles, /@import "\.\.\/\.\.\/\.\.\/styles\/inquiry-detail\.wxss"/);
  assert.match(styles, /\.inquiry-sheet\s*\{[\s\S]*?height:\s*82vh;[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.match(styles, /\.inquiry-sheet-scroll\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?flex:\s*1;/);
  assert.match(styles, /\.inquiry-message\s*\{[\s\S]*?max-width:\s*calc\(100%\s*-\s*12rpx\);[\s\S]*?box-sizing:\s*border-box;/);
  assert.match(styles, /\.inquiry-message__text\s*\{[\s\S]*?word-break:\s*break-all;/);
  assert.doesNotMatch(styles, /font-size:\s*(?:1\d|2[0-3])rpx/);
});

test("an empty detail response relabels the card as a summary after the first read", async () => {
  const page = loadInquiryPage({
    getInquiryDetail: async () => ({
      id: "inquiry-empty-detail",
      messages: [],
    }),
  });
  page.data = {
    inquiryGroups: [{
      inquiries: [{
        id: "inquiry-empty-detail",
        personName: "member",
        topic: "cough",
        summary: "Saved care summary.",
        detailLines: [],
        conversationReady: true,
      }],
    }],
  };
  page.setData = next => Object.assign(page.data, next);

  await page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 0, recordIndex: 0 } } });

  assert.equal(page.data.activeInquiry.processUnavailable, true);
  assert.equal(page.data.activeInquiry.conversationReady, false);
  assert.equal(page.data.inquiryGroups[0].inquiries[0].conversationReady, false);
});

test("the inquiry page omits unfinished dialogues before grouping summaries", async () => {
  const page = loadInquiryPage({
    getSnapshot: async () => ({
      inquiries: [
        {
          id: "inquiry-finished",
          personName: "妈妈",
          topic: "已完成的问询",
          summary: "已经形成照护建议。",
          stage: "result",
          nextAction: "show_recommendation",
          caregiverVisible: true,
        },
        {
          id: "inquiry-progress",
          personName: "妈妈",
          topic: "持续咳嗽",
          summary: "已保存目前的症状信息。",
          stage: "clarification",
          nextAction: "ask",
          caregiverVisible: false,
        },
        {
          id: "visitor-progress",
          personName: "访客",
          topic: "新问询",
          stage: "symptoms",
          nextAction: "ask",
          caregiverVisible: false,
        },
      ],
      commands: [],
    }),
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: item => item.caregiverVisible === true,
    groupInquiriesByPerson: rows => rows.length ? [{
      personKey: "member-1",
      personName: "妈妈",
      inquiries: rows,
    }] : [],
  });
  page.data = { inquiryGroups: [] };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(
    page.data.inquiryGroups[0].inquiries.map(item => item.topic),
    ["已完成的问询"],
  );
});

test("the inquiry tab omits summaries for an archived persona generation", async () => {
  const page = loadInquiryPage({
    getSnapshotStrict: async () => ({
      serviceUsers: [
        { id: "member-rebuilt", personaGeneration: "generation-v1", archived: true },
        { id: "member-rebuilt", personaGeneration: "generation-v2", archived: false },
      ],
      inquiries: [
        {
          inquiry_id: "archived-inquiry",
          service_user_id: "member-rebuilt",
          persona_generation: "generation-v1",
          stage: "result",
          next_action: "complete",
          updated_at: "2026-08-08 09:00:00",
        },
        {
          inquiry_id: "active-inquiry",
          service_user_id: "member-rebuilt",
          persona_generation: "generation-v2",
          stage: "result",
          next_action: "complete",
          updated_at: "2026-08-09 09:00:00",
        },
      ],
      commands: [],
    }),
    inquiryFromAiCommand: inquiryApi.inquiryFromAiCommand,
    mergeInquirySources: inquiryApi.mergeInquirySources,
    shouldShowCaregiverInquiry: inquiryApi.shouldShowCaregiverInquiry,
    shouldShowInquiryForServiceUsers: inquiryApi.shouldShowInquiryForServiceUsers,
    groupInquiriesByPerson: inquiryApi.groupInquiriesByPerson,
  });
  page.data = { inquiryGroups: [], initialLoading: true, hasLoaded: false, loadError: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(
    Array.from(page.data.inquiryGroups.flatMap(group => group.inquiries), item => item.id),
    ["active-inquiry"],
  );
});

test("the inquiry tab keeps the five globally most recent summaries before grouping and routes to history", async () => {
  let route = "";
  let groupedIds = [];
  const page = loadInquiryPage({
    getSnapshot: async () => ({
      inquiries: [
        { id: "dad-older", personKey: "dad", personName: "爸爸", topic: "较早腹痛", createdAt: "2026-08-08 10:00:00" },
        { id: "mom-latest", personKey: "mom", personName: "妈妈", topic: "最近头痛", createdAt: "2026-08-08 10:05:00" },
        { id: "visitor-recent", personKey: "visitor", personName: "访客", topic: "访客咨询", createdAt: "2026-08-08 10:01:00" },
        { id: "mom-earlier", personKey: "mom", personName: "妈妈", topic: "之前咳嗽", createdAt: "2026-08-08 10:02:00" },
        { id: "dad-latest", personKey: "dad", personName: "爸爸", topic: "最近发热", createdAt: "2026-08-08 10:04:00" },
        { id: "grandma-recent", personKey: "grandma", personName: "奶奶", topic: "最近血压", createdAt: "2026-08-08 10:03:00" },
      ],
      commands: [],
    }),
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => {
      groupedIds = rows.map(item => item.id);
      const groups = new Map();
      rows.forEach(record => {
        const key = record.personKey;
        if (!groups.has(key)) {
          groups.set(key, {
            personKey: key,
            personName: record.personName,
            inquiries: [],
          });
        }
        groups.get(key).inquiries.push(record);
      });
      return Array.from(groups.values());
    },
  }, {
    navigateTo({ url }) {
      route = url;
    },
  });
  page.data = { inquiryGroups: [], initialLoading: true, hasLoaded: false, loadError: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(groupedIds, ["mom-latest", "dad-latest", "grandma-recent", "mom-earlier", "visitor-recent"]);
  assert.deepEqual(page.data.inquiryGroups.map(group => group.personName), ["妈妈", "爸爸", "奶奶", "访客"]);
  assert.deepEqual(
    page.data.inquiryGroups.map(group => group.inquiries.map(record => record.id)),
    [["mom-latest", "mom-earlier"], ["dad-latest"], ["grandma-recent"], ["visitor-recent"]],
  );
  assert.deepEqual(
    page.data.inquiryGroups.map(group => group.countLabel),
    ["最近 2 条", "最近 1 条", "最近 1 条", "最近 1 条"],
  );

  assert.equal(page.data.carePage.detailAction.id, "inquiry.history");
  await page.onCarePageAction({ detail: { id: "inquiry.history", payload: {} } });
  assert.equal(route, "/pages/ai/history/index");

  const template = fs.readFileSync(templatePath, "utf8");
  assert.match(template, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/);
  assert.doesNotMatch(template, /inquiry-history-entry|wx:for="\{\{inquiryGroups\}\}"/);
});

test("the inquiry tab fills a single person's compact view with up to five recent summaries", async () => {
  const page = loadInquiryPage({
    getSnapshot: async () => ({
      inquiries: [
        { id: "mom-1", topic: "最近头痛" },
        { id: "mom-2", topic: "之前咳嗽" },
        { id: "mom-3", topic: "血压记录" },
        { id: "mom-4", topic: "睡眠情况" },
        { id: "mom-5", topic: "更早的记录" },
        { id: "mom-6", topic: "更早之前的记录" },
      ],
      commands: [],
    }),
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => [{
      personKey: "mom",
      personName: "妈妈",
      inquiries: rows,
    }],
  });
  page.data = { inquiryGroups: [], initialLoading: true, hasLoaded: false, loadError: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(
    page.data.inquiryGroups[0].inquiries.map(record => record.id),
    ["mom-1", "mom-2", "mom-3", "mom-4", "mom-5"],
  );
  assert.equal(page.data.inquiryGroups[0].countLabel, "最近 5 条");
  assert.equal(page.data.carePage.focus.title, "最近头痛");
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.id, "inquiry.open.0.0");
  assert.equal(page.data.carePage.focus.action.payload.recordIndex, 0);
  assert.equal(page.data.carePage.detailAction.id, "inquiry.history");
  assert.equal(page.data.carePage.sections[0].items.length, 4);
});

test("inquiry summaries keep advice and progress in the on-demand detail sheet", () => {
  const template = fs.readFileSync(templatePath, "utf8");
  const historyTemplate = fs.readFileSync(historyTemplatePath, "utf8");

  assert.match(template, /<care-screen model="\{\{carePage\}\}"/);
  assert.doesNotMatch(template, /\{\{record\.(?:topic|riskLabel|summary|progressLabel)\}\}/);
  for (const source of [template, historyTemplate]) {
    assert.match(source, /class="ui-sheet-title">问询详情</);
    assert.match(source, /class="ui-kicker[^"]*">问询摘要</);
    assert.match(source, /activeInquiry\.detailLines/);
    assert.match(source, /activeInquiry\.progressLabel/);
  }

  assert.match(historyTemplate, /\{\{record\.topic\}\}/);
  assert.match(historyTemplate, /\{\{record\.riskLabel\}\}/);
  assert.match(historyTemplate, /\{\{record\.summary\}\}/);
  assert.match(historyTemplate, /查看详情/);

  const styles = fs.readFileSync(path.join(__dirname, "../miniprogram/styles/inquiry-detail.wxss"), "utf8");
  assert.match(styles, /\.inquiry-card__summary\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
});

test("the inquiry page keeps an initial loading state until summaries arrive", async () => {
  let resolveSnapshot;
  const page = loadInquiryPage({
    getSnapshot: () => new Promise(resolve => { resolveSnapshot = resolve; }),
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: () => [],
  });
  page.data = {
    inquiryGroups: [],
    initialLoading: true,
    hasLoaded: false,
    loadError: "",
  };
  page.setData = next => Object.assign(page.data, next);

  const loading = page.load();
  assert.equal(page.data.initialLoading, true);
  assert.equal(page.data.carePage.phase.kind, "loading");

  resolveSnapshot({ inquiries: [], commands: [] });
  await loading;

  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.hasLoaded, true);
  assert.equal(page.data.carePage.phase.kind, "empty");
});

test("the inquiry page uses the strict snapshot reader and exposes an initial read failure", async () => {
  let strictReads = 0;
  let compatibilityReads = 0;
  let unavailable = true;
  const page = loadInquiryPage({
    getSnapshotStrict: async () => {
      strictReads += 1;
      if (unavailable) throw new Error("snapshot unavailable");
      return { inquiries: [], commands: [] };
    },
    getSnapshot: async () => {
      compatibilityReads += 1;
      return { inquiries: [], commands: [] };
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: () => [],
  });
  page.data = {
    inquiryGroups: [],
    initialLoading: true,
    hasLoaded: false,
    loadError: "",
  };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(strictReads, 1);
  assert.equal(compatibilityReads, 0);
  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.hasLoaded, false);
  assert.equal(page.data.carePage.phase.kind, "error");
  assert.match(page.data.carePage.phase.message, /暂未同步|刷新/);
  assert.equal(page.data.carePage.phase.action.id, "inquiry.retry");

  unavailable = false;
  await page.onCarePageAction({ detail: page.data.carePage.phase.action });

  assert.equal(strictReads, 2);
  assert.equal(page.data.hasLoaded, true);
  assert.equal(page.data.carePage.phase.kind, "empty");
});

test("the inquiry page keeps its summaries and marks them stale when a background refresh fails", async () => {
  let refreshFails = false;
  const page = loadInquiryPage({
    getSnapshotStrict: async () => {
      if (refreshFails) throw new Error("refresh unavailable");
      return {
        inquiries: [{ id: "saved", topic: "已保存问询", summary: "已形成照护建议" }],
        commands: [],
      };
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => [{
      personKey: "member-1",
      personName: "妈妈",
      inquiries: rows,
    }],
  });
  page.data = {
    inquiryGroups: [],
    initialLoading: true,
    hasLoaded: false,
    loadError: "",
    stale: false,
  };
  page.setData = next => Object.assign(page.data, next);

  await page.load();
  refreshFails = true;
  await page.load();

  assert.equal(page.data.stale, true);
  assert.equal(page.data.inquiryGroups[0].inquiries[0].id, "saved");
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.match(page.data.carePage.focus.supporting, /已保存/);
});

test("the inquiry history uses the strict snapshot reader and does not present a failed read as empty", async () => {
  let strictReads = 0;
  let compatibilityReads = 0;
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: async () => {
      strictReads += 1;
      throw new Error("history unavailable");
    },
    getSnapshot: async () => {
      compatibilityReads += 1;
      return { inquiries: [], commands: [] };
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: () => [],
  });
  page.data = {
    inquiryGroups: [],
    initialLoading: true,
    hasLoaded: false,
    loadError: "",
  };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(strictReads, 1);
  assert.equal(compatibilityReads, 0);
  assert.equal(page.data.initialLoading, false);
  assert.equal(page.data.hasLoaded, false);
  assert.match(page.data.loadError, /暂未同步|刷新/);
  assert.deepEqual(page.data.inquiryGroups, []);
});

test("inquiry history retries its failed first snapshot through a CarePage phase action", async () => {
  let failRead = true;
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: async () => {
      if (failRead) throw new Error("history unavailable");
      return { inquiries: [], commands: [], serviceUsers: [] };
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowInquiryForServiceUsers: () => true,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: () => [],
  });
  page.data = Object.assign({}, page.data);
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "error");
  assert.equal(page.data.carePage.phase.action.id, "inquiry.history.retry");
  failRead = false;

  const retrying = page.onCarePageAction({ detail: page.data.carePage.phase.action });

  assert.equal(page.data.carePage.phase.kind, "loading");
  await retrying;
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.hasLoaded, true);

  const template = fs.readFileSync(historyTemplatePath, "utf8");
  const config = JSON.parse(fs.readFileSync(historyConfigPath, "utf8"));
  assert.match(template, /<care-screen\s+wx:if="\{\{loadError\}\}"\s+model="\{\{carePage\}\}"\s+bind:action="onCarePageAction"\s*\/>/);
  assert.doesNotMatch(template, /bindtap="retryInquiryHistory"/);
  assert.equal(config.usingComponents["care-screen"], "/components/careScreen/index");
});

test("the inquiry history preserves loaded groups as stale after a background refresh failure", async () => {
  let refreshFails = false;
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: async () => {
      if (refreshFails) throw new Error("history refresh unavailable");
      return { inquiries: [{ id: "saved-history" }], commands: [] };
    },
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => [{
      personKey: "member-1",
      personName: "妈妈",
      inquiries: rows,
    }],
  });
  page.data = {
    inquiryGroups: [],
    initialLoading: true,
    hasLoaded: false,
    loadError: "",
    stale: false,
  };
  page.setData = next => Object.assign(page.data, next);

  await page.load();
  refreshFails = true;
  await page.load();

  assert.equal(page.data.stale, true);
  assert.equal(page.data.loadError, "");
  assert.equal(page.data.inquiryGroups[0].inquiries[0].id, "saved-history");
});

test("the full inquiry history omits archived persona generations by default", async () => {
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: async () => ({
      serviceUsers: [
        { id: "member-rebuilt", personaGeneration: "generation-v1", archived: true },
        { id: "member-rebuilt", personaGeneration: "generation-v2", archived: false },
      ],
      inquiries: [
        {
          inquiry_id: "archived-history",
          service_user_id: "member-rebuilt",
          persona_generation: "generation-v1",
          stage: "result",
          next_action: "complete",
        },
        {
          inquiry_id: "active-history",
          service_user_id: "member-rebuilt",
          persona_generation: "generation-v2",
          stage: "result",
          next_action: "complete",
        },
      ],
      commands: [],
    }),
    inquiryFromAiCommand: inquiryApi.inquiryFromAiCommand,
    mergeInquirySources: inquiryApi.mergeInquirySources,
    shouldShowCaregiverInquiry: inquiryApi.shouldShowCaregiverInquiry,
    shouldShowInquiryForServiceUsers: inquiryApi.shouldShowInquiryForServiceUsers,
    groupInquiriesByPerson: inquiryApi.groupInquiriesByPerson,
    inquiryMatchesPersonScope: inquiryApi.inquiryMatchesPersonScope,
  });
  page.data = Object.assign({}, page.data);
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(
    Array.from(page.data.inquiryGroups.flatMap(group => group.inquiries), item => item.id),
    ["active-history"],
  );
});

test("persona lifecycle strict snapshots hide orphan inquiries while retaining true guests", async () => {
  const app = {
    globalData: {
      deviceId: "strict-box",
      deviceSession: { capabilities: { personaLifecycle: "v1" } },
    },
  };
  const snapshot = {
    serviceUsersSnapshotComplete: true,
    serviceUsers: [{ id: "member-1", personaGeneration: "v2", archived: false }],
    commands: [],
    inquiries: [{ id: "active", personId: "member-1", personaGeneration: "v2", status: "done" }, {
      id: "orphan",
      personId: "removed-person",
      personaGeneration: "v1",
      status: "done",
    }, {
      id: "guest",
      guest_name: "临时访客",
      status: "done",
    }],
  };
  const gateway = {
    getSnapshotStrict: async () => snapshot,
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowInquiryForServiceUsers: () => true,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => [{ personKey: "all", personName: "全部", inquiries: rows }],
  };

  for (const page of [loadInquiryPage(Object.assign({}, gateway), {}, app), loadInquiryHistoryPage(Object.assign({}, gateway), app)]) {
    page.data = Object.assign({}, page.data, { deviceId: "strict-box" });
    page.setData = next => Object.assign(page.data, next);
    await page.load();
    const ids = page.data.inquiryGroups.flatMap(group => group.inquiries.map(item => item.id));
    assert.deepEqual(Array.from(ids), ["active", "guest"]);
  }
});

test("persona lifecycle capability without a complete snapshot keeps legacy orphan visibility", async () => {
  const app = {
    globalData: {
      deviceId: "incomplete-box",
      deviceSession: { capabilities: { personaLifecycle: "v1" } },
    },
  };
  const page = loadInquiryPage({
    getSnapshotStrict: async () => ({
      serviceUsersSnapshotComplete: false,
      serviceUsers: [],
      commands: [],
      inquiries: [{ id: "legacy-orphan", personId: "unknown", personaGeneration: "v1", status: "done" }],
    }),
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowInquiryForServiceUsers: () => true,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: rows => [{ personKey: "all", personName: "全部", inquiries: rows }],
  }, {}, app);
  page.data = Object.assign({}, page.data, { deviceId: "incomplete-box" });
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.inquiryGroups[0].inquiries[0].id, "legacy-orphan");
});

test("global and empty inquiry history states disclose the recent 60-row sync window", () => {
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: async () => ({ inquiries: [], commands: [] }),
  });
  const template = fs.readFileSync(historyTemplatePath, "utf8");

  assert.match(page.data.historyBoundaryText, /全设备最近 60 条同步窗口/);
  assert.match(template, /最近 60 条同步窗口内暂无已完成问询/);
});

test("the full inquiry history keeps every family group and opens the saved process", async () => {
  const template = fs.readFileSync(historyTemplatePath, "utf8");
  assert.match(template, /title="\{\{pageTitle\}\}"/);
  assert.match(template, /bindtap="viewInquiryProcess"/);
  assert.match(template, /activeInquiry\.messages/);

  let detailRequests = 0;
  const page = loadInquiryHistoryPage({
    getSnapshot: async () => ({ inquiries: [{ id: "loaded" }], commands: [] }),
    inquiryFromAiCommand: () => null,
    mergeInquirySources: rows => rows,
    shouldShowCaregiverInquiry: () => true,
    groupInquiriesByPerson: () => [
      {
        personKey: "mom",
        personName: "妈妈",
        inquiries: [{ id: "mom-latest", topic: "最近头痛" }, { id: "mom-earlier", topic: "之前咳嗽" }],
      },
      {
        personKey: "dad",
        personName: "爸爸",
        inquiries: [{ id: "dad-latest", topic: "最近发热" }, { id: "dad-earlier", topic: "之前腹痛", conversationReady: true }],
      },
      {
        personKey: "grandma",
        personName: "奶奶",
        inquiries: [{ id: "grandma-latest", topic: "最近血压" }],
      },
    ],
    getInquiryDetail: async () => {
      detailRequests += 1;
      return {
        id: "dad-earlier",
        messages: [{ id: "turn-1", role: "assistant", roleText: "AI 回复", content: "已保存过程" }],
      };
    },
  });
  page.data = { inquiryGroups: [], initialLoading: true, hasLoaded: false, loadError: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(page.data.inquiryGroups.map(group => group.personName), ["妈妈", "爸爸", "奶奶"]);
  assert.deepEqual(
    page.data.inquiryGroups[1].inquiries.map(record => record.id),
    ["dad-latest", "dad-earlier"],
  );

  await page.viewInquiryProcess({ currentTarget: { dataset: { groupIndex: 1, recordIndex: 1 } } });
  assert.equal(detailRequests, 1);
  assert.equal(page.data.processVisible, true);
  assert.equal(page.data.activeInquiry.messages[0].content, "已保存过程");
});

test("a family-card route shows only the stable person and persona generation in the synced history window", async () => {
  const page = loadInquiryHistoryPage({
    getSnapshotStrict: async () => ({
      inquiries: [
        {
          inquiry_id: "old-generation",
          service_user_id: "member-rebuilt",
          persona_generation: "generation-v1",
          display_name: "同名家人",
          stage: "result",
          next_action: "complete",
          updated_at: "2026-08-08 09:00:00",
        },
        {
          inquiry_id: "current-generation",
          service_user_id: "member-rebuilt",
          persona_generation: "generation-v2",
          display_name: "同名家人",
          stage: "result",
          next_action: "complete",
          updated_at: "2026-08-09 09:00:00",
        },
        {
          inquiry_id: "other-person",
          service_user_id: "member-other",
          persona_generation: "generation-v2",
          display_name: "另一位家人",
          stage: "result",
          next_action: "complete",
          updated_at: "2026-08-10 09:00:00",
        },
      ],
      commands: [],
    }),
    inquiryFromAiCommand: inquiryApi.inquiryFromAiCommand,
    mergeInquirySources: inquiryApi.mergeInquirySources,
    shouldShowCaregiverInquiry: inquiryApi.shouldShowCaregiverInquiry,
    groupInquiriesByPerson: inquiryApi.groupInquiriesByPerson,
    inquiryMatchesPersonScope: inquiryApi.inquiryMatchesPersonScope,
  });
  page.data = Object.assign({}, page.data);
  page.setData = next => Object.assign(page.data, next);

  page.onLoad({
    personId: "member-rebuilt",
    personaGeneration: "generation-v2",
    personName: "同名家人",
  });
  await page.load();

  assert.equal(page.data.pageTitle, "同名家人的近期问询");
  assert.equal(page.data.inquiryGroups.length, 1);
  assert.equal(page.data.inquiryGroups[0].personaGeneration, "generation-v2");
  assert.deepEqual(Array.from(page.data.inquiryGroups[0].inquiries, item => item.id), ["current-generation"]);
  assert.match(page.data.historyBoundaryText, /最近 60 条同步窗口/);
});
