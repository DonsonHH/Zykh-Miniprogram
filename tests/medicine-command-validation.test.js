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

test("Release A PING declares only implemented heartbeats and medicine snapshot capabilities", { concurrency: false }, async () => {
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

test("Release A keeps persona, pairing and remote command paths closed", { concurrency: false }, async () => {
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
