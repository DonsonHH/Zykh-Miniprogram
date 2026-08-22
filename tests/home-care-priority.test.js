const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const inquiryApi = require("../miniprogram/utils/api");

const pagePath = path.join(__dirname, "../miniprogram/pages/index/index.js");
const layoutPath = path.join(__dirname, "../miniprogram/pages/index/index.wxml");

function todayAt(time) {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${time}:00`;
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

function loadHomePage(snapshot, vitals = [], wx = {}, medicines = [], expirySummary = null, device = { online: true }, apiOverrides = {}) {
  let definition = null;
  const source = fs.readFileSync(pagePath, "utf8");
  const normalizedDevice = device && device.connection
    ? device
    : Object.assign({}, device, device && device.online === true ? {
      heartbeatAgeMs: 0,
      lastSeenAtEpochMs: Date.now(),
      connection: { state: "online", online: true, heartbeatAgeMs: 0 },
    } : {});
  const normalizedMedicines = (medicines || []).map((medicine, index) => Object.assign({
    medicineId: `legacy-slot-${medicine.slot || index + 1}`,
    storageBox: "DAILY",
  }, medicine));
  const api = {
    buildHeader: () => ({}),
    getDevice: async () => normalizedDevice,
    getDeviceStrict: apiOverrides.getDeviceStrict || (async () => normalizedDevice),
    getMedicines: async () => normalizedMedicines,
    getMedicinesStrict: apiOverrides.getMedicinesStrict || (async () => normalizedMedicines),
    getRecentRecords: async () => [],
    getRecentRecordsStrict: apiOverrides.getRecentRecordsStrict || (async () => []),
    getRecentVitals: async () => vitals,
    getRecentVitalsStrict: apiOverrides.getRecentVitalsStrict || (async () => vitals),
    getRecentCommands: async () => [],
    getRecentCommandsStrict: apiOverrides.getRecentCommandsStrict || (async () => []),
    getSnapshot: async () => snapshot,
    getSnapshotStrict: apiOverrides.getSnapshotStrict || (async () => snapshot),
    normalizeVitals: item => item,
    shouldShowCaregiverInquiry: item => item.caregiverVisible !== false,
    shouldShowInquiryForServiceUsers: inquiryApi.shouldShowInquiryForServiceUsers,
    shouldShowPlanForServiceUsers: inquiryApi.shouldShowPlanForServiceUsers,
    getCapabilitiesStrict: apiOverrides.getCapabilitiesStrict || (async () => ({
      schemaVersion: 2,
      schemaRevision: "2.2-miniprogram",
      capabilities: {},
    })),
    getMedicationSafetyEventsStrict: apiOverrides.getMedicationSafetyEventsStrict || (async () => ({ items: [] })),
    getMedicationSafetyEventDetail: apiOverrides.getMedicationSafetyEventDetail || (async () => ({})),
    markMedicationSafetyEventRead: apiOverrides.markMedicationSafetyEventRead || (async eventId => ({ eventId, ok: true })),
    requestMedicationReminder: apiOverrides.requestMedicationReminder || (async () => ({ _id: "reminder", status: "pending" })),
  };
  const app = apiOverrides.app || { globalData: { deviceId: "box-1" } };

  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(modulePath) {
      if (modulePath.includes("utils/api")) return api;
      if (modulePath.includes("utils/realtime")) {
        return apiOverrides.realtime || { subscribe: () => () => {} };
      }
      if (modulePath.includes("utils/dateTime")) {
        return require("../miniprogram/utils/dateTime");
      }
      if (modulePath.includes("utils/deviceSession")) {
        return Object.assign({}, require("../miniprogram/utils/deviceSession"), {
          runAfterDeviceSessionReady(callback) {
            if (app.globalData.deviceSessionResolved !== true
              && typeof app.waitForDeviceSession === "function") {
              return Promise.resolve(app.waitForDeviceSession()).then(callback);
            }
            return callback();
          },
        });
      }
      if (modulePath.includes("modules/personaVisibility")) {
        return require("../miniprogram/modules/personaVisibility");
      }
      if (modulePath.includes("modules/vitalsAttribution")) {
        return require("../miniprogram/modules/vitalsAttribution");
      }
      if (modulePath.includes("modules/capabilitySnapshot")) {
        return require("../miniprogram/modules/capabilitySnapshot");
      }
      if (modulePath.includes("utils/carePage")) return require("../miniprogram/utils/carePage");
      if (modulePath.includes("utils/carePlan")) return require("../miniprogram/utils/carePlan");
      if (modulePath.includes("utils/offlinePageCache")) return require("../miniprogram/utils/offlinePageCache");
      if (modulePath.includes("utils/medicineLibrary")) return require("../miniprogram/utils/medicineLibrary");
      if (modulePath.includes("utils/cabinetView")) return require("../miniprogram/utils/cabinetView");
      if (modulePath.includes("modules/medicationSafetyEvents")) {
        return require("../miniprogram/modules/medicationSafetyEvents");
      }
      if (modulePath.includes("utils/expiry")) {
        return {
          summarizeExpiry: input => {
            const summary = (typeof expirySummary === "function" ? expirySummary(input) : expirySummary) || ({
              attention: [],
              expiredCount: 0,
              expiringCount: 0,
              missingCount: 0,
              validCount: 0,
              medicines: [],
              nextAttention: null,
            });
            return Object.assign({}, summary, {
              attention: (summary.attention || []).map((item, index) => Object.assign({
                medicineId: `legacy-slot-${item.slot || index + 1}`,
                storageBox: "DAILY",
              }, item)),
            });
          },
        };
      }
      throw new Error(`unexpected module ${modulePath}`);
    },
    wx,
    getApp: () => app,
  }, { filename: pagePath });

  definition.data = Object.assign({}, definition.data);
  definition.setData = next => Object.assign(definition.data, next);
  definition._testApp = app;
  return definition;
}

test("the dashboard exposes a retry action when any first strict read fails", async () => {
  const strictReads = [
    "getDeviceStrict",
    "getMedicinesStrict",
    "getRecentCommandsStrict",
    "getSnapshotStrict",
    "getRecentVitalsStrict",
  ];

  for (const method of strictReads) {
    const page = loadHomePage(
      { plans: [], inquiries: [] },
      [],
      {},
      [],
      null,
      { online: true },
      {
        [method]: async () => {
          throw new Error(`${method} unavailable`);
        },
      },
    );

    await page.load();

    assert.equal(page.data.carePage.phase.kind, "error", method);
    assert.equal(page.data.carePage.phase.action.id, "home.retry", method);
  }
});

test("the dashboard never reads legacy dispense records", async () => {
  let legacyRecordReads = 0;
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: true },
    {
      getRecentRecordsStrict: async () => {
        legacyRecordReads += 1;
        return [{ id: "legacy-dispense", type: "DISPENSE" }];
      },
    },
  );

  await page.load();

  assert.equal(legacyRecordReads, 0);
  assert.equal(page.data.timeline.some(item => item.source === "record"), false);
});

test("the dashboard keeps its last care snapshot and marks it stale when a refresh fails", async () => {
  let snapshotReads = 0;
  const page = loadHomePage(
    {
      plans: [{ id: "evening-dose", time: "20:00", medicine: "降压药", status: "pending", due_today: true }],
      inquiries: [],
    },
    [],
    {},
    [],
    null,
    { online: true },
    {
      getSnapshotStrict: async () => {
        snapshotReads += 1;
        if (snapshotReads > 1) throw new Error("refresh unavailable");
        return {
          plans: [{ id: "evening-dose", time: "20:00", medicine: "降压药", status: "pending", due_today: true }],
          inquiries: [],
        };
      },
    },
  );

  await page.load();
  const focusTitle = page.data.carePage.focus.title;
  const todoIds = Array.from(page.data.todoItems, item => item.id);

  await page.load();

  assert.equal(page.data.carePage.focus.title, focusTitle);
  assert.deepEqual(Array.from(page.data.todoItems, item => item.id), todoIds);
  assert.match(page.data.carePage.focus.supporting, /已保存/);
});

test("switching medication boxes clears the old dashboard and cannot send its reminder to the new box", async () => {
  const app = { globalData: { deviceId: "box-a" } };
  const reminderCalls = [];
  const toastTitles = [];
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {
      showModal(request) {
        request.success({ confirm: true });
      },
      showToast(request) {
        toastTitles.push(request.title);
      },
    },
    [],
    null,
    { online: true },
    {
      app,
      getSnapshotStrict: async options => {
        if (options.deviceId === "box-b") throw new Error("new box unavailable");
        return {
          serviceUsers: [{ id: "person-a", name: "家人甲" }],
          plans: [{
            id: "plan-a",
            service_user_id: "person-a",
            time: "09:00",
            medicine: "甲药",
            status: "pending",
            due_today: true,
          }],
          inquiries: [],
        };
      },
      requestMedicationReminder: async (plan, options) => {
        reminderCalls.push({ plan, options });
        return { _id: "reminder-a", status: "pending" };
      },
    },
  );

  await page.load();
  const oldPlan = page.data.reminderPlan;
  assert.equal(page.data.deviceId, "box-a");

  app.globalData.deviceId = "box-b";
  await page.sendMedicineReminder(oldPlan);
  assert.equal(reminderCalls.length, 0);
  assert.match(toastTitles.join(" "), /药箱已切换/);

  const switching = page.load();
  assert.equal(page.data.carePage.phase.kind, "loading");
  assert.equal(page.data.todoItems.length, 0);
  await switching;

  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.carePage.phase.kind, "error");
  assert.equal(page.data.reminderPlan.id, undefined);
});

test("rapid reminder taps submit only one command and expose the in-flight state", async () => {
  const request = deferred();
  const reminderCalls = [];
  const page = loadHomePage(
    {
      plans: [{
        id: "morning-dose",
        time: "09:00",
        medicine: "降压药",
        target_user_name: "张三",
        status: "pending",
        due_today: true,
      }],
      inquiries: [],
    },
    [],
    {
      showModal(options) {
        options.success({ confirm: true });
      },
      showToast() {},
    },
    [],
    null,
    { online: true },
    {
      requestMedicationReminder: async (plan, options) => {
        reminderCalls.push({ plan, options });
        return request.promise;
      },
    },
  );

  await page.load();
  const plan = page.data.reminderPlan;
  const first = page.sendMedicineReminder(plan);
  const second = page.sendMedicineReminder(plan);
  await Promise.resolve();

  assert.equal(reminderCalls.length, 1);
  assert.equal(page.data.reminderSubmitting, true);
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.label, "查看计划用药");

  request.resolve({ _id: "reminder-one", status: "pending" });
  await Promise.all([first, second]);

  assert.equal(page.data.reminderSubmitting, false);
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.label, "查看计划用药");
});

test("the dashboard retry action reloads a failed first snapshot", async () => {
  let deviceReads = 0;
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: true },
    {
      getDeviceStrict: async () => {
        deviceReads += 1;
        if (deviceReads === 1) throw new Error("temporarily unavailable");
        return { online: true };
      },
    },
  );

  await page.load();
  const retrying = page.onCarePageAction({ detail: page.data.carePage.phase.action });

  assert.equal(page.data.carePage.phase.kind, "loading");
  await retrying;
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(deviceReads, 2);
});

test("the dashboard labels a true empty vitals snapshot as having no measurement", async () => {
  const page = loadHomePage({ plans: [], inquiries: [] }, []);

  await page.load();

  assert.equal(page.data.latestVitalsText, "暂无测量结果");
});

test("today's primary reminder excludes medication plans that are already complete", async () => {
  const page = loadHomePage({
    plans: [
      { id: "done", time: "08:00", medicine: "维生素", status: "done" },
      { id: "pending", time: "20:00", medicine: "降压药", status: "pending" },
    ],
    inquiries: [],
  });

  await page.load();

  assert.equal(page.data.planItems.length, 1);
  assert.equal(page.data.planItems[0].planKey, "pending");
  assert.equal(page.data.reminderPlan.id, "pending");
});

test("today's dashboard does not remind for future or skipped medication plans", async () => {
  const page = loadHomePage({
    plans: [
      { id: "future", time: "08:00", medicine: "未来计划", status: "pending", due_today: false },
      { id: "skipped", time: "09:00", medicine: "跳过计划", status: "skipped", due_today: true },
      { id: "today", time: "10:00", medicine: "今日计划", status: "pending", due_today: true },
    ],
    inquiries: [],
  });

  await page.load();

  assert.deepEqual(Array.from(page.data.planItems, item => item.planKey), ["today"]);
  assert.equal(page.data.reminderPlan.id, "today");
});

test("the dashboard includes recent vitals in its timeline and links to health measurement", async () => {
  const navigations = [];
  const page = loadHomePage({ plans: [], inquiries: [] }, [{
    id: "vitals-1",
    createdAt: "2026-08-08 10:20:00",
    heartRate: 72,
    spo2: 98,
    bodyTemp: 36.5,
    quality: "good",
  }], { navigateTo: request => navigations.push(request) });

  await page.load();

  assert.equal(page.data.timeline[0].source, "vitals");
  assert.match(page.data.latestVitalsText, /36\.5/);
  page.goVitals();
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].url, "/pages/vitals/index");
});

test("the dashboard timeline omits unfinished inquiries shown nowhere else to caregivers", async () => {
  const page = loadHomePage({
    plans: [],
    inquiries: [
      {
        inquiry_id: "finished-inquiry",
        target_user_name: "妈妈",
        title: "已完成问询",
        reasoning_summary: "已形成照护建议。",
        stage: "result",
        next_action: "show_recommendation",
        caregiverVisible: true,
        updated_at: "2026-08-08 10:20:00",
      },
      {
        inquiry_id: "unfinished-inquiry",
        target_user_name: "访客",
        title: "新问询",
        reasoning_summary: "仍在补充信息。",
        stage: "clarification",
        next_action: "ask",
        caregiverVisible: false,
        updated_at: "2026-08-08 10:21:00",
      },
    ],
  });

  await page.load();

  assert.deepEqual(
    Array.from(page.data.timeline.filter(item => item.source === "inquiry"), item => item.title),
    ["妈妈 · 已完成问询"],
  );
});

test("the dashboard keeps a date with older timeline events instead of showing a misleading clock-only time", async () => {
  const page = loadHomePage({ plans: [], inquiries: [] }, [{
    id: "vitals-older",
    createdAt: "2020-01-02 10:20:00",
    heartRate: 72,
    quality: "good",
  }]);

  await page.load();

  assert.match(page.data.timeline[0].time, /2020年1月2日/);
});

test("the dashboard creates refill work only from an explicit DEPLETED fact", async () => {
  const page = loadHomePage({ plans: [], inquiries: [] }, [], {}, [{
    slot: 3,
    name: "布洛芬",
    quantity: 0,
    inventoryState: "STOCKED",
    lowStockLine: 1,
    unit: "盒",
  }, {
    slot: 4,
    name: "维生素",
    quantity: 8,
    inventoryState: "DEPLETED",
    lowStockLine: 1,
    unit: "盒",
  }, {
    slot: 5,
    name: "库存待同步药品",
    quantity: 0,
    inventoryState: "UNKNOWN",
  }], null, { online: true }, {
    getCapabilitiesStrict: async () => ({
      schemaVersion: 2,
      capabilities: { explicitInventoryState: "v1" },
    }),
  });

  await page.load();

  assert.equal(page.data.todoItems.some(item => item.id === "depleted-legacy-slot-3"), false);
  const depletedItem = page.data.todoItems.find(item => item.id === "depleted-legacy-slot-4");
  assert.ok(depletedItem);
  assert.equal(page.data.todoItems.some(item => item.id === "depleted-legacy-slot-5"), false);
  assert.equal(depletedItem.action, "medicine");
  assert.equal(depletedItem.actionLabel, "补药");
});

test("the dashboard makes UNKNOWN inventory visible without creating a refill todo", async () => {
  const page = loadHomePage({ plans: [], inquiries: [] }, [], {}, [{
    slot: 5,
    name: "状态待确认药品",
    quantity: 0,
    inventoryState: "UNKNOWN",
  }], null, { online: true }, {
    getCapabilitiesStrict: async () => ({
      schemaVersion: 2,
      capabilities: { explicitInventoryState: "v1" },
    }),
  });

  await page.load();

  assert.equal(page.data.inventoryUnknownCount, 1);
  assert.equal(page.data.depletedCount, 0);
  assert.equal(page.data.todoItems.some(item => item.id === "depleted-legacy-slot-5"), false);
  assert.equal(page.data.carePage.overview.length, 0);
  const attention = page.data.carePage.sections.find(item => item.key === "home-attention");
  const medicineItem = attention.items.find(item => item.key === "home-attention-medicine");
  assert.equal(medicineItem.title, "1 项药品需要维护");
  assert.match(medicineItem.supporting, /余量待确认 1/);
  assert.equal(medicineItem.state.kind, "pending");
  assert.deepEqual(medicineItem.action.payload, { filter: "all" });
});

test("a confirmed empty slot overrides an old expiry instead of creating two todos", async () => {
  let expiryInput = [];
  const page = loadHomePage({ plans: [], inquiries: [] }, [], {}, [{
    slot: 1,
    name: "已取空的旧药",
    quantity: 0,
    inventoryState: "DEPLETED",
    expireDate: "2000-01-01",
  }], medicines => {
    expiryInput = medicines;
    return {
      attention: medicines.map(item => ({
        slot: item.slot,
        name: item.name,
        expiryText: "已过期",
        expiryHint: "请处理",
        expiryClass: "expired",
      })),
      expiredCount: medicines.length,
      expiringCount: 0,
      missingCount: 0,
      validCount: 0,
      medicines,
      nextAttention: null,
    };
  });

  await page.load();

  assert.deepEqual(Array.from(expiryInput), []);
  assert.deepEqual(Array.from(page.data.todoItems, item => item.id), ["depleted-legacy-slot-1"]);
  assert.equal(page.data.expiredCount, 0);
  assert.equal(page.data.depletedCount, 1);
});

test("an expired medicine is promoted ahead of a routine reminder", async () => {
  const page = loadHomePage({
    plans: [{ id: "routine", time: "09:00", medicine: "常规用药", status: "pending", due_today: true }],
    inquiries: [],
  }, [], {}, [], {
    attention: [{ slot: 4, name: "过期药", expiryText: "已过期", expiryHint: "请处理", expiryClass: "expired" }],
    expiredCount: 1,
    expiringCount: 0,
    missingCount: 0,
    validCount: 0,
    medicines: [],
    nextAttention: null,
  });

  await page.load();

  assert.equal(page.data.todoItems[0].id, "expiry-legacy-slot-4");
});

test("the hero follows the highest care todo instead of an otherwise normal expiry summary", async () => {
  const page = loadHomePage({
    plans: [{ id: "routine", time: "00:00", medicine: "Routine medicine", status: "pending", due_today: true }],
    inquiries: [],
  });

  await page.load();

  assert.equal(page.data.focusTitle, "00:00 待提醒");
  assert.equal(page.data.heroLevel, "attention");
  assert.equal(page.data.heroBadge, "待提醒");
  assert.equal(page.data.carePage.focus.action.id, "home.focus.plans");
  assert.equal(page.data.carePage.focus.activation, "surface");
});

test("an urgent highest todo gives the hero an urgent visual state", async () => {
  const page = loadHomePage({
    plans: [{ id: "routine", time: "09:00", medicine: "Routine medicine", status: "pending", due_today: true }],
    inquiries: [],
  }, [], {}, [], {
    attention: [{ slot: 4, name: "Expired medicine", expiryText: "已过期", expiryHint: "请处理", expiryClass: "expired" }],
    expiredCount: 1,
    expiringCount: 0,
    missingCount: 0,
    validCount: 0,
    medicines: [],
    nextAttention: null,
  });

  await page.load();

  assert.equal(page.data.todoItems[0].id, "expiry-legacy-slot-4");
  assert.equal(page.data.heroLevel, "danger");
  assert.equal(page.data.heroBadge, "优先处理");
});

test("the home care screen leads with today's plan and moves medicine maintenance into attention", async () => {
  const navigations = [];
  const page = loadHomePage({
    plans: [{ id: "routine", time: "09:00", medicine: "常规用药", status: "pending", due_today: true }],
    inquiries: [],
  }, [], { navigateTo: request => navigations.push(request) }, [], {
    attention: [{ slot: 4, name: "过期药", expiryText: "已过期", expiryHint: "请处理", expiryClass: "expired" }],
    expiredCount: 1,
    expiringCount: 0,
    missingCount: 0,
    validCount: 0,
    medicines: [],
    nextAttention: null,
  }, { online: false });

  assert.equal(page.data.carePage.phase.kind, "loading");
  await page.load();

  assert.equal(page.data.carePage.focus.title, "09:00 · 老人");
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.id, "home.focus.plans");
  assert.equal(page.data.carePage.focus.progress.current, 0);
  assert.equal(page.data.carePage.focus.progress.total, 1);
  assert.equal(page.data.carePage.overview.length, 0);
  assert.deepEqual(Array.from(page.data.carePage.sections, section => section.intent), ["tasks", "timeline", "navigation"]);

  const attention = page.data.carePage.sections.find(section => section.key === "home-attention");
  const medicineItem = attention.items.find(item => item.key === "home-attention-medicine");
  assert.equal(medicineItem.action.id, "home.cabinet.expired");
  page.onCarePageAction({ detail: medicineItem.action });
  assert.deepEqual(Array.from(navigations, item => item.url), [
    "/pages/libraryList/index?filter=expired",
  ]);
});

test("an offline medicine box never presents an empty dashboard as a reassuring all-clear", async () => {
  const tabRoutes = [];
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    { switchTab: request => tabRoutes.push(request.url) },
    [],
    null,
    { online: false },
  );

  await page.load();

  assert.equal(page.data.todoItems.length, 0);
  assert.equal(page.data.heroLevel, "attention");
  assert.equal(page.data.heroBadge, "等待药箱连接");
  assert.match(page.data.focusTitle, /药箱/);
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.id, "home.focus.connection");
  page.onCarePageAction({ detail: page.data.carePage.focus.action });
  assert.deepEqual(tabRoutes, ["/pages/settings/index"]);
});

test("an older cloud keeps the dashboard ready and labels safety history unsupported without probing it", async () => {
  let safetyListCalls = 0;
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: true },
    {
      getCapabilitiesStrict: async () => ({
        schemaVersion: 2,
        schemaRevision: "2.2-miniprogram",
        capabilities: {},
      }),
      getMedicationSafetyEventsStrict: async () => {
        safetyListCalls += 1;
        throw new Error("legacy cloud must not receive an unknown action");
      },
    },
  );

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.safetyState.availability, "unsupported");
  assert.equal(safetyListCalls, 0);
  assert.equal(page.data.carePage.overview.length, 0);
  assert.equal(page.data.carePage.sections.some(section => section.key === "home-attention"), false);
});

test("the dashboard exposes a safety membership denial without collapsing the whole page", async () => {
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: true },
    {
      getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
      getMedicationSafetyEventsStrict: async () => {
        const error = new Error("membership required");
        error.code = "FORBIDDEN";
        throw error;
      },
    },
  );

  await page.load();
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.safetyState.availability, "forbidden");
  assert.equal(page.data.carePage.overview.length, 0);
  assert.equal(page.data.carePage.sections.some(section => section.key === "home-attention"), false);
});

test("a transient safety refresh failure keeps the last unread attention and marks the page stale", async () => {
  let safetyReads = 0;
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: true },
    {
      getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
      getMedicationSafetyEventsStrict: async () => {
        safetyReads += 1;
        if (safetyReads > 1) throw new Error("temporary safety refresh failure");
        return {
          items: [{
            type: "MEDICATION_SAFETY_EVENT",
            event_id: "safety-stale-home",
            person_display_name: "王奶奶",
            medicine_name: "需保留药品",
            check_status: "BLOCKED",
            dispense_status: "BLOCKED",
            caregiver_summary: "检测到已登记病史冲突。",
            occurred_at: todayAt("10:20"),
            read_state: "UNREAD",
          }],
          nextCursor: "",
        };
      },
    },
  );

  await page.load();
  await page.load();

  assert.equal(page.data.safetyState.availability, "error");
  assert.equal(page.data.stale, true);
  assert.match(page.data.carePage.focus.supporting, /已保存/);
  const attention = page.data.carePage.sections.find(section => section.key === "home-attention");
  const safetyItem = attention.items.find(item => item.key === "home-attention-safety");
  assert.equal(safetyItem.action.id, "home.risks");
  assert.match(safetyItem.title, /1 条用药风险/);
});

test("an unread safety block stays visible as attention while connection remains in the header flow", async () => {
  const tabRoutes = [];
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    { navigateTo: request => tabRoutes.push(request.url) },
    [],
    {
      attention: [{ slot: 4, name: "过期药", expiryText: "已过期", expiryHint: "请处理", expiryClass: "expired" }],
      expiredCount: 1,
      expiringCount: 0,
      missingCount: 0,
      validCount: 0,
      medicines: [],
      nextAttention: null,
    },
    { online: false },
    {
      getCapabilitiesStrict: async () => ({
        schemaVersion: 2,
        capabilities: { medicationSafetyEvents: "v1" },
      }),
      getMedicationSafetyEventsStrict: async options => {
        assert.equal(options.unreadOnly, false);
        assert.equal(options.limit, 100);
        return { items: [{
          type: "MEDICATION_SAFETY_CHECK",
          event_id: "safety-wang-focus",
          person_display_name: "王奶奶",
          medicine_name: "布洛芬缓释胶囊",
          check_status: "BLOCKED",
          dispense_status: "BLOCKED",
          caregiver_summary: "检测到已登记病史冲突。",
          occurred_at: todayAt("10:30"),
          read_state: "UNREAD",
        }], nextCursor: "more-unread" };
      },
    },
  );

  await page.load();

  assert.equal(page.data.carePage.focus.action.id, "home.focus.connection");
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.overview.length, 0);
  const attention = page.data.carePage.sections.find(section => section.key === "home-attention");
  const safetyItem = attention.items.find(item => item.key === "home-attention-safety");
  assert.match(safetyItem.title, /1 条用药风险/);
  assert.equal(safetyItem.action.id, "home.risks");

  page.onCarePageAction({ detail: safetyItem.action });
  assert.deepEqual(tabRoutes, ["/pages/medicationRisks/index"]);
});

test("the dashboard delegates its focus and overview to the shared care screen", () => {
  const layout = fs.readFileSync(layoutPath, "utf8");

  assert.match(layout, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/);
  assert.doesNotMatch(layout, /<app-header|class="care-hero|class="home-status-strip/);
});

test("the dashboard keeps full todo and timeline lists behind secondary sheets", () => {
  const layout = fs.readFileSync(layoutPath, "utf8");

  assert.doesNotMatch(layout, /wx:for="\{\{todoPreview\}\}"/);
  assert.doesNotMatch(layout, /wx:for="\{\{timelinePreview\}\}"/);
  assert.match(layout, /wx:for="\{\{todoItems\}\}"/);
  assert.match(layout, /wx:for="\{\{timeline\}\}"/);
  assert.match(layout, /class="ui-sheet"/);
});

test("the dashboard puts the next medication and daily progress in the focus card without duplication", async () => {
  const page = loadHomePage({
    plans: [{
      id: "next-dose",
      time: "08:30",
      medicine: "降压药",
      dose: "1片",
      target_user_name: "妈妈",
      status: "pending",
      due_today: true,
    }],
    inquiries: [],
  });

  await page.load();

  assert.equal(page.data.nextDoseText, "08:30 · 妈妈 · 降压药 · 1片");
  assert.equal(page.data.carePage.focus.title, "08:30 · 妈妈");
  assert.equal(page.data.carePage.focus.supporting, "降压药 · 1片");
  assert.equal(page.data.carePage.focus.action.id, "home.focus.plans");
  assert.equal(page.data.carePage.focus.action.label, "查看计划用药");
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.deepEqual(page.data.carePage.focus.progress, {
    current: 0,
    total: 1,
    label: "今日已完成",
    percent: 0,
    ariaLabel: "今日已完成 0/1",
  });
  assert.equal(page.data.carePage.sections.flatMap(section => section.items)
    .some(item => item.key === "home-next-dose"), false);
});

test("the dashboard uses its remaining first-screen space for direct inquiry and family actions", async () => {
  const page = loadHomePage({
    plans: [],
    inquiries: [{
      inquiry_id: "care-summary",
      target_user_name: "妈妈",
      title: "头痛",
      stage: "result",
      next_action: "complete",
      caregiverVisible: true,
    }],
  });

  await page.load();
  assert.equal(page.data.inquiryCount, 1);
  const navigation = page.data.carePage.sections.find(section => section.intent === "navigation");
  assert.deepEqual(Array.from(navigation.items, item => item.action.id), ["home.inquiry", "home.family"]);
});

test("the dashboard keeps one dominant task and labels visible inquiry activity as 问询", async () => {
  const page = loadHomePage({
    plans: [],
    inquiries: [{
      inquiry_id: "wording-inquiry",
      target_user_name: "妈妈",
      title: "AI 问诊结论",
      reasoning_summary: "已同步摘要。",
      caregiverVisible: true,
      updated_at: "2026-08-08 10:20:00",
    }],
  });

  await page.load();

  const inquiry = page.data.timeline.find(item => item.source === "inquiry");
  assert.ok(inquiry);
  assert.match(inquiry.title, /问询/);
  assert.doesNotMatch(inquiry.title, /问诊/);
  assert.equal(page.data.carePage.focus.action, null);
  assert.equal(page.data.carePage.overview.length, 0);
  assert.equal(page.data.carePage.sections.some(section => section.key === "home-attention"), false);
});

test("the dashboard omits archived persona inquiries from its timeline and count", async () => {
  const page = loadHomePage({
    plans: [],
    serviceUsers: [
      { id: "member-rebuilt", personaGeneration: "generation-v1", archived: true },
      { id: "member-rebuilt", personaGeneration: "generation-v2", archived: false },
    ],
    inquiries: [
      {
        inquiry_id: "archived-home",
        service_user_id: "member-rebuilt",
        persona_generation: "generation-v1",
        title: "archived question",
        caregiverVisible: true,
        updated_at: "2026-08-08 09:00:00",
      },
      {
        inquiry_id: "active-home",
        service_user_id: "member-rebuilt",
        persona_generation: "generation-v2",
        title: "active question",
        caregiverVisible: true,
        updated_at: "2026-08-09 09:00:00",
      },
    ],
  });

  await page.load();

  assert.equal(page.data.inquiryCount, 1);
  assert.deepEqual(
    Array.from(page.data.timeline.filter(item => item.source === "inquiry"), item => item.id),
    ["inquiry-active-home"],
  );
});

test("the dashboard only promotes plans for the active persona generation", async () => {
  const page = loadHomePage({
    serviceUsers: [
      { id: "member-rebuilt", personaGeneration: "generation-v1", archived: true },
      { id: "member-rebuilt", personaGeneration: "generation-v2", archived: false },
      { id: "archived-person", personaGeneration: "legacy-v1", archived: true },
    ],
    plans: [
      {
        id: "archived-generation-plan",
        service_user_id: "member-rebuilt",
        persona_generation: "generation-v1",
        time: "07:00",
        medicine: "旧代次药品",
        status: "pending",
        due_today: true,
      },
      {
        id: "active-generation-plan",
        service_user_id: "member-rebuilt",
        persona_generation: "generation-v2",
        time: "08:00",
        medicine: "当前代次药品",
        status: "pending",
        due_today: true,
      },
      {
        id: "ambiguous-generation-plan",
        service_user_id: "member-rebuilt",
        time: "09:00",
        medicine: "代次不明药品",
        status: "pending",
        due_today: true,
      },
      {
        id: "archived-person-plan",
        service_user_id: "archived-person",
        persona_generation: "legacy-v1",
        time: "10:00",
        medicine: "归档人物药品",
        status: "pending",
        due_today: true,
      },
    ],
    inquiries: [],
  });

  await page.load();

  assert.deepEqual(
    Array.from(page.data.planItems, item => item.id),
    ["plan-active-generation-plan"],
  );
  assert.equal(page.data.nextDoseText.includes("当前代次药品"), true);
});

test("zero-value medicine facts do not navigate to empty filtered lists", async () => {
  const page = loadHomePage({ plans: [], inquiries: [] });

  await page.load();

  assert.equal(page.data.carePage.overview.every(item => item.action === null), true);
});

test("dashboard activation waits for the authorized device session and schedules later refreshes without a duplicate first read", async () => {
  const ready = deferred();
  const scopes = [];
  const subscriptions = [];
  const app = {
    globalData: {
      deviceId: "",
      deviceSessionResolved: false,
      deviceSession: { capabilities: {} },
    },
    waitForDeviceSession: () => ready.promise,
  };
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: true },
    {
      app,
      getDeviceStrict: async deviceId => {
        scopes.push(deviceId);
        return { deviceId, online: true };
      },
      realtime: {
        subscribe(callback, key, options) {
          subscriptions.push({ callback, key, options });
          return () => {};
        },
      },
    },
  );

  const activation = page.onShow();
  assert.deepEqual(scopes, []);
  assert.equal(subscriptions.length, 0);

  app.globalData.deviceId = "authorized-box";
  app.globalData.deviceSessionResolved = true;
  ready.resolve(app.globalData.deviceSession);
  await activation;

  assert.deepEqual(scopes, ["authorized-box"]);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].options.immediate, false);
});

test("an unpaired caregiver sees a pairing card without probing device-scoped care data", async () => {
  const tabRoutes = [];
  let scopedReads = 0;
  const app = {
    globalData: {
      deviceId: "",
      deviceSessionResolved: true,
      deviceSession: {
        mode: "membership",
        availability: "unpaired",
        canPair: true,
        message: "当前微信账号尚未配对药箱，请输入一次性配对码",
      },
    },
  };
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    { switchTab: request => tabRoutes.push(request.url) },
    [],
    null,
    { online: false },
    {
      app,
      getDeviceStrict: async () => {
        scopedReads += 1;
        return { online: false };
      },
    },
  );

  await page.onShow();

  assert.equal(scopedReads, 0);
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.match(page.data.carePage.focus.title, /配对药箱/);
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.id, "home.focus.connection");

  page.onCarePageAction({ detail: page.data.carePage.focus.action });
  assert.deepEqual(tabRoutes, ["/pages/settings/index"]);
});

test("a failed membership session without a selected box stays on account recovery and does not poll scoped data", async () => {
  let scopedReads = 0;
  let subscriptions = 0;
  const app = {
    globalData: {
      deviceId: "",
      deviceSessionResolved: true,
      deviceSession: {
        mode: "membership",
        availability: "error",
        message: "授权药箱列表读取失败，请稍后重试",
      },
    },
  };
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: false },
    {
      app,
      getDeviceStrict: async () => {
        scopedReads += 1;
        const error = new Error("device is not selected");
        error.code = "DEVICE_NOT_SELECTED";
        throw error;
      },
      realtime: {
        subscribe() {
          subscriptions += 1;
          return () => {};
        },
      },
    },
  );

  await page.onShow();

  assert.equal(scopedReads, 0);
  assert.equal(subscriptions, 0);
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.match(page.data.carePage.focus.title, /药箱状态暂不可用|重新确认/);
  assert.match(page.data.carePage.focus.supporting, /授权药箱列表读取失败/);
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.id, "home.focus.connection");
});

test("dashboard retry re-resolves account access before reading a box when the session lost its selection", async () => {
  let sessionRefreshes = 0;
  const deviceScopes = [];
  const app = {
    globalData: {
      deviceId: "",
      deviceSessionResolved: true,
      deviceSession: {
        mode: "membership",
        availability: "error",
        devices: [],
        selectedDeviceId: "",
        message: "授权药箱列表读取失败，请稍后重试",
      },
    },
    async refreshDeviceSession() {
      sessionRefreshes += 1;
      this.globalData.deviceId = "authorized-box";
      this.globalData.deviceSession = {
        mode: "membership",
        availability: "ready",
        devices: [{ deviceId: "authorized-box" }],
        selectedDeviceId: "authorized-box",
      };
      return this.globalData.deviceSession;
    },
  };
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: false },
    {
      app,
      getDeviceStrict: async deviceId => {
        deviceScopes.push(deviceId);
        return { deviceId, online: false };
      },
    },
  );

  await page.retryLoad();

  assert.equal(sessionRefreshes, 1);
  assert.deepEqual(deviceScopes, ["authorized-box"]);
  assert.equal(page.data.deviceId, "authorized-box");
  assert.equal(page.data.carePage.phase.kind, "ready");
});

test("dashboard drops a completed read when the active medication box changed without starting a second load", async () => {
  const oldDevice = deferred();
  const app = {
    globalData: {
      deviceId: "box-a",
      deviceSessionResolved: true,
      deviceSession: { capabilities: {} },
    },
  };
  const page = loadHomePage(
    { plans: [], inquiries: [] },
    [],
    {},
    [],
    null,
    { online: true },
    {
      app,
      getDeviceStrict: () => oldDevice.promise,
    },
  );

  const loading = page.load();
  app.globalData.deviceId = "box-b";
  oldDevice.resolve({ deviceId: "box-a", name: "old box", online: true });
  await loading;

  assert.notEqual(page._hasLoadedSnapshot, true);
  assert.notEqual(page.data.device.name, "old box");
  assert.equal(page.data.timeline.length, 0);
});

test("a complete persona-v1 snapshot hides orphaned home facts while keeping unlinked guest and device facts", async () => {
  const app = {
    globalData: {
      deviceId: "box-1",
      deviceSessionResolved: true,
      deviceSession: {
        capabilities: { personaLifecycle: "v1" },
      },
    },
  };
  const page = loadHomePage(
    {
      serviceUsersSnapshotComplete: true,
      serviceUsers: [{ id: "member-1", personaGeneration: "v2", archived: false }],
      plans: [{
        id: "active-plan",
        service_user_id: "member-1",
        persona_generation: "v2",
        time: "08:00",
        medicine: "当前计划",
        status: "pending",
        due_today: true,
      }, {
        id: "orphan-plan",
        service_user_id: "removed-member",
        persona_generation: "v1",
        time: "09:00",
        medicine: "孤儿计划",
        status: "pending",
        due_today: true,
      }],
      inquiries: [{
        inquiry_id: "active-inquiry",
        person_id: "member-1",
        persona_generation: "v2",
        title: "当前问询",
        caregiverVisible: true,
        updated_at: "2026-08-10 09:00:00",
      }, {
        inquiry_id: "orphan-inquiry",
        person_id: "removed-member",
        persona_generation: "v1",
        title: "孤儿问询",
        caregiverVisible: true,
        updated_at: "2026-08-10 09:10:00",
      }, {
        inquiry_id: "guest-inquiry",
        guest_name: "现场访客",
        title: "访客问询",
        caregiverVisible: true,
        updated_at: "2026-08-10 09:20:00",
      }],
    },
    [{
      id: "orphan-vitals",
      personId: "removed-member",
      personaGeneration: "v1",
      heartRate: 71,
      createdAt: "2026-08-10 09:30:00",
    }, {
      id: "device-vitals",
      heartRate: 72,
      createdAt: "2026-08-10 09:40:00",
    }],
    {},
    [],
    null,
    { online: true },
    {
      app,
      getCapabilitiesStrict: async () => ({
        capabilities: {
          explicitInventoryState: "v1",
          medicationSafetyEvents: "v1",
          personaLifecycle: "v1",
        },
      }),
      getMedicationSafetyEventsStrict: async () => ({
        items: [{
          type: "MEDICATION_SAFETY_EVENT",
          event_id: "orphan-safety",
          person_id: "removed-member",
          persona_generation: "v1",
          medicine_name: "孤儿安全记录",
          check_status: "BLOCKED",
          dispense_status: "BLOCKED",
          read_state: "UNREAD",
          occurred_at: "2026-08-10 10:10:00",
        }, {
          type: "MEDICATION_SAFETY_EVENT",
          event_id: "device-safety",
          medicine_name: "药箱现场记录",
          check_status: "ALLOWED",
          dispense_status: "DISPENSED",
          read_state: "READ",
          occurred_at: "2026-08-10 10:20:00",
        }],
      }),
    },
  );

  await page.load();

  assert.deepEqual(Array.from(page.data.planItems, item => item.id), ["plan-active-plan"]);
  assert.equal(page.data.inquiryCount, 2);
  const timelineText = JSON.stringify(page.data.timeline);
  assert.doesNotMatch(timelineText, /orphan|孤儿/);
  assert.match(timelineText, /guest-inquiry/);
  assert.match(timelineText, /device-vitals/);
  assert.match(timelineText, /device-safety/);
  assert.doesNotMatch(timelineText, /"source":"record"/);
  assert.notEqual(page.data.carePage.focus.action && page.data.carePage.focus.action.id, "home.focus.safety");
});

test("an incomplete persona snapshot keeps legacy home visibility instead of enabling strict orphan filtering", async () => {
  const app = {
    globalData: {
      deviceId: "box-1",
      deviceSessionResolved: true,
      deviceSession: { capabilities: { personaLifecycle: "v1" } },
    },
  };
  const page = loadHomePage(
    {
      serviceUsersSnapshotComplete: false,
      serviceUsers: [{
        id: "member-1",
        name: "同名成员",
        personaGeneration: "v1",
        archived: true,
      }, {
        id: "member-1",
        name: "同名成员",
        personaGeneration: "v2",
        archived: false,
      }],
      plans: [{
        id: "legacy-orphan-plan",
        service_user_id: "unknown-member",
        persona_generation: "v1",
        time: "08:00",
        medicine: "兼容计划",
        status: "pending",
        due_today: true,
      }, {
        id: "ambiguous-name-plan",
        target_user_name: "同名成员",
        time: "09:00",
        medicine: "不可安全匹配的计划",
        status: "pending",
        due_today: true,
      }],
      inquiries: [{
        inquiry_id: "legacy-orphan-inquiry",
        person_id: "unknown-member",
        persona_generation: "v1",
        title: "兼容问询",
        caregiverVisible: true,
        updated_at: "2026-08-10 09:00:00",
      }],
    },
    [],
    {},
    [],
    null,
    { online: true },
    {
      app,
      getCapabilitiesStrict: async () => ({
        capabilities: { medicationSafetyEvents: "v1", personaLifecycle: "v1" },
      }),
      getMedicationSafetyEventsStrict: async () => ({
        items: [{
          type: "MEDICATION_SAFETY_EVENT",
          event_id: "legacy-archived-safety",
          person_id: "member-1",
          persona_generation: "v1",
          medicine_name: "旧版仍可见的安全事实",
          check_status: "BLOCKED",
          dispense_status: "BLOCKED",
          read_state: "UNREAD",
          occurred_at: "2026-08-10 10:10:00",
        }],
      }),
    },
  );

  await page.load();

  assert.deepEqual(Array.from(page.data.planItems, item => item.id), ["plan-legacy-orphan-plan"]);
  assert.equal(page.data.inquiryCount, 1);
  assert.equal(page.data.carePage.focus.action.id, "home.focus.plans");
  const attention = page.data.carePage.sections.find(section => section.key === "home-attention");
  assert.equal(attention.items.find(item => item.key === "home-attention-safety").action.id, "home.risks");
});

test("home uses the canonical vitals attribution labels instead of inventing a family member", async () => {
  const page = loadHomePage(
    {
      serviceUsers: [{ id: "member-1", name: "王奶奶", personaGeneration: "v2" }],
      capabilities: { vitalsAttribution: "v1" },
      plans: [],
      inquiries: [],
    },
    [{
      recordId: "standalone-vitals",
      personId: "stale-person",
      personName: "残留姓名",
      personaGeneration: "v1",
      attributionSource: "STANDALONE",
      createdAt: todayAt("11:00"),
      heartRate: 70,
    }, {
      recordId: "member-vitals",
      personId: "member-1",
      personName: "测量时的王奶奶",
      personaGeneration: "v2",
      inquirySessionId: "inquiry-1",
      attributionSource: "INQUIRY_SESSION",
      createdAt: todayAt("10:00"),
      heartRate: 72,
    }],
    {},
    [],
    null,
    { online: true },
    {
      getCapabilitiesStrict: async () => {
        throw new Error("safety capability refresh unavailable");
      },
    },
  );

  await page.load();

  const titles = page.data.timeline.map(item => item.title);
  assert.ok(titles.includes("未登记人员 完成健康测量"));
  assert.ok(titles.includes("测量时的王奶奶 完成健康测量"));
  assert.equal(titles.some(title => title.includes("家庭成员")), false);
});
