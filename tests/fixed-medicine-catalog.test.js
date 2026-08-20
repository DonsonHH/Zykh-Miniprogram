const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FIXED_MEDICINES,
  enrichKnownMedicine,
  knownMedicineFor,
} = require("../miniprogram/data/fixedMedicineCatalog");
const { filterMedicines, summarizeMedicineLibrary } = require("../miniprogram/utils/medicineLibrary");

const EXPECTED_NAMES = [
  "复方感冒灵颗粒",
  "多维元素片",
  "感冒清热颗粒",
  "阿莫西林胶囊",
  "蜜炼川贝枇杷膏",
  "乳果糖口服液",
  "银黄颗粒",
  "藿香正气丸",
  "双歧杆菌三联活菌肠溶胶囊",
  "医用纱布敷料",
  "桂林西瓜霜",
  "铝碳酸镁咀嚼片",
  "玻璃酸钠滴眼液",
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

test("the 23 known medicines form the intended 4-11-8 three-box baseline", () => {
  const summary = summarizeMedicineLibrary(FIXED_MEDICINES.map(item => ({
    medicineId: item.medicineId,
    name: item.name,
    inventoryState: "STOCKED",
    storageBox: item.storageBox,
  })));
  const counts = Object.fromEntries(summary.boxes.map(box => [box.id, box.count]));
  assert.deepEqual(counts, { DAILY: 4, SYMPTOM: 11, CARE: 8 });
  assert.equal(summary.medicineCount, 23);
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
  assert.equal(enriched.storageBox, "SYMPTOM");
  assert.equal(enriched.category, "抗菌药");
  assert.equal(enriched.manufacturer, "现场包装厂家");
  assert.equal(enriched.inventoryState, "DEPLETED");
  assert.equal(enriched.expireDate, "2030-05");
  assert.match(enriched.safetyNote, /过敏史和医嘱/);
});
