const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FIXED_MEDICINE_REFERENCE_VERSION,
  FIXED_MEDICINES,
  enrichKnownMedicine,
  knownMedicineFor,
  mergeFixedMedicineBaseline,
} = require("../miniprogram/data/fixedMedicineCatalog");

test("board reference contains 23 unique medicines in a 9-8-6 split", () => {
  assert.equal(FIXED_MEDICINE_REFERENCE_VERSION, "board-authoritative-v7-three-box-23");
  assert.equal(FIXED_MEDICINES.length, 23);
  assert.equal(new Set(FIXED_MEDICINES.map(item => item.medicineId)).size, 23);
  assert.equal(new Set(FIXED_MEDICINES.map(item => item.legacySlot)).size, 23);

  const counts = FIXED_MEDICINES.reduce((result, item) => {
    result[item.storageBox] = (result[item.storageBox] || 0) + 1;
    return result;
  }, {});
  assert.deepEqual(counts, { DAILY: 9, PRESCRIPTION: 6, CARE: 8 });
  assert.equal(FIXED_MEDICINES.some(item => item.storageBox === "COLD"), false);
});

test("S09 is retained in the prescription box", () => {
  const medicine = knownMedicineFor({ medicineId: "slot-09-bifid-triple" });
  assert.ok(medicine);
  assert.equal(medicine.legacySlot, 9);
  assert.equal(medicine.name, "双歧杆菌三联活菌肠溶胶囊");
  assert.equal(medicine.storageBox, "PRESCRIPTION");
});

test("S03 and S13 use the canonical cloud identities", () => {
  const ibuprofen = knownMedicineFor({ medicineId: "slot-03-ibuprofen" });
  const montmorillonite = knownMedicineFor({ medicineId: "slot-13-montmorillonite" });
  assert.equal(ibuprofen.legacySlot, 3);
  assert.equal(ibuprofen.name, "布洛芬缓释胶囊");
  assert.equal(montmorillonite.legacySlot, 13);
  assert.equal(montmorillonite.name, "蒙脱石散");
});

test("reference enrichment only matches an explicit stable medicine id", () => {
  assert.equal(knownMedicineFor({ legacySlot: 1 }), null);
  assert.equal(knownMedicineFor({ name: "复方感冒灵颗粒" }), null);
  assert.equal(knownMedicineFor({ barcode: "6900966688219" }), null);

  const enriched = enrichKnownMedicine({
    medicineId: "slot-01-fufang-ganmaoling",
    quantity: 2,
    expireDate: "2027-10-01",
  });
  assert.equal(enriched.name, "复方感冒灵颗粒");
  assert.equal(enriched.quantity, 2);
  assert.equal(enriched.expireDate, "2027-10-01");
  assert.equal(enriched.fixedCatalogMatch, true);
});

test("finalized cloud rows, not the local reference table, decide visibility", () => {
  assert.deepEqual(mergeFixedMedicineBaseline([]), []);

  const rows = mergeFixedMedicineBaseline([
    {
      medicineId: "slot-01-fufang-ganmaoling",
      storageBox: "DAILY",
      quantity: 3,
    },
    {
      medicineId: "future-board-medicine",
      storageBox: "CARE",
      name: "新接入药品",
      inventoryState: "UNKNOWN",
    },
    {
      medicineId: "future-board-medicine",
      storageBox: "CARE",
      name: "重复行不得覆盖",
    },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "复方感冒灵颗粒");
  assert.equal(rows[0].quantity, 3);
  assert.equal(rows[1].name, "新接入药品");
  assert.equal(rows[1].fixedCatalogMatch, false);
});

test("conflicting identity aliases are isolated instead of guessed", () => {
  const rows = mergeFixedMedicineBaseline([
    {
      medicineId: "slot-01-fufang-ganmaoling",
      medicine_id: "slot-02-centrum",
      storageBox: "DAILY",
    },
  ]);
  assert.deepEqual(rows, []);
});
