const { expiryView, formatExpiryLabel } = require("./expiry");
const {
  enrichKnownMedicine,
  knownMedicineFor,
  mergeFixedMedicineBaseline,
} = require("../data/fixedMedicineCatalog");

const STORAGE_BOXES = Object.freeze([
  Object.freeze({
    id: "DAILY",
    label: "综合内服",
    shortLabel: "内服",
    symbol: "内",
    description: "慢病、营养、胃肠与抗菌类内服药",
  }),
  Object.freeze({
    id: "SYMPTOM",
    label: "感冒呼吸",
    shortLabel: "呼吸",
    symbol: "呼",
    description: "感冒、流感、咽喉、咳嗽、鼻炎与过敏药",
  }),
  Object.freeze({
    id: "CARE",
    label: "外用与护理",
    shortLabel: "护理",
    symbol: "护",
    description: "外用药、消毒用品与伤口护理",
  }),
]);

const STORAGE_BOX_BY_ID = Object.freeze(STORAGE_BOXES.reduce((result, box) => {
  result[box.id] = box;
  return result;
}, {}));

const LEGACY_SLOT_BOX = Object.freeze({
  2: "DAILY",
  4: "DAILY",
  6: "DAILY",
  8: "DAILY",
  9: "DAILY",
  12: "DAILY",
  21: "DAILY",
  10: "CARE",
  13: "CARE",
  15: "CARE",
  16: "CARE",
  17: "CARE",
  19: "CARE",
  20: "CARE",
  22: "CARE",
});

const CARE_KEYWORDS = [
  "外用", "乳膏", "软膏", "凝胶", "滴眼", "滴鼻", "喷雾", "消毒", "碘伏",
  "创口贴", "纱布", "棉签", "敷料", "贴剂", "洗剂",
];
const DAILY_KEYWORDS = [
  "氨氯地平", "缬沙坦", "厄贝沙坦", "二甲双胍", "阿托伐他汀", "长期",
  "慢病", "维生素", "多维元素", "乳果糖", "双歧杆菌", "益生菌",
];

function text(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function legacySlotFor(medicine = {}) {
  const slot = Number(medicine.legacySlot || medicine.hardware_slot || medicine.slot || 0);
  return Number.isInteger(slot) && slot > 0 ? slot : 0;
}

function medicineIdentity(medicine = {}) {
  const known = knownMedicineFor(medicine);
  const direct = text(
    medicine.medicineId
      || medicine.medicine_id
      || medicine.traceCode
      || medicine.trace_code
      || medicine.barcode
      || medicine.code
      || medicine._id
      || medicine.id,
  );
  if (direct) return direct;
  if (known) return known.medicineId;
  const legacySlot = legacySlotFor(medicine);
  if (legacySlot) return `legacy-slot-${legacySlot}`;
  return [medicine.name, medicine.spec, medicine.expireDate || medicine.expire_date]
    .map(text)
    .filter(Boolean)
    .join("|") || "unidentified-medicine";
}

function explicitStorageBox(value) {
  const normalized = text(value).toUpperCase();
  const aliases = {
    "1": "DAILY",
    BOX1: "DAILY",
    DAILY: "DAILY",
    ROUTINE: "DAILY",
    CHRONIC: "DAILY",
    "日常": "DAILY",
    "日常用药": "DAILY",
    "日常口服": "DAILY",
    "内服": "DAILY",
    "综合内服": "DAILY",
    "基础内服": "DAILY",
    "2": "SYMPTOM",
    BOX2: "SYMPTOM",
    SYMPTOM: "SYMPTOM",
    PRN: "SYMPTOM",
    COMMON: "SYMPTOM",
    "对症": "SYMPTOM",
    "对症药品": "SYMPTOM",
    "对症备用": "SYMPTOM",
    "呼吸": "SYMPTOM",
    "感冒呼吸": "SYMPTOM",
    "感冒与呼吸": "SYMPTOM",
    "3": "CARE",
    BOX3: "CARE",
    CARE: "CARE",
    EXTERNAL: "CARE",
    TOPICAL: "CARE",
    "护理": "CARE",
    "外用": "CARE",
    "外用护理": "CARE",
    "外用与护理": "CARE",
  };
  return aliases[normalized] || "";
}

function storageBoxId(medicine = {}) {
  const explicit = explicitStorageBox(
    medicine.storageBox
      || medicine.storage_box
      || medicine.boxType
      || medicine.box_type
      || medicine.boxId
      || medicine.box_id,
  );
  if (explicit) return explicit;

  const known = knownMedicineFor(medicine);
  if (known) return known.storageBox;

  const haystack = [medicine.name, medicine.category, medicine.tags].flat().map(text).join(" ");
  if (CARE_KEYWORDS.some(keyword => haystack.includes(keyword))) return "CARE";
  if (DAILY_KEYWORDS.some(keyword => haystack.includes(keyword))) return "DAILY";

  const legacySlot = legacySlotFor(medicine);
  return LEGACY_SLOT_BOX[legacySlot] || "SYMPTOM";
}

function storageBoxFor(medicine = {}) {
  return STORAGE_BOX_BY_ID[storageBoxId(medicine)] || STORAGE_BOX_BY_ID.SYMPTOM;
}

function inventoryView(medicine = {}) {
  const camel = text(medicine.inventoryState).toUpperCase();
  const snake = text(medicine.inventory_state).toUpperCase();
  const conflict = medicine.inventoryStateConflict === true || Boolean(camel && snake && camel !== snake);
  const state = conflict ? "UNKNOWN" : (camel || snake || "");
  if (state === "STOCKED") {
    return {
      inventoryState: "STOCKED",
      isStocked: true,
      isDepleted: false,
      isInventoryUnknown: false,
      stockText: "有药",
      stockHint: "最近一次现场确认仍有余量",
    };
  }
  if (state === "DEPLETED") {
    return {
      inventoryState: "DEPLETED",
      isStocked: false,
      isDepleted: true,
      isInventoryUnknown: false,
      stockText: "待补药",
      stockHint: "最近一次现场确认已经用完",
    };
  }

  const quantity = Number(medicine.quantity !== undefined ? medicine.quantity : medicine.stock);
  const hasQuantity = Number.isFinite(quantity);
  if (!state && hasQuantity && quantity > 0) {
    return {
      inventoryState: "STOCKED",
      isStocked: true,
      isDepleted: false,
      isInventoryUnknown: false,
      stockText: "有药",
      stockHint: "来自旧版库存记录，等待现场再次确认",
    };
  }
  return {
    inventoryState: "UNKNOWN",
    isStocked: false,
    isDepleted: false,
    isInventoryUnknown: true,
    stockText: "余量待确认",
    stockHint: "等待终端同步现场确认结果",
  };
}

function decorateMedicine(medicine = {}) {
  const enriched = enrichKnownMedicine(medicine);
  const box = storageBoxFor(enriched);
  const expiry = expiryView(enriched);
  const medicineId = medicineIdentity(enriched);
  const legacySlot = legacySlotFor(enriched);
  return Object.assign({}, enriched, inventoryView(enriched), {
    medicineId,
    medicine_id: medicineId,
    legacySlot,
    storageBox: box.id,
    storage_box: box.id,
    storageBoxLabel: box.label,
    storageBoxShortLabel: box.shortLabel,
    storageBoxSymbol: box.symbol,
    expiry,
    statusText: expiry.expiryText,
    statusClass: expiry.expiryClass,
    expiryHint: expiry.expiryHint,
    expiryLabel: formatExpiryLabel(enriched.expireDate || enriched.expire_date),
    tagsText: Array.isArray(enriched.tags) ? enriched.tags.join("、") : text(enriched.tags),
    contraindicationsText: Array.isArray(enriched.contraindications)
      ? enriched.contraindications.join("；")
      : text(enriched.contraindications),
  });
}

function attentionRank(medicine = {}) {
  if (medicine.statusClass === "expired") return 0;
  if (medicine.isDepleted) return 1;
  if (medicine.statusClass === "urgent") return 2;
  if (medicine.statusClass === "soon") return 3;
  if (medicine.statusClass === "missing") return 4;
  if (medicine.isInventoryUnknown) return 5;
  return 6;
}

function sortMedicines(medicines = []) {
  return medicines.slice().sort((left, right) => {
    const rank = attentionRank(left) - attentionRank(right);
    if (rank) return rank;
    const boxRank = STORAGE_BOXES.findIndex(box => box.id === left.storageBox)
      - STORAGE_BOXES.findIndex(box => box.id === right.storageBox);
    if (boxRank) return boxRank;
    const displayRank = Number(left.displayOrder || 999) - Number(right.displayOrder || 999);
    if (displayRank) return displayRank;
    return text(left.name).localeCompare(text(right.name), "zh-CN");
  });
}

function isAttentionMedicine(medicine = {}) {
  // The built-in catalog has no live cloud snapshot yet. Missing expiry or
  // inventory facts there are unknowns, not maintenance tasks.
  if (medicine.hasCloudRecord === false) return false;
  return medicine.isDepleted
    || ["expired", "urgent", "soon", "missing"].includes(medicine.statusClass);
}

function summarizeMedicineLibrary(rawMedicines = [], options = {}) {
  const sourceMedicines = options.includeFixedBaseline === true
    ? mergeFixedMedicineBaseline(rawMedicines)
    : (rawMedicines || []);
  const medicines = sortMedicines(sourceMedicines
    .filter(medicine => medicine && text(medicine.name))
    .map(decorateMedicine));
  const boxes = STORAGE_BOXES.map(box => {
    const items = medicines.filter(medicine => medicine.storageBox === box.id);
    const attention = items.filter(isAttentionMedicine);
    return Object.assign({}, box, {
      count: items.length,
      attentionCount: attention.length,
      medicines: items,
      previewNames: items.slice(0, 3).map(item => item.name).join("、"),
    });
  });
  const available = medicines.filter(item => !item.isDepleted);
  return {
    medicines,
    boxes,
    medicineCount: medicines.length,
    stockedCount: medicines.filter(item => item.isStocked).length,
    depletedCount: medicines.filter(item => item.isDepleted).length,
    inventoryUnknownCount: medicines.filter(item => item.isInventoryUnknown).length,
    expiredCount: available.filter(item => item.statusClass === "expired").length,
    expiringCount: available.filter(item => ["urgent", "soon"].includes(item.statusClass)).length,
    missingExpiryCount: available.filter(item => item.statusClass === "missing").length,
    attentionMedicines: medicines.filter(isAttentionMedicine),
  };
}

function filterMedicines(medicines = [], options = {}) {
  const box = explicitStorageBox(options.box) || text(options.box).toUpperCase();
  const filter = ["all", "attention", "expiring", "expired", "depleted", "unknown"].includes(options.filter)
    ? options.filter
    : "all";
  const query = text(options.keyword).toLowerCase();
  let result = (medicines || []).map(item => item.storageBox ? item : decorateMedicine(item));
  if (STORAGE_BOX_BY_ID[box]) result = result.filter(item => item.storageBox === box);
  if (filter === "attention") result = result.filter(isAttentionMedicine);
  if (filter === "expiring") result = result.filter(item => ["urgent", "soon"].includes(item.statusClass));
  if (filter === "expired") result = result.filter(item => item.statusClass === "expired");
  if (filter === "depleted") result = result.filter(item => item.isDepleted);
  if (filter === "unknown") result = result.filter(item => item.isInventoryUnknown);
  if (query) {
    result = result.filter(item => [
      item.name,
      item.spec,
      item.manufacturer,
      item.category,
      item.tagsText,
      item.traceCode,
      item.barcode,
    ].map(text).join(" ").toLowerCase().includes(query));
  }
  return sortMedicines(result);
}

module.exports = {
  STORAGE_BOXES,
  decorateMedicine,
  explicitStorageBox,
  filterMedicines,
  inventoryView,
  isAttentionMedicine,
  medicineIdentity,
  mergeFixedMedicineBaseline,
  storageBoxFor,
  storageBoxId,
  summarizeMedicineLibrary,
};
