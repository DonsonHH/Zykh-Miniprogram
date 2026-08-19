const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/familyDetail/index.js");

function loadFamilyDetailPage(api, context = {}) {
  let definition = null;
  const pureApi = require("../miniprogram/utils/api");
  const gateway = Object.assign({}, pureApi, { getRecentVitalsStrict: async () => [] }, api);
  const source = fs.readFileSync(pagePath, "utf8");
  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(modulePath) {
      if (modulePath.includes("carePlan")) return require("../miniprogram/utils/carePlan");
      if (modulePath.includes("carePage")) return require("../miniprogram/utils/carePage");
      if (modulePath.includes("medicationSafetyEvents")) return require("../miniprogram/modules/medicationSafetyEvents");
      if (modulePath.includes("vitalsAttribution")) return require("../miniprogram/modules/vitalsAttribution");
      if (modulePath.includes("personaVisibility")) return require("../miniprogram/modules/personaVisibility");
      if (modulePath.includes("capabilitySnapshot")) return require("../miniprogram/modules/capabilitySnapshot");
      if (modulePath.includes("realtime")) return context.realtime || { subscribe: () => () => {} };
      if (modulePath.includes("deviceSession")) {
        return context.deviceSession || { runAfterDeviceSessionReady: callback => callback() };
      }
      return gateway;
    },
    getApp: context.getApp || (() => ({ globalData: { deviceId: "box-1" } })),
    wx: context.wx || { setNavigationBarTitle() {} },
    console,
  }, { filename: pagePath });
  definition.setData = next => Object.assign(definition.data, next);
  return definition;
}

test("family detail includes only exact member vitals from its recent 80-row window", async () => {
  const vitalsRequests = [];
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { deviceId: "box-1", online: true },
      serviceUsers: [
        { id: "person-current", name: "王奶奶", personaGeneration: "generation-2" },
        { id: "same-name-other-id", name: "王奶奶", personaGeneration: "generation-2" },
      ],
      capabilities: { vitalsAttribution: "v1" },
      plans: [],
      inquiries: [],
      commands: [],
    }),
    getRecentVitalsStrict: async (limit, deviceId) => {
      vitalsRequests.push({ limit, deviceId });
      return [
        {
          recordId: "vitals-current",
          personId: "person-current",
          personName: "王奶奶",
          personaGeneration: "generation-2",
          attributionSource: "INQUIRY_SESSION",
          createdAt: "2026-08-10 10:00:00",
          heartRate: 72,
          spo2: 98,
          bodyTemp: 36.5,
          quality: "good",
        },
        {
          recordId: "vitals-old-generation",
          personId: "person-current",
          personName: "王奶奶",
          personaGeneration: "generation-1",
          attributionSource: "INQUIRY_SESSION",
        },
        {
          recordId: "vitals-same-name-other-id",
          personId: "same-name-other-id",
          personName: "王奶奶",
          personaGeneration: "generation-2",
          attributionSource: "INQUIRY_SESSION",
        },
        {
          recordId: "vitals-standalone",
          personId: "person-current",
          personName: "王奶奶",
          personaGeneration: "generation-2",
          attributionSource: "STANDALONE",
        },
        {
          recordId: "vitals-broken",
          personName: "王奶奶",
          personaGeneration: "generation-2",
          attributionSource: "INQUIRY_SESSION",
        },
      ];
    },
    getCapabilitiesStrict: async () => {
      throw new Error("safety capability refresh unavailable");
    },
    getMedicationSafetyEventsStrict: async () => ({ items: [], nextCursor: "" }),
  });
  page.onLoad({
    personId: "person-current",
    personaGeneration: "generation-2",
    personName: encodeURIComponent("王奶奶"),
  });

  await page.load();

  assert.deepEqual(vitalsRequests, [{ limit: 80, deviceId: "box-1" }]);
  assert.deepEqual(Array.from(page.data.vitals, item => item.recordId), ["vitals-current"]);
  const vitalsOverview = page.data.carePage.overview.find(item => item.key === "family-person-vitals-count");
  assert.equal(vitalsOverview.value, "1");
  const vitalsSection = page.data.carePage.sections.find(section => section.key === "family-person-vitals");
  assert.equal(vitalsSection.items.length, 1);
  assert.match(vitalsSection.supporting, /最近 80 条/);

  page.updatePersonPage({ safetyLoadingMore: true });
  const refreshedVitalsOverview = page.data.carePage.overview.find(item => item.key === "family-person-vitals-count");
  const refreshedVitalsSection = page.data.carePage.sections.find(section => section.key === "family-person-vitals");
  assert.equal(refreshedVitalsOverview.value, "1");
  assert.equal(refreshedVitalsSection.items.length, 1);
});

test("family detail refuses an identity tuple that is both active and tombstoned", async () => {
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { deviceId: "box-1", online: true },
      serviceUsersSnapshotComplete: true,
      serviceUsers: [
        { id: "person-conflict", name: "不应复活", personaGeneration: "v2", archived: false },
        { id: "person-conflict", name: "归档凭证", personaGeneration: "v2", archived: true },
      ],
      plans: [],
      inquiries: [],
      commands: [],
    }),
    getRecentVitalsStrict: async () => [],
    getCapabilitiesStrict: async () => ({
      capabilities: {
        personaLifecycle: "v1",
        vitalsAttribution: "v1",
        medicationSafetyEvents: "v1",
      },
    }),
    getMedicationSafetyEventsStrict: async () => ({ items: [], nextCursor: "" }),
  });
  page.onLoad({
    personId: "person-conflict",
    personaGeneration: "v2",
    personName: encodeURIComponent("不应复活"),
  });

  await page.load();

  assert.deepEqual(Object.keys(page.data.selectedUser), []);
  assert.equal(page.data.carePage.phase.kind, "empty");
  assert.match(page.data.carePage.phase.message, /更新或归档/);
});

function validSafetyEvent(overrides = {}) {
  return Object.assign({
    eventId: "safety-current",
    type: "MEDICATION_SAFETY_EVENT",
    personId: "person-current",
    personaGeneration: "generation-2",
    personName: "王奶奶",
    medicineName: "阿司匹林",
    checkStatus: "BLOCKED",
    dispenseStatus: "BLOCKED",
    readState: "UNREAD",
    summary: "存在用药禁忌",
    occurredAt: "2026-08-10 09:15:00",
  }, overrides);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("family detail retries its failed first snapshot through the CarePage error action", async () => {
  let failRead = true;
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => {
      if (failRead) throw new Error("person snapshot unavailable");
      return {
        device: { deviceId: "box-1", online: true },
        serviceUsers: [{ id: "person-current", name: "王奶奶", personaGeneration: "generation-2" }],
        plans: [],
        inquiries: [],
        commands: [],
      };
    },
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  });
  page.onLoad({
    personId: "person-current",
    personaGeneration: "generation-2",
    personName: encodeURIComponent("王奶奶"),
  });

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "error");
  assert.equal(page.data.carePage.phase.action.id, "family.person.retry");
  failRead = false;

  const retrying = page.onCarePageAction({ detail: page.data.carePage.phase.action });

  assert.equal(page.data.carePage.phase.kind, "loading");
  await retrying;
  assert.equal(page.data.carePage.phase.kind, "ready");
});

test("a stable family identity sees only its current-generation plans, completed inquiries, and safety events", async () => {
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { online: true },
      serviceUsers: [
        { id: "person-current", name: "王奶奶", personaGeneration: "generation-2", profile: "高血压" },
      ],
      plans: [
        { id: "plan-current", service_user_id: "person-current", personaGeneration: "generation-2", time: "09:00", medicine: "氨氯地平", status: "pending", due_today: true },
        { id: "plan-old", service_user_id: "person-current", personaGeneration: "generation-1", time: "10:00", medicine: "旧代次药品", status: "pending", due_today: true },
        { id: "plan-by-name", target_user_name: "王奶奶", personaGeneration: "generation-2", time: "11:00", medicine: "同名猜测药品", status: "pending", due_today: true },
      ],
      inquiries: [
        { id: "inquiry-current", person_id: "person-current", persona_generation: "generation-2", person_name: "王奶奶", topic: "头晕", summary: "注意起身缓慢", stage: "result", next_action: "complete", updated_at: "2026-08-10 08:30:00" },
        { id: "inquiry-old", person_id: "person-current", persona_generation: "generation-1", person_name: "王奶奶", topic: "旧代次问询", summary: "不应显示", stage: "result", next_action: "complete" },
        { id: "inquiry-by-name", person_name: "王奶奶", persona_generation: "generation-2", topic: "同名问询", summary: "不应显示", stage: "result", next_action: "complete" },
        { id: "inquiry-progress", person_id: "person-current", persona_generation: "generation-2", person_name: "王奶奶", topic: "进行中问询", summary: "不应显示", stage: "symptoms", next_action: "ask" },
      ],
      commands: [],
    }),
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({
      items: [
        validSafetyEvent(),
        validSafetyEvent({ eventId: "safety-old", personaGeneration: "generation-1", medicineName: "旧代次药品" }),
        validSafetyEvent({ eventId: "safety-by-name", personId: "", personName: "王奶奶", medicineName: "同名猜测药品" }),
      ],
      nextCursor: "",
    }),
  });

  page.onLoad({
    personId: "person-current",
    personaGeneration: "generation-2",
    personName: encodeURIComponent("王奶奶"),
  });
  await page.load();

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.carePage.focus.title, "王奶奶");
  assert.deepEqual(Array.from(page.data.carePage.overview, item => item.value), ["1", "1", "1", "0"]);
  assert.equal(page.data.carePage.overview[1].label, "窗口内问询");

  const planSection = page.data.carePage.sections.find(section => section.key === "family-person-plans");
  const inquirySection = page.data.carePage.sections.find(section => section.key === "family-person-inquiries");
  const safetySection = page.data.carePage.sections.find(section => section.key === "family-person-safety");
  assert.deepEqual(Array.from(planSection.items, item => item.key), ["family-plan-plan-current"]);
  assert.deepEqual(Array.from(inquirySection.items, item => item.key), ["family-inquiry-inquiry-current"]);
  assert.match(inquirySection.supporting, /最近 60 条同步窗口/);
  assert.deepEqual(Array.from(safetySection.items, item => item.key), ["family-safety-safety-current"]);
  assert.equal(planSection.items[0].action, null);
  assert.equal(inquirySection.items[0].action, null);
  assert.equal(safetySection.items[0].action.payload.eventId, "safety-current");
});

test("a family safety row opens the shared records detail and leaves read handling to that page", async () => {
  const app = { globalData: { deviceId: "box-1" } };
  const tabRoutes = [];
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { online: true },
      serviceUsers: [
        { id: "person-current", name: "王奶奶", personaGeneration: "generation-2" },
      ],
      plans: [],
      inquiries: [],
      commands: [],
    }),
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({
      items: [validSafetyEvent()],
      nextCursor: "",
    }),
  }, {
    getApp: () => app,
    wx: {
      setNavigationBarTitle() {},
      switchTab(request) {
        tabRoutes.push(request.url);
      },
    },
  });

  page.onLoad({
    personId: "person-current",
    personaGeneration: "generation-2",
    personName: encodeURIComponent("王奶奶"),
  });
  await page.load();

  const safetySection = page.data.carePage.sections.find(section => section.key === "family-person-safety");
  const action = safetySection.items[0].action;
  assert.equal(action.id, "family.person.safety.open.safety-current");
  assert.deepEqual(action.payload, { eventId: "safety-current" });

  page.onCarePageAction({ detail: action });

  assert.equal(app.globalData.pendingCareRecord.type, "safety");
  assert.equal(app.globalData.pendingCareRecord.eventId, "safety-current");
  assert.equal(app.globalData.pendingCareRecord.deviceId, "box-1");
  assert.deepEqual(tabRoutes, ["/pages/records/index"]);
});

test("a stale family safety row cannot route after the active medication box changes", async () => {
  const app = { globalData: { deviceId: "box-1" } };
  const tabRoutes = [];
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { online: true },
      serviceUsers: [{ id: "person-current", name: "王奶奶", personaGeneration: "generation-2" }],
      plans: [],
      inquiries: [],
      commands: [],
    }),
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [validSafetyEvent()], nextCursor: "" }),
  }, {
    getApp: () => app,
    wx: {
      setNavigationBarTitle() {},
      switchTab(request) { tabRoutes.push(request.url); },
    },
  });
  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("王奶奶") });
  await page.load();
  const action = page.data.carePage.sections[2].items[0].action;

  app.globalData.deviceId = "box-2";
  page.onCarePageAction({ detail: action });

  assert.equal(app.globalData.pendingCareRecord, undefined);
  assert.deepEqual(tabRoutes, []);
});

test("family safety history consumes cursors, deduplicates rows, and keeps generation isolation across pages", async () => {
  const listRequests = [];
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { online: true },
      serviceUsers: [
        { id: "person-current", name: "王奶奶", personaGeneration: "generation-2" },
      ],
      plans: [],
      inquiries: [],
      commands: [],
    }),
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => {
      listRequests.push(Object.assign({}, options));
      if (!options.cursor) {
        return {
          items: [
            validSafetyEvent(),
            validSafetyEvent({ eventId: "safety-old-first", personaGeneration: "generation-1" }),
          ],
          nextCursor: "cursor-2",
        };
      }
      if (options.cursor === "cursor-2") {
        return {
          items: [
            validSafetyEvent(),
            validSafetyEvent({ eventId: "safety-next", medicineName: "氨氯地平", occurredAt: "2026-08-09 09:15:00" }),
            validSafetyEvent({ eventId: "safety-old-next", personaGeneration: "generation-1" }),
          ],
          nextCursor: "cursor-3",
        };
      }
      return {
        items: [validSafetyEvent({ eventId: "safety-final", medicineName: "缬沙坦", occurredAt: "2026-08-08 09:15:00" })],
        nextCursor: "",
      };
    },
  });

  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("王奶奶") });
  await page.load();
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current"]);
  assert.equal(page.data.safetyState.nextCursor, "cursor-2");
  assert.equal(page.data.carePage.overview[2].value, "至少 1");

  await page.loadMoreSafetyEvents();
  assert.equal(listRequests[1].personId, "person-current");
  assert.equal(listRequests[1].cursor, "cursor-2");
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current", "safety-next"]);
  assert.equal(page.data.safetyState.nextCursor, "cursor-3");
  assert.equal(page.data.carePage.overview[2].value, "至少 2");
  let safetySection = page.data.carePage.sections.find(section => section.key === "family-person-safety");
  assert.equal(safetySection.more.label, "加载更多");

  await page.loadMoreSafetyEvents();
  assert.equal(listRequests[2].cursor, "cursor-3");
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current", "safety-next", "safety-final"]);
  assert.equal(page.data.safetyState.nextCursor, "");
  assert.equal(page.data.carePage.overview[2].value, "3");
  safetySection = page.data.carePage.sections.find(section => section.key === "family-person-safety");
  assert.equal(safetySection.more, null);
});

test("a late realtime first-page refresh does not discard safety pages loaded after it started", async () => {
  const refreshSnapshot = deferred();
  const refreshSafety = deferred();
  let snapshotCalls = 0;
  let firstPageCalls = 0;
  const snapshot = {
    device: { online: true },
    serviceUsers: [{ id: "person-current", name: "王奶奶", personaGeneration: "generation-2" }],
    plans: [],
    inquiries: [],
    commands: [],
  };
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? snapshot : refreshSnapshot.promise;
    },
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => {
      if (options.cursor === "cursor-2") {
        return {
          items: [validSafetyEvent({ eventId: "safety-next", medicineName: "氨氯地平" })],
          nextCursor: "cursor-3",
        };
      }
      firstPageCalls += 1;
      if (firstPageCalls === 1) return { items: [validSafetyEvent()], nextCursor: "cursor-2" };
      return refreshSafety.promise;
    },
  });

  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("王奶奶") });
  await page.load();

  const refresh = page.load();
  await Promise.resolve();
  await page.loadMoreSafetyEvents();
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current", "safety-next"]);

  refreshSnapshot.resolve(snapshot);
  refreshSafety.resolve({ items: [validSafetyEvent()], nextCursor: "cursor-2" });
  await refresh;

  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current", "safety-next"]);
  assert.equal(page.data.safetyState.nextCursor, "cursor-3");
});

test("a safety page whose cursor does not advance stays retryable instead of claiming the history is complete", async () => {
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { online: true },
      serviceUsers: [{ id: "person-current", name: "王奶奶", personaGeneration: "generation-2" }],
      plans: [],
      inquiries: [],
      commands: [],
    }),
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => (
      options.cursor
        ? { items: [validSafetyEvent({ eventId: "safety-next" })], nextCursor: "cursor-2" }
        : { items: [validSafetyEvent()], nextCursor: "cursor-2" }
    ),
  });

  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("王奶奶") });
  await page.load();
  await page.loadMoreSafetyEvents();

  assert.equal(page.data.safetyState.nextCursor, "cursor-2");
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current"]);
  assert.match(page.data.safetyLoadMoreError, /未完成/);
  const safetySection = page.data.carePage.sections.find(section => section.key === "family-person-safety");
  assert.equal(safetySection.more.label, "重试加载");
  assert.doesNotMatch(safetySection.supporting, /已显示全部/);
});

test("family detail preserves paged safety history only across transient refresh failures", async () => {
  let mode = "ready";
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { deviceId: "box-1", online: true },
      serviceUsers: [{ id: "person-current", name: "王奶奶", personaGeneration: "generation-2" }],
      plans: [],
      inquiries: [],
      commands: [],
    }),
    getCapabilitiesStrict: async () => {
      if (mode === "unknown") throw new Error("ping unavailable");
      return { capabilities: mode === "unsupported" ? {} : { medicationSafetyEvents: "v1" } };
    },
    getMedicationSafetyEventsStrict: async options => {
      if (mode === "error") throw new Error("list unavailable");
      if (mode === "forbidden") {
        const error = new Error("membership required");
        error.code = "FORBIDDEN";
        throw error;
      }
      return options.cursor
        ? { items: [validSafetyEvent({ eventId: "safety-next", medicineName: "氨氯地平" })], nextCursor: "cursor-3" }
        : { items: [validSafetyEvent()], nextCursor: "cursor-2" };
    },
  });
  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("王奶奶") });

  await page.load();
  await page.loadMoreSafetyEvents();
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current", "safety-next"]);

  mode = "error";
  await page.load();
  assert.equal(page.data.safetyState.availability, "error");
  assert.equal(page.data.safetyState.stale, true);
  assert.equal(page.data.safetyState.nextCursor, "cursor-3");
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current", "safety-next"]);
  assert.match(page.data.carePage.sections[2].supporting, /可能不是最新/);

  mode = "unknown";
  await page.load();
  assert.equal(page.data.safetyState.availability, "unknown");
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-current", "safety-next"]);

  mode = "unsupported";
  await page.load();
  assert.equal(page.data.safetyState.availability, "unsupported");
  assert.equal(page.data.safetyState.events.length, 0);

  mode = "ready";
  await page.load();
  mode = "forbidden";
  await page.load();
  assert.equal(page.data.safetyState.availability, "forbidden");
  assert.equal(page.data.safetyState.events.length, 0);
});

test("family detail pins a load to its starting medication box and ignores a late old-box response", async () => {
  const oldSnapshot = deferred();
  const requests = { snapshots: [], vitals: [], capabilities: [], safety: [] };
  const snapshotFor = deviceId => ({
    device: { deviceId, online: true },
    serviceUsers: [{
      id: "person-current",
      name: deviceId === "new-box" ? "新药箱成员" : "旧药箱成员",
      personaGeneration: "generation-2",
    }],
    plans: [],
    inquiries: [],
    commands: [],
  });
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async options => {
      requests.snapshots.push(options.deviceId);
      return options.deviceId === "old-box" ? oldSnapshot.promise : snapshotFor(options.deviceId);
    },
    getRecentVitalsStrict: async (limit, deviceId) => {
      requests.vitals.push({ limit, deviceId });
      return [{
        recordId: `vitals-${deviceId}`,
        personId: "person-current",
        personName: deviceId === "new-box" ? "新药箱成员" : "旧药箱成员",
        personaGeneration: "generation-2",
        attributionSource: "INQUIRY_SESSION",
      }];
    },
    getCapabilitiesStrict: async deviceId => {
      requests.capabilities.push(deviceId);
      return { capabilities: { medicationSafetyEvents: "v1", vitalsAttribution: "v1" } };
    },
    getMedicationSafetyEventsStrict: async options => {
      requests.safety.push(options.deviceId);
      return {
        items: [validSafetyEvent({
          eventId: `safety-${options.deviceId}`,
          medicineName: options.deviceId === "new-box" ? "新药箱药品" : "旧药箱药品",
        })],
        nextCursor: "",
      };
    },
  }, {
    getApp: () => ({ globalData: { deviceId: "old-box" } }),
  });
  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("家人") });

  const staleLoad = page.load();
  page.setData({ deviceId: "new-box" });
  await page.load();
  oldSnapshot.resolve(snapshotFor("old-box"));
  await staleLoad;

  assert.equal(page.data.deviceId, "new-box");
  assert.equal(page.data.carePage.focus.title, "新药箱成员");
  assert.deepEqual(Array.from(page.data.vitals, record => record.recordId), ["vitals-new-box"]);
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-new-box"]);
  assert.deepEqual(requests.snapshots, ["old-box", "new-box"]);
  assert.deepEqual(requests.vitals, [
    { limit: 80, deviceId: "old-box" },
    { limit: 80, deviceId: "new-box" },
  ]);
  assert.deepEqual(requests.capabilities, ["old-box", "new-box"]);
  assert.deepEqual(requests.safety, ["old-box", "new-box"]);
});

test("a late old-box load failure cannot replace a ready new-box family detail", async () => {
  const oldSnapshot = deferred();
  const snapshotFor = deviceId => ({
    device: { deviceId, online: true },
    serviceUsers: [{
      id: "person-current",
      name: deviceId === "new-box" ? "新药箱成员" : "旧药箱成员",
      personaGeneration: "generation-2",
    }],
    plans: [],
    inquiries: [],
    commands: [],
  });
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async options => (
      options.deviceId === "old-box" ? oldSnapshot.promise : snapshotFor(options.deviceId)
    ),
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => ({
      items: [validSafetyEvent({ eventId: `safety-${options.deviceId}` })],
      nextCursor: "",
    }),
  });
  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("家人") });
  page.setData({ deviceId: "old-box" });

  const staleLoad = page.load();
  page.setData({ deviceId: "new-box" });
  await page.load();
  oldSnapshot.reject(new Error("old box unavailable"));
  await staleLoad;

  assert.equal(page.data.deviceId, "new-box");
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.carePage.focus.title, "新药箱成员");
});

test("family detail waits for device-session resolution, then clears a switched box and reads once", async () => {
  let activeDeviceId = "old-box";
  const ready = deferred();
  let realtimeOptions = null;
  const page = loadFamilyDetailPage({}, {
    getApp: () => ({ globalData: { deviceId: activeDeviceId } }),
    deviceSession: {
      runAfterDeviceSessionReady: callback => ready.promise.then(callback),
    },
    realtime: {
      subscribe(callback, query, options) {
        realtimeOptions = options;
        return () => {};
      },
    },
  });
  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("王奶奶") });
  page.setData({
    selectedUser: { id: "person-current", name: "旧药箱人物" },
    plans: [{ id: "old-plan" }],
    inquiries: [{ id: "old-inquiry" }],
    vitals: [{ recordId: "old-vitals" }],
    safetyState: { availability: "ready", events: [validSafetyEvent()], nextCursor: "cursor-2" },
    safetyLoadingMore: true,
    safetyLoadMoreError: "旧错误",
    hasLoaded: true,
  });
  let loads = 0;
  page.load = () => { loads += 1; return Promise.resolve(); };

  activeDeviceId = "new-box";
  const showing = page.onShow();

  assert.equal(loads, 0);
  assert.equal(realtimeOptions, null);
  ready.resolve();
  await showing;

  assert.equal(page.data.deviceId, "new-box");
  assert.deepEqual(Object.keys(page.data.selectedUser), []);
  assert.deepEqual(Array.from(page.data.plans), []);
  assert.deepEqual(Array.from(page.data.inquiries), []);
  assert.deepEqual(Array.from(page.data.vitals), []);
  assert.deepEqual(Array.from(page.data.safetyState.events), []);
  assert.equal(page.data.safetyLoadingMore, false);
  assert.equal(page.data.safetyLoadMoreError, "");
  assert.equal(page.data.hasLoaded, false);
  assert.equal(page.data.carePage.phase.kind, "loading");
  assert.equal(loads, 1);
  assert.equal(realtimeOptions.immediate, false);
});

test("late safety-page success and failure cannot rebuild a different persona generation", async () => {
  const success = deferred();
  const failure = deferred();
  const pendingPages = [success, failure];
  const page = loadFamilyDetailPage({
    getSnapshotStrict: async () => ({
      device: { deviceId: "box-1", online: true },
      serviceUsers: [{ id: "person-current", name: "旧代人物", personaGeneration: "generation-2" }],
      plans: [],
      inquiries: [],
      commands: [],
    }),
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async options => (
      options.cursor
        ? pendingPages.shift().promise
        : { items: [validSafetyEvent()], nextCursor: "cursor-2" }
    ),
  });
  page.onLoad({ personId: "person-current", personaGeneration: "generation-2", personName: encodeURIComponent("旧代人物") });
  await page.load();
  const oldSafetyState = page.data.safetyState;

  const setNewPersona = marker => page.setData({
    personScope: { personId: "person-current", personaGeneration: "generation-3", personName: "新代人物" },
    selectedUser: { id: "person-current", name: "新代人物", personaGeneration: "generation-3" },
    safetyState: {
      availability: "ready",
      deviceId: "box-1",
      events: [validSafetyEvent({ id: "safety-new-persona", eventId: "safety-new-persona", personaGeneration: "generation-3" })],
      nextCursor: "",
    },
    safetyLoadingMore: false,
    safetyLoadMoreError: "",
    carePage: { marker },
  });

  const lateSuccess = page.loadMoreSafetyEvents();
  setNewPersona("new-after-success");
  success.resolve({
    items: [validSafetyEvent({ eventId: "safety-old-more" })],
    nextCursor: "cursor-3",
  });
  await lateSuccess;
  assert.equal(page.data.carePage.marker, "new-after-success");
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-new-persona"]);

  page.setData({
    personScope: { personId: "person-current", personaGeneration: "generation-2", personName: "旧代人物" },
    selectedUser: { id: "person-current", name: "旧代人物", personaGeneration: "generation-2" },
    safetyState: oldSafetyState,
    safetyLoadingMore: false,
    safetyLoadMoreError: "",
  });
  const lateFailure = page.loadMoreSafetyEvents();
  setNewPersona("new-after-failure");
  failure.reject(new Error("old page failed"));
  await lateFailure;
  assert.equal(page.data.carePage.marker, "new-after-failure");
  assert.equal(page.data.safetyLoadMoreError, "");
  assert.deepEqual(Array.from(page.data.safetyState.events, event => event.id), ["safety-new-persona"]);
});

test("the family-person detail is a registered CareScreen route with no approval or cabinet-control surface", () => {
  const root = path.join(__dirname, "..");
  const app = JSON.parse(fs.readFileSync(path.join(root, "miniprogram/app.json"), "utf8"));
  const layout = fs.readFileSync(path.join(root, "miniprogram/pages/familyDetail/index.wxml"), "utf8");
  const logic = fs.readFileSync(pagePath, "utf8");

  assert.ok(app.pages.includes("pages/familyDetail/index"));
  assert.match(layout, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/);
  assert.doesNotMatch(`${layout}\n${logic}`, /OPEN_CABINET|approve|approval|unlock|放行|批准|开柜/);
  assert.doesNotMatch(logic, /markMedicationSafetyEventRead|\.markRead\(/);
});
