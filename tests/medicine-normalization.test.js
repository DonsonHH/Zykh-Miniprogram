const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeMedicine } = require("../miniprogram/utils/api");

function manifestMedicine(overrides = {}) {
  return Object.assign({
    deviceId: "zykh-qsm-001",
    medicineId: "future-board-medicine",
    name: "新接入药品",
    storageBox: "CARE",
    inventoryState: "UNKNOWN",
  }, overrides);
}

test("strict manifest medicine preserves board facts and transport aliases", () => {
  const medicine = normalizeMedicine(manifestMedicine({
    quantity: 0,
    expire_date: "2027-12-31",
    expiry_precision: "day",
    inventoryState: "",
    inventory_state: "STOCKED",
    inventory_state_revision: 7,
    trace_code: "trace-001",
    barcode: "6901234567890",
  }), { strictManifest: true });

  assert.equal(medicine.medicineId, "future-board-medicine");
  assert.equal(medicine.storageBox, "CARE");
  assert.equal(medicine.storageBoxLabel, "外用护理");
  assert.equal(medicine.quantity, 0);
  assert.equal(medicine.inventoryState, "STOCKED");
  assert.equal(medicine.inventoryStateRevision, 7);
  assert.equal(medicine.expireDate, "2027-12-31");
  assert.equal(medicine.traceCode, "trace-001");
  assert.equal(medicine.barcode, "6901234567890");
});

test("S03 and S13 canonical ids enrich the correct display names", () => {
  const ibuprofen = normalizeMedicine(manifestMedicine({
    medicineId: "slot-03-ibuprofen",
    name: "布洛芬缓释胶囊",
    storageBox: "DAILY",
    legacySlot: 3,
  }), { strictManifest: true });
  const montmorillonite = normalizeMedicine(manifestMedicine({
    medicineId: "slot-13-montmorillonite",
    name: "蒙脱石散",
    storageBox: "DAILY",
    legacySlot: 13,
  }), { strictManifest: true });

  assert.equal(ibuprofen.name, "布洛芬缓释胶囊");
  assert.equal(ibuprofen.legacySlot, 3);
  assert.equal(montmorillonite.name, "蒙脱石散");
  assert.equal(montmorillonite.legacySlot, 13);
});

test("identity aliases fail closed", () => {
  assert.throws(
    () => normalizeMedicine(manifestMedicine({
      medicineId: "slot-03-ibuprofen",
      medicine_id: "slot-13-montmorillonite",
    }), { strictManifest: true }),
    error => error.code === "MEDICINE_IDENTITY_CONFLICT",
  );
});

test("storage aliases and known-reference conflicts fail closed", () => {
  assert.throws(
    () => normalizeMedicine(manifestMedicine({
      storageBox: "CARE",
      storage_box: "DAILY",
    }), { strictManifest: true }),
    error => error.code === "MEDICINE_STORAGE_BOX_CONFLICT",
  );
  assert.throws(
    () => normalizeMedicine(manifestMedicine({
      medicineId: "slot-09-bifid-triple",
      name: "双歧杆菌三联活菌肠溶胶囊",
      storageBox: "CARE",
    }), { strictManifest: true }),
    error => error.code === "MEDICINE_REFERENCE_CONFLICT",
  );
});

test("unknown stable ids are accepted but malformed rows are rejected", () => {
  assert.equal(
    normalizeMedicine(manifestMedicine(), { strictManifest: true }).fixedCatalogMatch,
    false,
  );
  assert.throws(
    () => normalizeMedicine(manifestMedicine({ medicineId: "", medicine_id: "" }), { strictManifest: true }),
    error => error.code === "MEDICINE_ID_REQUIRED",
  );
  assert.throws(
    () => normalizeMedicine(manifestMedicine({ storageBox: "COLD" }), { strictManifest: true }),
    error => error.code === "MEDICINE_STORAGE_BOX_INVALID",
  );
  assert.throws(
    () => normalizeMedicine(manifestMedicine({ name: "" }), { strictManifest: true }),
    error => error.code === "MEDICINE_NAME_REQUIRED",
  );
});

test("trace code and barcode remain separate fields", () => {
  const traceOnly = normalizeMedicine(manifestMedicine({
    traceCode: "TRACE-ONLY",
    barcode: "",
  }), { strictManifest: true });
  assert.equal(traceOnly.traceCode, "TRACE-ONLY");
  assert.equal(traceOnly.barcode, "");
});

test("conflicting expiry and inventory aliases remain explicit conflicts", () => {
  const medicine = normalizeMedicine(manifestMedicine({
    expireDate: "2027-01-01",
    expire_date: "2028-01-01",
    inventoryState: "STOCKED",
    inventory_state: "DEPLETED",
  }), { strictManifest: true });
  assert.equal(medicine.expiryConflict, true);
  assert.equal(medicine.expireDate, "");
  assert.equal(medicine.inventoryStateConflict, true);
  assert.equal(medicine.inventoryState, "");
});

test("the client has no remote fixed-medicine write producer", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../miniprogram/utils/api.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /function\s+buildMedicineCommandPayload\b/);
  assert.doesNotMatch(source, /function\s+saveMedicine\b/);
  assert.doesNotMatch(source, /addCommand\(\s*["']UPSERT_MEDICINE["']/);
});
