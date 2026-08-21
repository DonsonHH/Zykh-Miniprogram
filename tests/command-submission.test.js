const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../miniprogram/utils/api");

function installCloud(result, options = {}) {
  const calls = [];
  const previous = { getApp: global.getApp, wx: global.wx };
  global.getApp = () => ({
    globalData: {
      deviceId: options.deviceId || "station-001",
      deviceSession: {
        availability: "ready",
        compatibility: { compatible: true },
        capabilities: options.remoteCommands ? { remoteCommands: "v1" } : {},
      },
    },
  });
  global.wx = {
    showToast() {},
    cloud: {
      callFunction: async request => {
        calls.push(request);
        return { result: typeof result === "function" ? result(request) : result };
      },
    },
  };
  return {
    calls,
    restore() {
      global.getApp = previous.getApp;
      global.wx = previous.wx;
    },
  };
}

function emptyManifest(deviceId = "station-001") {
  return {
    boardMedicineSnapshot: "v1",
    protocol: "boardMedicineSnapshot:v1",
    deviceId,
    kind: "medicines",
    snapshotId: `${deviceId}-medicines-r1-test`,
    revision: 1,
    digest: "a".repeat(64),
    canonicalDigestVersion: "jcs-sha256-v1",
    snapshotComplete: true,
    rowCount: 0,
    finalizedAt: "2026-08-22T00:00:00.000Z",
    rows: [],
  };
}

test("client production code has no fixed-medicine write producer", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../miniprogram/utils/api.js"),
    "utf8",
  );
  assert.equal(typeof api.saveMedicine, "undefined");
  assert.doesNotMatch(source, /addCommand\(\s*["']UPSERT_MEDICINE["']/);
});

test("Release A blocks every remote command before a cloud call", async () => {
  const cloud = installCloud({ _id: "must-not-exist", status: "pending" });
  try {
    for (const type of ["AUDIO_BEEP", "AUDIO_SPEAK", "READ_VITALS_ALL", "AI_CHAT"]) {
      await assert.rejects(
        api.addCommand(type),
        error => error.code === "REMOTE_COMMANDS_DISABLED",
      );
    }
    assert.equal(cloud.calls.length, 0);
  } finally {
    cloud.restore();
  }
});

test("physical medicine actions are permanently blocked even after remote commands open", async () => {
  const cloud = installCloud({ _id: "must-not-exist", status: "pending" }, { remoteCommands: true });
  try {
    for (const type of ["OPEN_CABINET", "DISPENSE", "UPSERT_MEDICINE", "CABINET_LIGHT_ON"]) {
      await assert.rejects(
        api.addCommand(type, {}),
        error => error.code === "REMOTE_MEDICINE_ACTION_FORBIDDEN",
      );
    }
    assert.equal(cloud.calls.length, 0);
  } finally {
    cloud.restore();
  }
});

test("a future remoteCommands capability permits a strict command acknowledgement", async () => {
  const cloud = installCloud({ _id: "command-1", status: "pending" }, { remoteCommands: true });
  try {
    const result = await api.addCommand("AUDIO_BEEP", { reason: "device test" });
    assert.equal(result._id, "command-1");
    assert.equal(cloud.calls.length, 1);
    assert.equal(cloud.calls[0].data.action, "CREATE_COMMAND");
    assert.equal(cloud.calls[0].data.data.type, "AUDIO_BEEP");
  } finally {
    cloud.restore();
  }
});

test("remote command acknowledgements remain strict", async () => {
  for (const result of [
    null,
    {},
    { _id: "failed", status: "failed", error: "board rejected it" },
    { ok: false, error: "cloud unavailable" },
  ]) {
    const cloud = installCloud(result, { remoteCommands: true });
    try {
      await assert.rejects(api.addCommand("READ_VITALS_ALL"));
    } finally {
      cloud.restore();
    }
  }
});

test("a medication reminder carries the Station person identity when Release C opens", async () => {
  const cloud = installCloud({ _id: "reminder-1", status: "pending" }, {
    remoteCommands: true,
    deviceId: "station-reminder",
  });
  try {
    await api.requestMedicationReminder({
      id: "plan-1",
      time: "09:00",
      medicine: "阿司匹林",
      service_user_id: "service-user-42",
      target_user_name: "王阿姨",
    }, { deviceId: "station-reminder" });
    const payload = cloud.calls[0].data.data.payload;
    assert.equal(payload.target_user_id, "service-user-42");
    assert.equal(payload.service_user_id, "service-user-42");
    assert.equal(payload.text, "王阿姨请及时用药。");
  } finally {
    cloud.restore();
  }
});

test("strict medicine reads accept only a complete manifest envelope", async () => {
  const empty = installCloud(emptyManifest());
  try {
    const rows = await api.getMedicinesStrict();
    assert.deepEqual(rows, []);
    assert.equal(empty.calls[0].data.action, "GET_MEDICINE_SNAPSHOT");
  } finally {
    empty.restore();
  }

  for (const invalid of [
    [],
    Object.assign(emptyManifest(), { boardMedicineSnapshot: "" }),
    Object.assign(emptyManifest(), { snapshotComplete: false }),
    Object.assign(emptyManifest(), { canonicalDigestVersion: "legacy" }),
  ]) {
    const cloud = installCloud(invalid);
    try {
      await assert.rejects(api.getMedicinesStrict(), /manifest/i);
    } finally {
      cloud.restore();
    }
  }
});

test("compatibility cabinet reads can render empty slots without inventing medicine rows", async () => {
  const failed = installCloud({ ok: false, error: "medicine snapshot unavailable" });
  try {
    await assert.rejects(api.getCabinetSlotsStrict(), /medicine snapshot unavailable/);
    const slots = await api.getCabinetSlots();
    assert.equal(slots.length, 23);
    assert.equal(slots.every(slot => !slot.name), true);
  } finally {
    failed.restore();
  }
});
