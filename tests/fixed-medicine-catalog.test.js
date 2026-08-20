const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FIXED_MEDICINES,
  enrichKnownMedicine,
  knownMedicineFor,
  mergeFixedMedicineBaseline,
} = require("../miniprogram/data/fixedMedicineCatalog");
const { filterMedicines, summarizeMedicineLibrary } = require("../miniprogram/utils/medicineLibrary");

const EXPECTED_NAMES = [
  "复方感冒灵颗粒",
  "多维元素片",
  "布洛芬缓释胶囊",
  "阿莫西林胶囊",
  "蜜炼川贝枇杷膏",
  "乳果糖口服液",
  "银黄颗粒",
  "藿香正气丸",
  "双歧杆菌三联活菌肠溶胶囊",
  "医用纱布敷料",
  "桂林西瓜霜",
  "铝碳酸镁咀嚼片",
  "蒙脱石散",
  "磷酸奥司他韦胶囊",
  "莫匹罗星软膏",
  "酮康唑乳膏",
  "碘伏消毒液",
  "布地奈德鼻喷雾剂",
  "酮洛芬凝胶",
  "创口贴",
  "苯磺酸氨氯地平片",
  "医用棉签",
  "枸地氯雷他定胶囊",
];

test("fixed catalog contains the exact current 23 medicines once", () => {
  assert.equal(FIXED_MEDICINES.length, 23);
  assert.deepEqual(FIXED_MEDICINES.map(item => item.name), EXPECTED_NAMES);
  assert.equal(new Set(FIXED_MEDICINES.map(item => item.medicineId)).size, 23);
  assert.equal(new Set(FIXED_MEDICINES.map(item => item.legacySlot)).size, 23);
  assert.ok(FIXED_MEDICINES.every(item => item.manufacturer && item.category && item.safetyNote));
});

test("the 23 known medicines form the 9-8-5 ordinary-box baseline plus one cold-storage medicine", () => {
  const summary = summarizeMedicineLibrary(FIXED_MEDICINES.map(item => ({
    medicineId: item.medicineId,
    name: item.name,
    inventoryState: "STOCKED",
    storageBox: item.storageBox,
  })));
  const counts = Object.fromEntries(summary.boxes.map(box => [box.id, box.count]));
  assert.deepEqual(counts, { DAILY: 9, CARE: 8, PRESCRIPTION: 5 });
  assert.equal(summary.medicineCount, 23);
  assert.equal(summary.coldStorageCount, 1);
  assert.deepEqual(
    summary.boxes.find(box => box.id === "DAILY").medicines.map(item => item.name),
    [
      "复方感冒灵颗粒",
      "布洛芬缓释胶囊",
      "枸地氯雷他定胶囊",
      "藿香正气丸",
      "铝碳酸镁咀嚼片",
      "银黄颗粒",
      "桂林西瓜霜",
      "蜜炼川贝枇杷膏",
      "蒙脱石散",
    ],
  );
  assert.deepEqual(
    filterMedicines(summary.medicines, { keyword: "血压管理" }).map(item => item.name),
    ["苯磺酸氨氯地平片"],
  );
});

test("known medicine matching works by stable id, barcode, exact name and legacy slot", () => {
  assert.equal(knownMedicineFor({ medicineId: "slot-21-amlodipine" }).name, "苯磺酸氨氯地平片");
  assert.equal(knownMedicineFor({ barcode: "6938588802331" }).name, "阿莫西林胶囊");
  assert.equal(knownMedicineFor({ name: "碘伏消毒液" }).storageBox, "CARE");
  assert.equal(knownMedicineFor({ slot: "S23" }).name, "枸地氯雷他定胶囊");
});

test("catalog enrichment fills static reference data without replacing live facts", () => {
  const enriched = enrichKnownMedicine({
    name: "阿莫西林胶囊",
    inventoryState: "DEPLETED",
    expireDate: "2030-05",
    manufacturer: "现场包装厂家",
  });
  assert.equal(enriched.medicineId, "slot-04-amoxicillin");
  assert.equal(enriched.storageBox, "PRESCRIPTION");
  assert.equal(enriched.category, "抗菌药");
  assert.equal(enriched.manufacturer, "现场包装厂家");
  assert.equal(enriched.inventoryState, "DEPLETED");
  assert.equal(enriched.expireDate, "2030-05");
  assert.match(enriched.safetyNote, /过敏史和医嘱/);
});

test("the active medicine library overlays cloud facts onto all 23 canonical medicines", () => {
  const merged = mergeFixedMedicineBaseline([{
    _id: "random-cloud-document",
    name: "阿莫西林胶囊",
    storageBox: "SYMPTOM",
    inventoryState: "STOCKED",
    expireDate: "2027-12",
    spec: "0.25g×24粒",
  }]);

  assert.equal(merged.length, 23);
  const amoxicillin = merged.find(item => item.medicineId === "slot-04-amoxicillin");
  assert.equal(amoxicillin.storageBox, "PRESCRIPTION");
  assert.equal(amoxicillin.inventoryState, "STOCKED");
  assert.equal(amoxicillin.expireDate, "2027-12");
  assert.equal(amoxicillin.spec, "0.25g×24粒");
  assert.equal(amoxicillin.hasCloudRecord, true);
  assert.equal(merged.find(item => item.medicineId === "slot-21-amlodipine").hasCloudRecord, false);
});

test("unknown cloud rows do not inflate the current 23-medicine family catalog", () => {
  const merged = mergeFixedMedicineBaseline([
    { name: "阿莫西林胶囊", quantity: 2 },
    { _id: "old-extra-row-1", name: "历史测试药品A", quantity: 9 },
    { _id: "old-extra-row-2", name: "历史测试药品B", quantity: 9 },
  ]);

  assert.equal(merged.length, 23);
  assert.equal(merged.some(item => /历史测试药品/.test(item.name)), false);
  assert.equal(merged.find(item => item.medicineId === "slot-04-amoxicillin").hasCloudRecord, true);
});
