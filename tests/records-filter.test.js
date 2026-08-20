const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/records/index.js");

function todayAt(time) {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${time}:00`;
}

function loadRecordsPage(apiOverrides = {}, context = {}) {
  let definition = null;
  const source = fs.readFileSync(pagePath, "utf8");
  const app = context.app || { globalData: {} };
  const api = Object.assign({
    getDevice: async () => ({}),
    getRecentRecords: async () => [],
    getRecentVitals: async () => [],
    normalizeVitals: item => item,
  }, apiOverrides);
  api.getRecentRecordsStrict = api.getRecentRecordsStrict || api.getRecentRecords;
  api.getRecentVitalsStrict = api.getRecentVitalsStrict || api.getRecentVitals;
  api.getSnapshotStrict = api.getSnapshotStrict || (async () => ({ serviceUsers: [] }));
  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(modulePath) {
      if (modulePath.includes("utils/api")) return api;
      if (modulePath.includes("utils/realtime")) return context.realtime || { subscribe: () => () => {} };
      if (modulePath.includes("utils/deviceSession")) {
        return context.deviceSession || { runAfterDeviceSessionReady: callback => callback() };
      }
      if (modulePath.includes("utils/carePage")) {
        return require(path.join(__dirname, "../miniprogram/utils/carePage"));
      }
      if (modulePath.includes("modules/medicationSafetyEvents")) {
        return require(path.join(__dirname, "../miniprogram/modules/medicationSafetyEvents"));
      }
      if (modulePath.includes("modules/vitalsAttribution")) {
        return require(path.join(__dirname, "../miniprogram/modules/vitalsAttribution"));
      }
      if (modulePath.includes("modules/personaVisibility")) {
        return require(path.join(__dirname, "../miniprogram/modules/personaVisibility"));
      }
      if (modulePath.includes("modules/capabilitySnapshot")) {
        return require(path.join(__dirname, "../miniprogram/modules/capabilitySnapshot"));
      }
      return {};
    },
    Date,
    getApp: () => app,
    wx: {
      showToast() {},
    },
  }, { filename: pagePath });
  definition.data = Object.assign({}, definition.data);
  definition.setData = next => Object.assign(definition.data, next);
  definition._testApp = app;
  return definition;
}

test("records presents canonical inquiry vitals through the exact active member identity", async () => {
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId, online: true }),
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [{
      recordId: "vitals-member",
      personId: "member-1",
      personName: "王奶奶",
      personaGeneration: "generation-2",
      inquirySessionId: "inquiry-1",
      attributionSource: "INQUIRY_SESSION",
      createdAt: todayAt("08:30"),
      heartRate: 72,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
    }],
    getSnapshotStrict: async () => ({
      serviceUsers: [{ id: "member-1", name: "当前王奶奶", personaGeneration: "generation-2" }],
      capabilities: { vitalsAttribution: "v1" },
    }),
    getCapabilitiesStrict: async () => {
      throw new Error("safety capability refresh unavailable");
    },
    getMedicationSafetyEventsStrict: async () => ({ items: [], nextCursor: "" }),
  });
  page._testApp.globalData.deviceId = "box-1";

  await page.load();

  assert.equal(page.data.vitalsRecords[0].person, "王奶奶");
  assert.equal(page.data.vitalsRecords[0].attributionKind, "MEMBER");
  assert.equal(page.data.vitalsRecords[0].canAttach, true);
});

test("records keeps broken, standalone, and legacy vitals distinct and exposes broken diagnostics", async () => {
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId, online: true }),
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [
      {
        recordId: "vitals-broken",
        personName: "王奶奶",
        personaGeneration: "generation-2",
        inquirySessionId: "inquiry-broken",
        attributionSource: "INQUIRY_SESSION",
        createdAt: todayAt("10:00"),
        heartRate: 73,
      },
      {
        recordId: "vitals-standalone",
        attributionSource: "STANDALONE",
        createdAt: todayAt("09:00"),
        heartRate: 72,
      },
      {
        recordId: "vitals-legacy",
        personName: "旧记录姓名",
        createdAt: todayAt("08:00"),
        heartRate: 71,
      },
    ],
    getSnapshotStrict: async () => ({
      serviceUsers: [{ id: "member-1", name: "王奶奶", personaGeneration: "generation-2" }],
      schemaRevision: "2.7-runtime-consistency",
      capabilities: { vitalsAttribution: "v1" },
    }),
    getCapabilitiesStrict: async () => ({
      schemaRevision: "2.7-runtime-consistency",
      capabilities: { medicationSafetyEvents: "v1", vitalsAttribution: "v1" },
    }),
    getMedicationSafetyEventsStrict: async () => ({ items: [], nextCursor: "" }),
  });
  page._testApp.globalData.deviceId = "box-1";

  await page.load();

  const byKind = Object.fromEntries(page.data.vitalsRecords.map(record => [record.attributionKind, record]));
  assert.equal(byKind.BROKEN_INQUIRY.person, "归属信息同步异常");
  assert.equal(byKind.BROKEN_INQUIRY.recordId, "vitals-broken");
  assert.equal(byKind.BROKEN_INQUIRY.inquirySessionId, "inquiry-broken");
  assert.equal(byKind.BROKEN_INQUIRY.attributionSource, "INQUIRY_SESSION");
  assert.equal(byKind.BROKEN_INQUIRY.attributionCapability, "v1");
  assert.equal(byKind.BROKEN_INQUIRY.schemaRevision, "2.7-runtime-consistency");
  assert.equal(byKind.STANDALONE.person, "未登记人员");
  assert.equal(byKind.LEGACY.person, "旧记录姓名（旧记录）");

  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/records/index.wxml"), "utf8");
  assert.match(layout, /测量对象：\{\{item\.person\}\}/);
  assert.match(layout, /记录编号：\{\{item\.recordId\}\}/);
  assert.match(layout, /问询会话：\{\{item\.inquirySessionId\}\}/);
  assert.match(layout, /归属来源：\{\{item\.attributionSource\}\}/);
});

test("records waits for the device session and starts one read before non-immediate realtime", async () => {
  let releaseReady;
  const ready = new Promise(resolve => { releaseReady = resolve; });
  let realtimeOptions = null;
  const page = loadRecordsPage({}, {
    deviceSession: {
      runAfterDeviceSessionReady: callback => ready.then(callback),
    },
    realtime: {
      subscribe(callback, query, options) {
        realtimeOptions = options;
        return () => {};
      },
    },
  });
  let loads = 0;
  page.load = () => { loads += 1; return Promise.resolve(); };

  const showing = page.onShow();
  assert.equal(loads, 0);
  assert.equal(realtimeOptions, null);

  releaseReady();
  await showing;

  assert.equal(loads, 1);
  assert.equal(realtimeOptions.immediate, false);
});

test("care timeline filters health measurements and medication risks without hiding either type", () => {
  const page = loadRecordsPage();
  page.data = {
    feed: [
      { id: "safety-1", type: "safety" },
      { id: "vitals-1", type: "vitals" },
      { id: "safety-2", type: "safety" },
    ],
    recordFilter: "all",
  };
  page.setData = next => Object.assign(page.data, next);

  page.applyRecordFilter("safety");
  assert.equal(page.data.recordFilter, "safety");
  assert.deepEqual(page.data.visibleFeed.map(item => item.id), ["safety-1", "safety-2"]);
  assert.equal(page.data.emptyText, "暂无用药风险记录。");

  page.setRecordFilter({ currentTarget: { dataset: { filter: "vitals" } } });
  assert.equal(page.data.recordFilter, "vitals");
  assert.deepEqual(page.data.visibleFeed.map(item => item.id), ["vitals-1"]);
});

test("filtered timeline opens its first visible record from both the focus card and first timeline row", () => {
  const page = loadRecordsPage();
  page.data = {
    feed: [
      {
        id: "safety-latest",
        type: "safety",
        title: "妈妈 · 存在明确用药风险",
        subtitle: "降压药 · 建议先咨询医生",
        time: "09:00",
        date: "8月9日",
      },
      {
        id: "vitals-first",
        type: "vitals",
        title: "爸爸 完成健康测量",
        subtitle: "36.5℃ · 98% · 72 bpm",
        time: "08:30",
        date: "8月9日",
      },
    ],
    recordFilter: "all",
  };
  page.setData = next => Object.assign(page.data, next);

  page.applyRecordFilter("vitals");

  assert.equal(page.data.visibleFeed[0].id, "vitals-first");
  assert.equal(page.data.carePage.focus.title, "爸爸 完成健康测量 · 08:30");
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.id, "records-action-open-latest");
  assert.equal(page.data.carePage.focus.action.payload.recordId, "vitals-first");
  const firstAction = page.data.carePage.sections[0].items[0].action;
  assert.equal(firstAction.payload.recordId, "vitals-first");

  page.onCarePageAction({ detail: page.data.carePage.focus.action });
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailList[0].id, "vitals-first");
});

test("an empty filtered timeline presents that filter's empty state without a stale focus action", () => {
  const page = loadRecordsPage();
  page.data = {
    feed: [
      {
        id: "safety-only",
        type: "safety",
        title: "妈妈 · 存在明确用药风险",
        time: "09:00",
        date: "8月9日",
      },
    ],
    recordFilter: "all",
  };
  page.setData = next => Object.assign(page.data, next);

  page.applyRecordFilter("vitals");

  assert.equal(page.data.visibleFeed.length, 0);
  assert.equal(page.data.carePage.focus.title, "暂无健康测量记录。");
  assert.equal(page.data.carePage.focus.state.kind, "muted");
  assert.equal(page.data.carePage.focus.action, null);
  assert.equal(page.data.carePage.focus.activation, "none");
  assert.equal(page.data.carePage.sections[0].empty, "暂无健康测量记录。");
});

test("records shows a retryable error instead of an empty timeline when its first read fails", async () => {
  let unavailable = true;
  const page = loadRecordsPage({
    getRecentVitals: async () => [],
    getRecentVitalsStrict: async () => {
      if (unavailable) throw new Error("vitals unavailable");
      return [];
    },
  });

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "error");
  assert.match(page.data.carePage.phase.message, /读取失败|重新加载/);
  assert.doesNotMatch(page.data.carePage.phase.message, /暂无记录|暂无数据/);
  assert.equal(page.data.carePage.focus, null);
  assert.equal(page.data.carePage.phase.action.id, "records.retry");
  assert.equal(page.data.carePage.phase.action.label, "重新加载照护记录");

  unavailable = false;
  await page.onCarePageAction({ detail: page.data.carePage.phase.action });

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.carePage.focus.title, "暂时没有同步到照护记录。");
});

test("records keeps the last timeline and marks it as stale when a background refresh fails", async () => {
  let refreshFails = false;
  const vitals = [{
    recordId: "vitals-kept",
    personName: "妈妈",
    bodyTemp: 36.5,
    spo2: 98,
    heartRate: 72,
    createdAt: todayAt("09:00"),
  }];
  const page = loadRecordsPage({
    getRecentVitals: async () => vitals,
    getRecentVitalsStrict: async () => {
      if (refreshFails) throw new Error("refresh failed");
      return vitals;
    },
  });

  await page.load();
  refreshFails = true;
  await page.load();

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.feed[0].id, "vitals-vitals-kept");
  assert.match(page.data.carePage.focus.supporting, /可能不是最新/);
});

test("care records keep four recent rows on the page while the detail sheet keeps the full selected list", () => {
  const page = loadRecordsPage();
  page.data = {
    feed: [
      { id: "latest-safety", type: "safety" },
      { id: "latest-vitals", type: "vitals" },
      { id: "older-safety", type: "safety" },
      { id: "older-vitals", type: "vitals" },
      { id: "archive-safety", type: "safety" },
    ],
    recordFilter: "all",
  };
  page.setData = next => Object.assign(page.data, next);

  page.applyRecordFilter("all");

  assert.deepEqual(page.data.visibleFeed.map(item => item.id), ["latest-safety", "latest-vitals", "older-safety", "older-vitals", "archive-safety"]);
  assert.deepEqual(page.data.previewFeed.map(item => item.id), ["latest-safety", "latest-vitals", "older-safety", "older-vitals"]);
  assert.equal(page.data.carePage.sections[0].items.length, 4);
  assert.equal(page.data.carePage.sections[0].filters[0].active, true);

  page.showAllRecords();
  assert.equal(page.data.detailVisible, true);
  assert.deepEqual(page.data.detailList.map(item => item.id), ["latest-safety", "latest-vitals", "older-safety", "older-vitals", "archive-safety"]);
});

test("all records can load the next safety page with canonical-id deduplication and stable ordering", async () => {
  const listRequests = [];
  const occurredAt = todayAt("10:00");
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => {
      listRequests.push(options);
      if (!options.cursor) {
        return {
          items: [
            {
              type: "MEDICATION_SAFETY_EVENT",
              event_id: "safety-b",
              _id: "storage-b",
              person_display_name: "王奶奶",
              medicine_name: "药品 B",
              check_status: "BLOCKED",
              dispense_status: "BLOCKED",
              occurred_at: occurredAt,
            },
            {
              type: "MEDICATION_SAFETY_EVENT",
              event_id: "safety-a",
              _id: "storage-a",
              person_display_name: "王奶奶",
              medicine_name: "药品 A",
              check_status: "BLOCKED",
              dispense_status: "BLOCKED",
              occurred_at: occurredAt,
            },
          ],
          nextCursor: "cursor-page-2",
        };
      }
      return {
        items: [
          {
            type: "MEDICATION_SAFETY_EVENT",
            event_id: "safety-a",
            _id: "different-storage-id",
            person_display_name: "王奶奶",
            medicine_name: "药品 A（补充）",
            check_status: "BLOCKED",
            dispense_status: "BLOCKED",
            occurred_at: occurredAt,
          },
          {
            type: "MEDICATION_SAFETY_EVENT",
            event_id: "safety-c",
            _id: "storage-c",
            person_display_name: "李爷爷",
            medicine_name: "药品 C",
            check_status: "CHECK_FAILED",
            dispense_status: "BLOCKED",
            occurred_at: occurredAt,
          },
        ],
        nextCursor: "",
      };
    },
  });

  await page.load();
  assert.equal(listRequests[0].limit, 50);
  assert.equal(page.data.safetyNextCursor, "cursor-page-2");
  assert.equal(page.data.carePage.overview[0].value, "2");

  page.showAllRecords();
  assert.equal(page.data.safetyPaginationVisible, true);
  assert.match(page.data.safetyPaginationLabel, /加载更多安全记录/);

  const nextPageRequest = page.loadMoreSafetyRecords();
  assert.equal(page.data.safetyPaginationStatus, "loading");
  assert.match(page.data.safetyPaginationLabel, /正在加载/);
  assert.equal(page.data.safetyPaginationVisible, true);
  await nextPageRequest;

  assert.equal(listRequests[1].cursor, "cursor-page-2");
  assert.equal(listRequests[1].limit, 50);
  assert.deepEqual(Array.from(page.data.safetyRecords, item => item.id), ["safety-a", "safety-b", "safety-c"]);
  assert.deepEqual(Array.from(page.data.detailList, item => item.id), ["safety-a", "safety-b", "safety-c"]);
  assert.equal(page.data.safetyRecords[0].medicineName, "药品 A（补充）");
  assert.equal(page.data.safetyNextCursor, "");
  assert.equal(page.data.carePage.overview[0].value, "2");
  assert.equal(page.data.safetyPaginationVisible, false);
});

test("safety history remains complete and ordered after paging beyond one hundred events", async () => {
  const occurredAt = todayAt("10:00");
  const event = (index, suffix = "") => ({
    type: "MEDICATION_SAFETY_EVENT",
    event_id: `safety-${String(index).padStart(3, "0")}`,
    _id: `storage-${index}-${suffix || "base"}`,
    person_id: "member-current",
    person_display_name: "当前成员",
    medicine_name: `药品 ${index}${suffix}`,
    check_status: index % 2 ? "CHECK_FAILED" : "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: occurredAt,
  });
  const requests = [];
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => {
      requests.push({ cursor: options.cursor || "", limit: options.limit });
      if (!options.cursor) {
        return { items: Array.from({ length: 50 }, (_, index) => event(index)), nextCursor: "page-2" };
      }
      if (options.cursor === "page-2") {
        return {
          items: [event(0, "（更新）")].concat(Array.from({ length: 49 }, (_, index) => event(index + 50))),
          nextCursor: "page-3",
        };
      }
      return { items: Array.from({ length: 6 }, (_, index) => event(index + 99)), nextCursor: "" };
    },
  });

  await page.load();
  page.showAllRecords();
  await page.loadMoreSafetyRecords();
  await page.loadMoreSafetyRecords();

  const ids = Array.from(page.data.safetyRecords, item => item.id);
  assert.deepEqual(requests, [
    { cursor: "", limit: 50 },
    { cursor: "page-2", limit: 50 },
    { cursor: "page-3", limit: 50 },
  ]);
  assert.equal(ids.length, 105);
  assert.equal(new Set(ids).size, 105);
  assert.deepEqual(ids, ids.slice().sort());
  assert.equal(page.data.safetyRecords[0].medicineName, "药品 0（更新）");
  assert.equal(page.data.safetyNextCursor, "");
  assert.equal(page.data.safetyPaginationStatus, "done");
  assert.equal(page.data.safetyPaginationVisible, false);
});

test("a failed next safety page stays visible and retryable without losing its cursor or records", async () => {
  let nextPageFails = true;
  const requestedCursors = [];
  const firstEvent = {
    type: "MEDICATION_SAFETY_EVENT",
    event_id: "safety-kept",
    person_display_name: "王奶奶",
    medicine_name: "保留药品",
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt("09:00"),
  };
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => {
      requestedCursors.push(options.cursor || "");
      if (!options.cursor) return { items: [firstEvent], nextCursor: "retry-cursor" };
      if (nextPageFails) throw new Error("temporary page failure");
      return {
        items: [{
          type: "MEDICATION_SAFETY_EVENT",
          event_id: "safety-retried",
          person_display_name: "李爷爷",
          medicine_name: "重试药品",
          check_status: "CHECK_FAILED",
          dispense_status: "BLOCKED",
          occurred_at: todayAt("08:00"),
        }],
        nextCursor: "",
      };
    },
  });

  await page.load();
  page.applyRecordFilter("safety");
  page.showAllRecords();
  await page.loadMoreSafetyRecords();

  assert.equal(page.data.safetyPaginationStatus, "error");
  assert.equal(page.data.safetyNextCursor, "retry-cursor");
  assert.equal(page.data.safetyPaginationVisible, true);
  assert.match(page.data.safetyPaginationLabel, /点击重试/);
  assert.deepEqual(Array.from(page.data.detailList, item => item.id), ["safety-kept"]);

  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/records/index.wxml"), "utf8");
  assert.match(layout, /class="care-record-sheet__more/);
  assert.match(layout, /bindtap="loadMoreSafetyRecords"/);

  nextPageFails = false;
  await page.loadMoreSafetyRecords();

  assert.deepEqual(requestedCursors, ["", "retry-cursor", "retry-cursor"]);
  assert.deepEqual(Array.from(page.data.detailList, item => item.id), ["safety-kept", "safety-retried"]);
  assert.equal(page.data.safetyPaginationStatus, "done");
  assert.equal(page.data.safetyNextCursor, "");
});

test("a late pagination failure from the previous medication box cannot overwrite the new box state", async () => {
  let rejectBoxAPage;
  const boxAPage = new Promise((resolve, reject) => {
    rejectBoxAPage = reject;
  });
  const eventFor = (deviceId, medicineName) => ({
    type: "MEDICATION_SAFETY_EVENT",
    event_id: `safety-${deviceId}`,
    device_id: deviceId,
    person_display_name: "家庭成员",
    medicine_name: medicineName,
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt("09:00"),
  });
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId }),
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => {
      if (options.deviceId === "box-a" && options.cursor) return boxAPage;
      return {
        items: [eventFor(options.deviceId, options.deviceId === "box-a" ? "药箱 A 的药品" : "药箱 B 的药品")],
        nextCursor: options.deviceId === "box-a" ? "box-a-cursor" : "box-b-cursor",
      };
    },
  });
  page._testApp.globalData.deviceId = "box-a";
  await page.load();
  page.applyRecordFilter("safety");
  page.showAllRecords();

  const loadMoreFromBoxA = page.loadMoreSafetyRecords();
  page._testApp.globalData.deviceId = "box-b";
  await page.load();

  rejectBoxAPage(new Error("box A page failed late"));
  await loadMoreFromBoxA;

  assert.equal(page.data.safetyDeviceId, "box-b");
  assert.deepEqual(Array.from(page.data.safetyRecords, item => item.id), ["safety-box-b"]);
  assert.equal(page.data.safetyNextCursor, "box-b-cursor");
  assert.equal(page.data.safetyPaginationStatus, "idle");
  assert.equal(page.data.safetyPaginationError, "");
});

test("a late successful page from the previous medication box cannot append into the new box", async () => {
  let resolveBoxAPage;
  const boxAPage = new Promise(resolve => {
    resolveBoxAPage = resolve;
  });
  const eventFor = (deviceId, suffix) => ({
    type: "MEDICATION_SAFETY_EVENT",
    event_id: `safety-${suffix}`,
    device_id: deviceId,
    person_display_name: "家庭成员",
    medicine_name: `${deviceId} 药品`,
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt("09:00"),
  });
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId }),
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => {
      if (options.deviceId === "box-a" && options.cursor) return boxAPage;
      return {
        items: [eventFor(options.deviceId, options.deviceId)],
        nextCursor: options.deviceId === "box-a" ? "box-a-cursor" : "box-b-cursor",
      };
    },
  });
  page._testApp.globalData.deviceId = "box-a";
  await page.load();
  page.applyRecordFilter("safety");
  page.showAllRecords();

  const loadMoreFromBoxA = page.loadMoreSafetyRecords();
  page._testApp.globalData.deviceId = "box-b";
  await page.load();
  resolveBoxAPage({ items: [eventFor("box-a", "box-a-page-2")], nextCursor: "" });
  await loadMoreFromBoxA;

  assert.equal(page.data.safetyDeviceId, "box-b");
  assert.deepEqual(Array.from(page.data.safetyRecords, item => item.id), ["safety-box-b"]);
  assert.equal(page.data.safetyNextCursor, "box-b-cursor");
  assert.equal(page.data.safetyPaginationStatus, "idle");
});

test("a repeated safety cursor fails closed without appending or claiming the history is complete", async () => {
  const firstEvent = {
    type: "MEDICATION_SAFETY_EVENT",
    event_id: "safety-first-page",
    person_display_name: "王奶奶",
    medicine_name: "首屏药品",
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt("09:00"),
  };
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => ({
      items: options.cursor ? [{
        type: "MEDICATION_SAFETY_EVENT",
        event_id: "safety-should-not-append",
        person_display_name: "李爷爷",
        medicine_name: "协议异常药品",
        check_status: "CHECK_FAILED",
        dispense_status: "BLOCKED",
        occurred_at: todayAt("08:00"),
      }] : [firstEvent],
      nextCursor: "stuck-cursor",
    }),
  });

  await page.load();
  page.applyRecordFilter("safety");
  page.showAllRecords();
  await page.loadMoreSafetyRecords();

  assert.equal(page.data.safetyNextCursor, "stuck-cursor");
  assert.equal(page.data.safetyPaginationStatus, "error");
  assert.equal(page.data.safetyPaginationVisible, true);
  assert.match(page.data.safetyPaginationLabel, /重试/);
  assert.deepEqual(Array.from(page.data.safetyRecords, item => item.id), ["safety-first-page"]);
});

test("a first-page refresh preserves safety pages that the caregiver already loaded", async () => {
  let firstPageReads = 0;
  const event = (id, medicineName, time) => ({
    type: "MEDICATION_SAFETY_EVENT",
    event_id: id,
    person_display_name: "家庭成员",
    medicine_name: medicineName,
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt(time),
  });
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => {
      if (options.cursor === "cursor-page-2") {
        return { items: [event("safety-page-2", "第二页药品", "08:00")], nextCursor: "cursor-page-3" };
      }
      firstPageReads += 1;
      return {
        items: [event("safety-page-1", firstPageReads === 1 ? "首屏药品" : "首屏药品（已刷新）", "09:00")],
        nextCursor: "cursor-page-2",
      };
    },
  });

  await page.load();
  page.applyRecordFilter("safety");
  page.showAllRecords();
  await page.loadMoreSafetyRecords();
  assert.equal(page.data.safetyNextCursor, "cursor-page-3");

  await page.load();

  assert.deepEqual(
    Array.from(page.data.safetyRecords, item => item.id),
    ["safety-page-1", "safety-page-2"],
  );
  assert.equal(page.data.safetyRecords[0].medicineName, "首屏药品（已刷新）");
  assert.equal(page.data.safetyNextCursor, "cursor-page-3");
  assert.deepEqual(Array.from(page.data.detailList, item => item.id), ["safety-page-1", "safety-page-2"]);
});

test("a transient safety refresh failure keeps the last visible safety facts and marks them stale", async () => {
  let safetyReads = 0;
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => {
      safetyReads += 1;
      if (safetyReads > 1) throw new Error("temporary safety refresh failure");
      return {
        items: [{
          type: "MEDICATION_SAFETY_EVENT",
          event_id: "safety-stale-kept",
          person_display_name: "王奶奶",
          medicine_name: "应保留药品",
          check_status: "BLOCKED",
          dispense_status: "BLOCKED",
          occurred_at: todayAt("09:30"),
        }],
        nextCursor: "",
      };
    },
  });

  await page.load();
  await page.load();

  assert.deepEqual(Array.from(page.data.safetyRecords, item => item.id), ["safety-stale-kept"]);
  assert.equal(page.data.safetyState.availability, "error");
  assert.equal(page.data.stale, true);
  assert.match(page.data.carePage.sections[0].supporting, /读取失败/);
});

test("switching medication boxes clears the old feed immediately and a failed first read cannot restore it", async () => {
  const requestedDeviceIds = [];
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId }),
    getRecentVitalsStrict: async (limit, deviceId) => {
      requestedDeviceIds.push(deviceId);
      if (deviceId === "box-b") throw new Error("box B unavailable");
      return [];
    },
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => ({
      items: [{
        type: "MEDICATION_SAFETY_EVENT",
        event_id: `safety-${options.deviceId}`,
        device_id: options.deviceId,
        person_display_name: "家庭成员",
        medicine_name: "药箱 A 的药品",
        check_status: "BLOCKED",
        dispense_status: "BLOCKED",
        occurred_at: todayAt("09:00"),
      }],
      nextCursor: "box-a-next-page",
    }),
  });
  page._testApp.globalData.deviceId = "box-a";

  await page.load();
  page.applyRecordFilter("safety");
  page.showAllRecords();
  assert.deepEqual(Array.from(page.data.feed, item => item.id), ["safety-box-a"]);
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.safetyPaginationVisible, true);

  page._testApp.globalData.deviceId = "box-b";
  const boxBLoad = page.load();

  assert.equal(page.data.safetyDeviceId, "box-b");
  assert.deepEqual(Array.from(page.data.feed), []);
  assert.deepEqual(Array.from(page.data.detailList), []);
  assert.equal(page.data.detailVisible, false);
  assert.equal(page.data.safetyNextCursor, "");
  assert.equal(page.data.safetyPaginationVisible, false);

  await boxBLoad;

  assert.deepEqual(requestedDeviceIds, ["box-a", "box-b"]);
  assert.equal(page.data.carePage.phase.kind, "error");
  assert.deepEqual(Array.from(page.data.feed), []);
  assert.equal(page.data.stale, false);
});

test("a safety event beyond the four-row preview can open from the full list and become read", async () => {
  let detailCalls = 0;
  let markReadCalls = 0;
  const items = Array.from({ length: 5 }, (_, index) => ({
    type: "MEDICATION_SAFETY_EVENT",
    event_id: `safety-full-${index + 1}`,
    person_display_name: "任意家人",
    medicine_name: `药品 ${index + 1}`,
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    read_state: "UNREAD",
    occurred_at: todayAt(`${String(index + 7).padStart(2, "0")}:00`),
  }));
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items }),
    getMedicationSafetyEventDetail: async eventId => {
      detailCalls += 1;
      return items.find(item => item.event_id === eventId);
    },
    markMedicationSafetyEventRead: async eventId => {
      markReadCalls += 1;
      return { eventId, ok: true, state: "READ" };
    },
  });

  await page.load();
  assert.equal(page.data.carePage.sections[0].items.length, 4);
  page.showAllRecords();
  assert.equal(page.data.detailList.length, 5);
  await page.openDetailRecord({ currentTarget: { dataset: { recordId: "safety-full-1" } } });

  assert.equal(detailCalls, 1);
  assert.equal(markReadCalls, 1);
  assert.equal(page.data.detailMode, "record");
  assert.equal(page.data.detailList[0].id, "safety-full-1");
  assert.equal(page.data.detailList[0].readState, "READ");
});

test("records page renders one semantic care screen and keeps detail rows on demand", () => {
  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/records/index.wxml"), "utf8");
  const firstLevelLayout = layout.slice(0, layout.indexOf('<view wx:if="{{detailVisible}}"'));

  assert.match(firstLevelLayout, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/);
  assert.doesNotMatch(firstLevelLayout, /<app-header|wx:for="\{\{previewFeed\}\}"|class="ui-kicker"/);
  assert.match(layout, /wx:for="\{\{detailList\}\}"/);
  assert.match(layout, /class="ui-sheet care-record-sheet"/);
});

test("records never reads or presents legacy dispense rows", async () => {
  let legacyRecordReads = 0;
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => {
      legacyRecordReads += 1;
      return [{
        id: "legacy-dispense",
        type: "DISPENSE",
        medicine_name: "旧版药品",
        createdAt: todayAt("09:00"),
      }];
    },
    getRecentVitalsStrict: async () => [],
  });

  await page.load();

  assert.equal(legacyRecordReads, 0);
  assert.deepEqual(Array.from(page.data.feed), []);
  assert.deepEqual(Array.from(page.data.carePage.sections[0].filters, filter => filter.label), [
    "全部",
    "用药风险",
    "测量",
  ]);
});

test("a complete persona snapshot filters archived safety events across the first page and pagination", async () => {
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId, online: true }),
    getSnapshotStrict: async () => ({
      serviceUsersSnapshotComplete: true,
      serviceUsers: [
        { id: "active-person", name: "当前人物", personaGeneration: "v2", archived: false },
        { id: "archived-person", name: "已归档人物", personaGeneration: "v1", archived: true },
      ],
    }),
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({
      capabilities: {
        medicationSafetyEvents: "v1",
        personaLifecycle: "v1",
        vitalsAttribution: "v1",
      },
    }),
    getMedicationSafetyEventsStrict: async options => options.cursor ? ({
      items: [{
        type: "MEDICATION_SAFETY_EVENT",
        event_id: "safety-archived-page",
        person_id: "archived-person",
        persona_generation: "v1",
        check_status: "BLOCKED",
        dispense_status: "BLOCKED",
        occurred_at: todayAt("06:00"),
      }],
      nextCursor: "",
    }) : ({
      items: [{
        type: "MEDICATION_SAFETY_EVENT",
        event_id: "safety-active",
        person_id: "active-person",
        persona_generation: "v2",
        check_status: "BLOCKED",
        dispense_status: "BLOCKED",
        occurred_at: todayAt("11:00"),
      }, {
        type: "MEDICATION_SAFETY_EVENT",
        event_id: "safety-guest",
        check_status: "CHECK_FAILED",
        dispense_status: "NOT_STARTED",
        occurred_at: todayAt("05:00"),
      }],
      nextCursor: "cursor-2",
    }),
  });
  page._testApp.globalData.deviceId = "box-persona";

  await page.load();

  assert.deepEqual(Array.from(page.data.safetyRecords, record => record.id), ["safety-active", "safety-guest"]);
  assert.equal(page._personaPolicy.strict, true);

  page.showAllRecords();
  await page.loadMoreSafetyRecords();
  assert.deepEqual(Array.from(page.data.safetyRecords, record => record.id), ["safety-active", "safety-guest"]);
  assert.equal(page.data.safetyNextCursor, "");
});

test("records presents medication safety as its own filter and detail", async () => {
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({
      schemaVersion: 2,
      capabilities: { medicationSafetyEvents: "v1" },
    }),
    getMedicationSafetyEventsStrict: async () => ({
      items: [{
        type: "MEDICATION_SAFETY_CHECK",
        event_id: "safety-wang-001",
        service_user_id: "wang-nainai",
        person_display_name: "王奶奶",
        medicine_name: "布洛芬缓释胶囊",
        check_status: "BLOCKED",
        dispense_status: "BLOCKED",
        caregiver_summary: "检测到已登记的既往胃溃疡与该药禁忌冲突。",
        occurred_at: todayAt("10:30"),
        read_state: "UNREAD",
        ruleset_version: "manual-safety-v1",
        profile_revision: 3,
      }],
    }),
  });

  await page.load();

  assert.equal(page.data.feed[0].type, "safety");
  assert.equal(page.data.feed[0].title, "王奶奶 · 存在明确用药风险");
  assert.match(page.data.feed[0].subtitle, /不建议自行使用/);
  assert.equal(page.data.todaySafetyCount, 1);
  assert.deepEqual(Array.from(page.data.carePage.sections[0].filters, filter => filter.label), [
    "全部",
    "用药风险",
    "测量",
  ]);
  assert.equal(page.data.carePage.overview[0].label, "今日风险");

  page.applyRecordFilter("safety");
  const action = page.data.carePage.sections[0].items[0].action;
  page.onCarePageAction({ detail: action });
  assert.equal(page.data.detailTitle, "用药风险");
  assert.match(page.data.detailList[0].outcomeText, /不建议自行使用/);

  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/records/index.wxml"), "utf8");
  assert.match(layout, /item\.type === 'safety'/);
  assert.match(layout, /风险状态/);
  assert.doesNotMatch(layout, /是否出药/);
});

test("an older cloud keeps records usable and says safety history is unsupported without probing it", async () => {
  let safetyListCalls = 0;
  let safetyDetailCalls = 0;
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({
      schemaVersion: 2,
      schemaRevision: "2.2-miniprogram",
      capabilities: {},
    }),
    getMedicationSafetyEventsStrict: async () => {
      safetyListCalls += 1;
      throw new Error("legacy cloud must not receive an unknown action");
    },
    getMedicationSafetyEventDetail: async () => {
      safetyDetailCalls += 1;
      throw new Error("legacy cloud must not receive an unknown detail action");
    },
  });
  page._testApp.globalData.deviceId = "legacy-box";
  page._testApp.globalData.pendingCareRecord = {
    type: "safety",
    eventId: "unsupported-event",
    deviceId: "legacy-box",
  };

  await page.load();
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.safetyState.availability, "unsupported");
  assert.equal(safetyListCalls, 0);
  assert.equal(safetyDetailCalls, 0);
  assert.equal(page._testApp.globalData.pendingCareRecord, undefined);
  assert.match(page.data.carePage.sections[0].supporting, /当前云端版本尚未支持安全记录/);
  assert.equal(page.data.carePage.overview[0].value, "未支持");

  page.applyRecordFilter("safety");
  assert.match(page.data.emptyText, /当前云端版本尚未支持安全记录/);
});

test("records shows a membership denial explicitly instead of treating it as no safety risk", async () => {
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => {
      const error = new Error("membership required");
      error.code = "FORBIDDEN";
      throw error;
    },
  });

  await page.load();
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.safetyState.availability, "forbidden");
  assert.match(page.data.carePage.sections[0].supporting, /当前微信账号无权查看该药箱/);
  assert.equal(page.data.carePage.overview[0].value, "无权限");
});

test("a pending safety route without the current medication-box id is discarded without reading or marking it", async () => {
  for (const pendingDeviceId of [undefined, "box-a"]) {
    let detailCalls = 0;
    let markReadCalls = 0;
    const page = loadRecordsPage({
      getRecentRecordsStrict: async () => [],
      getRecentVitalsStrict: async () => [],
      getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
      getMedicationSafetyEventsStrict: async () => ({
        items: [{
          type: "MEDICATION_SAFETY_EVENT",
          event_id: "same-event-id",
          device_id: "box-b",
          person_display_name: "家庭成员",
          medicine_name: "药箱 B 的药品",
          check_status: "BLOCKED",
          dispense_status: "BLOCKED",
          occurred_at: todayAt("10:00"),
          read_state: "UNREAD",
        }],
      }),
      getMedicationSafetyEventDetail: async eventId => {
        detailCalls += 1;
        return { type: "MEDICATION_SAFETY_EVENT", event_id: eventId, device_id: "box-b" };
      },
      markMedicationSafetyEventRead: async eventId => {
        markReadCalls += 1;
        return { eventId, ok: true, state: "READ" };
      },
    });
    page._testApp.globalData.deviceId = "box-b";
    page._testApp.globalData.pendingCareRecord = {
      type: "safety",
      eventId: "same-event-id",
    };
    if (pendingDeviceId) page._testApp.globalData.pendingCareRecord.deviceId = pendingDeviceId;

    await page.load();

    assert.equal(detailCalls, 0);
    assert.equal(markReadCalls, 0);
    assert.equal(page.data.detailVisible, false);
    assert.equal(page._testApp.globalData.pendingCareRecord, undefined);
  }
});

test("a home safety focus opens the matching records detail once after switching tabs", async () => {
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({
      schemaVersion: 2,
      capabilities: { medicationSafetyEvents: "v1" },
    }),
    getMedicationSafetyEventsStrict: async () => ({
      items: [{
        type: "MEDICATION_SAFETY_CHECK",
        event_id: "safety-route-001",
        person_display_name: "李爷爷",
        medicine_name: "蜜炼川贝枇杷膏",
        check_status: "BLOCKED",
        dispense_status: "BLOCKED",
        occurred_at: todayAt("11:00"),
        read_state: "UNREAD",
      }],
    }),
  });
  page._testApp.globalData.deviceId = "route-box";
  page._testApp.globalData.pendingCareRecord = {
    type: "safety",
    eventId: "safety-route-001",
    deviceId: "route-box",
  };

  await page.load();

  assert.equal(page.data.recordFilter, "safety");
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailTitle, "用药风险");
  assert.equal(page.data.detailList[0].id, "safety-route-001");
  assert.equal(page._testApp.globalData.pendingCareRecord, undefined);

  page.closeDetail();
  await page.load();
  assert.equal(page.data.detailVisible, false, "the consumed route must not reopen on refresh");
});

test("a home safety focus loads its event by id when it is outside the recent records window", async () => {
  let detailCalls = 0;
  let markReadCalls = 0;
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [] }),
    getMedicationSafetyEventDetail: async (eventId, options) => {
      detailCalls += 1;
      assert.equal(options.deviceId, "outside-window-box");
      return {
        type: "MEDICATION_SAFETY_EVENT",
        event_id: eventId,
        device_id: "outside-window-box",
        person_display_name: "任意家人",
        medicine_name: "窗口外药品",
        check_status: "BLOCKED",
        dispense_status: "BLOCKED",
        caregiver_summary: "该事件不在最近 50 条列表中。",
        occurred_at: todayAt("08:00"),
        read_state: "UNREAD",
      };
    },
    markMedicationSafetyEventRead: async (eventId, options) => {
      markReadCalls += 1;
      assert.equal(options.deviceId, "outside-window-box");
      return { eventId, ok: true, state: "READ" };
    },
  });
  page._testApp.globalData.deviceId = "outside-window-box";
  page._testApp.globalData.pendingCareRecord = {
    type: "safety",
    eventId: "safety-outside-window",
    deviceId: "outside-window-box",
  };

  await page.load();

  assert.equal(detailCalls, 1);
  assert.equal(markReadCalls, 1);
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailList[0].id, "safety-outside-window");
  assert.equal(page.data.detailList[0].readState, "READ");
  assert.equal(page._testApp.globalData.pendingCareRecord, undefined);
});

test("a failed pending detail is consumed once and leaves an explicit manual retry instead of realtime retries", async () => {
  let detailCalls = 0;
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [] }),
    getMedicationSafetyEventDetail: async (eventId, options) => {
      detailCalls += 1;
      assert.equal(eventId, "failed-pending-detail");
      assert.equal(options.deviceId, "failed-detail-box");
      throw new Error("detail unavailable");
    },
  });
  page._testApp.globalData.deviceId = "failed-detail-box";
  page._testApp.globalData.pendingCareRecord = {
    type: "safety",
    eventId: "failed-pending-detail",
    deviceId: "failed-detail-box",
  };

  await page.load();
  await page.load();

  assert.equal(detailCalls, 1);
  assert.equal(page._testApp.globalData.pendingCareRecord, undefined);
  assert.equal(page.data.detailVisible, false);
  const retrySection = page.data.carePage.sections.find(section => section.key === "records-pending-safety-detail");
  assert.ok(retrySection, "the failed navigation should remain visible on the records page");
  assert.match(retrySection.supporting, /读取失败|网络/);
  assert.equal(retrySection.items[0].action.id, "records-action-retry-pending-safety");
  assert.equal(retrySection.items[0].action.label, "重试打开用药风险");
});

test("the pending-detail retry reuses its original device and event then opens and marks the detail", async () => {
  let detailCalls = 0;
  let markReadCalls = 0;
  let detailUnavailable = true;
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [] }),
    getMedicationSafetyEventDetail: async (eventId, options) => {
      detailCalls += 1;
      assert.equal(eventId, "retry-pending-detail");
      assert.equal(options.deviceId, "retry-detail-box");
      if (detailUnavailable) throw new Error("temporary detail failure");
      return {
        type: "MEDICATION_SAFETY_EVENT",
        event_id: eventId,
        device_id: options.deviceId,
        person_display_name: "家庭成员",
        medicine_name: "临时失败后恢复的药品",
        check_status: "BLOCKED",
        dispense_status: "BLOCKED",
        occurred_at: todayAt("08:30"),
        read_state: "UNREAD",
      };
    },
    markMedicationSafetyEventRead: async (eventId, options) => {
      markReadCalls += 1;
      assert.equal(eventId, "retry-pending-detail");
      assert.equal(options.deviceId, "retry-detail-box");
      return { eventId, ok: true, state: "READ" };
    },
  });
  page._testApp.globalData.deviceId = "retry-detail-box";
  page._testApp.globalData.pendingCareRecord = {
    type: "safety",
    eventId: "retry-pending-detail",
    deviceId: "retry-detail-box",
  };

  await page.load();
  const retryAction = page.data.carePage.sections
    .find(section => section.key === "records-pending-safety-detail")
    .items[0].action;

  detailUnavailable = false;
  await page.onCarePageAction({ detail: retryAction });

  assert.equal(detailCalls, 2);
  assert.equal(markReadCalls, 1);
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailTitle, "用药风险");
  assert.equal(page.data.detailList[0].id, "retry-pending-detail");
  assert.equal(page.data.detailList[0].readState, "READ");
  assert.equal(page.data.pendingSafetyDetailRetry, null);
  assert.equal(
    page.data.carePage.sections.some(section => section.key === "records-pending-safety-detail"),
    false,
  );
});

test("a pending-detail retry becomes inert after switching medication boxes", async () => {
  let detailCalls = 0;
  let markReadCalls = 0;
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId }),
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [] }),
    getMedicationSafetyEventDetail: async () => {
      detailCalls += 1;
      throw new Error("temporary detail failure");
    },
    markMedicationSafetyEventRead: async eventId => {
      markReadCalls += 1;
      return { eventId, ok: true, state: "READ" };
    },
  });
  page._testApp.globalData.deviceId = "retry-box-a";
  page._testApp.globalData.pendingCareRecord = {
    type: "safety",
    eventId: "retry-event-a",
    deviceId: "retry-box-a",
  };

  await page.load();
  const staleRetryAction = page.data.carePage.sections
    .find(section => section.key === "records-pending-safety-detail")
    .items[0].action;

  page._testApp.globalData.deviceId = "retry-box-b";
  await page.load();
  await page.onCarePageAction({ detail: staleRetryAction });

  assert.equal(detailCalls, 1);
  assert.equal(markReadCalls, 0);
  assert.equal(page.data.safetyDeviceId, "retry-box-b");
  assert.equal(page.data.pendingSafetyDetailRetry, null);
  assert.equal(page.data.detailVisible, false);
  assert.equal(
    page.data.carePage.sections.some(section => section.key === "records-pending-safety-detail"),
    false,
  );
});

test("a pending outside-window detail that returns after a box switch is ignored before its read receipt", async () => {
  let resolveDetail;
  let notifyDetailStarted;
  let markReadCalls = 0;
  const detailStarted = new Promise(resolve => {
    notifyDetailStarted = resolve;
  });
  const detailResponse = new Promise(resolve => {
    resolveDetail = resolve;
  });
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId }),
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [] }),
    getMedicationSafetyEventDetail: async (eventId, options) => {
      assert.equal(options.deviceId, "box-a");
      notifyDetailStarted();
      return detailResponse;
    },
    markMedicationSafetyEventRead: async eventId => {
      markReadCalls += 1;
      return { eventId, ok: true, state: "READ" };
    },
  });
  page._testApp.globalData.deviceId = "box-a";
  page._testApp.globalData.pendingCareRecord = {
    type: "safety",
    eventId: "pending-slow-detail",
    deviceId: "box-a",
  };

  const boxALoad = page.load();
  await detailStarted;
  page._testApp.globalData.deviceId = "box-b";
  await page.load();
  resolveDetail({
    type: "MEDICATION_SAFETY_EVENT",
    event_id: "pending-slow-detail",
    device_id: "box-a",
    person_display_name: "家庭成员",
    medicine_name: "药箱 A 的药品",
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt("08:00"),
    read_state: "UNREAD",
  });
  await boxALoad;

  assert.equal(markReadCalls, 0);
  assert.equal(page.data.safetyDeviceId, "box-b");
  assert.deepEqual(Array.from(page.data.feed), []);
  assert.equal(page.data.detailVisible, false);
  assert.equal(page._testApp.globalData.pendingCareRecord, undefined);
});

test("a safety detail that returns after switching medication boxes cannot mark or repopulate the new box", async () => {
  let resolveDetail;
  let markReadCalls = 0;
  const detailResponse = new Promise(resolve => {
    resolveDetail = resolve;
  });
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId }),
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => ({
      items: options.deviceId === "box-a" ? [{
        type: "MEDICATION_SAFETY_EVENT",
        event_id: "safety-slow-detail",
        device_id: "box-a",
        person_display_name: "家庭成员",
        medicine_name: "药箱 A 的药品",
        check_status: "BLOCKED",
        dispense_status: "BLOCKED",
        occurred_at: todayAt("10:00"),
        read_state: "UNREAD",
      }] : [],
    }),
    getMedicationSafetyEventDetail: async (eventId, options) => {
      assert.equal(eventId, "safety-slow-detail");
      assert.equal(options.deviceId, "box-a");
      return detailResponse;
    },
    markMedicationSafetyEventRead: async eventId => {
      markReadCalls += 1;
      return { eventId, ok: true, state: "READ" };
    },
  });
  page._testApp.globalData.deviceId = "box-a";
  await page.load();

  const openDetail = page.onCarePageAction({ detail: page.data.carePage.focus.action });
  page._testApp.globalData.deviceId = "box-b";
  await page.load();

  resolveDetail({
    type: "MEDICATION_SAFETY_EVENT",
    event_id: "safety-slow-detail",
    device_id: "box-a",
    person_display_name: "家庭成员",
    medicine_name: "药箱 A 的药品（详情）",
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt("10:00"),
    read_state: "UNREAD",
  });
  await openDetail;

  assert.equal(markReadCalls, 0);
  assert.equal(page.data.safetyDeviceId, "box-b");
  assert.deepEqual(Array.from(page.data.feed), []);
  assert.deepEqual(Array.from(page.data.detailList), []);
  assert.equal(page.data.detailVisible, false);
});

test("a read receipt that returns after switching medication boxes cannot mark a same-id event in the new box", async () => {
  let resolveMarkRead;
  let notifyMarkStarted;
  const markStarted = new Promise(resolve => {
    notifyMarkStarted = resolve;
  });
  const markResponse = new Promise(resolve => {
    resolveMarkRead = resolve;
  });
  const eventFor = (deviceId, medicineName) => ({
    type: "MEDICATION_SAFETY_EVENT",
    event_id: "shared-event-id",
    device_id: deviceId,
    person_display_name: "家庭成员",
    medicine_name: medicineName,
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt("10:00"),
    read_state: "UNREAD",
  });
  const page = loadRecordsPage({
    getDevice: async deviceId => ({ deviceId }),
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => ({
      items: [eventFor(options.deviceId, options.deviceId === "box-a" ? "药箱 A 的药品" : "药箱 B 的药品")],
    }),
    getMedicationSafetyEventDetail: async (eventId, options) => {
      assert.equal(options.deviceId, "box-a");
      return Object.assign(eventFor("box-a", "药箱 A 的药品（详情）"), { event_id: eventId });
    },
    markMedicationSafetyEventRead: async (eventId, options) => {
      assert.equal(options.deviceId, "box-a");
      notifyMarkStarted();
      return markResponse;
    },
  });
  page._testApp.globalData.deviceId = "box-a";
  await page.load();

  const openDetail = page.onCarePageAction({ detail: page.data.carePage.focus.action });
  await markStarted;
  page._testApp.globalData.deviceId = "box-b";
  await page.load();

  resolveMarkRead({ eventId: "shared-event-id", ok: true, state: "READ" });
  await openDetail;

  assert.equal(page.data.safetyDeviceId, "box-b");
  assert.equal(page.data.safetyRecords[0].deviceId, "box-b");
  assert.equal(page.data.safetyRecords[0].medicineName, "药箱 B 的药品");
  assert.equal(page.data.safetyRecords[0].readState, "UNREAD");
  assert.equal(page.data.detailVisible, false);
});

test("opening a safety detail loads evidence and marks only the caregiver receipt as read", async () => {
  let detailCalls = 0;
  let markReadCalls = 0;
  let commandCalls = 0;
  const summaryEvent = {
    type: "MEDICATION_SAFETY_CHECK",
    event_id: "safety-read-001",
    device_id: "detail-box",
    person_display_name: "王奶奶",
    medicine_name: "布洛芬缓释胶囊",
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    occurred_at: todayAt("11:30"),
    read_state: "UNREAD",
  };
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [summaryEvent] }),
    getMedicationSafetyEventDetail: async (eventId, options) => {
      detailCalls += 1;
      assert.equal(eventId, "safety-read-001");
      assert.equal(options.deviceId, "detail-box");
      return Object.assign({}, summaryEvent, {
        caregiver_summary: "检测到已登记的既往胃溃疡与该药禁忌冲突。",
        profile_revision: 3,
        ruleset_version: "manual-safety-v1",
      });
    },
    markMedicationSafetyEventRead: async (eventId, options) => {
      markReadCalls += 1;
      assert.equal(eventId, "safety-read-001");
      assert.equal(options.deviceId, "detail-box");
      return { eventId, ok: true, state: "READ" };
    },
    addCommand: async () => {
      commandCalls += 1;
      throw new Error("a safety record must not create a command");
    },
  });
  page._testApp.globalData.deviceId = "detail-box";

  await page.load();
  const action = page.data.carePage.sections[0].items[0].action;
  await page.onCarePageAction({ detail: action });

  assert.equal(detailCalls, 1);
  assert.equal(markReadCalls, 1);
  assert.equal(commandCalls, 0);
  assert.equal(page.data.detailList[0].readState, "READ");
  assert.equal(page.data.detailList[0].readText, "已查看");
  assert.match(page.data.detailList[0].detailSummary, /胃溃疡/);
  assert.match(page.data.detailList[0].evidenceText, /档案版本 3/);
  assert.match(page.data.detailList[0].evidenceText, /manual-safety-v1/);
});

test("a failed safety-detail read keeps the receipt unread", async () => {
  let markReadCalls = 0;
  const summaryEvent = {
    type: "MEDICATION_SAFETY_CHECK",
    event_id: "safety-detail-failed",
    person_display_name: "任意家人",
    medicine_name: "任意药品",
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    read_state: "UNREAD",
    occurred_at: todayAt("12:00"),
  };
  const page = loadRecordsPage({
    getRecentRecordsStrict: async () => [],
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [summaryEvent] }),
    getMedicationSafetyEventDetail: async () => {
      throw new Error("detail unavailable");
    },
    markMedicationSafetyEventRead: async () => {
      markReadCalls += 1;
      return { ok: true };
    },
  });

  await page.load();
  const action = page.data.carePage.focus.action;
  await page.onCarePageAction({ detail: action });

  assert.equal(markReadCalls, 0);
  assert.equal(page.data.detailList[0].readState, "UNREAD");
  assert.equal(page.data.detailList[0].readText, "未读");
});
