const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

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

test("cold start exposes no medication box until account access has been resolved", async () => {
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

  assert.equal(app.globalData.deviceId, "");
  assert.equal(app.globalData.deviceSessionResolved, false);
  assert.equal(cloudInit.length, 1);
  assert.equal(resolveCalls[0].savedDeviceId, "cached-box");

  pending.resolve({
    mode: "membership",
    availability: "ready",
    selectedDeviceId: "authorized-box",
    devices: [{ deviceId: "authorized-box" }],
    capabilities: { caregiverMembership: "v1" },
  });
  await app.waitForDeviceSession();

  assert.equal(app.globalData.deviceId, "authorized-box");
  assert.equal(app.globalData.deviceSessionResolved, true);
  assert.equal(storage.get("deviceId"), "authorized-box");
});

test("legacy default is restored only after a successful capability negotiation", async () => {
  const { app } = loadApp({
    savedDeviceId: "",
    module: {
      async resolve(options) {
        assert.equal(options.legacyDefaultDeviceId, "zykh-qsm-001");
        return {
          mode: "legacy",
          availability: "unsupported",
          selectedDeviceId: options.legacyDefaultDeviceId,
          devices: [],
          capabilities: {},
        };
      },
    },
  });

  app.onLaunch();
  assert.equal(app.globalData.deviceId, "");
  await app.waitForDeviceSession();
  assert.equal(app.globalData.deviceId, "zykh-qsm-001");
});

test("an account with no membership clears the previously selected device", async () => {
  const { app, storage } = loadApp({
    module: {
      async resolve() {
        return {
          mode: "membership",
          availability: "unpaired",
          selectedDeviceId: "",
          devices: [],
          canPair: true,
          capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
        };
      },
    },
  });

  app.onLaunch();
  await app.waitForDeviceSession();

  assert.equal(app.globalData.deviceId, "");
  assert.equal(storage.has("deviceId"), false);
});

test("app scope stays empty when a non-ready membership state carries stale selection fields", async () => {
  const { app, storage } = loadApp({
    module: {
      async resolve() {
        return {
          mode: "membership",
          availability: "error",
          selectedDeviceId: "stale-box",
          devices: [{ deviceId: "stale-box" }],
          capabilities: { caregiverMembership: "v1" },
        };
      },
    },
  });

  app.onLaunch();
  await app.waitForDeviceSession();

  assert.equal(app.globalData.deviceId, "");
  assert.equal(storage.has("deviceId"), false);
});

test("selecting and pairing delegate to the membership policy before changing global scope", async () => {
  const selections = [];
  const redemptions = [];
  const initialState = {
    mode: "membership",
    availability: "ready",
    selectedDeviceId: "box-a",
    devices: [{ deviceId: "box-a" }, { deviceId: "box-b" }],
    capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
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
          availability: "ready",
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
  assert.equal(redemptions[0].previousState.selectedDeviceId, "box-b");
  assert.equal(app.globalData.deviceId, "box-c");
});

test("page activation waits for an unresolved device session but remains synchronous after resolution", async () => {
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
    const synchronous = runAfterDeviceSessionReady(() => { calls += 1; return "now"; });
    assert.equal(synchronous, "now");
    assert.equal(calls, 2);
  } finally {
    global.getApp = previousGetApp;
  }
});
