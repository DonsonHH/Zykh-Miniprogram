const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/settings/index.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function loadSettingsPage(api, context = {}) {
  let definition = null;
  const pureApi = require("../miniprogram/utils/api");
  const gateway = Object.assign({}, pureApi, api);
  [
    ["getSnapshot", "getSnapshotStrict"],
    ["getRecentCommands", "getRecentCommandsStrict"],
    ["getDevice", "getDeviceStrict"],
  ].forEach(([softName, strictName]) => {
    if (Object.prototype.hasOwnProperty.call(api, softName)
      && !Object.prototype.hasOwnProperty.call(api, strictName)) {
      gateway[strictName] = api[softName];
    }
  });
  const source = fs.readFileSync(pagePath, "utf8");
  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(modulePath) {
      if (modulePath.includes("dateTime")) return require("../miniprogram/utils/dateTime");
      if (modulePath.includes("carePlan")) return require("../miniprogram/utils/carePlan");
      if (modulePath.includes("carePage")) return require("../miniprogram/utils/carePage");
      if (modulePath.includes("offlinePageCache")) return require("../miniprogram/utils/offlinePageCache");
      if (modulePath.includes("connectionState")) return require("../miniprogram/utils/connectionState");
      if (modulePath.includes("medicationSafetyEvents")) return require("../miniprogram/modules/medicationSafetyEvents");
      if (modulePath.includes("personaVisibility")) return require("../miniprogram/modules/personaVisibility");
      if (modulePath.includes("realtime")) return { subscribe: () => () => {} };
      return gateway;
    },
    getApp: context.getApp,
    wx: context.wx,
  }, { filename: pagePath });
  return definition;
}

test("family view joins a service user with only that person's pending care plans", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "member-a", name: "王阿姨", age: 71, profile: "高血压" },
        { id: "member-b", name: "李叔叔", age: 75, profile: "" },
      ],
      plans: [
        { service_user_id: "member-a", target_user_name: "王阿姨", time: "09:00", medicine: "阿司匹林", status: "pending" },
        { service_user_id: "member-a", target_user_name: "王阿姨", time: "20:00", medicine: "氨氯地平", status: "done" },
        { service_user_id: "member-a", target_user_name: "王阿姨", time: "07:00", medicine: "未来计划", status: "pending", due_today: false },
        { service_user_id: "member-a", target_user_name: "王阿姨", time: "08:00", medicine: "跳过计划", status: "skipped", due_today: true },
        { service_user_id: "member-b", target_user_name: "李叔叔", time: "10:00", medicine: "维生素", status: "done" },
      ],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
  });
  page.data = { commands: [] };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.familyMembers.length, 2);
  assert.equal(page.data.familyMembers[0].pendingCount, 1);
  assert.equal(page.data.familyMembers[0].careStatusText, "待办 1 项");
  assert.equal(page.data.familyMembers[0].nextCareText, "09:00 · 阿司匹林");
  assert.equal(page.data.familyMembers[1].pendingCount, 0);
  assert.equal(page.data.familyMembers[1].careStatusText, "暂无待办");
});

test("a complete persona snapshot hides tombstone conflicts and contract-invalid family rows", async () => {
  const page = loadSettingsPage({
    getSnapshotStrict: async () => ({
      device: { deviceId: "box-1", online: true },
      serviceUsersSnapshotComplete: true,
      serviceUsers: [
        { id: "valid-person", name: "当前家人", personaGeneration: "v2", archived: false },
        { id: "conflicted-person", name: "不应复活", personaGeneration: "v1", archived: false },
        { id: "conflicted-person", name: "归档凭证", personaGeneration: "v1", archived: true },
        { id: "missing-generation", name: "契约不完整人物", archived: false },
      ],
      plans: [
        { id: "valid-plan", service_user_id: "valid-person", persona_generation: "v2", status: "pending", due_today: true },
        { id: "conflicted-plan", service_user_id: "conflicted-person", persona_generation: "v1", status: "pending", due_today: true },
      ],
    }),
    getDeviceStrict: async () => ({ deviceId: "box-1", online: true }),
    getRecentCommandsStrict: async () => [],
    getCapabilitiesStrict: async () => ({
      capabilities: { personaLifecycle: "v1" },
    }),
  });
  page.data = Object.assign({}, page.data, { deviceId: "box-1" });
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(Array.from(page.data.familyMembers, member => member.personId), ["valid-person"]);
  assert.equal(page.data.todayCare.totalCount, 1);
  assert.doesNotMatch(JSON.stringify(page.data.todayCare), /conflicted-person/);
});

test("family profiles do not repeat an age already shown in the member metadata", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "member-child", name: "小宇", age: 8, profile: "8岁儿童，花粉过敏" },
        { id: "member-elder", name: "王阿姨", age: "71岁", profile: "高血压" },
      ],
      plans: [],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
  });
  page.data = { commands: [], deviceId: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.familyMembers[0].profileText, "8 岁 · 儿童，花粉过敏");
  assert.equal(page.data.familyMembers[1].profileText, "71 岁 · 高血压");
  assert.equal(page.data.carePage.focus.action.id, "family.focus.people");
  assert.equal(page.data.carePage.focus.activation, "surface");
  page.onCarePageAction({ detail: { id: "family.focus.people" } });
  assert.equal(page.data.detailMode, "family");
});

test("family settings builds a compact today-care overview from the existing care plans", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "member-a", name: "王阿姨" },
        { id: "member-b", name: "李叔叔" },
      ],
      plans: [
        { service_user_id: "member-a", time: "09:00", medicine: "阿司匹林", status: "pending" },
        { service_user_id: "member-b", time: "08:00", medicine: "降压药", status: "done" },
        { service_user_id: "member-a", time: "07:00", medicine: "明日计划", status: "pending", due_today: false },
      ],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
  });
  page.data = { commands: [], deviceId: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.todayCare.totalCount, 2);
  assert.equal(page.data.todayCare.pendingCount, 1);
  assert.equal(page.data.todayCare.doneCount, 1);
  assert.equal(page.data.todayCare.nextText, "09:00 · 王阿姨 · 阿司匹林");
  assert.deepEqual(page.data.todayCareLines.map(item => item.label), ["08:00", "09:00"]);

  page.showTodayCareDetails();
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailMode, "todayCare");
  assert.equal(page.data.detailTitle, "今日照护");
  assert.equal(page.data.detailLines.length, 2);
});

test("family settings presents today's next care step through the care screen interface", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "member-a", name: "王阿姨", age: 71 },
        { id: "member-b", name: "李叔叔", age: 75 },
        { id: "member-c", name: "陈奶奶", age: 70 },
        { id: "member-d", name: "赵爷爷", age: 76 },
      ],
      plans: [
        { service_user_id: "member-a", time: "09:00", medicine: "阿司匹林", status: "pending" },
        { service_user_id: "member-b", time: "08:00", medicine: "降压药", status: "done" },
      ],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true, lastSeenAt: "刚刚" }),
    getRecentCommands: async () => [],
  });
  page.setData = next => Object.assign(page.data, next);

  assert.equal(page.data.carePage.phase.kind, "loading");
  await page.load();

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.carePage.focus.eyebrow, "今日照护 · 下一项");
  assert.equal(page.data.carePage.focus.title, "09:00 · 王阿姨 · 阿司匹林");
  assert.equal(page.data.carePage.focus.activation, "surface");
  assert.equal(page.data.carePage.focus.action.id, "family.today");
  assert.deepEqual(
    Array.from(page.data.carePage.overview, item => item.label),
    ["待办", "已完成", "今日计划"],
  );
  assert.deepEqual(
    Array.from(page.data.carePage.sections, section => section.intent),
    ["people", "device"],
  );
  assert.equal(page.data.carePage.sections[0].items.length, 3);
  assert.equal(page.data.carePage.sections[0].more.id, "family.all");
  assert.equal(page.data.carePage.sections[1].items[0].action.id, "family.device");

  const todayPlanFact = page.data.carePage.overview.find(item => item.key === "family-total");
  assert.equal(todayPlanFact.action, null);
  page.onCarePageAction({ detail: page.data.carePage.focus.action });
  assert.equal(page.data.detailMode, "todayCare");
  page.onCarePageAction({ detail: { id: "family.all", payload: {} } });
  assert.equal(page.data.detailMode, "family");
  page.onCarePageAction({ detail: { id: "family.device", payload: {} } });
  assert.equal(page.data.detailMode, "device");
});

test("family settings keeps a three-person first-level preview and exposes complete details in sheets", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "member-a", name: "王阿姨" },
        { id: "member-b", name: "李叔叔" },
        { id: "member-c", name: "陈奶奶" },
        { id: "member-d", name: "赵爷爷" },
      ],
      plans: [],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true, lastSeenAt: "刚刚" }),
    getRecentCommands: async () => [{ _id: "command-1", type: "AUDIO_SPEAK", status: "done" }],
  });
  page.data = { commands: [], deviceId: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(page.data.familyPreview.map(item => item.id), ["member-a", "member-b", "member-c"]);
  assert.equal(page.data.familyMembers.length, 4);

  page.showFamilyDetails();
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailMode, "family");
  assert.deepEqual(page.data.detailMembers.map(item => item.id), ["member-a", "member-b", "member-c", "member-d"]);

  page.showDeviceDetails();
  assert.equal(page.data.detailMode, "device");
  assert.equal(page.data.detailLines[0].label, "药箱编号");

  page.showCommandDetails();
  assert.equal(page.data.detailMode, "commands");
  assert.equal(page.data.detailLines[0].value, "语音提醒 · 已完成");
});

test("family cards hide archived identities and open a stable person's unified care detail", async () => {
  const routes = [];
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        {
          id: "active-person",
          name: "任意家人",
          personaGeneration: "generation-v2",
          safetyProfileUpdatedAt: "2026-08-10 09:30:00",
          archived: false,
        },
        { id: "archived-person", name: "已归档人物", archived: true },
        { name: "尚未绑定身份", archived: false },
      ],
      plans: [
        { service_user_id: "active-person", personaGeneration: "generation-v2", time: "09:00", medicine: "当前计划", status: "pending", due_today: true },
        { service_user_id: "archived-person", time: "10:00", medicine: "旧计划", status: "pending", due_today: true },
      ],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
  }, {
    wx: { navigateTo: request => routes.push(request.url) },
  });
  page.data = { commands: [], deviceId: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.deepEqual(Array.from(page.data.familyMembers, member => member.name), ["任意家人", "尚未绑定身份"]);
  assert.equal(page.data.todayCare.totalCount, 1, "an archived person's old plan is not a current family task");
  assert.match(page.data.familyMembers[0].safetyProfileText, /2026-08-10/);
  const peopleItems = page.data.carePage.sections[0].items;
  assert.match(peopleItems[0].action.id, /^family\.person\.detail\./);
  assert.equal(peopleItems[0].action.payload.personId, "active-person");
  assert.equal(peopleItems[1].action, null, "a generated UI key is never used as a health-data identity");

  page.onCarePageAction({ detail: peopleItems[0].action });
  assert.equal(routes.length, 1);
  assert.match(routes[0], /^\/pages\/familyDetail\/index\?/);
  assert.match(routes[0], /personId=active-person/);
  assert.match(routes[0], /personaGeneration=generation-v2/);
  assert.match(routes[0], /personName=/);
});

test("family CarePage keeps reused stable ids unique by persona generation without changing route identity", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "reused-person", name: "王奶奶旧档", personaGeneration: "generation-v1", archived: false },
        { id: "reused-person", name: "王奶奶", personaGeneration: "generation-v2", archived: false },
      ],
      plans: [],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  });
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "ready");
  const peopleItems = page.data.carePage.sections[0].items;
  assert.equal(peopleItems.length, 2);
  assert.equal(new Set(peopleItems.map(item => item.key)).size, 2);
  assert.equal(new Set(peopleItems.map(item => item.action.id)).size, 2);
  assert.deepEqual(
    Array.from(peopleItems, item => [item.action.payload.personId, item.action.payload.personaGeneration]),
    [["reused-person", "generation-v1"], ["reused-person", "generation-v2"]],
  );
});

test("family settings keeps only plans belonging to an active persona generation", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "reused-person", name: "王奶奶旧档", personaGeneration: "generation-v1", archived: true },
        { id: "reused-person", name: "王奶奶", personaGeneration: "generation-v2", archived: false },
        { id: "archived-only", name: "归档成员", personaGeneration: "generation-v1", archived: true },
      ],
      plans: [
        { id: "plan-current", service_user_id: "reused-person", personaGeneration: "generation-v2", time: "09:00", medicine: "当前代次药品", status: "pending", due_today: true },
        { id: "plan-old", service_user_id: "reused-person", personaGeneration: "generation-v1", time: "10:00", medicine: "旧代次药品", status: "pending", due_today: true },
        { id: "plan-ambiguous", service_user_id: "reused-person", time: "11:00", medicine: "缺少代次药品", status: "pending", due_today: true },
        { id: "plan-archived", service_user_id: "archived-only", personaGeneration: "generation-v1", time: "12:00", medicine: "归档成员药品", status: "pending", due_today: true },
      ],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  });
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.familyMembers.length, 1);
  assert.equal(page.data.familyMembers[0].personaGeneration, "generation-v2");
  assert.equal(page.data.familyMembers[0].pendingCount, 1);
  assert.match(page.data.familyMembers[0].nextCareText, /当前代次药品/);
  assert.equal(page.data.todayCare.totalCount, 1);
  assert.deepEqual(Array.from(page.data.todayCareLines, line => line.value), ["王奶奶 · 当前代次药品 · 待处理"]);
});

test("family cards attribute unread safety events by stable identity and current persona generation", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "person-primary", name: "成员甲", personaGeneration: "generation-2" },
        { id: "person-secondary", name: "成员乙", personaGeneration: "generation-1" },
        { id: "person-passed", name: "成员丙", personaGeneration: "generation-1" },
        { name: "未绑定身份", personaGeneration: "generation-1" },
        { id: "person-legacy", name: "旧版人物" },
      ],
      plans: [
        { service_user_id: "person-primary", personaGeneration: "generation-2", time: "09:00", medicine: "计划药品", status: "pending" },
        { service_user_id: "person-passed", personaGeneration: "generation-1", time: "11:00", medicine: "计划药品丙", status: "pending" },
      ],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({
      items: [
        {
          id: "safety-current",
          type: "MEDICATION_SAFETY_EVENT",
          personId: "person-primary",
          personaGeneration: "generation-2",
          medicineName: "药品甲",
          checkStatus: "BLOCKED",
          dispenseStatus: "BLOCKED",
          readState: "UNREAD",
          summary: "身份与药品不匹配",
          occurredAt: "2026-08-10 09:15:00",
        },
        {
          id: "safety-old-generation",
          type: "MEDICATION_SAFETY_EVENT",
          personId: "person-primary",
          personaGeneration: "generation-1",
          medicineName: "旧身份药品",
          checkStatus: "BLOCKED",
          dispenseStatus: "BLOCKED",
          readState: "UNREAD",
          occurredAt: "2026-08-10 09:20:00",
        },
        {
          id: "safety-missing-generation",
          type: "MEDICATION_SAFETY_EVENT",
          personId: "person-primary",
          medicineName: "缺少人物代次的旧事件",
          checkStatus: "BLOCKED",
          dispenseStatus: "BLOCKED",
          readState: "UNREAD",
          occurredAt: "2026-08-10 09:25:00",
        },
        {
          id: "safety-secondary",
          type: "MEDICATION_SAFETY_EVENT",
          personId: "person-secondary",
          personaGeneration: "generation-1",
          medicineName: "药品乙",
          checkStatus: "CHECK_FAILED",
          dispenseStatus: "NOT_STARTED",
          readState: "UNREAD",
          occurredAt: "2026-08-10 08:15:00",
        },
        {
          id: "safety-passed",
          type: "MEDICATION_SAFETY_EVENT",
          personId: "person-passed",
          personaGeneration: "generation-1",
          medicineName: "药品丙",
          checkStatus: "PASSED",
          dispenseStatus: "DISPENSED",
          readState: "UNREAD",
          occurredAt: "2026-08-10 08:45:00",
        },
        {
          id: "safety-without-person",
          type: "MEDICATION_SAFETY_EVENT",
          personName: "未绑定身份",
          medicineName: "不应归属的药品",
          checkStatus: "BLOCKED",
          readState: "UNREAD",
          occurredAt: "2026-08-10 10:15:00",
        },
        {
          id: "safety-versioned-for-legacy-person",
          type: "MEDICATION_SAFETY_EVENT",
          personId: "person-legacy",
          personaGeneration: "generation-2",
          medicineName: "不应归入旧版人物的药品",
          checkStatus: "BLOCKED",
          readState: "UNREAD",
          occurredAt: "2026-08-10 10:20:00",
        },
      ],
    }),
  });
  page.data = { commands: [], deviceId: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  const primary = page.data.familyMembers[0];
  const secondary = page.data.familyMembers[1];
  const passed = page.data.familyMembers[2];
  const unbound = page.data.familyMembers[3];
  const legacy = page.data.familyMembers[4];
  assert.equal(primary.unreadSafetyCount, 1, "a previous or missing persona generation must not leak into the current card");
  assert.match(primary.latestSafetyText, /药品甲/);
  assert.match(primary.latestSafetyText, /身份与药品不匹配/);
  assert.equal(primary.careStatusText, "未读安全提醒 1 条");
  assert.equal(primary.careTone, "danger");
  assert.equal(primary.careStateKind, "risk");
  assert.equal(secondary.unreadSafetyCount, 1);
  assert.equal(secondary.careStateKind, "pending");
  assert.equal(passed.unreadSafetyCount, 1);
  assert.equal(passed.careStatusText, "待办 1 项", "a successful unread receipt does not outrank pending care");
  assert.match(page.data.carePage.sections[0].items[2].meta, /未读安全 1 条/);
  assert.equal(unbound.unreadSafetyCount, 0, "display names are never used as a safety-data identity");
  assert.equal(legacy.unreadSafetyCount, 0, "a versioned event is not guessed onto a legacy persona");

  const peopleItems = page.data.carePage.sections[0].items;
  assert.equal(peopleItems[0].state.kind, "risk");
  assert.match(peopleItems[0].supporting, /最近安全/);
  assert.match(peopleItems[0].supporting, /药品甲/);
});

test("family cards label unread safety counts as a lower bound while another event page exists", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [
        { id: "person-primary", name: "成员甲", personaGeneration: "generation-2" },
      ],
      plans: [],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({
      items: [{
        eventId: "safety-current",
        type: "MEDICATION_SAFETY_EVENT",
        personId: "person-primary",
        personaGeneration: "generation-2",
        medicineName: "药品甲",
        checkStatus: "BLOCKED",
        dispenseStatus: "BLOCKED",
        readState: "UNREAD",
        occurredAt: "2026-08-10 09:15:00",
      }],
      nextCursor: "cursor-2",
    }),
  });
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  const member = page.data.familyMembers[0];
  assert.equal(member.unreadSafetyText, "未读安全至少 1 条");
  assert.equal(member.careStatusText, "未读安全提醒至少 1 条");
  assert.match(page.data.carePage.sections[0].items[0].meta, /未读安全至少 1 条/);
});

test("family settings preserves the last ready safety summary only for transient refresh failures", async () => {
  let mode = "ready";
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [{ id: "person-primary", name: "成员甲", personaGeneration: "generation-2" }],
      plans: [],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
    getCapabilitiesStrict: async () => {
      if (mode === "unknown") throw new Error("ping unavailable");
      return { capabilities: mode === "unsupported" ? {} : { medicationSafetyEvents: "v1" } };
    },
    getMedicationSafetyEventsStrict: async () => {
      if (mode === "error") throw new Error("list unavailable");
      if (mode === "forbidden") {
        const error = new Error("membership required");
        error.code = "FORBIDDEN";
        throw error;
      }
      return {
        items: [{
          eventId: "safety-current",
          type: "MEDICATION_SAFETY_EVENT",
          personId: "person-primary",
          personaGeneration: "generation-2",
          medicineName: "药品甲",
          checkStatus: "BLOCKED",
          dispenseStatus: "BLOCKED",
          readState: "UNREAD",
          occurredAt: "2026-08-10 09:15:00",
        }],
        nextCursor: "cursor-2",
      };
    },
  });
  page.data.deviceId = "cabinet-1";
  page.setData = next => Object.assign(page.data, next);

  await page.load();
  assert.equal(page.data.familyMembers[0].unreadSafetyCount, 1);

  mode = "error";
  await page.load();
  assert.equal(page.data.safetyState.availability, "error");
  assert.equal(page.data.safetyState.stale, true);
  assert.equal(page.data.familyMembers[0].unreadSafetyCount, 1);
  assert.match(page.data.carePage.sections[0].supporting, /可能不是最新/);

  mode = "unknown";
  await page.load();
  assert.equal(page.data.safetyState.availability, "unknown");
  assert.equal(page.data.familyMembers[0].unreadSafetyCount, 1);
  assert.match(page.data.safetyState.message, /可能不是最新/);

  mode = "unsupported";
  await page.load();
  assert.equal(page.data.safetyState.availability, "unsupported");
  assert.equal(page.data.familyMembers[0].unreadSafetyCount, 0);
  assert.equal(page.data.familyMembers[0].latestSafetyText, "");

  mode = "ready";
  await page.load();
  mode = "forbidden";
  await page.load();
  assert.equal(page.data.safetyState.availability, "forbidden");
  assert.equal(page.data.familyMembers[0].unreadSafetyCount, 0);
  assert.equal(page.data.familyMembers[0].latestSafetyText, "");
});

test("family settings treats an older cloud without safety capability as unsupported instead of empty or failed", async () => {
  let eventListCalls = 0;
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      serviceUsers: [{ id: "person-a", name: "成员甲" }],
      plans: [{ service_user_id: "person-a", time: "09:00", medicine: "计划药品", status: "pending" }],
    }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
    getMedicationSafetyEventsStrict: async () => {
      eventListCalls += 1;
      return { items: [] };
    },
  });
  page.data = { commands: [], deviceId: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(eventListCalls, 0, "an unsupported server is never probed with an unknown action");
  assert.equal(page.data.safetyState.availability, "unsupported");
  assert.equal(page.data.familyMembers[0].unreadSafetyCount, 0);
  assert.equal(page.data.familyMembers[0].careStatusText, "待办 1 项");
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.match(page.data.carePage.sections[0].supporting, /当前云端版本尚未支持安全记录/);
});

test("family settings presents a medication-box membership denial explicitly", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({ serviceUsers: [{ id: "person-a", name: "成员甲" }], plans: [] }),
    getDevice: async () => ({ deviceId: "cabinet-1", online: true }),
    getRecentCommands: async () => [],
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => {
      const error = new Error("membership required");
      error.code = "FORBIDDEN";
      throw error;
    },
  });
  page.data = { commands: [], deviceId: "" };
  page.setData = next => Object.assign(page.data, next);

  await page.load();
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.safetyState.availability, "forbidden");
  assert.match(page.data.carePage.sections[0].supporting, /当前微信账号无权查看该药箱/);
});

test("an initial family-data failure is explicit instead of looking like an empty household", async () => {
  const permissionError = Object.assign(new Error("membership required"), { code: "FORBIDDEN" });
  for (const failure of [new Error("network unavailable"), permissionError]) {
    const page = loadSettingsPage({
      getSnapshot: async () => ({ serviceUsers: [], plans: [] }),
      getRecentCommands: async () => [],
      getDevice: async () => ({ deviceId: "box-1", online: false }),
      getSnapshotStrict: async () => { throw failure; },
      getRecentCommandsStrict: async () => { throw failure; },
      getDeviceStrict: async () => { throw failure; },
      getCapabilitiesStrict: async () => ({ capabilities: {} }),
    });
    page.data.deviceId = "box-1";
    page.setData = next => Object.assign(page.data, next);

    await page.load();

    assert.equal(page.data.carePage.phase.kind, "error");
    assert.match(page.data.carePage.phase.message, /暂未同步|稍后刷新/);
  }
});

test("family settings can retry an initial failed snapshot through its CarePage error action", async () => {
  let failReads = true;
  const readError = new Error("network unavailable");
  const page = loadSettingsPage({
    getSnapshotStrict: async () => {
      if (failReads) throw readError;
      return { serviceUsers: [], plans: [], device: { deviceId: "box-1", online: true } };
    },
    getRecentCommandsStrict: async () => {
      if (failReads) throw readError;
      return [];
    },
    getDeviceStrict: async () => {
      if (failReads) throw readError;
      return { deviceId: "box-1", online: true };
    },
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  });
  page.data.deviceId = "box-1";
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "error");
  assert.equal(page.data.carePage.phase.action.id, "family.retry");
  failReads = false;

  const retrying = page.onCarePageAction({ detail: page.data.carePage.phase.action });

  assert.equal(page.data.carePage.phase.kind, "loading");
  await retrying;
  assert.equal(page.data.carePage.phase.kind, "ready");
});

test("a same-box background failure keeps the loaded family view and marks it as possibly stale", async () => {
  let failMainData = false;
  const refreshError = new Error("refresh unavailable");
  const page = loadSettingsPage({
    getSnapshotStrict: async () => {
      if (failMainData) throw refreshError;
      return {
        serviceUsers: [{ id: "person-loaded", name: "已加载成员" }],
        plans: [{ service_user_id: "person-loaded", time: "09:00", medicine: "晨间药", status: "pending" }],
      };
    },
    getRecentCommandsStrict: async () => {
      if (failMainData) throw refreshError;
      return [];
    },
    getDeviceStrict: async () => {
      if (failMainData) throw refreshError;
      return { deviceId: "box-1", online: true };
    },
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  });
  page.data.deviceId = "box-1";
  page.setData = next => Object.assign(page.data, next);

  await page.load();
  page.setData({
    bindValue: "box-2-draft",
    detailVisible: true,
    detailMode: "family",
    detailTitle: "全部家人",
    detailMembers: page.data.familyMembers,
  });
  failMainData = true;
  await page.load();

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.stale, true);
  assert.deepEqual(Array.from(page.data.familyMembers, member => member.name), ["已加载成员"]);
  assert.match(page.data.carePage.focus.supporting, /已保存/);
  assert.equal(page.data.bindValue, "box-2-draft");
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailMode, "family");
});

test("family settings keeps device operations and collaboration history out of the first-level page", () => {
  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/settings/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/settings/index.wxss"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/settings/index.js"), "utf8");
  const firstLevelLayout = layout.slice(0, layout.indexOf('<view wx:if="{{detailVisible}}"'));

  assert.match(firstLevelLayout, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/);
  assert.doesNotMatch(firstLevelLayout, /<app-header|wx:for=|bindtap="testVoiceReminder"|bindtap="showCommandDetails"/);
  assert.match(layout, /detailMode === 'family'/);
  assert.match(layout, /detailMode === 'device'/);
  assert.match(layout, /bindtap="showCommandDetails"/);
  assert.match(layout, /detailMode === 'todayCare' && !detailLines\.length/);
  assert.match(layout, /暂无今日照护计划/);
  assert.match(styles, /\.family-member\s*\{[\s\S]*?min-height:\s*132rpx/);
  assert.match(styles, /\.family-member__profile,\s*\.family-member__next\s*\{[\s\S]*?-webkit-line-clamp:\s*2/);
  assert.match(styles, /\.device-action\s*\{[\s\S]*?min-height:\s*88rpx/);
  assert.doesNotMatch(styles, /font-size:\s*(?:1\d|2[0-3])rpx/);
  assert.match(script, /realtime\.subscribe\([\s\S]*?immediate:\s*false/);
});

test("My Medication Boxes renders only the controls allowed by the resolved access mode", () => {
  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/settings/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/settings/index.wxss"), "utf8");

  assert.match(layout, /wx:if="\{\{deviceSessionMode === 'membership'\}\}"[\s\S]*?我的药箱/);
  assert.match(layout, /wx:for="\{\{authorizedDevices\}\}"[\s\S]*?bindtap="selectAuthorizedDevice"[\s\S]*?aria-role="button"[\s\S]*?aria-label=/);
  assert.match(layout, /bindtap="selectAuthorizedDevice"[\s\S]*?aria-selected="\{\{item\.selected\}\}"/);
  assert.match(layout, /wx:if="\{\{canPair\}\}"[\s\S]*?bindinput="onPairingCodeInput"[\s\S]*?aria-label="一次性配对码"[\s\S]*?bindtap="redeemDevicePairingCode"/);
  assert.match(layout, /bindinput="onPairingCodeInput"[\s\S]*?maxlength="256"/);
  assert.match(layout, /deviceSessionAvailability === 'error' \|\| deviceSessionAvailability === 'forbidden' \|\| deviceSessionAvailability === 'pairing-unavailable'[\s\S]*?bindtap="refreshDeviceSession"[\s\S]*?aria-label="重新读取授权药箱"/);
  assert.match(layout, /item\.statusText/);
  assert.match(layout, /item\.statusHint/);
  assert.match(layout, /item\.connectionState/);
  assert.doesNotMatch(layout, /旧版云端|旧版药箱编号|onBindInput|bindDevice|toggleBindForm/);
  assert.match(styles, /\.authorized-device-row\s*\{[\s\S]*?min-height:\s*(?:9[6-9]|[1-9]\d{2,})rpx/);
  assert.match(styles, /\.device-pairing-panel input\s*\{[\s\S]*?height:\s*88rpx/);
  assert.match(styles, /\.authorized-device-row\.is-selected\s*\{/);
});

test("family settings waits for membership resolution before loading an authorized medication box", async () => {
  const pendingSession = deferred();
  const app = {
    globalData: {
      env: "demo",
      deviceId: "cached-unverified-box",
      deviceSessionResolved: false,
      deviceSession: {
        mode: "unknown",
        availability: "loading",
        devices: [],
        selectedDeviceId: "",
        canPair: false,
        pairing: { phase: "idle", message: "" },
      },
    },
    waitForDeviceSession: () => pendingSession.promise,
  };
  const page = loadSettingsPage({}, {
    getApp: () => app,
    wx: { showToast() {} },
  });
  page.data.deviceId = "cached-unverified-box";
  page.data.familyMembers = [{ id: "cached-person" }];
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  let realtimeStarts = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => { realtimeStarts += 1; };

  const showing = page.onShow();

  assert.equal(loads, 0);
  assert.equal(realtimeStarts, 0);
  assert.equal(page.data.deviceId, "");
  assert.deepEqual(Array.from(page.data.familyMembers), []);

  pendingSession.resolve({
    mode: "membership",
    availability: "ready",
    devices: [
      { deviceId: "box-a", name: "父母家药箱", role: "CAREGIVER" },
      { deviceId: "box-b", name: "自己的药箱", role: "OWNER" },
    ],
    selectedDeviceId: "box-a",
    canPair: true,
    message: "",
    pairing: { phase: "idle", message: "" },
  });
  await showing;

  assert.equal(page.data.deviceSessionMode, "membership");
  assert.equal(page.data.deviceSessionAvailability, "ready");
  assert.deepEqual(Array.from(page.data.authorizedDevices, item => item.deviceId), ["box-a", "box-b"]);
  assert.equal(page.data.deviceId, "box-a");
  assert.equal(loads, 1);
  assert.equal(realtimeStarts, 1);
});

test("an unpaired membership opens My Medication Boxes recovery without loading an empty household", () => {
  const session = {
    mode: "membership",
    availability: "unpaired",
    devices: [],
    selectedDeviceId: "",
    canPair: true,
    message: "当前微信账号尚未配对药箱",
    pairing: { phase: "idle", message: "" },
  };
  const page = loadSettingsPage({}, {
    getApp: () => ({
      globalData: {
        env: "demo",
        deviceId: "",
        deviceSessionResolved: true,
        deviceSession: session,
      },
    }),
  });
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => {};

  page.onShow();

  assert.equal(loads, 0);
  assert.equal(page.data.carePage.phase.kind, "empty");
  assert.equal(page.data.carePage.phase.action.id, "family.device");
  assert.match(page.data.carePage.phase.message, /尚未配对药箱/);
  assert.equal(page.data.canPair, true);
  page.onCarePageAction({ detail: page.data.carePage.phase.action });
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailMode, "device");
  assert.equal(page.data.detailTitle, "我的药箱");
});

test("a forbidden membership stays explicit and recoverable without reading a cached device", () => {
  const page = loadSettingsPage({}, {
    getApp: () => ({
      globalData: {
        env: "demo",
        deviceId: "cached-unverified-box",
        deviceSessionResolved: true,
        deviceSession: {
          mode: "membership",
          availability: "forbidden",
          devices: [],
          selectedDeviceId: "cached-unverified-box",
          canPair: true,
          message: "当前微信账号无权查看已选药箱，可重新配对或联系管理员",
          pairing: { phase: "idle", message: "" },
        },
      },
    }),
  });
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => {};

  page.onShow();

  assert.equal(loads, 0);
  assert.equal(page.data.deviceId, "");
  assert.equal(page.data.deviceSessionAvailability, "forbidden");
  assert.equal(page.data.canPair, true);
  assert.equal(page.data.carePage.phase.kind, "error");
  assert.match(page.data.carePage.phase.message, /无权|配对|管理员/);
  assert.equal(page.data.carePage.phase.action.id, "family.device");
});

test("pairing-unavailable membership offers management recovery without a code or cached scope", () => {
  const page = loadSettingsPage({}, {
    getApp: () => ({
      globalData: {
        env: "demo",
        deviceId: "cached-unverified-box",
        deviceSessionResolved: true,
        deviceSession: {
          mode: "membership",
          availability: "pairing-unavailable",
          devices: [],
          selectedDeviceId: "cached-unverified-box",
          canPair: false,
          message: "当前云端未开放自助配对，请联系管理员",
          pairing: { phase: "idle", message: "" },
        },
      },
    }),
  });
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => {};

  page.onShow();

  assert.equal(loads, 0);
  assert.equal(page.data.deviceId, "");
  assert.equal(page.data.deviceSessionAvailability, "pairing-unavailable");
  assert.equal(page.data.canPair, false);
  assert.equal(page.data.carePage.phase.kind, "empty");
  assert.match(page.data.carePage.phase.message, /未开放|管理员/);
  assert.equal(page.data.carePage.phase.action.id, "family.device");
});

test("device-access errors can refresh into a verified membership before family data loads", async () => {
  const refreshed = deferred();
  const app = {
    globalData: {
      env: "demo",
      deviceId: "",
      deviceSessionResolved: true,
      deviceSession: {
        mode: "membership",
        availability: "error",
        devices: [],
        selectedDeviceId: "",
        canPair: true,
        message: "授权药箱列表读取失败，请稍后重试",
      },
    },
    refreshDeviceSession() {
      this.globalData.deviceSessionResolved = false;
      return refreshed.promise.then(session => {
        this.globalData.deviceSessionResolved = true;
        this.globalData.deviceSession = session;
        this.globalData.deviceId = session.selectedDeviceId;
        return session;
      });
    },
  };
  const page = loadSettingsPage({}, {
    getApp: () => app,
    wx: { showToast() {} },
  });
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  let realtimeStarts = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => { realtimeStarts += 1; };
  page.onShow();

  assert.equal(page.data.deviceSessionAvailability, "error");
  assert.equal(page.data.carePage.phase.kind, "error");
  assert.equal(loads, 0);

  const refreshing = page.refreshDeviceSession();
  assert.equal(page.data.deviceSessionAvailability, "loading");
  assert.equal(page.data.deviceId, "");
  assert.equal(loads, 0);

  refreshed.resolve({
    mode: "membership",
    availability: "ready",
    devices: [{ deviceId: "verified-box", name: "已授权药箱" }],
    selectedDeviceId: "verified-box",
    canPair: true,
    pairing: { phase: "idle", message: "" },
  });
  await refreshing;

  assert.equal(page.data.deviceId, "verified-box");
  assert.equal(page.data.deviceSessionAvailability, "ready");
  assert.equal(loads, 1);
  assert.equal(realtimeStarts, 1);
});

test("selecting an authorized medication-box row clears the previous box before reloading", () => {
  const selections = [];
  const initialSession = {
    mode: "membership",
    availability: "ready",
    devices: [
      { deviceId: "box-a", name: "父母家药箱", role: "CAREGIVER" },
      { deviceId: "box-b", name: "自己的药箱", role: "OWNER" },
    ],
    selectedDeviceId: "box-a",
    canPair: true,
    pairing: { phase: "idle", message: "" },
  };
  const app = {
    globalData: {
      env: "demo",
      deviceId: "box-a",
      deviceSessionResolved: true,
      deviceSession: initialSession,
    },
    selectAuthorizedDevice(deviceId) {
      selections.push(deviceId);
      const next = Object.assign({}, this.globalData.deviceSession, { selectedDeviceId: deviceId });
      this.globalData.deviceSession = next;
      this.globalData.deviceId = deviceId;
      return next;
    },
  };
  const page = loadSettingsPage({}, {
    getApp: () => app,
    wx: { showToast() {} },
  });
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  let realtimeStarts = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => { realtimeStarts += 1; };
  page.onShow();
  page.setData({
    pairingCode: "old-one-time-draft",
    pairingBusy: true,
    detailVisible: true,
    detailMode: "family",
    detailLines: [{ label: "旧详情", value: "不应保留" }],
    detailMembers: [{ id: "old-person" }],
    familyMembers: [{ id: "old-person" }],
    familyPreview: [{ id: "old-person" }],
    commands: [{ id: "old-command" }],
    safetyState: { availability: "ready", events: [{ id: "old-safety" }] },
  });

  page.selectAuthorizedDevice({ currentTarget: { dataset: { deviceId: "box-b" } } });

  assert.deepEqual(selections, ["box-b"]);
  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.selectedDeviceId, "box-b");
  assert.equal(page.data.authorizedDevices.find(item => item.deviceId === "box-b").selected, true);
  assert.equal(loads, 2);
  assert.equal(realtimeStarts, 2);
  assert.equal(page.data.detailVisible, false);
  assert.equal(page.data.pairingCode, "");
  assert.equal(page.data.pairingBusy, false);
  assert.deepEqual(Array.from(page.data.familyMembers), []);
  assert.deepEqual(Array.from(page.data.commands), []);
  assert.deepEqual(Array.from(page.data.safetyState.events), []);
});

test("a successful one-time pairing switches only to the device returned in the authorized list", async () => {
  const redeemedCodes = [];
  const unpairedSession = {
    mode: "membership",
    availability: "unpaired",
    devices: [],
    selectedDeviceId: "",
    canPair: true,
    pairing: { phase: "idle", message: "" },
  };
  const app = {
    globalData: {
      env: "demo",
      deviceId: "",
      deviceSessionResolved: true,
      deviceSession: unpairedSession,
    },
    async redeemDevicePairingCode(code) {
      redeemedCodes.push(code);
      const next = {
        mode: "membership",
        availability: "ready",
        devices: [{ deviceId: "paired-box", name: "刚配对药箱", role: "CAREGIVER" }],
        selectedDeviceId: "paired-box",
        canPair: true,
        pairing: { phase: "idle", message: "" },
      };
      this.globalData.deviceSession = next;
      this.globalData.deviceId = "paired-box";
      return next;
    },
  };
  const page = loadSettingsPage({}, {
    getApp: () => app,
    wx: { showToast() {} },
  });
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  let realtimeStarts = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => { realtimeStarts += 1; };
  page.onShow();
  page.onPairingCodeInput({ detail: { value: "  one-time-secret  " } });

  await page.redeemDevicePairingCode();

  assert.deepEqual(redeemedCodes, ["one-time-secret"]);
  assert.equal(page.data.deviceId, "paired-box");
  assert.equal(page.data.selectedDeviceId, "paired-box");
  assert.equal(page.data.deviceSessionAvailability, "ready");
  assert.equal(page.data.authorizedDevices[0].selected, true);
  assert.equal(page.data.pairingCode, "");
  assert.equal(page.data.pairingBusy, false);
  assert.equal(loads, 1);
  assert.equal(realtimeStarts, 1);
});

test("an invalid pairing code cannot look successful just because an older authorized box stays ready", async () => {
  const toasts = [];
  const readySession = {
    mode: "membership",
    availability: "ready",
    devices: [{ deviceId: "existing-box", name: "已有药箱" }],
    selectedDeviceId: "existing-box",
    canPair: true,
    pairing: { phase: "idle", message: "" },
  };
  const app = {
    globalData: {
      env: "demo",
      deviceId: "existing-box",
      deviceSessionResolved: true,
      deviceSession: readySession,
    },
    async redeemDevicePairingCode() {
      const next = Object.assign({}, readySession, {
        pairing: { phase: "error", message: "配对码无效或已失效，请重新获取" },
      });
      this.globalData.deviceSession = next;
      return next;
    },
  };
  const page = loadSettingsPage({}, {
    getApp: () => app,
    wx: { showToast(options) { toasts.push(options.title); } },
  });
  page.setData = next => Object.assign(page.data, next);
  let loads = 0;
  page.load = () => { loads += 1; };
  page.startRealtime = () => {};
  page.onShow();
  page.onPairingCodeInput({ detail: { value: "expired-code" } });

  await page.redeemDevicePairingCode();

  assert.equal(page.data.deviceId, "existing-box");
  assert.equal(page.data.pairingCode, "expired-code");
  assert.equal(page.data.pairingPhase, "error");
  assert.match(page.data.pairingMessage, /无效|失效|重新/);
  assert.equal(loads, 1);
  assert.doesNotMatch(toasts.join(" "), /成功/);
});

test("membership mode has no arbitrary device-id handler and rejects injected rows", () => {
  const storage = [];
  let selectionCalls = 0;
  const app = {
    globalData: {
      env: "demo",
      deviceId: "authorized-box",
      deviceSessionResolved: true,
      deviceSession: {
        mode: "membership",
        availability: "ready",
        devices: [{ deviceId: "authorized-box", name: "授权药箱" }],
        selectedDeviceId: "authorized-box",
        canPair: true,
      },
    },
    selectAuthorizedDevice() {
      selectionCalls += 1;
      throw new Error("must not be called");
    },
  };
  const page = loadSettingsPage({}, {
    getApp: () => app,
    wx: {
      setStorageSync: (...args) => storage.push(args),
      showToast() {},
    },
  });
  page.setData = next => Object.assign(page.data, next);
  page.load = () => {};
  page.startRealtime = () => {};
  page.onShow();

  page.selectAuthorizedDevice({ currentTarget: { dataset: { deviceId: "row-injected-box" } } });

  assert.equal(typeof page.bindDevice, "undefined");
  assert.equal(typeof page.toggleBindForm, "undefined");
  assert.equal(selectionCalls, 0);
  assert.equal(app.globalData.deviceId, "authorized-box");
  assert.equal(page.data.deviceId, "authorized-box");
  assert.deepEqual(storage, []);
});

test("selecting another authorized medication box restarts syncing before reload", () => {
  const storage = [];
  const selections = [];
  const app = {
    globalData: {
      env: "demo",
      deviceId: "old-box",
      deviceSessionResolved: true,
      deviceSession: {
        mode: "membership",
        availability: "ready",
        devices: [
          { deviceId: "old-box", name: "旧药箱" },
          { deviceId: "new-box", name: "新药箱" },
        ],
        selectedDeviceId: "old-box",
        canPair: false,
      },
    },
    selectAuthorizedDevice(deviceId) {
      selections.push(deviceId);
      const next = Object.assign({}, this.globalData.deviceSession, { selectedDeviceId: deviceId });
      this.globalData.deviceSession = next;
      this.globalData.deviceId = deviceId;
      return next;
    },
  };
  const page = loadSettingsPage({}, {
    getApp: () => app,
    wx: {
      setStorageSync() {
        assert.fail("settings must leave legacy selection persistence to app.selectAuthorizedDevice");
      },
      showToast() {},
    },
  });
  page.data = {
    deviceId: "old-box",
    detailVisible: true,
    detailMode: "family",
    detailTitle: "全部家人",
    detailLines: [{ label: "旧详情", value: "不应保留" }],
    detailMembers: [{ id: "old-person" }],
    familyMembers: [{ id: "old-person" }],
    familyPreview: [{ id: "old-person" }],
    commands: [{ id: "old-command" }],
    safetyState: { availability: "ready", events: [{ id: "old-safety" }] },
    carePage: { phase: { kind: "ready" } },
    deviceSessionMode: "membership",
    deviceSessionAvailability: "ready",
    authorizedDevices: [
      { deviceId: "old-box", selected: true },
      { deviceId: "new-box", selected: false },
    ],
  };
  page.setData = next => Object.assign(page.data, next);
  let restarts = 0;
  let reloads = 0;
  page.startRealtime = () => { restarts += 1; };
  page.load = () => { reloads += 1; };

  page.selectAuthorizedDevice({ currentTarget: { dataset: { deviceId: "new-box" } } });

  assert.deepEqual(selections, ["new-box"]);
  assert.equal(restarts, 1);
  assert.equal(reloads, 1);
  assert.deepEqual(storage, []);
  assert.equal(page.data.detailVisible, false);
  assert.equal(page.data.detailMode, "lines");
  assert.deepEqual(Array.from(page.data.detailLines), []);
  assert.deepEqual(Array.from(page.data.detailMembers), []);
  assert.deepEqual(Array.from(page.data.familyMembers), []);
  assert.deepEqual(Array.from(page.data.familyPreview), []);
  assert.deepEqual(Array.from(page.data.commands), []);
  assert.deepEqual(Array.from(page.data.safetyState.events), []);
  assert.equal(page.data.carePage.phase.kind, "loading");
});

test("showing settings for a different medication box clears the old interaction state before reload", () => {
  const page = loadSettingsPage({}, {
    getApp: () => ({
      globalData: {
        deviceId: "new-box",
        env: "demo",
        deviceSessionResolved: true,
        deviceSession: {
          mode: "membership",
          availability: "ready",
          devices: [{ deviceId: "new-box", name: "新药箱" }],
          selectedDeviceId: "new-box",
          canPair: false,
        },
      },
    }),
  });
  page.data = {
    deviceId: "old-box",
    detailVisible: true,
    detailMode: "family",
    detailTitle: "旧药箱家人",
    detailLines: [{ label: "旧详情", value: "不应保留" }],
    detailMembers: [{ id: "old-person" }],
    familyMembers: [{ id: "old-person" }],
    familyPreview: [{ id: "old-person" }],
    commands: [{ id: "old-command" }],
    safetyState: { availability: "ready", events: [{ id: "old-safety" }] },
    carePage: { phase: { kind: "ready" } },
  };
  page.setData = next => Object.assign(page.data, next);
  let reloads = 0;
  let realtimeStarts = 0;
  page.load = () => { reloads += 1; };
  page.startRealtime = () => { realtimeStarts += 1; };

  page.onShow();

  assert.equal(reloads, 1);
  assert.equal(realtimeStarts, 1);
  assert.equal(page.data.deviceId, "new-box");
  assert.equal(page.data.detailVisible, false);
  assert.equal(page.data.detailMode, "lines");
  assert.deepEqual(Array.from(page.data.detailLines), []);
  assert.deepEqual(Array.from(page.data.detailMembers), []);
  assert.deepEqual(Array.from(page.data.familyMembers), []);
  assert.deepEqual(Array.from(page.data.familyPreview), []);
  assert.deepEqual(Array.from(page.data.commands), []);
  assert.deepEqual(Array.from(page.data.safetyState.events), []);
  assert.equal(page.data.carePage.phase.kind, "loading");
});

test("a first load failure after switching boxes shows an error instead of reviving the old box", async () => {
  let appDeviceId = "old-box";
  let failNewBox = true;
  const app = {
    globalData: {
      deviceId: "old-box",
      env: "demo",
      deviceSessionResolved: true,
      deviceSession: {
        mode: "membership",
        availability: "ready",
        devices: [
          { deviceId: "old-box", name: "旧药箱" },
          { deviceId: "new-box", name: "新药箱" },
        ],
        selectedDeviceId: "old-box",
        canPair: false,
      },
    },
  };
  const page = loadSettingsPage({
    getSnapshotStrict: async options => {
      if (options.deviceId === "new-box" && failNewBox) throw new Error("new box unavailable");
      return {
        serviceUsers: [{
          id: `${options.deviceId}-person`,
          name: options.deviceId === "new-box" ? "新药箱成员" : "旧药箱成员",
        }],
        plans: [],
      };
    },
    getRecentCommandsStrict: async (limit, deviceId) => {
      if (deviceId === "new-box" && failNewBox) throw new Error("new box unavailable");
      return [];
    },
    getDeviceStrict: async deviceId => {
      if (deviceId === "new-box" && failNewBox) throw new Error("new box unavailable");
      return { deviceId, online: true };
    },
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  }, {
    getApp: () => {
      app.globalData.deviceId = appDeviceId;
      app.globalData.deviceSession.selectedDeviceId = appDeviceId;
      return app;
    },
  });
  page.data.deviceId = "old-box";
  page.setData = next => Object.assign(page.data, next);
  page.startRealtime = () => {};

  await page.load();
  assert.deepEqual(Array.from(page.data.familyMembers, member => member.name), ["旧药箱成员"]);

  appDeviceId = "new-box";
  const originalLoad = page.load;
  let switchedLoad;
  page.load = function loadAfterSwitch() {
    switchedLoad = originalLoad.call(this);
    return switchedLoad;
  };
  page.onShow();

  assert.equal(page.data.deviceId, "new-box");
  assert.deepEqual(Array.from(page.data.familyMembers), []);
  assert.equal(page.data.detailVisible, false);
  await switchedLoad;

  assert.equal(page.data.carePage.phase.kind, "error");
  assert.equal(page.data.carePage.phase.action.id, "family.retry");
  assert.equal(page.data.stale, false);
  assert.deepEqual(Array.from(page.data.familyMembers), []);

  failNewBox = false;
  const retrying = page.onCarePageAction({ detail: page.data.carePage.phase.action });
  assert.equal(page.data.carePage.phase.kind, "loading");
  await retrying;

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.deviceId, "new-box");
  assert.deepEqual(Array.from(page.data.familyMembers, member => member.name), ["新药箱成员"]);
});

test("family settings pins each load to its starting medication box and ignores a late old-box response", async () => {
  const oldSnapshot = deferred();
  const requests = { snapshots: [], commands: [], devices: [], capabilities: [], safety: [] };
  const snapshotFor = deviceId => ({
    device: { deviceId, online: true },
    serviceUsers: [{ id: `person-${deviceId}`, name: deviceId === "new-box" ? "新药箱成员" : "旧药箱成员" }],
    plans: [],
  });
  const page = loadSettingsPage({
    getSnapshot: async options => {
      requests.snapshots.push(options.deviceId);
      return options.deviceId === "old-box" ? oldSnapshot.promise : snapshotFor(options.deviceId);
    },
    getRecentCommands: async (limit, deviceId) => {
      requests.commands.push(deviceId);
      return [];
    },
    getDevice: async deviceId => {
      requests.devices.push(deviceId);
      return { deviceId, online: true };
    },
    getCapabilitiesStrict: async deviceId => {
      requests.capabilities.push(deviceId);
      return { capabilities: { medicationSafetyEvents: "v1" } };
    },
    getMedicationSafetyEventsStrict: async options => {
      requests.safety.push(options.deviceId);
      return { items: [], nextCursor: "" };
    },
  });
  page.data.deviceId = "old-box";
  page.setData = next => Object.assign(page.data, next);

  const staleLoad = page.load();
  page.setData({ deviceId: "new-box" });
  await page.load();
  oldSnapshot.resolve(snapshotFor("old-box"));
  await staleLoad;

  assert.equal(page.data.deviceId, "new-box");
  assert.deepEqual(Array.from(page.data.familyMembers, member => member.name), ["新药箱成员"]);
  assert.deepEqual(requests.snapshots, ["old-box", "new-box"]);
  assert.deepEqual(requests.commands, ["old-box", "new-box"]);
  assert.deepEqual(requests.devices, ["old-box", "new-box"]);
  assert.deepEqual(requests.capabilities, ["old-box", "new-box"]);
  assert.deepEqual(requests.safety, ["old-box", "new-box"]);
});

test("an obsolete snapshot device field cannot replace the selected authorized scope", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({
      device: { deviceId: "injected-box", online: true },
      serviceUsers: [{ id: "injected-person", name: "不应显示" }],
      plans: [],
    }),
    getRecentCommands: async () => [],
    getDevice: async () => ({ deviceId: "authorized-box", online: true }),
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  });
  page.data.deviceId = "authorized-box";
  page.data.deviceSessionMode = "membership";
  page.data.deviceSessionAvailability = "ready";
  page.data.authorizedDevices = [{ deviceId: "authorized-box", selected: true }];
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.deviceId, "authorized-box");
  assert.deepEqual(Array.from(page.data.familyMembers, item => item.name), ["不应显示"]);
  assert.equal(page.data.carePage.phase.kind, "ready");
  const source = fs.readFileSync(pagePath, "utf8");
  assert.doesNotMatch(source, /snapshot\.device/);
});

test("membership data loading stops before I/O when the current device is not authorized", async () => {
  let readCalls = 0;
  const countRead = async () => {
    readCalls += 1;
    return {};
  };
  const page = loadSettingsPage({
    getSnapshotStrict: countRead,
    getRecentCommandsStrict: countRead,
    getDeviceStrict: countRead,
    getCapabilitiesStrict: countRead,
  });
  page.data.deviceId = "typed-unauthorized-box";
  page.data.deviceSessionMode = "membership";
  page.data.deviceSessionAvailability = "ready";
  page.data.authorizedDevices = [{ deviceId: "authorized-box", selected: true }];
  page.data.canPair = true;
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(readCalls, 0);
  assert.equal(page.data.deviceId, "");
  assert.equal(page.data.deviceSessionAvailability, "error");
  assert.equal(page.data.carePage.phase.kind, "error");
});

test("a successful same-box refresh preserves the detail being read and the box id being typed", async () => {
  const page = loadSettingsPage({
    getSnapshot: async () => ({ serviceUsers: [{ id: "person-new", name: "新成员" }], plans: [] }),
    getRecentCommands: async () => [],
    getDevice: async () => ({ deviceId: "box-1", online: true }),
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  });
  page.data.deviceId = "box-1";
  page.data.bindValue = "box-2-draft";
  page.data.pairingCode = "same-box-pairing-draft";
  page.data.detailVisible = true;
  page.data.detailMode = "family";
  page.data.detailTitle = "全部家人";
  page.data.detailLines = [{ label: "阅读位置", value: "不应关闭" }];
  page.data.detailMembers = [{ id: "person-old" }];
  page.setData = next => Object.assign(page.data, next);

  await page.load();

  assert.equal(page.data.bindValue, "box-2-draft");
  assert.equal(page.data.pairingCode, "same-box-pairing-draft");
  assert.equal(page.data.detailVisible, true);
  assert.equal(page.data.detailMode, "family");
  assert.equal(page.data.detailTitle, "全部家人");
  assert.deepEqual(Array.from(page.data.detailLines), [{ label: "阅读位置", value: "不应关闭" }]);
  assert.deepEqual(Array.from(page.data.detailMembers), [{ id: "person-old" }]);
});

test("voice reminder submission stays pinned to the medication box captured when it starts", async () => {
  const submission = deferred();
  const calls = [];
  const page = loadSettingsPage({
    addCommand: async (type, payload, options) => {
      calls.push({ type, payload, options });
      return submission.promise;
    },
  }, {
    getApp: () => ({ globalData: { deviceId: "old-box" } }),
    wx: { showToast() {} },
  });
  page.data.deviceId = "old-box";
  page.data.device = { deviceId: "old-box", online: true };
  page.data.offlineSnapshot = false;
  page.data.deviceAccessReady = true;
  page.setData = next => Object.assign(page.data, next);
  page.load = () => {};

  const pending = page.testVoiceReminder();
  page.setData({ deviceId: "new-box" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "AUDIO_SPEAK");
  assert.equal(calls[0].options.deviceId, "old-box");
  assert.match(calls[0].options.requestId, /^test-speak-/);

  submission.resolve({ id: "command-1", status: "pending" });
  await pending;
});

test("authorization refresh invalidates an old-box load before it can repaint cleared settings", async () => {
  const oldSnapshot = deferred();
  const refreshedSession = deferred();
  const app = {
    globalData: {
      deviceId: "old-box",
      env: "demo",
      deviceSessionResolved: true,
      deviceSession: {
        mode: "membership",
        availability: "ready",
        selectedDeviceId: "old-box",
        devices: [{ deviceId: "old-box" }],
      },
    },
    refreshDeviceSession() {
      this.globalData.deviceId = "";
      this.globalData.deviceSessionResolved = false;
      return refreshedSession.promise;
    },
  };
  const page = loadSettingsPage({
    getSnapshotStrict: async () => oldSnapshot.promise,
    getRecentCommandsStrict: async () => [],
    getDeviceStrict: async () => ({ deviceId: "old-box", online: true }),
    getCapabilitiesStrict: async () => ({ capabilities: {} }),
  }, {
    getApp: () => app,
    wx: { showToast() {} },
  });
  page.data.deviceId = "old-box";
  page.data.deviceAccessReady = true;
  page.data.deviceSessionMode = "membership";
  page.data.deviceSessionAvailability = "ready";
  page.data.authorizedDevices = [{ deviceId: "old-box", selected: true }];
  page.setData = next => Object.assign(page.data, next);
  page.startRealtime = () => {};

  const staleLoad = page.load();
  const refreshing = page.refreshDeviceSession();
  assert.equal(page.data.deviceId, "");
  assert.deepEqual(Array.from(page.data.familyMembers), []);

  oldSnapshot.resolve({
    device: { deviceId: "old-box", online: true },
    serviceUsers: [{ id: "old-person", name: "旧药箱成员" }],
    plans: [],
  });
  await staleLoad;

  assert.equal(page.data.deviceId, "");
  assert.deepEqual(Array.from(page.data.familyMembers), []);
  assert.equal(page.data.deviceSessionAvailability, "loading");

  const unpaired = {
    mode: "membership",
    availability: "unpaired",
    selectedDeviceId: "",
    devices: [],
    canPair: true,
  };
  app.globalData.deviceSession = unpaired;
  app.globalData.deviceSessionResolved = true;
  refreshedSession.resolve(unpaired);
  await refreshing;
  assert.equal(page.data.deviceSessionAvailability, "unpaired");
  assert.deepEqual(Array.from(page.data.familyMembers), []);
});

test("voice reminder is blocked when the displayed medication box is no longer the active authorized scope", async () => {
  const calls = [];
  const toasts = [];
  const page = loadSettingsPage({
    addCommand: async (...args) => calls.push(args),
  }, {
    getApp: () => ({ globalData: { deviceId: "new-box" } }),
    wx: { showToast: options => toasts.push(options) },
  });
  page.data.deviceId = "old-box";
  page.data.deviceAccessReady = true;
  page.data.deviceSessionMode = "membership";
  page.data.deviceSessionAvailability = "ready";
  page.data.authorizedDevices = [{ deviceId: "old-box", selected: true }];
  page.setData = next => Object.assign(page.data, next);

  await page.testVoiceReminder();

  assert.equal(calls.length, 0);
  assert.match(toasts[0].title, /重新选择|授权/);
});
