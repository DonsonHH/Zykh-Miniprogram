const test = require("node:test");
const assert = require("node:assert/strict");

const { FIXED_MEDICINES } = require("../miniprogram/data/fixedMedicineCatalog");
const {
  CANONICAL_DIGEST_VERSION,
  canonicalSnapshotDigest,
} = require("../cloudfunctions/api/canonicalDigest");
const {
  DEFAULT_LEASE_MS,
  MIN_RETAIN_MS,
  createSnapshotStore,
} = require("../cloudfunctions/api/snapshotStore");
const { createInMemoryCloudDb } = require("./helpers/inMemoryCloudDb");

const DEVICE_ID = "zykh-qsm-001";

function medicineRows() {
  return FIXED_MEDICINES.map(item => ({
    medicineId: item.medicineId,
    legacySlot: item.legacySlot,
    name: item.name,
    storageBox: item.storageBox,
    inventoryState: "STOCKED",
  }));
}

function digestFor(rows) {
  return canonicalSnapshotDigest(DEVICE_ID, "medicines", rows, row => row.medicineId);
}

function harness(start = Date.UTC(2026, 7, 22, 0, 0, 0)) {
  const memory = createInMemoryCloudDb();
  let now = start;
  const store = createSnapshotStore({
    db: memory.db,
    nowEpochMs: () => now,
    nowText: () => new Date(now).toISOString(),
  });
  return {
    memory,
    store,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function beginInput(rows, instanceId = "station-instance-a") {
  return {
    deviceId: DEVICE_ID,
    kind: "medicines",
    rowCount: rows.length,
    digest: digestFor(rows),
    canonicalDigestVersion: CANONICAL_DIGEST_VERSION,
    instanceId,
  };
}

function envelope(begin, rows, extra = {}) {
  return Object.assign({}, beginInput(rows, begin.instanceId || "station-instance-a"), {
    snapshotId: begin.snapshotId,
    snapshotRevision: begin.snapshotRevision,
    leaseToken: begin.leaseToken,
  }, extra);
}

async function uploadAll(store, begin, rows, batchSize = 10) {
  for (let offset = 0, batchOrdinal = 0; offset < rows.length; offset += batchSize, batchOrdinal += 1) {
    await store.upsertBatch(envelope(begin, rows, {
      batchOrdinal,
      rowOffset: offset,
      rows: rows.slice(offset, offset + batchSize),
    }));
  }
}

test("23-row staging stays invisible until finalize and then becomes authoritative", async () => {
  const { store } = harness();
  const rows = medicineRows();
  const begin = await store.begin(beginInput(rows));
  await store.upsertBatch(envelope(begin, rows, {
    batchOrdinal: 0,
    rowOffset: 0,
    rows: rows.slice(0, 10),
  }));
  await assert.rejects(
    store.readMedicineSnapshot(DEVICE_ID),
    error => error.code === "MEDICINE_SNAPSHOT_NOT_FOUND",
  );
  await store.upsertBatch(envelope(begin, rows, {
    batchOrdinal: 1,
    rowOffset: 10,
    rows: rows.slice(10),
  }));
  const finalized = await store.finalize(envelope(begin, rows));
  assert.equal(finalized.rowCount, 23);

  const snapshot = await store.readMedicineSnapshot(DEVICE_ID);
  assert.equal(snapshot.boardMedicineSnapshot, "v1");
  assert.equal(snapshot.protocol, "boardMedicineSnapshot:v1");
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.rowCount, 23);
  assert.equal(snapshot.rows.filter(row => row.storageBox === "DAILY").length, 9);
  assert.equal(snapshot.rows.filter(row => row.storageBox === "CARE").length, 8);
  assert.equal(snapshot.rows.filter(row => row.storageBox === "PRESCRIPTION").length, 6);
  assert.equal((await store.listMedicines(DEVICE_ID)).length, 23);
});

test("BEGIN resume requires the persisted lease and renews the same revision", async () => {
  const { store } = harness();
  const rows = medicineRows();
  const input = beginInput(rows);
  const begin = await store.begin(input);
  await assert.rejects(
    store.begin(input),
    error => error.code === "SNAPSHOT_LEASE_REQUIRED",
  );
  await assert.rejects(
    store.begin(Object.assign({}, input, { leaseToken: "wrong" })),
    error => error.code === "SNAPSHOT_LEASE_INVALID",
  );
  const resumed = await store.begin(Object.assign({}, input, { leaseToken: begin.leaseToken }));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.snapshotId, begin.snapshotId);
  assert.equal(resumed.snapshotRevision, begin.snapshotRevision);
  assert.equal(resumed.leaseToken, begin.leaseToken);
});

test("expired leases are fenced by a higher revision", async () => {
  const { store, advance } = harness();
  const rows = medicineRows();
  const oldBegin = await store.begin(beginInput(rows, "old-instance"));
  advance(DEFAULT_LEASE_MS + 1);
  const newBegin = await store.begin(beginInput(rows, "new-instance"));
  assert.equal(newBegin.snapshotRevision, oldBegin.snapshotRevision + 1);
  await assert.rejects(
    store.upsertBatch(envelope(oldBegin, rows, {
      instanceId: "old-instance",
      batchOrdinal: 0,
      rowOffset: 0,
      rows: rows.slice(0, 1),
    })),
    error => error.code === "SNAPSHOT_FENCE_REJECTED",
  );
});

test("batch retry is idempotent but conflicting content and cross-batch duplicates fail", async () => {
  const { store } = harness();
  const rows = medicineRows().slice(0, 2);
  const begin = await store.begin(beginInput(rows));
  const first = envelope(begin, rows, {
    batchOrdinal: 0,
    rowOffset: 0,
    rows: [rows[0]],
  });
  assert.equal((await store.upsertBatch(first)).idempotent, false);
  assert.equal((await store.upsertBatch(first)).idempotent, true);
  await assert.rejects(
    store.upsertBatch(Object.assign({}, first, {
      rows: [Object.assign({}, rows[0], { name: "冲突内容" })],
    })),
    error => error.code === "SNAPSHOT_BATCH_CONFLICT",
  );
  await assert.rejects(
    store.upsertBatch(envelope(begin, rows, {
      batchOrdinal: 1,
      rowOffset: 1,
      rows: [rows[0]],
    })),
    error => error.code === "SNAPSHOT_DUPLICATE_ROW_ID",
  );
});

test("finalize verifies completeness and canonical digest", async () => {
  const { store } = harness();
  const rows = medicineRows().slice(0, 2);
  const declaredRows = rows.map(row => Object.assign({}, row));
  const begin = await store.begin(beginInput(declaredRows));
  await store.upsertBatch(envelope(begin, declaredRows, {
    batchOrdinal: 0,
    rowOffset: 0,
    rows: [declaredRows[0]],
  }));
  await assert.rejects(
    store.finalize(envelope(begin, declaredRows)),
    error => error.code === "SNAPSHOT_INCOMPLETE",
  );
  await store.upsertBatch(envelope(begin, declaredRows, {
    batchOrdinal: 1,
    rowOffset: 1,
    rows: [Object.assign({}, declaredRows[1], { name: "摘要不一致" })],
  }));
  await assert.rejects(
    store.finalize(envelope(begin, declaredRows)),
    error => error.code === "SNAPSHOT_DIGEST_MISMATCH",
  );
});

test("manifest switch retains an immutable old version token for the grace window", async () => {
  const { store, advance } = harness();
  const oldRows = medicineRows();
  const oldBegin = await store.begin(beginInput(oldRows, "instance-a"));
  await uploadAll(store, oldBegin, oldRows);
  await store.finalize(envelope(oldBegin, oldRows, { instanceId: "instance-a" }));
  const oldSnapshot = await store.readMedicineSnapshot(DEVICE_ID);

  const newRows = oldRows.map(row => Object.assign({}, row));
  newRows[0].inventoryState = "DEPLETED";
  const newBegin = await store.begin(beginInput(newRows, "instance-a"));
  await store.upsertBatch(envelope(newBegin, newRows, {
    instanceId: "instance-a",
    batchOrdinal: 0,
    rowOffset: 0,
    rows: newRows.slice(0, 10),
  }));
  const duringStaging = await store.readMedicineSnapshot(DEVICE_ID);
  assert.deepEqual(duringStaging.rows, oldSnapshot.rows);

  await store.upsertBatch(envelope(newBegin, newRows, {
    instanceId: "instance-a",
    batchOrdinal: 1,
    rowOffset: 10,
    rows: newRows.slice(10),
  }));
  await store.finalize(envelope(newBegin, newRows, { instanceId: "instance-a" }));
  const current = await store.readMedicineSnapshot(DEVICE_ID);
  assert.equal(current.snapshotRevision, oldSnapshot.snapshotRevision + 1);
  assert.equal(current.rows.find(row => row.medicineId === oldRows[0].medicineId).inventoryState, "DEPLETED");

  const oldTokenRead = await store.readMedicineSnapshot(DEVICE_ID, {
    snapshotId: oldSnapshot.snapshotId,
    snapshotRevision: oldSnapshot.snapshotRevision,
    digest: oldSnapshot.digest,
  });
  assert.equal(oldTokenRead.versionState, "SUPERSEDED");
  assert.deepEqual(oldTokenRead.rows, oldSnapshot.rows);

  advance(MIN_RETAIN_MS + 1);
  await assert.rejects(
    store.readMedicineSnapshot(DEVICE_ID, { snapshotId: oldSnapshot.snapshotId }),
    error => error.code === "MEDICINE_SNAPSHOT_INCOMPLETE",
  );
});

test("non-medicine finalize and physical cabinet fields are rejected", async () => {
  const { store } = harness();
  const rows = medicineRows().slice(0, 1);
  await assert.rejects(
    store.begin(Object.assign(beginInput(rows), { kind: "vitals" })),
    error => error.code === "SNAPSHOT_KIND_NOT_FINALIZABLE",
  );

  const begin = await store.begin(beginInput(rows));
  await assert.rejects(
    store.upsertBatch(envelope(begin, rows, {
      batchOrdinal: 0,
      rowOffset: 0,
      rows: [Object.assign({}, rows[0], { cabinet_id: 1 })],
    })),
    error => error.code === "PHYSICAL_CABINET_FIELD_FORBIDDEN",
  );
  await assert.rejects(
    store.upsertBatch(envelope(begin, rows, {
      batchOrdinal: 0,
      rowOffset: 0,
      rows: [Object.assign({}, rows[0], { deviceId: "other-device" })],
    })),
    error => error.code === "SNAPSHOT_ROW_DEVICE_SCOPE_MISMATCH",
  );
});
