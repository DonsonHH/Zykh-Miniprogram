const test = require("node:test");
const assert = require("node:assert/strict");

const { createDeviceMembershipModule } = require("../miniprogram/modules/deviceMemberships");

test("an older cloud stays in explicit legacy mode without probing membership actions", async () => {
  let deviceListCalls = 0;
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => ({
      schemaRevision: "2.2-miniprogram",
      capabilities: {},
    }),
    getMyDevicesStrict: async () => {
      deviceListCalls += 1;
      return { items: [] };
    },
  });

  const state = await module.resolve({
    savedDeviceId: "legacy-saved-box",
    legacyDefaultDeviceId: "zykh-qsm-001",
  });

  assert.equal(state.mode, "legacy");
  assert.equal(state.availability, "unsupported");
  assert.equal(state.selectedDeviceId, "legacy-saved-box");
  assert.equal(state.canPair, false);
  assert.equal(deviceListCalls, 0);
});

test("membership mode selects only a device returned for the current account", async () => {
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => ({
      capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
    }),
    getMyDevicesStrict: async () => ({
      items: [{
        deviceId: "authorized-box",
        name: "父母家药箱",
        role: "caregiver",
        permissions: ["READ_PROFILE", "READ_PLAN"],
        service_user_scopes: ["person-a"],
      }],
    }),
  });

  const state = await module.resolve({ savedDeviceId: "stale-unauthorized-box" });

  assert.equal(state.mode, "membership");
  assert.equal(state.availability, "ready");
  assert.equal(state.selectedDeviceId, "authorized-box");
  assert.equal(state.canPair, true);
  assert.deepEqual(state.devices, [{
    deviceId: "authorized-box",
    name: "父母家药箱",
    online: false,
    lastSeenAt: "",
    role: "CAREGIVER",
    permissions: ["READ_PROFILE", "READ_PLAN"],
    serviceUserScopes: ["person-a"],
  }]);
});

test("a capability failure never restores a cached device as if it were authorized", async () => {
  const failure = new Error("PING unavailable");
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => { throw failure; },
  });

  const state = await module.resolve({
    savedDeviceId: "unverified-cache",
    legacyDefaultDeviceId: "zykh-qsm-001",
  });

  assert.equal(state.mode, "unknown");
  assert.equal(state.availability, "error");
  assert.equal(state.selectedDeviceId, "");
  assert.equal(state.error, failure);
});

test("a membership-list failure stays an error instead of falling back to manual device access", async () => {
  const failure = Object.assign(new Error("network unavailable"), {
    code: "NETWORK_FAILURE",
  });
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => ({
      capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
    }),
    getMyDevicesStrict: async () => { throw failure; },
  });

  const state = await module.resolve({ savedDeviceId: "unverified-cache" });

  assert.equal(state.mode, "membership");
  assert.equal(state.availability, "error");
  assert.equal(state.selectedDeviceId, "");
  assert.equal(state.canPair, true);
  assert.equal(state.error, failure);
});

test("membership without a pairing capability cannot fall back to typing a device id", async () => {
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => ({
      capabilities: { caregiverMembership: "v1" },
    }),
    getMyDevicesStrict: async () => ({ items: [] }),
  });

  const state = await module.resolve({ savedDeviceId: "typed-box" });

  assert.equal(state.mode, "membership");
  assert.equal(state.availability, "pairing-unavailable");
  assert.equal(state.selectedDeviceId, "");
  assert.equal(state.canPair, false);
});

test("membership selection rejects a device that is absent from the authorized list", () => {
  const module = createDeviceMembershipModule({});
  const state = {
    mode: "membership",
    availability: "ready",
    devices: [{ deviceId: "authorized-box" }],
    selectedDeviceId: "authorized-box",
  };

  assert.throws(
    () => module.select(state, "typed-unknown-box"),
    error => error && error.code === "DEVICE_NOT_AUTHORIZED",
  );
  assert.equal(state.selectedDeviceId, "authorized-box");
});

test("membership selection cannot reactivate a stale row from a non-ready session", () => {
  const module = createDeviceMembershipModule({});
  for (const availability of ["loading", "error", "forbidden", "unpaired"]) {
    assert.throws(
      () => module.select({
        mode: "membership",
        availability,
        devices: [{ deviceId: "stale-box" }],
        selectedDeviceId: "stale-box",
      }, "stale-box"),
      error => error && error.code === "DEVICE_SELECTION_UNAVAILABLE",
      availability,
    );
  }
});

test("explicit legacy mode permits a non-empty manual device selection", () => {
  const module = createDeviceMembershipModule({});

  const next = module.select({
    mode: "legacy",
    availability: "unsupported",
    selectedDeviceId: "old-box",
  }, "  legacy-new-box  ");

  assert.equal(next.selectedDeviceId, "legacy-new-box");
});

test("an unresolved cloud mode cannot select any device", () => {
  const module = createDeviceMembershipModule({});

  assert.throws(
    () => module.select({ mode: "unknown", availability: "error" }, "cached-box"),
    error => error && error.code === "DEVICE_SELECTION_UNAVAILABLE",
  );
});

test("redeeming a pairing code selects the device only after it appears in the authorized list", async () => {
  const redeemedCodes = [];
  const module = createDeviceMembershipModule({
    redeemDevicePairingCodeStrict: async pairingCode => {
      redeemedCodes.push(pairingCode);
      return { deviceId: "newly-paired-box" };
    },
    getMyDevicesStrict: async () => ({
      items: [
        { deviceId: "existing-box", name: "现有药箱" },
        { deviceId: "newly-paired-box", name: "刚配对药箱" },
      ],
    }),
  });
  const previousState = {
    mode: "membership",
    availability: "unpaired",
    devices: [],
    selectedDeviceId: "",
    canPair: true,
    capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
    pairing: { phase: "idle", message: "" },
  };

  const state = await module.redeem({
    pairingCode: "  one-time-secret-code  ",
    previousState,
  });

  assert.deepEqual(redeemedCodes, ["one-time-secret-code"]);
  assert.equal(state.availability, "ready");
  assert.equal(state.selectedDeviceId, "newly-paired-box");
  assert.equal(state.devices.length, 2);
  assert.equal(state.pairing.phase, "idle");
  assert.equal(Object.prototype.hasOwnProperty.call(state, "pairingCode"), false);
});

test("an invalid pairing code stays recoverable without changing the selected device", async () => {
  const failure = Object.assign(new Error("PAIRING_CODE_INVALID"), { code: "PAIRING_CODE_INVALID" });
  const module = createDeviceMembershipModule({
    redeemDevicePairingCodeStrict: async () => { throw failure; },
  });
  const previousState = {
    mode: "membership",
    availability: "unpaired",
    devices: [],
    selectedDeviceId: "",
    canPair: true,
    capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
    pairing: { phase: "idle", message: "" },
  };

  const state = await module.redeem({ pairingCode: "expired-secret-code", previousState });

  assert.equal(state.mode, "membership");
  assert.equal(state.availability, "unpaired");
  assert.equal(state.selectedDeviceId, "");
  assert.equal(state.pairing.phase, "error");
  assert.match(state.pairing.message, /无效|失效|重新/);
  assert.equal(state.error, failure);
});

test("a pairing-list verification failure cannot retain a stale active device", async () => {
  const failure = new Error("authorized list unavailable");
  const module = createDeviceMembershipModule({
    redeemDevicePairingCodeStrict: async () => ({ deviceId: "new-box" }),
    getMyDevicesStrict: async () => { throw failure; },
  });
  const previousState = {
    mode: "membership",
    availability: "ready",
    devices: [{ deviceId: "old-box" }],
    selectedDeviceId: "old-box",
    canPair: true,
    capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
  };

  const state = await module.redeem({ pairingCode: "valid-secret-code", previousState });

  assert.equal(state.availability, "error");
  assert.equal(state.selectedDeviceId, "");
  assert.deepEqual(state.devices, []);
  assert.equal(state.error, failure);
});

test("a malformed authorized-device response is an error rather than an empty membership", async () => {
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => ({
      capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
    }),
    getMyDevicesStrict: async () => ({ ok: true, devices: [] }),
  });

  const state = await module.resolve({ savedDeviceId: "cached-box" });

  assert.equal(state.mode, "membership");
  assert.equal(state.availability, "error");
  assert.equal(state.selectedDeviceId, "");
  assert.match(state.message, /格式|读取/);
});

test("an account without membership enters the recoverable pairing state", async () => {
  const failure = Object.assign(new Error("CAREGIVER_MEMBERSHIP_REQUIRED"), {
    code: "CAREGIVER_MEMBERSHIP_REQUIRED",
  });
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => ({
      capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
    }),
    getMyDevicesStrict: async () => { throw failure; },
  });

  const state = await module.resolve({ savedDeviceId: "untrusted-cache" });

  assert.equal(state.availability, "unpaired");
  assert.equal(state.selectedDeviceId, "");
  assert.equal(state.canPair, true);
  assert.match(state.message, /配对/);
});

test("a permission denial is distinct from an empty authorized-device list", async () => {
  const failure = Object.assign(new Error("CAREGIVER_PERMISSION_DENIED"), {
    code: "CAREGIVER_PERMISSION_DENIED",
  });
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => ({
      capabilities: { caregiverMembership: "v1", devicePairing: "v1" },
    }),
    getMyDevicesStrict: async () => { throw failure; },
  });

  const state = await module.resolve();

  assert.equal(state.availability, "forbidden");
  assert.equal(state.selectedDeviceId, "");
  assert.equal(state.canPair, true);
  assert.match(state.message, /无权|权限/);
});
