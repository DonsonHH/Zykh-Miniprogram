const test = require("node:test");
const assert = require("node:assert/strict");

const { createDeviceMembershipModule } = require("../miniprogram/modules/deviceMemberships");
const { REQUIRED_CAPABILITIES } = require("../miniprogram/utils/connectionState");

function releaseACapabilities(overrides = {}) {
  return {
    schemaVersion: 2,
    schemaRevision: "3.0-three-box-library",
    capabilities: Object.assign({}, REQUIRED_CAPABILITIES, overrides),
  };
}

test("a 2.7 cloud is incompatible and never probes membership rows", async () => {
  let listCalls = 0;
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => ({
      schemaVersion: 2,
      schemaRevision: "2.7-runtime-consistency",
      capabilities: { snapshotBatch: "v2" },
    }),
    getMyDevicesStrict: async () => {
      listCalls += 1;
      return { items: [] };
    },
  });
  const state = await module.resolve({ savedDeviceId: "cached-box" });
  assert.equal(state.mode, "membership");
  assert.equal(state.availability, "incompatible");
  assert.equal(state.selectedDeviceId, "");
  assert.equal(state.compatibility.compatible, false);
  assert.equal(listCalls, 0);
});

test("Release A selects only an authorized device and preserves heartbeat and generations", async () => {
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => releaseACapabilities(),
    getMyDevicesStrict: async () => ({
      items: [{
        deviceId: "authorized-box",
        name: "父母家药箱",
        role: "caregiver",
        permissions: ["READ_MEDICINE"],
        serviceUserScopes: ["person-a"],
        serviceUserGenerations: { "person-a": "generation-3" },
        lastSeenAt: "2026-08-22 10:00:00",
        lastSeenAtEpochMs: 1787364000000,
        heartbeatAgeMs: 4000,
      }],
    }),
  });
  const state = await module.resolve({ savedDeviceId: "stale-unauthorized-box" });
  assert.equal(state.availability, "ready");
  assert.equal(state.selectedDeviceId, "authorized-box");
  assert.equal(state.canPair, false);
  assert.equal(state.schemaRevision, "3.0-three-box-library");
  assert.equal(state.compatibility.compatible, true);
  assert.equal(state.devices[0].online, true);
  assert.equal(state.devices[0].connectionState, "online");
  assert.equal(state.devices[0].heartbeatAgeMs, 4000);
  assert.deepEqual(state.devices[0].serviceUserGenerations, { "person-a": "generation-3" });
});

test("missing one required capability stays incompatible", async () => {
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => releaseACapabilities({ boardMedicineSnapshot: "" }),
  });
  const state = await module.resolve();
  assert.equal(state.availability, "incompatible");
  assert.ok(state.compatibility.missingCapabilities.includes("boardMedicineSnapshot"));
});

test("capability and membership transport failures never restore a cached device", async () => {
  const capabilityFailure = new Error("PING unavailable");
  const capabilityModule = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => { throw capabilityFailure; },
  });
  const capabilityState = await capabilityModule.resolve({ savedDeviceId: "cached-box" });
  assert.equal(capabilityState.availability, "error");
  assert.equal(capabilityState.selectedDeviceId, "");

  const listFailure = new Error("membership list unavailable");
  const listModule = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => releaseACapabilities(),
    getMyDevicesStrict: async () => { throw listFailure; },
  });
  const listState = await listModule.resolve({ savedDeviceId: "cached-box" });
  assert.equal(listState.availability, "error");
  assert.equal(listState.selectedDeviceId, "");
  assert.equal(listState.canPair, false);
});

test("Release A has no self-service pairing fallback", async () => {
  const noMembership = Object.assign(new Error("CAREGIVER_MEMBERSHIP_REQUIRED"), {
    code: "CAREGIVER_MEMBERSHIP_REQUIRED",
  });
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => releaseACapabilities(),
    getMyDevicesStrict: async () => { throw noMembership; },
  });
  const state = await module.resolve({ savedDeviceId: "typed-box" });
  assert.equal(state.availability, "pairing-unavailable");
  assert.equal(state.canPair, false);
  assert.equal(state.selectedDeviceId, "");
});

test("permission denial remains distinct from missing membership", async () => {
  const failure = Object.assign(new Error("CAREGIVER_PERMISSION_DENIED"), {
    code: "CAREGIVER_PERMISSION_DENIED",
  });
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => releaseACapabilities(),
    getMyDevicesStrict: async () => { throw failure; },
  });
  const state = await module.resolve();
  assert.equal(state.availability, "forbidden");
  assert.equal(state.selectedDeviceId, "");
});

test("malformed authorized-device responses fail closed", async () => {
  const module = createDeviceMembershipModule({
    getCapabilitiesStrict: async () => releaseACapabilities(),
    getMyDevicesStrict: async () => ({ devices: [] }),
  });
  const state = await module.resolve({ savedDeviceId: "cached-box" });
  assert.equal(state.availability, "error");
  assert.equal(state.selectedDeviceId, "");
});

test("selection is allowed only for a row in a ready membership session", () => {
  const module = createDeviceMembershipModule({});
  const ready = {
    mode: "membership",
    availability: "ready",
    devices: [{ deviceId: "box-a" }, { deviceId: "box-b" }],
    selectedDeviceId: "box-a",
  };
  assert.equal(module.select(ready, "box-b").selectedDeviceId, "box-b");
  assert.throws(
    () => module.select(ready, "unknown"),
    error => error.code === "DEVICE_NOT_AUTHORIZED",
  );
  assert.throws(
    () => module.select({ mode: "legacy", availability: "unsupported" }, "typed-box"),
    error => error.code === "DEVICE_SELECTION_UNAVAILABLE",
  );
  assert.throws(
    () => module.select({ mode: "membership", availability: "error" }, "box-a"),
    error => error.code === "DEVICE_SELECTION_UNAVAILABLE",
  );
});
