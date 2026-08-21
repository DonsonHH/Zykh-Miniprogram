const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/vitals/index.js");

function loadVitalsPage(apiOverrides, context = {}) {
  let definition = null;
  const toasts = [];
  const modals = [];
  const api = Object.assign({}, apiOverrides);
  const readDevice = api.getDeviceStrict || api.getDevice || (async deviceId => ({ deviceId, online: true }));
  api.getDeviceStrict = async deviceId => {
    const device = await readDevice(deviceId);
    if (device && device.connection) return device;
    const online = device && device.online === true;
    return Object.assign({}, device, {
      heartbeatAgeMs: online ? 0 : 120000,
      lastSeenAtEpochMs: online ? Date.now() : Date.now() - 120000,
      connection: {
        state: online ? "online" : "stale",
        online,
        heartbeatAgeMs: online ? 0 : 120000,
      },
    });
  };
  api.getLatestVitalsStrict = api.getLatestVitalsStrict || api.getLatestVitals;
  api.getRecentCommandsStrict = api.getRecentCommandsStrict || api.getRecentCommands;
  api.getSnapshotStrict = api.getSnapshotStrict || (async () => ({ serviceUsers: [] }));
  api.getCapabilitiesStrict = api.getCapabilitiesStrict || (async () => ({ capabilities: {} }));
  const source = fs.readFileSync(pagePath, "utf8");
  const app = context.app || { globalData: { deviceId: "box-1" } };
  vm.runInNewContext(source, {
    Page(page) {
      definition = page;
    },
    require(modulePath) {
      if (modulePath.includes("realtime")) return context.realtime || { subscribe: () => () => {} };
      if (modulePath.includes("utils/dateTime")) {
        return require(path.join(__dirname, "../miniprogram/utils/dateTime"));
      }
      if (modulePath.includes("utils/deviceSession")) {
        return Object.assign(
          {},
          require(path.join(__dirname, "../miniprogram/utils/deviceSession")),
          { runAfterDeviceSessionReady: callback => callback() },
          context.deviceSession || {},
        );
      }
      if (modulePath.includes("utils/carePage")) {
        return require(path.join(__dirname, "../miniprogram/utils/carePage"));
      }
      if (modulePath.includes("utils/connectionState")) {
        return require(path.join(__dirname, "../miniprogram/utils/connectionState"));
      }
      if (modulePath.includes("modules/vitalsAttribution")) {
        return require(path.join(__dirname, "../miniprogram/modules/vitalsAttribution"));
      }
      if (modulePath.includes("utils/api")) return api;
      throw new Error(`unexpected module ${modulePath}`);
    },
    getApp: () => app,
    wx: {
      showToast(options) {
        toasts.push(options);
      },
      showModal(options) {
        modals.push(options);
      },
    },
  }, { filename: pagePath });
  definition.data = Object.assign({}, definition.data);
  definition.setData = next => Object.assign(definition.data, next);
  definition.toasts = toasts;
  definition.modals = modals;
  definition._testApp = app;
  return definition;
}

test("vitals presents a canonical inquiry measurement as its exact active member", async () => {
  const page = loadVitalsPage({
    getDevice: async () => ({ online: true }),
    getLatestVitalsStrict: async () => ({
      recordId: "vitals-member",
      personId: "member-1",
      personName: "王奶奶",
      personaGeneration: "generation-2",
      inquirySessionId: "inquiry-1",
      attributionSource: "INQUIRY_SESSION",
      createdAt: localTimestamp(),
      heartRate: 72,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
    }),
    getRecentCommandsStrict: async () => [],
    getSnapshotStrict: async () => ({
      serviceUsers: [{ id: "member-1", name: "当前王奶奶", personaGeneration: "generation-2" }],
    }),
    getCapabilitiesStrict: async () => ({
      schemaRevision: "2.7-runtime-consistency",
      capabilities: { vitalsAttribution: "v1" },
    }),
  });

  await page.load();

  assert.equal(page.data.vitalsView.personName, "王奶奶");
  assert.equal(page.data.vitalsView.attributionKind, "MEMBER");
  assert.equal(page.data.vitalsAttribution.canAttach, true);
});

test("vitals exposes broken inquiry attribution diagnostics without inventing a member", async () => {
  const page = loadVitalsPage({
    getDevice: async () => ({ online: true }),
    getLatestVitalsStrict: async () => ({
      recordId: "vitals-broken",
      personName: "王奶奶",
      personaGeneration: "generation-2",
      inquirySessionId: "inquiry-broken",
      attributionSource: "INQUIRY_SESSION",
      createdAt: localTimestamp(),
      heartRate: 72,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
    }),
    getRecentCommandsStrict: async () => [],
    getSnapshotStrict: async () => ({
      serviceUsers: [{ id: "member-1", name: "王奶奶", personaGeneration: "generation-2" }],
    }),
    getCapabilitiesStrict: async () => ({
      schemaRevision: "2.7-runtime-consistency",
      capabilities: { vitalsAttribution: "v1" },
    }),
  });

  await page.load();
  page.showMeasureDetails();

  assert.equal(page.data.vitalsView.personName, "归属信息同步异常");
  assert.equal(page.data.vitalsView.attributionKind, "BROKEN_INQUIRY");
  const detail = Object.fromEntries(page.data.detailRows.map(row => [row.label, row.value]));
  assert.equal(detail["记录编号"], "vitals-broken");
  assert.equal(detail["问询会话"], "inquiry-broken");
  assert.equal(detail["归属来源"], "INQUIRY_SESSION");
  assert.equal(detail["归属能力"], "v1");
  assert.equal(detail["云端版本"], "2.7-runtime-consistency");
});

test("vitals presents a canonical standalone measurement as an unregistered person", async () => {
  const page = loadVitalsPage({
    getDevice: async () => ({ online: true }),
    getLatestVitalsStrict: async () => ({
      recordId: "vitals-standalone",
      personId: "stale-member-id",
      personName: "同名人员",
      personaGeneration: "generation-2",
      attributionSource: "STANDALONE",
      createdAt: localTimestamp(),
      heartRate: 72,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
    }),
    getRecentCommandsStrict: async () => [],
    getSnapshotStrict: async () => ({
      serviceUsers: [{ id: "stale-member-id", name: "同名人员", personaGeneration: "generation-2" }],
    }),
    getCapabilitiesStrict: async () => ({
      schemaRevision: "2.7-runtime-consistency",
      capabilities: { vitalsAttribution: "v1" },
    }),
  });

  await page.load();

  assert.equal(page.data.vitalsView.personName, "未登记人员");
  assert.equal(page.data.vitalsView.attributionKind, "STANDALONE");
  assert.equal(page.data.vitalsAttribution.canAttach, false);
});

test("vitals waits for the device session and starts one read before non-immediate realtime", async () => {
  const ready = deferred();
  let realtimeOptions = null;
  const page = loadVitalsPage({}, {
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
  let loads = 0;
  page.load = () => { loads += 1; return Promise.resolve(); };

  const showing = page.onShow();
  assert.equal(loads, 0);
  assert.equal(realtimeOptions, null);

  ready.resolve();
  await showing;

  assert.equal(loads, 1);
  assert.equal(realtimeOptions.immediate, false);
});

function localTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
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

test("vitals summary turns a synced measurement timestamp into a contextual care time", async () => {
  const rawTime = localTimestamp();
  const page = loadVitalsPage({
    getDevice: async () => ({ online: true }),
    getLatestVitals: async () => ({
      createdAt: rawTime,
      personName: "王阿姨",
      heartRate: 72,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
    }),
    getRecentCommands: async () => [],
  });

  await page.load();

  assert.match(page.data.vitalsView.timeLabel, /^今天 \d{2}:\d{2}$/);
  assert.notEqual(page.data.vitalsView.timeLabel, rawTime);
  assert.match(page.data.vitalsView.sensorHint, /最近一次有效测量/);
  assert.equal(page.data.vitalsView.personName, "王阿姨（旧记录）");
  assert.equal(page.data.vitalsView.attributionKind, "LEGACY");
  assert.equal(page.data.vitalsView.measurementStatusLabel, "已同步");
  assert.equal(page.data.vitalsView.measurementStatusClass, "good");
});

test("vitals summary distinguishes a missing upload from a failed measurement", async () => {
  const page = loadVitalsPage({
    getDevice: async () => ({ online: false }),
    getLatestVitals: async () => null,
    getRecentCommands: async () => [],
  });

  await page.load();

  assert.equal(page.data.vitalsView.timeLabel, "暂无测量数据");
  assert.match(page.data.vitalsView.sensorHint, /等待药箱上传/);
  assert.equal(page.data.vitalsView.measurementStatusLabel, "暂无数据");
  assert.equal(page.data.vitalsView.measurementStatusClass, "muted");
  assert.match(page.data.vitalsView.actionFootnote, /药箱上线后执行/);
});

test("vitals treats an unavailable command status as unknown and blocks a potentially duplicate request", async () => {
  let strictCommandReads = 0;
  let compatibilityCommandReads = 0;
  let submissions = 0;
  const page = loadVitalsPage({
    getDevice: async () => ({ online: true }),
    getLatestVitals: async () => ({
      createdAt: localTimestamp(),
      heartRate: 72,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
    }),
    getRecentCommandsStrict: async () => {
      strictCommandReads += 1;
      throw new Error("command status unavailable");
    },
    getRecentCommands: async () => {
      compatibilityCommandReads += 1;
      return [];
    },
    addCommand: async () => {
      submissions += 1;
    },
  });

  await page.load();

  assert.equal(strictCommandReads, 1);
  assert.equal(compatibilityCommandReads, 0);
  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.vitalsView.commandStatusLabel, "请求状态暂不可用");
  assert.equal(page.data.commandStatusKnown, false);
  assert.equal(page.data.carePage.focus.action.disabled, true);
  assert.match(page.data.carePage.focus.action.label, /状态暂不可用/);

  await page.readAll();

  assert.equal(submissions, 0);
  assert.match(page.toasts.at(-1).title, /状态暂不可用/);
});

test("vitals shows a retryable error instead of an empty measurement when its first read fails", async () => {
  let unavailable = true;
  const page = loadVitalsPage({
    getDevice: async () => ({ online: false }),
    getLatestVitals: async () => null,
    getLatestVitalsStrict: async () => {
      if (unavailable) throw new Error("vitals unavailable");
      return null;
    },
    getRecentCommands: async () => [],
  });

  await page.load();

  assert.equal(page.data.carePage.phase.kind, "error");
  assert.match(page.data.carePage.phase.message, /读取失败|重新加载/);
  assert.doesNotMatch(page.data.carePage.phase.message, /暂无数据/);
  assert.equal(page.data.carePage.focus, null);
  assert.equal(page.data.carePage.phase.action.id, "vitals.retry");
  assert.equal(page.data.carePage.phase.action.label, "重新加载测量数据");

  unavailable = false;
  await page.onCarePageAction({ detail: page.data.carePage.phase.action });

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.match(page.data.carePage.focus.title, /还没有测量记录/);
});

test("vitals keeps the last measurement and marks it as stale when a background refresh fails", async () => {
  let refreshFails = false;
  const latestVitals = {
    createdAt: localTimestamp(),
    heartRate: 72,
    spo2: 98,
    bodyTemp: 36.5,
    quality: "good",
  };
  const page = loadVitalsPage({
    getDevice: async () => ({ online: true }),
    getLatestVitals: async () => latestVitals,
    getLatestVitalsStrict: async () => {
      if (refreshFails) throw new Error("refresh failed");
      return latestVitals;
    },
    getRecentCommands: async () => [],
  });

  await page.load();
  refreshFails = true;
  await page.load();

  assert.equal(page.data.carePage.phase.kind, "ready");
  assert.equal(page.data.carePage.overview[0].value, "72");
  assert.match(page.data.carePage.focus.supporting, /可能不是最新/);
});

test("vitals summary labels partial and poor-signal readings without calling them valid", async () => {
  for (const quality of ["partial", "poor_signal"]) {
    const page = loadVitalsPage({
      getDevice: async () => ({ online: true }),
      getLatestVitals: async () => ({
        createdAt: localTimestamp(),
        heartRate: 72,
        spo2: null,
        bodyTemp: 36.5,
        quality,
      }),
      getRecentCommands: async () => [],
    });

    await page.load();

    assert.equal(page.data.vitalsView.measurementStatusClass, "warn");
    assert.doesNotMatch(page.data.vitalsView.sensorHint, /有效测量/);
    assert.equal(page.data.vitalsView.spo2, "--");
  }
});

test("vitals summary treats unavailable and no-finger readings as failed measurements", async () => {
  for (const quality of ["unavailable", "no_finger", "failed", "error"]) {
    const page = loadVitalsPage({
      getDevice: async () => ({ online: true }),
      getLatestVitals: async () => ({
        createdAt: localTimestamp(),
        heartRate: 72,
        spo2: 98,
        bodyTemp: 36.5,
        quality,
      }),
      getRecentCommands: async () => [],
    });

    await page.load();

    assert.equal(page.data.vitalsView.measurementStatusClass, "danger");
    assert.equal(page.data.vitalsView.measurementStatusLabel, "测量异常");
    assert.doesNotMatch(page.data.vitalsView.sensorHint, /有效测量/);
    assert.equal(page.data.vitalsView.heartRate, "--");
  }
});

test("vitals summary makes an unlabelled measurement explicit instead of assigning it to a family member", async () => {
  const page = loadVitalsPage({
    getDevice: async () => ({ online: true }),
    getLatestVitals: async () => ({
      createdAt: localTimestamp(),
      heartRate: 72,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
    }),
    getRecentCommands: async () => [],
  });

  await page.load();

  assert.equal(page.data.vitalsView.personName, "未登记人员（旧记录）");
});

test("vitals exposes measurement, device detail and request flows through the care screen interface", async () => {
  const page = loadVitalsPage({
    getDevice: async () => ({ online: true }),
    getLatestVitals: async () => ({
      createdAt: localTimestamp(),
      heartRate: 72,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
    }),
    getRecentCommands: async () => ([{
      type: "READ_VITALS_ALL",
      status: "done",
    }]),
  });

  await page.load();

  assert.equal(page.data.vitalsView.deviceStatusLabel, "药箱在线");
  assert.equal(page.data.vitalsView.commandStatusLabel, "已完成");
  assert.equal(page.data.vitalsView.measurementStatusLabel, "已同步");

  assert.equal(page.data.carePage.title, "健康测量");
  assert.equal(page.data.carePage.focus.action.id, "vitals.measure");
  assert.equal(page.data.carePage.focus.activation, "button");
  assert.deepEqual(Array.from(page.data.carePage.overview, fact => fact.label), ["心率", "血氧", "体温"]);
  assert.deepEqual(Array.from(page.data.carePage.overview, fact => fact.value), ["72", "98", "36.5"]);
  assert.equal(page.data.carePage.sections[0].items[0].action.id, "vitals.details");

  page.onCarePageAction({ detail: { id: "vitals.details" } });
  assert.equal(page.data.detailVisible, true);
  assert.ok(page.data.detailRows.some(row => row.label === "测量对象" && row.value === "未登记人员（旧记录）"));

  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/vitals/index.wxml"), "utf8");
  assert.match(layout, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/);
  assert.match(layout, /class="ui-sheet vitals-sheet"/);
  assert.match(layout, /ui-status--{{vitalsView\.measurementStatusClass}}/);
  assert.match(layout, /{{vitalsView\.measurementStatusLabel}}/);
  assert.match(layout, /{{vitalsView\.actionFootnote}}/);
  assert.doesNotMatch(layout, /<app-header|vitals-summary-card|vitals-action-panel/);
});

test("vitals submits only one measurement command while a request is in progress", async () => {
  const commandSubmission = deferred();
  let submissionCount = 0;
  let submittedPayload = null;
  const page = loadVitalsPage({
    getDevice: async () => ({ online: false }),
    getLatestVitals: async () => null,
    getRecentCommands: async () => [],
    addCommand: async (type, payload) => {
      submissionCount += 1;
      submittedPayload = payload;
      return commandSubmission.promise;
    },
  });
  await page.load();

  const firstRequest = page.readAll();
  const repeatedRequest = page.readAll();

  assert.equal(submissionCount, 1);
  assert.equal(page.data.measuring, true);
  assert.equal(page.data.carePage.focus.action.disabled, true);
  assert.equal(page.data.carePage.focus.action.label, "请求中…");

  commandSubmission.resolve();
  await Promise.all([firstRequest, repeatedRequest]);

  assert.equal(page.data.measuring, false);
  assert.equal(page.data.carePage.focus.action.disabled, false);
  assert.equal(page.data.carePage.focus.action.label, "请求测量");
  assert.deepEqual(JSON.parse(JSON.stringify(submittedPayload)), {
    attribution_source: "STANDALONE",
    attributionSource: "STANDALONE",
  });
});

test("a scoped caregiver must select an authorized member before requesting remote vitals", async () => {
  const submitted = [];
  const app = {
    globalData: {
      deviceId: "box-scoped",
      deviceSession: {
        mode: "membership",
        availability: "ready",
        selectedDeviceId: "box-scoped",
        devices: [{
          deviceId: "box-scoped",
          serviceUserScopes: ["member-a", "member-b"],
        }],
      },
    },
  };
  const page = loadVitalsPage({
    getDevice: async () => ({ deviceId: "box-scoped", online: true }),
    getLatestVitalsStrict: async () => null,
    getRecentCommandsStrict: async () => [],
    getSnapshotStrict: async () => ({
      serviceUsers: [
        { id: "member-a", name: "王奶奶", personaGeneration: "generation-a", archived: false },
        { id: "member-b", name: "李爷爷", personaGeneration: "generation-b", archived: false },
      ],
    }),
    getCapabilitiesStrict: async () => ({
      capabilities: { vitalsAttribution: "v1", caregiverMembership: "v1" },
    }),
    addCommand: async (type, payload, options) => {
      submitted.push({ type, payload, options });
      return { _id: "measure-member-a", status: "pending" };
    },
  }, { app });

  await page.load();

  assert.equal(page.data.measurementTargetRequired, true);
  assert.equal(page.data.carePage.focus.action.disabled, true);
  assert.match(page.data.carePage.focus.action.label, /选择测量对象/);
  const targetSection = page.data.carePage.sections.find(section => section.key === "vitals-target");
  assert.equal(targetSection.items.length, 2);

  page.onCarePageAction({ detail: targetSection.items[0].action });
  assert.equal(page.data.selectedMeasurementTarget.personId, "member-a");
  assert.equal(page.data.carePage.focus.action.disabled, false);

  await page.readAll();

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].type, "READ_VITALS_ALL");
  assert.equal(submitted[0].options.deviceId, "box-scoped");
  assert.deepEqual(JSON.parse(JSON.stringify(submitted[0].payload)), {
    service_user_id: "member-a",
    serviceUserId: "member-a",
    service_user_name_snapshot: "王奶奶",
    serviceUserNameSnapshot: "王奶奶",
    persona_generation: "generation-a",
    personaGeneration: "generation-a",
    attribution_source: "REMOTE_COMMAND",
    attributionSource: "REMOTE_COMMAND",
  });
});

test("switching medication boxes clears old vitals immediately and ignores their late response", async () => {
  const oldVitals = deferred();
  const app = { globalData: { deviceId: "box-a" } };
  const page = loadVitalsPage({
    getDevice: async deviceId => ({ deviceId, online: true }),
    getLatestVitalsStrict: async deviceId => (
      deviceId === "box-a"
        ? oldVitals.promise
        : { deviceId, heartRate: 88, spo2: 97, bodyTemp: 36.6, quality: "good", createdAt: localTimestamp() }
    ),
    getRecentCommandsStrict: async () => [],
  }, { app });

  const staleLoad = page.load();
  app.globalData.deviceId = "box-b";
  const currentLoad = page.load();

  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.carePage.phase.kind, "loading");
  assert.equal(page.data.vitals, null);

  await currentLoad;
  oldVitals.resolve({ deviceId: "box-a", heartRate: 61, quality: "good", createdAt: localTimestamp() });
  await staleLoad;

  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.vitals.heartRate, 88);
  assert.equal(page.data.carePage.phase.kind, "ready");
});

test("a measurement command stays pinned to its source box and cannot rebuild a newly selected box", async () => {
  const submission = deferred();
  const app = { globalData: { deviceId: "box-a" } };
  const calls = [];
  const page = loadVitalsPage({
    getDevice: async deviceId => ({ deviceId, online: true }),
    getLatestVitalsStrict: async deviceId => ({
      deviceId,
      heartRate: deviceId === "box-a" ? 71 : 91,
      spo2: 98,
      bodyTemp: 36.5,
      quality: "good",
      createdAt: localTimestamp(),
    }),
    getRecentCommandsStrict: async () => [],
    addCommand: async (type, payload, options) => {
      calls.push({ type, payload, options });
      return submission.promise;
    },
  }, { app });

  await page.load();
  const measuring = page.readAll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.deviceId, "box-a");

  app.globalData.deviceId = "box-b";
  await page.load();
  submission.resolve({ _id: "measure-a", status: "pending" });
  await measuring;

  assert.equal(page.data.deviceId, "box-b");
  assert.equal(page.data.vitals.heartRate, 91);
  assert.equal(page.data.measuring, false);
});

test("vitals keeps contextual care text in a readable on-demand detail sheet", () => {
  const vitalsLayout = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/vitals/index.wxml"), "utf8");
  const vitalsStyles = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/vitals/index.wxss"), "utf8");

  assert.match(vitalsLayout, /{{vitalsView\.timeLabel}}/);
  assert.match(vitalsLayout, /测量对象：{{vitalsView\.personName}}/);
  assert.match(vitalsStyles, /\.vitals-sheet__time\s*\{[\s\S]*?font-size:\s*31rpx/);
  assert.match(vitalsStyles, /\.vitals-sheet__person\s*\{[\s\S]*?font-size:\s*26rpx/);
  assert.match(vitalsStyles, /\.vitals-sheet__footnote\s*\{[\s\S]*?font-size:\s*24rpx/);
  assert.doesNotMatch(vitalsStyles, /font-size:\s*(?:1\d|2[0-3])rpx/);
});
