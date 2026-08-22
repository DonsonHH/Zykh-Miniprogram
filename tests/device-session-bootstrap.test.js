const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const connectionState = require("../miniprogram/utils/connectionState");
const appPath = path.join(__dirname, "../miniprogram/app.js");

function deferred() {
  let resolve;
  const promise = new Promise(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}

function loadApp({ module, savedDeviceId = "cached-box" } = {}) {
  let definition;
  const storage = new Map(savedDeviceId ? [["deviceId", savedDeviceId]] : []);
  const cloudInit = [];
  const source = fs.readFileSync(appPath, "utf8");
  vm.runInNewContext(source, {
    App(value) { definition = value; },
    require(request) {
      if (request.includes("deviceMemberships")) {
        return { createDeviceMembershipModule: () => module };
      }
      if (request.includes("connectionState")) return connectionState;
      return {
        getCapabilitiesStrict() {},
        getMyDevicesStrict() {},
        redeemDevicePairingCodeStrict() {},
      };
    },
    wx: {
      getStorageSync(key) { return storage.get(key) || ""; },
      setStorageSync(key, value) { storage.set(key, value); },
      removeStorageSync(key) { storage.delete(key); },
      cloud: { init(options) { cloudInit.push(options); } },
    },
    console,
  }, { filename: appPath });
  return { app: definition, storage, cloudInit };
}

test("cold start exposes the saved display scope while account access resolves", async () => {
  const pending = deferred();
  const resolveCalls = [];
  const { app, storage, cloudInit } = loadApp({
    module: {
      resolve(options) {
        resolveCalls.push(options);
        return pending.promise;
      },
    },
  });
  app.onLaunch();
  assert.equal(app.globalData.deviceId, "cached-box");
  assert.equal(app.globalData.offlineBrowsingEnabled, true);
  assert.equal(app.globalData.deviceSession.displayOnly, true);
  assert.equal(app.globalData.deviceSession.connection.state, "loading");
  assert.equal(app.globalData.deviceSessionResolved, false);
  assert.equal(cloudInit.length, 1);
  assert.deepEqual(Object.keys(resolveCalls[0]), ["savedDeviceId"]);

  pending.resolve({
    mode: "membership",
    availability: "ready",
    selectedDeviceId: "authorized-box",
    devices: [{
      deviceId: "authorized-box",
      connection: connectionState.projectConnection({ heartbeatAgeMs: 1000 }),
    }],
    compatibility: { compatible: true },
  });
  await app.waitForDeviceSession();
  assert.equal(app.globalData.deviceId, "authorized-box");
  assert.equal(app.globalData.deviceSession.connection.state, "online");
  assert.equal(storage.get("deviceId"), "authorized-box");
});

test("incompatible cloud retains the display scope while remaining explicit", async () => {
  const { app, storage } = loadApp({
    module: {
      async resolve() {
        return {
          mode: "membership",
          availability: "incompatible",
          selectedDeviceId: "cached-box",
          devices: [],
          compatibility: { compatible: false, reason: "云端版本待升级" },
          message: "云端版本待升级",
        };
      },
    },
  });
  app.onLaunch();
  await app.waitForDeviceSession();
  assert.equal(app.globalData.deviceId, "cached-box");
  assert.equal(app.globalData.deviceSession.displayOnly, true);
  assert.equal(app.globalData.deviceSession.connection.state, "incompatible");
  assert.equal(storage.get("deviceId"), "cached-box");
});

test("non-ready membership states retain only the saved display scope", async () => {
  for (const availability of ["unpaired", "error", "forbidden", "pairing-unavailable"]) {
    const { app, storage } = loadApp({
      module: {
        async resolve() {
          return {
            mode: "membership",
            availability,
            selectedDeviceId: "stale-box",
            devices: [{ deviceId: "stale-box" }],
            compatibility: { compatible: true },
          };
        },
      },
    });
    app.onLaunch();
    await app.waitForDeviceSession();
    assert.equal(app.globalData.deviceId, "cached-box", availability);
    assert.equal(app.globalData.deviceSession.displayOnly, true, availability);
    assert.equal(storage.get("deviceId"), "cached-box", availability);
  }
});

test("selecting and redeeming delegate to membership policy before scope changes", async () => {
  const selections = [];
  const redemptions = [];
  const initialState = {
    mode: "membership",
    availability: "ready",
    selectedDeviceId: "box-a",
    devices: [{ deviceId: "box-a" }, { deviceId: "box-b" }],
    compatibility: { compatible: true },
  };
  const { app } = loadApp({
    module: {
      async resolve() { return initialState; },
      select(state, deviceId) {
        selections.push({ state, deviceId });
        return Object.assign({}, state, { selectedDeviceId: deviceId });
      },
      async redeem(input) {
        redemptions.push(input);
        return Object.assign({}, input.previousState, {
          devices: [{ deviceId: "box-a" }, { deviceId: "box-b" }, { deviceId: "box-c" }],
          selectedDeviceId: "box-c",
        });
      },
    },
  });
  app.onLaunch();
  await app.waitForDeviceSession();
  app.selectAuthorizedDevice("box-b");
  assert.equal(app.globalData.deviceId, "box-b");
  assert.equal(selections[0].deviceId, "box-b");

  await app.redeemDevicePairingCode("secret-once");
  assert.equal(redemptions[0].pairingCode, "secret-once");
  assert.equal(app.globalData.deviceId, "box-c");
});

test("page activation waits for session resolution and is synchronous afterwards", async () => {
  const previousGetApp = global.getApp;
  const pending = deferred();
  let calls = 0;
  const app = {
    globalData: { deviceSessionResolved: false },
    waitForDeviceSession: () => pending.promise,
  };
  global.getApp = () => app;
  try {
    delete require.cache[require.resolve("../miniprogram/utils/deviceSession")];
    const { runAfterDeviceSessionReady } = require("../miniprogram/utils/deviceSession");
    const result = runAfterDeviceSessionReady(() => { calls += 1; return "ready"; });
    assert.equal(calls, 0);
    pending.resolve({ availability: "ready" });
    assert.equal(await result, "ready");
    assert.equal(calls, 1);
    app.globalData.deviceSessionResolved = true;
    assert.equal(runAfterDeviceSessionReady(() => { calls += 1; return "now"; }), "now");
    assert.equal(calls, 2);
  } finally {
    global.getApp = previousGetApp;
  }
});
