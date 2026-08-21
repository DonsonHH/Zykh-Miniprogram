const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STORAGE_BOXES,
  decorateMedicine,
  filterMedicines,
  storageBoxFor,
  summarizeMedicineLibrary,
} = require("../miniprogram/utils/medicineLibrary");

test("the three user-facing box labels match the board contract", () => {
  assert.deepEqual(
    STORAGE_BOXES.map(box => [box.id, box.label]),
    [
      ["DAILY", "日常用药"],
      ["CARE", "外用护理"],
      ["PRESCRIPTION", "慢病处方"],
    ],
  );
});

test("storage classification requires an explicit box or stable known identity", () => {
  assert.equal(storageBoxFor({ storageBox: "CARE" }).id, "CARE");
  assert.equal(storageBoxFor({ medicineId: "slot-09-bifid-triple" }).id, "PRESCRIPTION");
  assert.equal(storageBoxFor({ legacySlot: 1 }), null);
  assert.equal(storageBoxFor({ name: "复方感冒灵颗粒" }), null);
});

test("an unknown valid board medicine remains visible", () => {
  const medicine = decorateMedicine({
    medicineId: "future-board-medicine",
    name: "新接入药品",
    storageBox: "CARE",
    inventoryState: "UNKNOWN",
    expireDate: "2028-01-01",
  });
  assert.equal(medicine.medicineId, "future-board-medicine");
  assert.equal(medicine.storageBoxLabel, "外用护理");
  assert.equal(medicine.name, "新接入药品");
});

test("invalid or missing classification fails closed", () => {
  assert.throws(
    () => decorateMedicine({ medicineId: "unknown", name: "未分类药品" }),
    error => error.code === "MEDICINE_STORAGE_BOX_INVALID",
  );
  assert.throws(
    () => decorateMedicine({ medicineId: "unknown", name: "未分类药品", storageBox: "COLD" }),
    error => error.code === "MEDICINE_STORAGE_BOX_INVALID",
  );
});

test("library summary reflects only supplied manifest rows", () => {
  const summary = summarizeMedicineLibrary([
    {
      medicineId: "slot-01-fufang-ganmaoling",
      name: "复方感冒灵颗粒",
      storageBox: "DAILY",
      inventoryState: "STOCKED",
      expireDate: "2099-12-31",
    },
    {
      medicineId: "slot-09-bifid-triple",
      name: "双歧杆菌三联活菌肠溶胶囊",
      storageBox: "PRESCRIPTION",
      inventoryState: "DEPLETED",
      expireDate: "2099-12-31",
    },
  ]);
  assert.equal(summary.medicineCount, 2);
  assert.equal(summary.cabinetCount, 3);
  assert.equal(summary.stockedCount, 1);
  assert.equal(summary.depletedCount, 1);
  assert.deepEqual(summary.boxes.map(box => box.count), [1, 0, 1]);
});

test("inventory state is explicit and quantity is legacy-only context", () => {
  const stocked = decorateMedicine({
    medicineId: "stocked",
    name: "有药",
    storageBox: "DAILY",
    inventoryState: "STOCKED",
    quantity: 0,
  });
  const unknown = decorateMedicine({
    medicineId: "unknown-stock",
    name: "待确认",
    storageBox: "CARE",
    quantity: 0,
  });
  assert.equal(stocked.isStocked, true);
  assert.equal(stocked.isDepleted, false);
  assert.equal(unknown.isInventoryUnknown, true);
});

test("library filters use box, attention and search text", () => {
  const medicines = [
    decorateMedicine({
      medicineId: "daily",
      name: "日常药",
      storageBox: "DAILY",
      inventoryState: "STOCKED",
      expireDate: "2099-12-31",
    }),
    decorateMedicine({
      medicineId: "care",
      name: "护理用品",
      storageBox: "CARE",
      inventoryState: "DEPLETED",
      expireDate: "2099-12-31",
    }),
  ];
  assert.deepEqual(filterMedicines(medicines, { box: "CARE" }).map(item => item.medicineId), ["care"]);
  assert.deepEqual(filterMedicines(medicines, { filter: "depleted" }).map(item => item.medicineId), ["care"]);
  assert.deepEqual(filterMedicines(medicines, { keyword: "日常" }).map(item => item.medicineId), ["daily"]);
});
