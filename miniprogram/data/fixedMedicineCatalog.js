const FIXED_MEDICINE_REFERENCE_VERSION = "home-real-cabinet-v5-balanced-three-box";

const FIXED_MEDICINES = Object.freeze([
  {
    medicineId: "slot-01-fufang-ganmaoling",
    legacySlot: 1,
    barcode: "6900966688219",
    manufacturer: "999",
    name: "复方感冒灵颗粒",
    category: "感冒发热",
    storageBox: "SYMPTOM",
    displayOrder: 1,
    tags: ["风热感冒", "发热咽痛"],
    contraindications: ["严重肝肾功能不全禁用", "避免与同类解热镇痛药重复使用"],
    safetyNote: "含对乙酰氨基酚成分，使用前核对肝肾功能风险和重复用药。",
    unit: "盒",
    isOtc: true,
  },
  {
    medicineId: "slot-02-centrum",
    legacySlot: 2,
    barcode: "",
    manufacturer: "善存",
    name: "多维元素片",
    category: "营养补充",
    storageBox: "DAILY",
    displayOrder: 2,
    tags: ["维生素矿物质", "营养补充"],
    contraindications: ["慢性肾功能衰竭禁用", "高钙血症或高磷血症禁用"],
    safetyNote: "按说明书剂量使用，避免与高剂量维矿补充剂重复。",
    unit: "瓶",
    isOtc: true,
  },
  {
    medicineId: "slot-03-ganmao-qingre",
    legacySlot: 3,
    barcode: "6928849913616",
    manufacturer: "999",
    name: "感冒清热颗粒",
    category: "感冒发热",
    storageBox: "SYMPTOM",
    displayOrder: 2,
    tags: ["风寒感冒", "头痛发热"],
    contraindications: ["对本品成分过敏禁用", "风热感冒表现者不适用"],
    safetyNote: "用于风寒感冒相关症状，症状不匹配或持续加重需联系医生。",
    unit: "盒",
    isOtc: true,
  },
  {
    medicineId: "slot-04-amoxicillin",
    legacySlot: 4,
    barcode: "6938588802331",
    manufacturer: "华北制药",
    name: "阿莫西林胶囊",
    category: "抗菌药",
    storageBox: "DAILY",
    displayOrder: 7,
    tags: ["青霉素类", "处方核验"],
    contraindications: ["青霉素过敏禁用", "需按既往医嘱或处方使用"],
    safetyNote: "抗菌药需确认过敏史和医嘱，不作为自行新增用药。",
    unit: "盒",
    isOtc: false,
  },
  {
    medicineId: "slot-05-nin-jiom-pei-pa-koa",
    legacySlot: 5,
    barcode: "081364361693",
    manufacturer: "京都念慈庵",
    name: "蜜炼川贝枇杷膏",
    category: "咳嗽咽喉",
    storageBox: "SYMPTOM",
    displayOrder: 8,
    tags: ["咳嗽痰多", "咽喉不适"],
    contraindications: ["对成分过敏禁用", "糖尿病患者禁用"],
    safetyNote: "含糖浆类辅料，糖代谢异常或症状持续者需谨慎核验。",
    unit: "瓶",
    isOtc: true,
  },
  {
    medicineId: "slot-06-lactulose",
    legacySlot: 6,
    barcode: "6943798800923",
    manufacturer: "健能药业",
    name: "乳果糖口服液",
    category: "肠胃",
    storageBox: "DAILY",
    displayOrder: 3,
    tags: ["便秘", "肠道调节"],
    contraindications: ["肠梗阻或急腹痛禁用", "半乳糖不耐受者不宜使用"],
    safetyNote: "便秘用药前需排除急腹痛、肠梗阻等风险。",
    unit: "瓶",
    isOtc: true,
  },
  {
    medicineId: "slot-07-yinhuang",
    legacySlot: 7,
    barcode: "6934199500017",
    manufacturer: "神鹤药业",
    name: "银黄颗粒",
    category: "咽喉口腔",
    storageBox: "SYMPTOM",
    displayOrder: 6,
    tags: ["咽痛", "上呼吸道不适"],
    contraindications: ["对本品过敏禁用", "脾胃虚寒或糖尿病患者慎用"],
    safetyNote: "高热、化脓或症状三天无改善时需联系医生。",
    unit: "盒",
    isOtc: true,
  },
  {
    medicineId: "slot-08-huoxiang-zhengqi",
    legacySlot: 8,
    barcode: "6921711516168",
    manufacturer: "恒心堂",
    name: "藿香正气丸",
    category: "肠胃",
    storageBox: "DAILY",
    displayOrder: 5,
    tags: ["暑湿不适", "腹胀呕吐"],
    contraindications: ["风热感冒不适用", "孕妇及严重慢病患者需医师指导"],
    safetyNote: "适用暑湿相关不适，胸闷心悸或吐泻明显需就医。",
    unit: "盒",
    isOtc: true,
  },
  {
    medicineId: "slot-09-bifid-triple",
    legacySlot: 9,
    barcode: "6922313021210",
    manufacturer: "贝飞达",
    name: "双歧杆菌三联活菌肠溶胶囊",
    category: "肠胃",
    storageBox: "DAILY",
    displayOrder: 4,
    tags: ["菌群调节", "腹泻便秘"],
    contraindications: ["对本品过敏禁用", "避免与抗菌药同时服用"],
    safetyNote: "活菌制剂注意储存条件，和抗菌药需错开。",
    unit: "盒",
    isOtc: true,
  },
  {
    medicineId: "slot-10-gauze",
    legacySlot: 10,
    barcode: "6950715511633",
    manufacturer: "可孚",
    name: "医用纱布敷料",
    category: "外伤护理",
    storageBox: "CARE",
    displayOrder: 3,
    tags: ["伤口覆盖", "包扎"],
    contraindications: ["包装破损或污染禁用", "深大伤口需专业处理"],
    safetyNote: "使用前确认无菌包装完好，伤口感染或出血不止需就医。",
    unit: "包",
    isOtc: true,
    isEmergency: true,
  },
  {
    medicineId: "slot-11-guilin-xiguashuang",
    legacySlot: 11,
    barcode: "6939261900771",
    manufacturer: "三金",
    name: "桂林西瓜霜",
    category: "咽喉口腔",
    storageBox: "SYMPTOM",
    displayOrder: 7,
    tags: ["咽喉肿痛", "口腔不适"],
    contraindications: ["对本品过敏禁用", "喷敷时避免吸入气道"],
    safetyNote: "高热、化脓或口腔严重糜烂需联系医生。",
    unit: "瓶",
    isOtc: true,
  },
  {
    medicineId: "slot-12-hydrotalcite",
    legacySlot: 12,
    barcode: "6921041723526",
    manufacturer: "华森制药",
    name: "铝碳酸镁咀嚼片",
    category: "肠胃",
    storageBox: "DAILY",
    displayOrder: 6,
    tags: ["胃酸", "胃部不适"],
    contraindications: ["重度肾损害禁用", "低磷血症或重症肌无力禁用"],
    safetyNote: "需嚼服，长期或反复胃痛应联系医生。",
    unit: "盒",
    isOtc: true,
  },
  {
    medicineId: "slot-13-sodium-hyaluronate-eye",
    legacySlot: 13,
    barcode: "6955236613620",
    manufacturer: "普润盈",
    name: "玻璃酸钠滴眼液",
    category: "眼部护理",
    storageBox: "CARE",
    displayOrder: 8,
    tags: ["干眼", "眼部润滑"],
    contraindications: ["对成分过敏禁用", "瓶口勿接触眼部或皮肤"],
    safetyNote: "眼部疼痛、红肿或视力变化时不要自行处理。",
    unit: "盒",
    isOtc: true,
  },
  {
    medicineId: "slot-14-oseltamivir",
    legacySlot: 14,
    barcode: "6958439003076",
    manufacturer: "华海药业",
    name: "磷酸奥司他韦胶囊",
    category: "感冒发热",
    storageBox: "SYMPTOM",
    displayOrder: 3,
    tags: ["流感用药", "处方核验"],
    contraindications: ["对本品成分过敏禁用", "需按医嘱确认适用时机"],
    safetyNote: "流感相关用药需核验症状时间窗和医嘱。",
    unit: "盒",
    isOtc: false,
  },
  {
    medicineId: "slot-15-mupirocin",
    legacySlot: 15,
    barcode: "62000000204025",
    manufacturer: "中美史克",
    name: "莫匹罗星软膏",
    category: "外用皮肤",
    storageBox: "CARE",
    displayOrder: 5,
    tags: ["皮肤感染", "外用软膏"],
    contraindications: ["莫匹罗星或聚乙二醇过敏禁用", "不用于眼内或鼻腔"],
    safetyNote: "外用抗菌药需核验伤口状态和既往用药。",
    unit: "支",
    isOtc: false,
  },
  {
    medicineId: "slot-16-ketoconazole",
    legacySlot: 16,
    barcode: "",
    manufacturer: "金日制药",
    name: "酮康唑乳膏",
    category: "外用皮肤",
    storageBox: "CARE",
    displayOrder: 6,
    tags: ["真菌感染", "外用乳膏"],
    contraindications: ["对本品过敏禁用", "避免接触眼睛和黏膜"],
    safetyNote: "不得用于破溃皮肤，大面积或长期使用需咨询医生。",
    unit: "支",
    isOtc: true,
  },
  {
    medicineId: "slot-17-iodophor",
    legacySlot: 17,
    barcode: "6926378900350",
    manufacturer: "利尔康",
    name: "碘伏消毒液",
    category: "外伤护理",
    storageBox: "CARE",
    displayOrder: 1,
    tags: ["皮肤消毒", "浅表伤口"],
    contraindications: ["碘过敏者慎用", "外用消毒剂禁止口服"],
    safetyNote: "仅限外用，深部伤口、严重烧伤或感染需就医。",
    unit: "瓶",
    isOtc: true,
    isEmergency: true,
  },
  {
    medicineId: "slot-18-budesonide-nasal",
    legacySlot: 18,
    barcode: "",
    manufacturer: "雷诺考特",
    name: "布地奈德鼻喷雾剂",
    category: "鼻炎过敏",
    storageBox: "SYMPTOM",
    displayOrder: 5,
    tags: ["鼻炎", "鼻喷雾"],
    contraindications: ["对布地奈德或辅料过敏禁用", "仅鼻腔使用，避免入眼"],
    safetyNote: "连续使用后症状无改善或鼻出血需咨询医生。",
    unit: "瓶",
    isOtc: true,
  },
  {
    medicineId: "slot-19-ketoprofen-gel",
    legacySlot: 19,
    barcode: "",
    manufacturer: "法斯通",
    name: "酮洛芬凝胶",
    category: "外用止痛",
    storageBox: "CARE",
    displayOrder: 7,
    tags: ["肌肉关节痛", "外用凝胶"],
    contraindications: ["非甾体抗炎药过敏禁用", "活动性消化道溃疡禁用"],
    safetyNote: "不得用于破损或感染伤口，孕哺期慎用。",
    unit: "支",
    isOtc: true,
  },
  {
    medicineId: "slot-20-bandage",
    legacySlot: 20,
    barcode: "",
    manufacturer: "凡卡",
    name: "创口贴",
    category: "外伤护理",
    storageBox: "CARE",
    displayOrder: 4,
    tags: ["浅表小伤口", "保护包扎"],
    contraindications: ["深部伤口或动物咬伤不适用", "感染化脓伤口不适用"],
    safetyNote: "只用于清洁浅表小伤口，需定期更换并观察感染迹象。",
    unit: "盒",
    isOtc: true,
    isEmergency: true,
  },
  {
    medicineId: "slot-21-amlodipine",
    legacySlot: 21,
    barcode: "6910853810272",
    manufacturer: "京新药业",
    name: "苯磺酸氨氯地平片",
    category: "慢病常用",
    storageBox: "DAILY",
    displayOrder: 1,
    tags: ["血压管理", "长期用药"],
    contraindications: ["对氨氯地平过敏禁用", "低血压或肝功能受损需医嘱"],
    safetyNote: "慢病用药仅按既往计划或医嘱使用。",
    unit: "盒",
    isOtc: false,
  },
  {
    medicineId: "slot-22-cotton-swab",
    legacySlot: 22,
    barcode: "6932593000577",
    manufacturer: "稳健医疗",
    name: "医用棉签",
    category: "外伤护理",
    storageBox: "CARE",
    displayOrder: 2,
    tags: ["清洁处理", "一次性用品"],
    contraindications: ["包装破损或污染禁用", "一次性用品禁止重复使用"],
    safetyNote: "使用前核对有效期和包装完整性，用后按废弃物处理。",
    unit: "包",
    isOtc: true,
    isEmergency: true,
  },
  {
    medicineId: "slot-23-desloratadine",
    legacySlot: 23,
    barcode: "6970847150012",
    manufacturer: "恩瑞特医疗",
    name: "枸地氯雷他定胶囊",
    category: "鼻炎过敏",
    storageBox: "SYMPTOM",
    displayOrder: 4,
    tags: ["过敏性鼻炎", "荨麻疹"],
    contraindications: ["对活性成分或辅料过敏禁用", "出现心悸或明显嗜睡需停止并咨询"],
    safetyNote: "过敏症状伴呼吸困难或面唇肿胀时应立即就医。",
    unit: "盒",
    isOtc: false,
  },
]);

function text(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function numericSlot(medicine = {}) {
  const value = medicine.legacySlot || medicine.hardware_slot || medicine.slot;
  const direct = Number(value);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = text(value).match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function knownMedicineFor(medicine = {}) {
  const medicineId = text(medicine.medicineId || medicine.medicine_id || medicine.id || medicine._id);
  if (medicineId) {
    const byId = FIXED_MEDICINES.find(item => item.medicineId === medicineId);
    if (byId) return byId;
  }
  const barcode = text(medicine.traceCode || medicine.trace_code || medicine.barcode || medicine.code);
  if (barcode) {
    const byBarcode = FIXED_MEDICINES.find(item => item.barcode && item.barcode === barcode);
    if (byBarcode) return byBarcode;
  }
  const name = text(medicine.name);
  if (name) {
    const byName = FIXED_MEDICINES.find(item => item.name === name);
    if (byName) return byName;
    return null;
  }
  const slot = numericSlot(medicine);
  return slot ? FIXED_MEDICINES.find(item => item.legacySlot === slot) || null : null;
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return "";
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value.slice();
  }
  return [];
}

function enrichKnownMedicine(medicine = {}) {
  const known = knownMedicineFor(medicine);
  if (!known) return Object.assign({}, medicine, { fixedCatalogMatch: false });
  const medicineId = firstText(medicine.medicineId, medicine.medicine_id, known.medicineId);
  return Object.assign({}, known, medicine, {
    medicineId,
    medicine_id: medicineId,
    legacySlot: numericSlot(medicine) || known.legacySlot,
    name: firstText(medicine.name, known.name),
    manufacturer: firstText(medicine.manufacturer, medicine.producer, known.manufacturer),
    barcode: firstText(medicine.barcode, medicine.code, known.barcode),
    category: firstText(medicine.category, known.category),
    storageBox: firstText(medicine.storageBox, medicine.storage_box, known.storageBox),
    tags: firstArray(medicine.tags, known.tags),
    contraindications: firstArray(medicine.contraindications, known.contraindications),
    safetyNote: firstText(medicine.safetyNote, medicine.safety_note, known.safetyNote),
    unit: firstText(medicine.unit, known.unit),
    referenceVersion: FIXED_MEDICINE_REFERENCE_VERSION,
    fixedCatalogMatch: true,
  });
}

function mergeFixedMedicineBaseline(rawMedicines = []) {
  const liveByMedicineId = Object.create(null);

  (Array.isArray(rawMedicines) ? rawMedicines : []).forEach(medicine => {
    const known = knownMedicineFor(medicine);
    // The current product baseline is intentionally limited to these 23
    // medicines. Unknown legacy rows remain in cloud storage for audit, but
    // they must not become extra medicines in the family-facing UI.
    if (!known) return;
    // LIST_MEDICINES is newest-first. Keep one current cloud fact per stable
    // medicine identity so old random document ids cannot duplicate a drug.
    if (!liveByMedicineId[known.medicineId]) {
      liveByMedicineId[known.medicineId] = medicine;
    }
  });

  const fixedMedicines = FIXED_MEDICINES.map(reference => {
    const live = liveByMedicineId[reference.medicineId] || null;
    return Object.assign({}, reference, live || {}, {
      medicineId: reference.medicineId,
      medicine_id: reference.medicineId,
      legacySlot: reference.legacySlot,
      storageBox: reference.storageBox,
      storage_box: reference.storageBox,
      fixedCatalogMatch: true,
      hasCloudRecord: Boolean(live),
    });
  });

  return fixedMedicines;
}

module.exports = {
  FIXED_MEDICINE_REFERENCE_VERSION,
  FIXED_MEDICINES,
  enrichKnownMedicine,
  knownMedicineFor,
  mergeFixedMedicineBaseline,
};
