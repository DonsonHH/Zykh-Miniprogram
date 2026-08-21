const test = require("node:test");
const assert = require("node:assert/strict");
const {
  filterMedicines,
  isAttentionMedicine,
  storageBoxId,
  summarizeMedicineLibrary,
} = require("../miniprogram/utils/medicineLibrary");

test("canonical medicine classification wins over an obsolete cloud box value", () => {
  assert.equal(storageBoxId({ name: "创口贴", storageBox: "DAILY" }), "CARE");
  assert.equal(storageBoxId({ name: "维生素", storage_box: "CARE" }), "CARE");
  assert.equal(storageBoxId({ name: "任意药品", box_type: "2" }), "CARE");
});

test("the current 22 medicines are deterministically grouped into three boxes", () => {
  assert.equal(storageBoxId({ slot: 2, name: "多维元素片" }), "PRESCRIPTION");
  assert.equal(storageBoxId({ slot: 4, name: "阿莫西林胶囊" }), "PRESCRIPTION");
  assert.equal(storageBoxId({ slot: 8, name: "藿香正气丸" }), "DAILY");
  assert.equal(storageBoxId({ slot: 12, name: "铝碳酸镁咀嚼片" }), "DAILY");
  assert.equal(storageBoxId({ slot: 1, name: "复方感冒灵颗粒" }), "DAILY");
  assert.equal(storageBoxId({ slot: 20, name: "创口贴" }), "CARE");
});

test("medicine names provide a safe compatibility classification when slots are absent", () => {
  assert.equal(storageBoxId({ name: "苯磺酸氨氯地平片" }), "PRESCRIPTION");
  assert.equal(storageBoxId({ name: "莫匹罗星软膏" }), "CARE");
  assert.equal(storageBoxId({ name: "布洛芬缓释胶囊" }), "DAILY");
});

test("library summary counts expiry and explicit inventory facts without guessing low stock", () => {
  const summary = summarizeMedicineLibrary([
    { medicineId: "m-1", name: "长期药", storageBox: "DAILY", inventoryState: "STOCKED", expireDate: "2099-12" },
    { medicineId: "m-2", name: "缺药", storageBox: "CARE", inventoryState: "DEPLETED", expireDate: "2099-12" },
    { medicineId: "m-3", name: "护理药", storageBox: "CARE", inventoryState: "UNKNOWN", expireDate: "" },
  ]);

  assert.equal(summary.medicineCount, 3);
  assert.equal(summary.boxes.find(box => box.id === "DAILY").count, 1);
  assert.equal(summary.boxes.find(box => box.id === "CARE").count, 2);
  assert.equal(summary.depletedCount, 1);
  assert.equal(summary.inventoryUnknownCount, 1);
});

test("library filters by box, attention state and medicine text", () => {
  const summary = summarizeMedicineLibrary([
    { medicineId: "m-1", name: "氨氯地平", storageBox: "DAILY", inventoryState: "STOCKED", expireDate: "2099-12" },
    { medicineId: "m-2", name: "感冒灵", storageBox: "DAILY", inventoryState: "DEPLETED", expireDate: "2099-12" },
    { medicineId: "m-3", name: "创口贴", storageBox: "CARE", inventoryState: "STOCKED", expireDate: "2099-12" },
  ]);

  assert.deepEqual(filterMedicines(summary.medicines, { box: "CARE" }).map(item => item.name), ["创口贴"]);
  assert.deepEqual(filterMedicines(summary.medicines, { filter: "depleted" }).map(item => item.name), ["感冒灵"]);
  assert.deepEqual(filterMedicines(summary.medicines, { keyword: "氨氯" }).map(item => item.name), ["氨氯地平"]);
});

test("catalog-only medicines do not become maintenance alerts without live facts", () => {
  assert.equal(isAttentionMedicine({
    hasCloudRecord: false,
    isInventoryUnknown: true,
    statusClass: "missing",
  }), false);
  assert.equal(isAttentionMedicine({
    hasCloudRecord: true,
    isInventoryUnknown: true,
    statusClass: "missing",
  }), true);
});
