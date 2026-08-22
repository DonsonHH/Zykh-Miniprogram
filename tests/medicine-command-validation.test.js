const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createInMemoryCloudDb } = require("./helpers/inMemoryCloudDb");
const {
  CANONICAL_DIGEST_VERSION,
  canonicalSnapshotDigest,
} = require("../cloudfunctions/api/canonicalDigest");

const DEVICE_ID = "station-001";
const DEVICE_SECRET = "test-only-device-secret-at-least-32-bytes";
const RELEASE_A_CAPABILITIES = {
  medicationSafetyEvents: "v1",
  inquiryDetail: "v1",
  medicationRiskRegistry: "v1",
  personaLifecycle: "v1",
  vitalsAttribution: "v1",
  snapshotBatch: "v2",
  snapshotFencing: "v1",
  snapshotCanonicalDigest: "jcs-sha256-v1",
  boardMedicineSnapshot: "v1",
  explicitInventoryState: "v1",
  medicineStorageBoxes: "v1",
  caregiverMembership: "v1",
};

function loadCloudApi(seed = {}, options = {}) {
  const memory = createInMemoryCloudDb(seed);
  process.env.DEVICE_SECRETS = options.deviceSecrets === undefined
    ? JSON.stringify({ [DEVICE_ID]: DEVICE_SECRET })
    : options.deviceSecrets;
  delete process.env.DEVICE_SECRET;
  const cloud = {
    DYNAMIC_CURRENT_ENV: "dynamic",
    init() {},
    getWXContext() {
      return { OPENID: options.openId || "family-member" };
    },
    database() {
      return memory.db;
    },
  };
  const target = path.resolve(__dirname, "../cloudfunctions/api/index.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[target];
    return { api: require(target), memory };
  } finally {
    Module._load = originalLoad;
  }
}

function boardData(extra = {}) {
  return Object.assign({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET }, extra);
}

test("PING declares versioned medicine sync plus caregiver read capabilities", { concurrency: false }, async () => {
  const { api } = loadCloudApi();
  const result = await api.main({ action: "PING", data: {} });
  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.schemaRevision, "3.0-three-box-library");
  assert.deepEqual(result.capabilities, RELEASE_A_CAPABILITIES);
  assert.equal(result.capabilities.serviceUserPersonaTombstones, undefined);
  assert.equal(result.capabilities.devicePairing, undefined);
  assert.equal(result.capabilities.devicePairingIssue, undefined);
  assert.equal(result.capabilities.remoteCommands, undefined);
  assert.equal(result.collections, undefined);
});

test("every board action rejects a wrong per-device secret", { concurrency: false }, async () => {
  const { api } = loadCloudApi();
  const actions = [
    "REPORT_DEVICE",
    "UPLOAD_MEDICINES",
    "UPLOAD_VITALS",
    "UPLOAD_RECORD",
    "UPLOAD_SNAPSHOT",
    "BEGIN_SNAPSHOT",
    "UPSERT_SNAPSHOT_BATCH",
    "FINALIZE_SNAPSHOT",
    "ABORT_SNAPSHOT",
    "GET_BOARD_MEDICINE_MANIFEST",
    "PULL_COMMANDS",
    "ACK_COMMAND",
  ];
  for (const action of actions) {
    const result = await api.main({
      action,
      data: { deviceId: DEVICE_ID, deviceSecret: "wrong" },
    });
    assert.equal(result.ok, false, action);
    assert.equal(result.error, "unauthorized", action);
  }
});

test("production board authentication has no DEVICE_SECRET fallback", { concurrency: false }, async () => {
  process.env.DEVICE_SECRET = DEVICE_SECRET;
  const { api } = loadCloudApi({}, { deviceSecrets: "{}" });
  process.env.DEVICE_SECRET = DEVICE_SECRET;
  const result = await api.main({ action: "REPORT_DEVICE", data: boardData() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "device secret is not configured");
});

test("REPORT_DEVICE overwrites client liveness with server time", { concurrency: false }, async () => {
  const fixedNow = Date.UTC(2026, 7, 22, 2, 3, 4);
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const { api, memory } = loadCloudApi();
    const result = await api.main({
      action: "REPORT_DEVICE",
      data: boardData({
        schemaVersion: 2,
        online: false,
        lastSeenAt: "2000-01-01 00:00:00",
        lastSeenAtEpochMs: 1,
        network: "Wi-Fi",
        syncSummary: {
          serviceUsers: [{ id: "must-not-enter-release-a" }],
          recentInquiries: [{ inquiry_id: "must-not-enter-release-a" }],
        },
      }),
    });
    assert.equal(result.online, true);
    assert.equal(result.lastSeenAtEpochMs, fixedNow);
    assert.equal(result.lastSeenAt, "2026-08-22 10:03:04");
    assert.equal(result.heartbeatAgeMs, 0);
    assert.equal(result.deviceSecret, undefined);
    assert.equal(result.syncSummary, undefined);
    assert.equal(memory.row("devices", DEVICE_ID).lastSeenAtEpochMs, fixedNow);
    assert.equal(memory.row("devices", DEVICE_ID).syncSummary, undefined);
  } finally {
    Date.now = originalNow;
  }
});

test("board can compare the finalized medicine manifest through device authentication", { concurrency: false }, async () => {
  const { api } = loadCloudApi();
  const rows = [{
    medicineId: "slot-01-cold-granules",
    name: "999复方感冒灵颗粒",
    storageBox: "DAILY",
    inventoryState: "STOCKED",
  }];
  const digest = canonicalSnapshotDigest(
    DEVICE_ID,
    "medicines",
    rows,
    row => row.medicineId,
  );
  const common = boardData({
    kind: "medicines",
    rowCount: rows.length,
    digest,
    canonicalDigestVersion: CANONICAL_DIGEST_VERSION,
    instanceId: "station-manifest-test",
  });
  const begin = await api.main({ action: "BEGIN_SNAPSHOT", data: common });
  const envelope = Object.assign({}, common, {
    snapshotId: begin.snapshotId,
    snapshotRevision: begin.snapshotRevision,
    leaseToken: begin.leaseToken,
  });
  await api.main({
    action: "UPSERT_SNAPSHOT_BATCH",
    data: Object.assign({}, envelope, { batchOrdinal: 0, rowOffset: 0, rows }),
  });
  await api.main({ action: "FINALIZE_SNAPSHOT", data: envelope });

  const manifest = await api.main({
    action: "GET_BOARD_MEDICINE_MANIFEST",
    data: boardData(),
  });
  assert.equal(manifest.protocol, "boardMedicineSnapshot:v1");
  assert.equal(manifest.snapshotComplete, true);
  assert.equal(manifest.rowCount, 1);
  assert.equal(manifest.digest, digest);
  assert.equal(manifest.rows, undefined);
});

test("GET_DEVICE returns server heartbeat age and preserves database errors", { concurrency: false }, async () => {
  const now = Date.now();
  const { api } = loadCloudApi({
    devices: [{
      _id: DEVICE_ID,
      deviceId: DEVICE_ID,
      lastSeenAtEpochMs: now - 5000,
      syncSummary: { serviceUsers: [{ id: "legacy-person" }] },
      recentInquiries: [{ inquiry_id: "legacy-inquiry" }],
    }],
    device_memberships: [{
      _id: "membership-1",
      openid: "family-member",
      deviceId: DEVICE_ID,
      status: "ACTIVE",
      role: "VIEWER",
      permissions: ["READ_MEDICINE"],
    }, {
      _id: "membership-2",
      openid: "family-member",
      deviceId: "missing",
      status: "ACTIVE",
      role: "VIEWER",
      permissions: ["READ_MEDICINE"],
    }],
  });
  const result = await api.main({ action: "GET_DEVICE", data: { deviceId: DEVICE_ID } });
  assert.equal(result.deviceId, DEVICE_ID);
  assert.equal(result.online, true);
  assert.ok(result.heartbeatAgeMs >= 0 && result.heartbeatAgeMs < 60000);
  assert.equal(result.syncSummary, undefined);
  assert.equal(result.recentInquiries, undefined);

  const missing = await api.main({ action: "GET_DEVICE", data: { deviceId: "missing" } });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "NOT_FOUND");
});

test("pairing, remote commands and legacy board writes remain closed", { concurrency: false }, async () => {
  const { api } = loadCloudApi();
  const remote = await api.main({
    action: "CREATE_COMMAND",
    data: { deviceId: DEVICE_ID, type: "UPSERT_MEDICINE", payload: {} },
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.code, "REMOTE_COMMANDS_DISABLED");

  const pairing = await api.main({ action: "REDEEM_DEVICE_PAIRING_CODE", data: {} });
  assert.equal(pairing.ok, false);
  assert.equal(pairing.code, "DEVICE_PAIRING_NOT_AVAILABLE");

  const legacyUpload = await api.main({ action: "UPLOAD_MEDICINES", data: boardData() });
  assert.equal(legacyUpload.ok, false);
  assert.equal(legacyUpload.code, "SNAPSHOT_PROTOCOL_REQUIRED");

  const vitals = await api.main({ action: "UPLOAD_VITALS", data: boardData() });
  assert.equal(vitals.ok, false);
  assert.equal(vitals.code, "PERSONA_DATA_MIGRATION_IN_PROGRESS");
});

test("caregiver reads keep existing plans, inquiries, vitals and records visible", { concurrency: false }, async () => {
  const membership = {
    _id: "membership-1",
    openid: "family-member",
    deviceId: DEVICE_ID,
    status: "ACTIVE",
    role: "CAREGIVER",
    permissions: [
      "READ_PROFILE",
      "READ_PLAN",
      "READ_INQUIRY",
      "READ_VITALS",
      "READ_RECORD",
      "CREATE_COMMAND",
    ],
    service_user_scopes: ["wang-nainai"],
  };
  const { api } = loadCloudApi({
    device_memberships: [membership],
    service_users: [{
      _id: "service-user-1",
      deviceId: DEVICE_ID,
      id: "wang-nainai",
      name: "王奶奶",
    }],
    today_plans: [{
      _id: "plan-1",
      deviceId: DEVICE_ID,
      service_user_id: "wang-nainai",
      medicine: "苯磺酸氨氯地平片",
      time: "08:00",
    }],
    inquiries: [{
      _id: "inquiry-1",
      deviceId: DEVICE_ID,
      inquiry_id: "inquiry-1",
      service_user_id: "wang-nainai",
      symptoms_summary: "头晕",
      updatedAt: "2026-08-21 10:00:00",
    }],
    vitals: [{
      _id: "vitals-1",
      deviceId: DEVICE_ID,
      service_user_id: "wang-nainai",
      heartRate: 72,
      createdAt: "2026-08-21 09:00:00",
    }],
    records: [{
      _id: "record-1",
      deviceId: DEVICE_ID,
      service_user_id: "wang-nainai",
      message: "王奶奶完成健康测量",
      createdAt: "2026-08-21 09:00:00",
    }],
  });

  const snapshot = await api.main({ action: "GET_SNAPSHOT", data: { deviceId: DEVICE_ID } });
  assert.equal(snapshot.serviceUsers.length, 1);
  assert.equal(snapshot.plans.length, 1);
  assert.equal(snapshot.inquiries.length, 1);
  assert.equal(snapshot.vitals.length, 1);

  const records = await api.main({
    action: "LIST_RECORDS",
    data: { deviceId: DEVICE_ID, limit: 20 },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].message, "王奶奶完成健康测量");
});

test("medicine reads bridge the existing cloud rows until Station finalizes a snapshot", { concurrency: false }, async () => {
  const { api } = loadCloudApi({
    device_memberships: [{
      _id: "membership-1",
      openid: "family-member",
      deviceId: DEVICE_ID,
      status: "ACTIVE",
      role: "CAREGIVER",
      permissions: ["READ_MEDICINE"],
    }],
    medicines: [{
      _id: `${DEVICE_ID}-slot-3`,
      deviceId: DEVICE_ID,
      medicineId: "slot-03-diosmectite",
      medicine_id: "slot-03-diosmectite",
      name: "蒙脱石散",
      storageBox: "ORAL",
      storage_box: "ORAL",
      inventoryState: "STOCKED",
      updatedAt: "2026-08-20 23:50:34",
    }, {
      _id: `${DEVICE_ID}-slot-13`,
      deviceId: DEVICE_ID,
      medicineId: "slot-13-ibuprofen",
      medicine_id: "slot-13-ibuprofen",
      name: "布洛芬缓释胶囊",
      storageBox: "ORAL",
      storage_box: "ORAL",
      inventoryState: "STOCKED",
      updatedAt: "2026-08-20 23:50:34",
    }],
  });

  const snapshot = await api.main({
    action: "GET_MEDICINE_SNAPSHOT",
    data: { deviceId: DEVICE_ID },
  });
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.versionState, "TRANSITIONAL_LEGACY");
  assert.equal(snapshot.rowCount, 2);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    snapshot.rows.map(row => [row.medicineId, row.storageBox]),
    [["slot-03-ibuprofen", "DAILY"], ["slot-13-montmorillonite", "DAILY"]],
  );
  assert.equal(
    snapshot.digest,
    canonicalSnapshotDigest(
      DEVICE_ID,
      "medicines",
      snapshot.rows,
      row => row.medicineId,
    ),
  );
});
