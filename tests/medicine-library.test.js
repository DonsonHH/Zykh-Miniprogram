const test = require("node:test");
const assert = require("node:assert/strict");
const {
  filterMedicines,
  isAttentionMedicine,
  storageBoxId,
  summarizeMedicineLibrary,
} = require("../miniprogram/utils/medicineLibrary");

test("explicit three-box values win over legacy classification", () => {
  assert.equal(storageBoxId({ name: "创口贴", storageBox: "DAILY" }), "DAILY");
  assert.equal(storageBoxId({ name: "维生素", storage_box: "CARE" }), "CARE");
  assert.equal(storageBoxId({ name: "任意药品", box_type: "2" }), "SYMPTOM");
});

test("the former 23 medicines are deterministically grouped into three boxes", () => {
  assert.equal(storageBoxId({ slot: 2, name: "多维元素片" }), "DAILY");
  assert.equal(storageBoxId({ slot: 4, name: "阿莫西林胶囊" }), "DAILY");
  assert.equal(storageBoxId({ slot: 8, name: "藿香正气丸" }), "DAILY");
  assert.equal(storageBoxId({ slot: 12, name: "铝碳酸镁咀嚼片" }), "DAILY");
  assert.equal(storageBoxId({ slot: 1, name: "复方感冒灵颗粒" }), "SYMPTOM");
  assert.equal(storageBoxId({ slot: 20, name: "创口贴" }), "CARE");
});

test("medicine names provide a safe compatibility classification when slots are absent", () => {
  assert.equal(storageBoxId({ name: "苯磺酸氨氯地平片" }), "DAILY");
  assert.equal(storageBoxId({ name: "莫匹罗星软膏" }), "CARE");
  assert.equal(storageBoxId({ name: "感冒清热颗粒" }), "SYMPTOM");
});

test("library summary counts expiry and explicit inventory facts without guessing low stock", () => {
  const summary = summarizeMedicineLibrary([
    { medicineId: "m-1", name: "长期药", storageBox: "DAILY", inventoryState: "STOCKED", expireDate: "2099-12" },
    { medicineId: "m-2", name: "缺药", storageBox: "SYMPTOM", inventoryState: "DEPLETED", expireDate: "2099-12" },
    { medicineId: "m-3", name: "护理药", storageBox: "CARE", inventoryState: "UNKNOWN", expireDate: "" },
  ]);

  assert.equal(summary.medicineCount, 3);
  assert.equal(summary.boxes.find(box => box.id === "DAILY").count, 1);
  assert.equal(summary.boxes.find(box => box.id === "SYMPTOM").count, 1);
  assert.equal(summary.boxes.find(box => box.id === "CARE").count, 1);
  assert.equal(summary.depletedCount, 1);
  assert.equal(summary.inventoryUnknownCount, 1);
});

test("library filters by box, attention state and medicine text", () => {
  const summary = summarizeMedicineLibrary([
    { medicineId: "m-1", name: "氨氯地平", storageBox: "DAILY", inventoryState: "STOCKED", expireDate: "2099-12" },
    { medicineId: "m-2", name: "感冒灵", storageBox: "SYMPTOM", inventoryState: "DEPLETED", expireDate: "2099-12" },
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
