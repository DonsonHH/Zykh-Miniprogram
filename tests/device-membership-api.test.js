const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../miniprogram/utils/api");

function installCloud(handler) {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  global.getApp = () => ({ globalData: { deviceId: "must-not-leak" } });
  global.wx = {
    cloud: {
      callFunction: request => handler(request),
    },
  };
  return () => {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  };
}

test("GET_MY_DEVICES is a strict account-scoped API with normalized authorized devices", async () => {
  const restore = installCloud(async ({ data }) => {
    assert.equal(data.action, "GET_MY_DEVICES");
    assert.deepEqual(data.data, {});
    return {
      result: {
        ok: true,
        items: [{
          device_id: "box-a",
          display_name: "客厅药箱",
          role: "caregiver",
          permissions: ["READ_VITALS", "READ_VITALS"],
          service_user_scopes: ["member-1"],
          service_user_generations: { "member-1": "generation-2" },
          lastSeenAt: "2026-08-22 10:00:00",
          lastSeenAtEpochMs: 1787364000000,
          heartbeatAgeMs: 5000,
        }],
      },
    };
  });

  try {
    const result = await api.getMyDevicesStrict();
    assert.deepEqual(result, {
      items: [{
        deviceId: "box-a",
        name: "客厅药箱",
        online: true,
        connection: {
          state: "online",
          online: true,
          lastSeenAt: "2026-08-22 10:00:00",
          lastSeenAtEpochMs: 1787364000000,
          heartbeatAgeMs: 5000,
          reason: "药箱已同步",
        },
        connectionState: "online",
        lastSeenAt: "2026-08-22 10:00:00",
        lastSeenAtEpochMs: 1787364000000,
        heartbeatAgeMs: 5000,
        role: "CAREGIVER",
        permissions: ["READ_VITALS"],
        serviceUserScopes: ["member-1"],
        serviceUserGenerations: { "member-1": "generation-2" },
      }],
    });
  } finally {
    restore();
  }
});

test("GET_MY_DEVICES rejects malformed payloads and rows instead of treating them as unpaired", async () => {
  for (const result of [
    { ok: true, devices: [] },
    { ok: true, items: [{ name: "missing identity" }] },
  ]) {
    const restore = installCloud(async () => ({ result }));
    try {
      await assert.rejects(api.getMyDevicesStrict(), /授权药箱|authorized device/i);
    } finally {
      restore();
    }
  }
});

test("REDEEM_DEVICE_PAIRING_CODE sends only the trimmed one-time code", async () => {
  const restore = installCloud(async ({ data }) => {
    assert.equal(data.action, "REDEEM_DEVICE_PAIRING_CODE");
    assert.deepEqual(data.data, { pairingCode: "one-time-code" });
    return {
      result: {
        ok: true,
        device_id: "box-new",
        role: "caregiver",
        permissions: ["READ_DEVICE"],
        service_user_scopes: ["member-1"],
      },
    };
  });

  try {
    const result = await api.redeemDevicePairingCodeStrict("  one-time-code  ");
    assert.equal(result.deviceId, "box-new");
    assert.equal(result.role, "CAREGIVER");
    assert.deepEqual(result.permissions, ["READ_DEVICE"]);
    assert.deepEqual(result.serviceUserScopes, ["member-1"]);
  } finally {
    restore();
  }
});

test("membership error tokens in legacy Station error strings remain machine-readable", async () => {
  const restore = installCloud(async () => ({
    result: {
      ok: false,
      error: "CAREGIVER_MEMBERSHIP_REQUIRED",
    },
  }));

  try {
    await assert.rejects(
      api.getMyDevicesStrict(),
      error => error && error.code === "CAREGIVER_MEMBERSHIP_REQUIRED",
    );
  } finally {
    restore();
  }
});

test("unrelated uppercase text is not promoted into an authorization code", async () => {
  const restore = installCloud(async () => ({
    result: { ok: false, error: "SOMETHING_ELSE_FAILED" },
  }));

  try {
    await assert.rejects(
      api.getMyDevicesStrict(),
      error => error && error.code === "",
    );
  } finally {
    restore();
  }
});

test("device-scoped reads fail locally until an authorized medication box is selected", async () => {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  let cloudCalls = 0;
  global.getApp = () => ({ globalData: { deviceId: "" } });
  global.wx = {
    cloud: {
      callFunction: async () => {
        cloudCalls += 1;
        return { result: { ok: true, schemaVersion: 2, capabilities: {} } };
      },
    },
  };

  try {
    await assert.rejects(
      api.getDeviceStrict(),
      error => error && error.code === "DEVICE_NOT_SELECTED",
    );
    assert.equal(cloudCalls, 0);

    await api.getCapabilitiesStrict();
    assert.equal(cloudCalls, 1, "PING remains account-scoped during cold start");
  } finally {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
});

test("account-scoped capability discovery works before getApp returns the App instance", async () => {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  let cloudCalls = 0;
  global.getApp = () => undefined;
  global.wx = {
    cloud: {
      callFunction: async request => {
        cloudCalls += 1;
        assert.equal(request.data.action, "PING");
        assert.deepEqual(request.data.data, {});
        return {
          result: {
            ok: true,
            schemaVersion: 2,
            schemaRevision: "2.7-runtime-consistency",
            capabilities: { caregiverMembership: "v1" },
          },
        };
      },
    },
  };

  try {
    const result = await api.getCapabilitiesStrict();
    assert.equal(result.schemaRevision, "2.7-runtime-consistency");
    assert.equal(result.capabilities.caregiverMembership, "v1");
    assert.equal(cloudCalls, 1);
  } finally {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
});
