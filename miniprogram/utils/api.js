const { daysUntil, normalizeExpiryDate } = require("./expiry");
const { CABINET_SLOT_COUNT } = require("./cabinetSlots");
const { storageBoxFor } = require("./medicineLibrary");
const {
  enrichKnownMedicine,
  knownMedicineFor,
} = require("../data/fixedMedicineCatalog");
const { validateMedicationSafetyEventReadReceipt } = require("../modules/medicationSafetyEvents");
const { parseTimestamp } = require("./dateTime");
const {
  evaluateCompatibility,
  projectConnection,
} = require("./connectionState");

const COLLECTIONS = {
  devices: "devices",
  medicines: "medicines",
  vitals: "vitals",
  records: "records",
  commands: "commands",
  serviceUsers: "service_users",
  plans: "today_plans",
  inquiries: "inquiries",
};

const MEMBERSHIP_ERROR_CODES = new Set([
  "CAREGIVER_MEMBERSHIP_REQUIRED",
  "CAREGIVER_PERMISSION_DENIED",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "PERMISSION_DENIED",
]);

function appData() {
  const app = typeof getApp === "function" ? getApp() : null;
  return app && app.globalData || {};
}

function membershipErrorCode(value) {
  const tokens = String(value || "").match(/\b[A-Z][A-Z0-9_]+\b/g) || [];
  return tokens.find(token => MEMBERSHIP_ERROR_CODES.has(token)) || "";
}

async function cloudAction(action, data = {}, deviceIdOverride = "", options = {}) {
  const deviceId = firstPresent(deviceIdOverride, appData().deviceId);
  if (options.accountScoped !== true && !deviceId) {
    const error = new Error("请先选择当前账号有权访问的药箱");
    error.code = "DEVICE_NOT_SELECTED";
    error.action = action;
    throw error;
  }
  const res = await wx.cloud.callFunction({
    name: "api",
    data: {
      action,
      data: options.accountScoped === true
        ? Object.assign({}, data)
        : Object.assign({ deviceId }, data),
    },
  });
  const result = res.result;
  if (result && result.ok === false) {
    const error = new Error(result.error || "cloud action failed");
    error.code = firstPresent(
      result.code,
      result.errorCode,
      result.error_code,
      membershipErrorCode(result.error),
      "",
    );
    error.action = firstPresent(result.action, action, "");
    error.details = result.details;
    throw error;
  }
  return result;
}

function nowText() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function emptyDevice(deviceIdOverride = "") {
  const deviceId = firstPresent(deviceIdOverride, appData().deviceId);
  const connection = projectConnection({}, { loading: true });
  return {
    _id: deviceId,
    deviceId,
    name: "智药康护终端",
    online: null,
    connection,
    connectionState: connection.state,
    network: "未上报",
    signal: "未上报",
    medicineCount: 0,
    lowStockCount: 0,
    lastVitals: null,
    lastSeenAt: "",
    lastSeenAtEpochMs: 0,
    heartbeatAgeMs: null,
    cloudAgent: "未上报",
    localApi: "未上报",
    board: "未上报",
    stm32: "未上报",
  };
}

function parseTime(value) {
  return parseTimestamp(value);
}

function isDeviceOnline(device) {
  if (!device) return false;
  if (device.connection && device.connection.state) {
    return device.connection.state === "online";
  }
  return projectConnection(device).state === "online";
}

function firstPresent(...values) {
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== undefined && values[i] !== null && values[i] !== "") return values[i];
  }
  return "";
}

function compactServiceUser(user = {}) {
  const archivedValue = firstPresent(user.archived, user.isArchived, user.is_archived, false);
  const archived = archivedValue === true || archivedValue === 1 || ["true", "1", "yes", "是"].includes(String(archivedValue).trim().toLowerCase());
  return {
    id: firstPresent(user.id, user.user_id, user._id, user.service_user_id, ""),
    name: firstPresent(user.name, user.user_name, user.nickname, user.display_name, "家庭成员"),
    age: firstPresent(user.age, ""),
    profile: firstPresent(user.profile, user.disease, user.note, ""),
    status: firstPresent(user.status, ""),
    personaGeneration: firstPresent(user.personaGeneration, user.persona_generation, ""),
    safetyProfileRevision: firstPresent(user.safetyProfileRevision, user.safety_profile_revision, ""),
    safetyProfileUpdatedAt: firstPresent(user.safetyProfileUpdatedAt, user.safety_profile_updated_at, ""),
    archived,
  };
}

function compactPlan(plan = {}) {
  return {
    _id: plan._id,
    id: firstPresent(plan.id, plan.plan_id, plan._id, ""),
    time: firstPresent(plan.time, ""),
    timing_label: firstPresent(plan.timing_label, ""),
    medicine: firstPresent(plan.medicine, plan.medicine_name, plan.name, ""),
    dose: firstPresent(plan.dose, plan.dosage, ""),
    target_user: firstPresent(plan.target_user, plan.target_user_name, plan.user_name, ""),
    target_user_name: firstPresent(plan.target_user_name, plan.target_user, plan.user_name, ""),
    service_user_id: firstPresent(plan.service_user_id, plan.target_user_id, plan.user_id, ""),
    personaGeneration: firstPresent(plan.personaGeneration, plan.persona_generation, ""),
    status: firstPresent(plan.status, ""),
    due_today: plan.due_today,
    next_due_date: firstPresent(plan.next_due_date, ""),
    last_action_date: firstPresent(plan.last_action_date, ""),
  };
}

function planMatchesServiceUser(plan = {}, serviceUser = {}, options = {}) {
  const normalizedPlan = compactPlan(plan);
  const normalizedUser = compactServiceUser(serviceUser);
  if (options.includeArchived !== true && normalizedUser.archived) return false;

  const planId = String(normalizedPlan.service_user_id || "").trim();
  const userId = String(normalizedUser.id || "").trim();
  const planGeneration = String(normalizedPlan.personaGeneration || "").trim();
  const userGeneration = String(normalizedUser.personaGeneration || "").trim();

  if (!planId && !userId) {
    if (planGeneration || userGeneration) return false;
    const planName = String(normalizedPlan.target_user_name || normalizedPlan.target_user || "").trim();
    const userName = String(normalizedUser.name || "").trim();
    return Boolean(planName && userName && planName === userName);
  }
  if (!planId || !userId || planId !== userId) return false;
  if (options.strictGeneration === true && Boolean(planGeneration) !== Boolean(userGeneration)) return false;
  return !planGeneration || !userGeneration || planGeneration === userGeneration;
}

function shouldShowPlanForServiceUsers(plan = {}, serviceUsers = []) {
  const users = (serviceUsers || []).map(compactServiceUser);
  if (!users.length) return true;

  const normalizedPlan = compactPlan(plan);
  const planId = String(normalizedPlan.service_user_id || "").trim();
  const planGeneration = String(normalizedPlan.personaGeneration || "").trim();
  if (planId) {
    const matchingUsers = users.filter(user => String(user.id || "").trim() === planId);
    if (!matchingUsers.length) return true;
    const knownGenerations = new Set(matchingUsers
      .map(user => String(user.personaGeneration || "").trim())
      .filter(Boolean));
    if (!planGeneration && knownGenerations.size > 1) return false;
    return matchingUsers.some(user => planMatchesServiceUser(normalizedPlan, user));
  }

  const planName = String(normalizedPlan.target_user_name || normalizedPlan.target_user || "").trim();
  if (!planName) return true;
  const nameMatches = users.filter(user => String(user.name || "").trim() === planName);
  if (!nameMatches.length) return true;
  if (nameMatches.length !== 1) return false;
  if (planGeneration || nameMatches.some(user => String(user.personaGeneration || "").trim())) return false;
  return nameMatches.some(user => planMatchesServiceUser(normalizedPlan, user));
}

function safeId(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "-");
}

function normalizeMedicineSlot(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const direct = Number(value);
    if (Number.isInteger(direct) && direct > 0) return direct;
    const match = String(value).match(/(\d+)/);
    if (match) {
      const extracted = Number(match[1]);
      if (Number.isInteger(extracted) && extracted > 0) return extracted;
    }
  }
  return 1;
}

function expiryInfo(value) {
  const text = normalizeExpiryDate(value);
  if (!text) {
    return { text: "未登记", status: "unknown", level: "warn", days: null };
  }
  const days = daysUntil(text);
  if (days === null) {
    return { text, status: "unknown", level: "warn", days: null };
  }
  if (days < 0) return { text, status: "expired", level: "bad", days };
  if (days <= 30) return { text, status: "soon", level: "warn", days };
  if (days <= 90) return { text, status: "watch", level: "notice", days };
  return { text, status: "ok", level: "ok", days };
}

function buildHeader(device = {}) {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const connection = device.connection && device.connection.state
    ? device.connection
    : projectConnection(device);
  const online = connection.state === "online";
  let network = device.network || "未上报";
  if (network === "unknown") network = online ? "已同步" : "待同步";
  if (String(network).indexOf(":down") >= 0) network = online ? "已同步" : "待同步";
  return {
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    date: `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`,
    weekday: weekdays[d.getDay()],
    network,
    signal: device.signal || "未上报",
    online,
    connection,
    connectionState: connection.state,
    onlineText: online ? "在线" : (connection.state === "stale" ? "等待连接" : "状态待确认"),
  };
}

function normalizeDevice(data = {}, requestDeviceId = "") {
  const raw = Object.assign(emptyDevice(requestDeviceId), data || {});
  const summary = raw.syncSummary || {};
  const counts = summary.counts || {};
  const session = appData().deviceSession || {};
  const compatibility = session.compatibility || (
    session.schemaRevision || session.schemaVersion
      ? evaluateCompatibility(session)
      : { compatible: true }
  );
  const connection = projectConnection(raw, {
    availability: session.availability === "ready" ? "" : session.availability,
    compatible: compatibility.compatible,
    reason: compatibility.compatible === false ? compatibility.reason : "",
  });
  const device = Object.assign(emptyDevice(requestDeviceId), {
    _id: firstPresent(raw._id, raw.deviceId),
    deviceId: firstPresent(raw.deviceId, raw._id, requestDeviceId, appData().deviceId),
    name: firstPresent(raw.name, "智药康护终端"),
    online: connection.online,
    connection,
    connectionState: connection.state,
    network: firstPresent(raw.network, "未上报"),
    signal: firstPresent(raw.signal, "未上报"),
    medicineCount: Number(firstPresent(raw.medicineCount, counts.medicines, 0)),
    lowStockCount: Number(firstPresent(raw.lowStockCount, 0)),
    lastVitals: raw.lastVitals || null,
    lastSeenAt: firstPresent(raw.lastSeenAt, raw.updatedAt, ""),
    lastSeenAtEpochMs: Number(firstPresent(raw.lastSeenAtEpochMs, raw.last_seen_at_epoch_ms, 0)) || 0,
    heartbeatAgeMs: Number.isFinite(Number(firstPresent(raw.heartbeatAgeMs, raw.heartbeat_age_ms, NaN)))
      ? Number(firstPresent(raw.heartbeatAgeMs, raw.heartbeat_age_ms))
      : null,
    updatedAt: firstPresent(raw.updatedAt, ""),
    cloudAgent: firstPresent(raw.cloudAgent, raw.agent, "未上报"),
    agentVersion: firstPresent(raw.agentVersion, ""),
    schemaVersion: firstPresent(raw.schemaVersion, ""),
    localApi: firstPresent(raw.localApi, "未上报"),
    board: firstPresent(raw.board, "未上报"),
    stm32: firstPresent(raw.stm32, "未上报"),
    syncSummary: {
      counts,
      serviceUsers: (summary.serviceUsers || []).slice(0, 20).map(compactServiceUser),
      plans: (summary.plans || []).slice(0, 50).map(compactPlan),
      recentInquiries: compactInquiryTransportRows(
        summary.recentInquiries || [],
        firstPresent(raw.deviceId, raw._id, requestDeviceId),
      ).slice(0, 60),
    },
  });
  return device;
}

function normalizeMedicine(item, options = {}) {
  const raw = item || {};
  const known = enrichKnownMedicine(raw);
  const deviceId = raw.deviceId || appData().deviceId;
  const camelMedicineId = String(raw.medicineId || "").trim();
  const snakeMedicineId = String(raw.medicine_id || "").trim();
  if (camelMedicineId && snakeMedicineId && camelMedicineId !== snakeMedicineId) {
    const error = new Error("medicine identity aliases conflict");
    error.code = "MEDICINE_IDENTITY_CONFLICT";
    throw error;
  }
  const referenceMedicine = knownMedicineFor({ medicineId: camelMedicineId || snakeMedicineId });
  const slotValue = firstPresent(
    raw.legacySlot,
    raw.legacy_slot,
    raw.hardware_slot,
    raw.hardwareSlot,
    raw.slot,
    known.fixedCatalogMatch ? known.legacySlot : "",
    0,
  );
  const slotNumber = Number(slotValue);
  const slot = Number.isInteger(slotNumber) && slotNumber > 0
    ? slotNumber
    : (slotValue ? normalizeMedicineSlot(slotValue) : 0);
  const medicineId = String(firstPresent(
    camelMedicineId,
    snakeMedicineId,
    options.strictManifest ? "" : firstPresent(raw.traceCode, raw.trace_code, raw.barcode, raw.code, raw._id),
    slot ? `legacy-slot-${slot}` : "",
  ) || "").trim();
  if (options.strictManifest && !medicineId) {
    const error = new Error("medicine identity is required");
    error.code = "MEDICINE_ID_REQUIRED";
    throw error;
  }
  const camelStorageBox = String(raw.storageBox || "").trim().toUpperCase();
  const snakeStorageBox = String(raw.storage_box || "").trim().toUpperCase();
  if (camelStorageBox && snakeStorageBox && camelStorageBox !== snakeStorageBox) {
    const error = new Error("medicine storage box aliases conflict");
    error.code = "MEDICINE_STORAGE_BOX_CONFLICT";
    throw error;
  }
  const manifestStorageBox = camelStorageBox || snakeStorageBox;
  const validStorageBoxes = new Set(["DAILY", "CARE", "PRESCRIPTION"]);
  if (options.strictManifest && !validStorageBoxes.has(manifestStorageBox)) {
    const error = new Error("medicine storage box is invalid");
    error.code = "MEDICINE_STORAGE_BOX_INVALID";
    throw error;
  }
  if (options.strictManifest
      && referenceMedicine
      && referenceMedicine.storageBox !== manifestStorageBox) {
    const error = new Error("medicine identity and storage box conflict");
    error.code = "MEDICINE_REFERENCE_CONFLICT";
    throw error;
  }
  // Quantity is only a coarse count. Preserve an omitted value and leave all
  // inventory-state interpretation to the capability-aware projection layer.
  const rawQuantity = firstPresent(raw.quantity, raw.stock);
  const parsedQuantity = rawQuantity === "" ? NaN : Number(rawQuantity);
  const quantity = Number.isFinite(parsedQuantity) ? parsedQuantity : undefined;
  const camelExpiry = normalizeExpiryDate(raw.expireDate);
  const snakeExpiry = normalizeExpiryDate(raw.expire_date);
  const expiryConflict = Boolean(camelExpiry && snakeExpiry && camelExpiry !== snakeExpiry);
  const expireDate = expiryConflict ? "" : firstPresent(camelExpiry, snakeExpiry);
  const expiryPrecision = firstPresent(
    raw.expiryPrecision,
    raw.expiry_precision,
    /^\d{4}-\d{2}$/.test(expireDate) ? "month" : expireDate ? "day" : "",
  );
  const camelInventoryState = String(raw.inventoryState || "").trim().toUpperCase();
  const snakeInventoryState = String(raw.inventory_state || "").trim().toUpperCase();
  const inventoryStateConflict = Boolean(
    camelInventoryState
    && snakeInventoryState
    && camelInventoryState !== snakeInventoryState
  );
  const inventoryState = inventoryStateConflict
    ? ""
    : firstPresent(camelInventoryState, snakeInventoryState, "");
  const inventoryStateRevision = Number(firstPresent(
    raw.inventoryStateRevision,
    raw.inventory_state_revision,
    0,
  ));
  const depletionConfirmedAt = firstPresent(
    raw.depletionConfirmedAt,
    raw.depletion_confirmed_at,
    "",
  );
  const depletionConfirmationSource = firstPresent(
    raw.depletionConfirmationSource,
    raw.depletion_confirmation_source,
    "",
  );
  const authoritativeStorageBox = validStorageBoxes.has(manifestStorageBox)
    ? manifestStorageBox
    : "";
  const box = storageBoxFor(Object.assign({}, known, raw, {
    medicineId,
    storageBox: authoritativeStorageBox,
    slot,
  })) || { id: "", label: "同步数据异常" };
  const name = firstPresent(raw.name, known.name, "");
  if (options.strictManifest && !String(name || "").trim()) {
    const error = new Error("medicine name is required");
    error.code = "MEDICINE_NAME_REQUIRED";
    throw error;
  }
  return Object.assign({}, known, raw, {
    _id: raw._id || `${deviceId}-medicine-${safeId(medicineId)}`,
    deviceId,
    medicineId,
    medicine_id: medicineId,
    slot,
    legacySlot: slot,
    storageBox: authoritativeStorageBox || box.id,
    storage_box: authoritativeStorageBox || box.id,
    storageBoxLabel: box.label,
    name,
    manufacturer: firstPresent(raw.manufacturer, raw.producer, known.manufacturer, ""),
    category: firstPresent(raw.category, known.category, ""),
    tags: Array.isArray(raw.tags) && raw.tags.length ? raw.tags : (known.tags || []),
    contraindications: Array.isArray(raw.contraindications) && raw.contraindications.length
      ? raw.contraindications
      : (known.contraindications || []),
    safetyNote: firstPresent(raw.safetyNote, raw.safety_note, known.safetyNote, ""),
    spec: firstPresent(raw.spec, raw.package_spec),
    quantity,
    stock: quantity,
    unit: firstPresent(raw.unit, known.unit, "盒"),
    expireDate,
    expire_date: expireDate,
    expiryConflict,
    expiryConflictValues: expiryConflict ? [camelExpiry, snakeExpiry] : [],
    expiryPrecision,
    expiry_precision: expiryPrecision,
    inventoryState,
    inventory_state: inventoryState,
    inventoryStateConflict,
    inventoryStateConflictValues: inventoryStateConflict
      ? [camelInventoryState, snakeInventoryState]
      : [],
    inventoryStateRevision,
    inventory_state_revision: inventoryStateRevision,
    depletionConfirmedAt,
    depletion_confirmed_at: depletionConfirmedAt,
    depletionConfirmationSource,
    depletion_confirmation_source: depletionConfirmationSource,
    // 条码与追溯码不可互相回退：它们在板端是不同字段，混用会污染扫码数据。
    barcode: firstPresent(raw.barcode, raw.code),
    traceCode: firstPresent(raw.traceCode, raw.trace_code),
    trace_code: firstPresent(raw.trace_code, raw.traceCode),
    lowStockLine: Number(firstPresent(raw.lowStockLine, raw.low_stock_line, 0)),
    activeIngredients: firstPresent(raw.activeIngredients, raw.active_ingredients, []),
    structuredContraindications: firstPresent(
      raw.structuredContraindications,
      raw.structured_contraindications,
      [],
    ),
    updatedAt: raw.updatedAt || "",
    hasCloudRecord: options.strictManifest ? true : raw.hasCloudRecord !== false,
  });
}

function medicineDocId(deviceId, slot) {
  return `${deviceId}-slot-${Number(slot)}`;
}

function normalizeVitals(item) {
  if (!item) return null;
  const identityField = (values, normalize = value => String(value || "").trim()) => {
    const normalized = values.map(normalize).filter(Boolean);
    const distinct = Array.from(new Set(normalized));
    return {
      value: distinct.length > 1 ? "" : (normalized[0] || ""),
      conflict: distinct.length > 1,
    };
  };
  const deviceId = identityField([item.device_id, item.deviceId]);
  const personId = identityField([item.service_user_id, item.person_id, item.personId]);
  const personaGeneration = identityField([item.persona_generation, item.personaGeneration]);
  const inquirySessionId = identityField([item.inquiry_session_id, item.inquirySessionId]);
  const attributionSource = identityField(
    [item.attribution_source, item.attributionSource],
    value => String(value || "").trim().toUpperCase(),
  );
  const attributionConflictFields = [
    ["deviceId", deviceId],
    ["personId", personId],
    ["personaGeneration", personaGeneration],
    ["inquirySessionId", inquirySessionId],
    ["attributionSource", attributionSource],
  ].filter(([, field]) => field.conflict).map(([name]) => name);
  return Object.assign({}, item, {
    recordId: firstPresent(item.vitals_record_id, item.recordId, item.id, item._id),
    deviceId: deviceId.value,
    heartRate: firstPresent(item.heartRate, item.heart_rate, item.heart_rate_bpm),
    spo2: firstPresent(item.spo2, item.spo2_percent),
    bodyTemp: firstPresent(item.bodyTemp, item.body_temp_c, item.target_temp_c, item.temperature),
    quality: firstPresent(item.quality, item.signal_quality, "unknown"),
    createdAt: firstPresent(item.createdAt, item.created_at, item.measuredAt, item.measured_at, item.time),
    personId: personId.value,
    personName: firstPresent(
      item.service_user_name_snapshot,
      item.service_user_name,
      item.person_name,
      item.personName,
    ),
    personaGeneration: personaGeneration.value,
    inquirySessionId: inquirySessionId.value,
    attributionSource: attributionSource.value,
    attributionRevision: firstPresent(item.attribution_revision, item.attributionRevision),
    attributionConflict: attributionConflictFields.length > 0,
    attributionConflictFields,
  });
}

function uniqueTextList(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(item => String(item || "").trim()).filter(Boolean)))
    : [];
}

function normalizeAuthorizedDevice(item = {}) {
  const deviceId = firstPresent(item.deviceId, item.device_id, item._id);
  if (!deviceId) return null;
  const session = appData().deviceSession || {};
  const compatibility = session.compatibility || (
    session.schemaRevision || session.schemaVersion
      ? evaluateCompatibility(session)
      : { compatible: true }
  );
  const connection = projectConnection(item, {
    compatible: compatibility.compatible,
    reason: compatibility.compatible === false ? compatibility.reason : "",
  });
  return {
    deviceId,
    name: firstPresent(item.name, item.displayName, item.display_name, "家庭药箱"),
    online: connection.online,
    connection,
    connectionState: connection.state,
    lastSeenAt: firstPresent(item.lastSeenAt, item.last_seen_at, item.updatedAt, ""),
    lastSeenAtEpochMs: Number(firstPresent(item.lastSeenAtEpochMs, item.last_seen_at_epoch_ms, 0)) || 0,
    heartbeatAgeMs: connection.heartbeatAgeMs,
    role: String(firstPresent(item.role, "VIEWER")).trim().toUpperCase(),
    permissions: uniqueTextList(item.permissions),
    serviceUserScopes: uniqueTextList(firstPresent(item.serviceUserScopes, item.service_user_scopes)),
    serviceUserGenerations: (() => {
      const value = firstPresent(item.serviceUserGenerations, item.service_user_generations, {});
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.assign({}, value)
        : {};
    })(),
  };
}

function inquiryPersonName(item = {}) {
  return firstPresent(
    item.personName,
    item.display_name,
    item.target_user_name,
    item.target_user,
    item.service_user_name,
    item.patient_name,
    item.user_name,
    item.person_name,
    item.family_member_name,
    item.guest_name,
    item.actor_name,
    item.requester_name,
    item.name,
    "问询记录",
  );
}

function localizeInquiryRisk(value) {
  const label = String(value || "").trim();
  const normalized = label.toLowerCase();
  if (["emergency", "critical"].some(token => normalized.indexOf(token) >= 0)) return "紧急风险";
  if (normalized.indexOf("high") >= 0) return "高风险";
  if (["medium", "warn"].some(token => normalized.indexOf(token) >= 0)) return "需要关注";
  if (["low", "normal"].some(token => normalized.indexOf(token) >= 0)) return "低风险";
  return label;
}

function inquiryPersonId(item = {}) {
  return firstPresent(
    item.personId,
    item.target_user_id,
    item.service_user_id,
    item.user_id,
    item.person_id,
    item.patient_id,
    item.guest_id,
    item.owner_id,
    "",
  );
}

function inquiryFamilyMemberId(item = {}) {
  return firstPresent(
    item.familyMemberId,
    item.family_member_id,
    item.target_user_id,
    item.service_user_id,
    item.user_id,
    item.person_id,
    item.patient_id,
    "",
  );
}

function inquiryTopic(item = {}) {
  return firstPresent(
    item.title,
    item.topic,
    item.symptoms_summary,
    item.symptomsText,
    item.symptoms_text,
    item.risk_label,
    item.risk_level,
    "AI问询",
  );
}

function inquiryFinalAssessment(item = {}) {
  const extracted = item.extracted_information || item.extractedInformation || {};
  const assessment = item.final_assessment || item.finalAssessment || extracted.final_assessment || extracted.finalAssessment || {};
  if (assessment && typeof assessment === "object") {
    return firstPresent(assessment.summary, assessment.assessment, assessment.conclusion, "");
  }
  return firstPresent(assessment, "");
}

function inquiryActionList(item = {}, key) {
  const extracted = item.extracted_information || item.extractedInformation || {};
  const assessment = item.final_assessment || item.finalAssessment || extracted.final_assessment || extracted.finalAssessment || {};
  const candidates = [
    item[key],
    item[key === "next_steps" ? "nextSteps" : "seekCareIf"],
    assessment && assessment[key],
    assessment && assessment[key === "next_steps" ? "nextSteps" : "seekCareIf"],
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean);
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return [];
}

function inquirySummaryText(item = {}) {
  const parts = [];
  const symptoms = firstPresent(item.symptoms_summary, item.symptomsText, item.symptoms_text);
  const reasoning = firstPresent(item.reasoning_summary, item.reasoningSummary, item.summary, inquiryFinalAssessment(item));
  const reply = firstPresent(item.reply, item.ai_message, item.message);
  if (symptoms) parts.push(symptoms);
  if (reasoning && reasoning !== symptoms) parts.push(reasoning);
  if (reply && reply !== symptoms && reply !== reasoning) parts.push(reply);
  if (!parts.length) {
    const question = firstPresent(item.question, item.user_question, item.transcript, item.prompt);
    if (question) parts.push(question);
  }
  return parts.join("；") || inquiryTopic(item);
}

function normalizeInquiryMessage(item = {}, index = 0) {
  const rawRole = String(item.role || item.sender || item.author || item.from || "").toLowerCase();
  let role = "assistant";
  if (rawRole.indexOf("user") >= 0 || rawRole.indexOf("patient") >= 0 || rawRole.indexOf("family") >= 0 || rawRole.indexOf("visitor") >= 0 || rawRole.indexOf("client") >= 0) {
    role = "user";
  } else if (rawRole.indexOf("system") >= 0) {
    role = "system";
  }
  const content = firstPresent(item.content, item.text, item.message, item.reply, item.transcript, item.value);
  if (!content) return null;
  const roleText = role === "user" ? "用户提问" : role === "system" ? "系统提示" : "AI 回复";
  return {
    id: item.id || item._id || `msg-${index}`,
    role,
    roleText,
    content,
    source: firstPresent(item.source, item.origin),
    createdAt: firstPresent(item.created_at, item.createdAt, item.time, item.timestamp),
  };
}

function inquiryMessages(item = {}) {
  let raw = null;
  for (const candidate of [item.messages, item.conversation, item.dialogue, item.history, item.chat_history, item.turns, item.message_list]) {
    if (Array.isArray(candidate) && candidate.length) {
      raw = candidate;
      break;
    }
    if (candidate && !Array.isArray(candidate)) {
      raw = candidate;
      break;
    }
  }

  let messages = [];
  if (Array.isArray(raw)) {
    messages = raw.map((message, index) => normalizeInquiryMessage(message, index)).filter(Boolean);
  } else if (typeof raw === "string") {
    const text = raw.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          messages = parsed.map((message, index) => normalizeInquiryMessage(message, index)).filter(Boolean);
        }
      } catch (error) {
        const lines = text.split(/\r?\n+/).map(line => line.trim()).filter(Boolean);
        messages = lines.map((content, index) => ({
          id: `msg-${index}`,
          // A legacy plain-text transcript has no trustworthy speaker
          // boundaries. Present it as the original board record instead of
          // inventing alternating family/AI turns.
          role: "system",
          roleText: "药箱原始记录",
          content,
          source: "raw-transcript",
          createdAt: "",
        }));
      }
    }
  } else if (raw && typeof raw === "object") {
    const nested = Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw.items) ? raw.items : [];
    messages = nested.map((message, index) => normalizeInquiryMessage(message, index)).filter(Boolean);
  }

  return messages.slice(-60);
}

function inquiryHasConversation(item = {}) {
  const messageCount = Number(firstPresent(item.messageCount, item.message_count, item.conversation_count, 0));
  if (Number.isFinite(messageCount) && messageCount > 0) return true;
  return [item.messages, item.conversation, item.dialogue, item.history, item.chat_history, item.turns, item.message_list]
    .some(value => Array.isArray(value) ? value.length > 0 : Boolean(value && String(value).trim()));
}

function inquiryLifecycleValue(value) {
  return String(value || "").trim().toLowerCase();
}

function isLegacyInquiryOpening(item = {}) {
  const title = String(firstPresent(item.title, item.topic, item.symptoms_summary, "")).trim();
  const text = String(firstPresent(
    item.reasoning_summary,
    item.reasoningSummary,
    item.summary,
    item.reply,
    item.ai_message,
    inquiryFinalAssessment(item),
    "",
  )).trim();
  const isNewInquiryTitle = /新问询(?:[\s·：:！!？?]*$)/.test(title);
  const isGenericOpening = [
    "您好，今天感觉哪里不舒服呢",
    "今天感觉哪里不舒服呢",
    "请告诉我哪里不舒服",
  ].some(phrase => text.indexOf(phrase) >= 0);
  return isNewInquiryTitle || isGenericOpening;
}

function hasLegacyCareOutcome(item = {}) {
  const risk = inquiryLifecycleValue(firstPresent(
    item.risk_level,
    item.riskLevel,
    item.risk_label,
    item.riskLabel,
    "",
  ));
  const hasKnownRisk = Boolean(risk && ["unknown", "none", "n/a", "未知", "未评估"].indexOf(risk) < 0);
  return Boolean(
    !isLegacyInquiryOpening(item)
    && (hasKnownRisk
    || inquiryActionList(item, "next_steps").length
    || inquiryActionList(item, "seek_care_if").length
    )
  );
}

function shouldShowCaregiverInquiry(item = {}) {
  const record = normalizeInquiryRecord(item);
  const stage = inquiryLifecycleValue(record.stage);
  const nextAction = inquiryLifecycleValue(record.nextAction);
  const hasLifecycle = Boolean(stage || nextAction);
  const terminalStage = ["result", "escalated"];
  const terminalAction = ["show_recommendation", "complete", "escalate"];

  // A synchronised session has authoritative lifecycle state.  Do not let a
  // saved message count or a transport command status make an in-progress
  // dialogue look useful to a caregiver.
  if (hasLifecycle) {
    return terminalStage.indexOf(stage) >= 0 || terminalAction.indexOf(nextAction) >= 0;
  }

  // Command acknowledgements are not a saved consultation. Old persisted
  // rows may lack lifecycle fields, so bridge only a real decision signal
  // (risk or next-step advice), never free-text/message count alone.
  if (record.sourceCommandId) return false;
  return hasLegacyCareOutcome(item);
}

function inquiryDetailLines(item = {}) {
  const lines = [];
  const topic = inquiryTopic(item);
  const symptoms = firstPresent(item.symptoms_summary, item.symptomsText, item.symptoms_text);
  const reasoning = firstPresent(item.reasoning_summary, item.reasoningSummary, item.summary, inquiryFinalAssessment(item));
  const reply = firstPresent(item.reply, item.ai_message);
  const risk = localizeInquiryRisk(firstPresent(item.risk_label, item.riskLevel, item.risk_level));
  const steps = inquiryActionList(item, "next_steps");
  const seekCare = inquiryActionList(item, "seek_care_if");
  if (topic) lines.push({ label: "问询主题", value: topic });
  if (symptoms) lines.push({ label: "主要描述", value: symptoms });
  if (reasoning) lines.push({ label: "AI总结", value: reasoning });
  if (reply && reply !== reasoning) lines.push({ label: "AI回复", value: reply });
  if (risk) lines.push({ label: "风险提示", value: risk });
  if (steps.length) lines.push({ label: "后续建议", value: steps.join("；") });
  if (seekCare.length) lines.push({ label: "建议就医时机", value: seekCare.join("；") });
  return lines;
}

function normalizeInquiryRecord(item = {}) {
  const rawTime = firstPresent(item.updated_at, item.created_at, item.updatedAt, item.createdAt, item.time);
  const personName = inquiryPersonName(item);
  const personId = inquiryPersonId(item);
  const familyMemberId = inquiryFamilyMemberId(item);
  const personaGeneration = firstPresent(item.personaGeneration, item.persona_generation, "");
  const personIdentity = personId || personName;
  const personKey = personaGeneration
    ? `${personIdentity}::${personaGeneration}`
    : personIdentity;
  const topic = inquiryTopic(item);
  const summary = inquirySummaryText(item);
  const riskLabel = localizeInquiryRisk(firstPresent(item.risk_label, item.riskLevel, item.risk_level));
  const stage = firstPresent(item.stage, item.inquiry_stage, "");
  const nextAction = firstPresent(item.next_action, item.nextAction, "");
  const transportedMessageCount = [
    item.messages,
    item.conversation,
    item.dialogue,
    item.history,
    item.chat_history,
    item.turns,
    item.message_list,
  ].reduce((maximum, value) => (
    Array.isArray(value) ? Math.max(maximum, value.length) : maximum
  ), 0);
  const messages = inquiryMessages(item);
  const detailLines = inquiryDetailLines(item);
  const conversationReady = inquiryHasConversation(item);
  const messageCountValue = Number(firstPresent(item.messageCount, item.message_count, messages.length, 0));
  const syncedMessageCountValue = Number(firstPresent(
    item.syncedMessageCount,
    item.synced_message_count,
    messages.length,
    0,
  ));
  const messageCount = Number.isFinite(messageCountValue) && messageCountValue >= 0
    ? messageCountValue
    : messages.length;
  const syncedMessageCount = Number.isFinite(syncedMessageCountValue) && syncedMessageCountValue >= 0
    ? syncedMessageCountValue
    : messages.length;
  const conversationTruncated = item.conversationTruncated === true ||
    item.conversation_truncated === true ||
    transportedMessageCount > messages.length;
  return {
    id: item.id || item._id || item.inquiryId || item.inquiry_id || item.sessionId || item.session_id || `inquiry-${safeId(personName)}-${safeId(rawTime || topic)}`,
    sourceCommandId: firstPresent(item.sourceCommandId, item.source_command_id, ""),
    inquiryId: firstPresent(item.inquiryId, item.inquiry_id, ""),
    sessionId: firstPresent(item.sessionId, item.session_id, ""),
    personId,
    familyMemberId,
    personaGeneration,
    personKey,
    personName,
    topic,
    summary,
    riskLabel,
    riskLevel: firstPresent(item.risk_level, item.riskLevel, ""),
    stage,
    nextAction,
    status: firstPresent(item.status, item.action_status, "done"),
    createdAt: rawTime,
    updatedAt: rawTime,
    messages,
    messageCount,
    syncedMessageCount,
    conversationTruncated,
    detailLines,
    conversationReady,
    hasDetail: Boolean(summary || riskLabel || detailLines.length),
  };
}

const inquiryProcessCache = new Map();
const inquiryProcessCacheKeyLimit = 480;
const inquiryProcessFields = [
  "messages",
  "conversation",
  "dialogue",
  "history",
  "chat_history",
  "turns",
  "message_list",
];

function inquiryIdentityKeys(item = {}, requestDeviceId = "") {
  // Prefer the response's own device identity, then the scope captured when
  // the request began. The active binding may change while a request is in flight.
  const deviceScope = String(firstPresent(item.deviceId, item.device_id, requestDeviceId, appData().deviceId, "unbound"));
  const personaGeneration = String(firstPresent(item.personaGeneration, item.persona_generation, "legacy"));
  const identityScope = `${deviceScope}:${personaGeneration}`;
  return Array.from(new Set([
    item.id,
    item._id,
    item.inquiryId,
    item.inquiry_id,
    item.sessionId,
    item.session_id,
    item.sourceCommandId,
    item.source_command_id,
  ].filter(Boolean).map(value => `${identityScope}:${String(value)}`)));
}

function rememberInquiryProcess(item = {}, requestDeviceId = "") {
  const detail = normalizeInquiryRecord(item);
  if (!detail.messages.length) return;
  inquiryIdentityKeys(Object.assign({}, item, detail), requestDeviceId).forEach(key => {
    inquiryProcessCache.delete(key);
    inquiryProcessCache.set(key, detail);
  });
  // One inquiry can have several aliases. Keep enough alias keys for the
  // complete 60-row mobile history window without evicting recent processes.
  while (inquiryProcessCache.size > inquiryProcessCacheKeyLimit) {
    inquiryProcessCache.delete(inquiryProcessCache.keys().next().value);
  }
}

function cachedInquiryProcess(item = {}, requestDeviceId = "") {
  for (const key of inquiryIdentityKeys(item, requestDeviceId)) {
    if (inquiryProcessCache.has(key)) return inquiryProcessCache.get(key);
  }
  return null;
}

function compactInquiryTransportRows(rows = [], requestDeviceId = "") {
  return (rows || []).map(row => {
    const detail = normalizeInquiryRecord(row);
    if (detail.messages.length) rememberInquiryProcess(row, requestDeviceId);
    const summary = Object.assign({}, row);
    inquiryProcessFields.forEach(field => delete summary[field]);
    summary.messageCount = Math.max(detail.messageCount, detail.messages.length);
    summary.syncedMessageCount = Math.max(detail.syncedMessageCount, detail.messages.length);
    summary.conversationTruncated = detail.conversationTruncated;
    return summary;
  });
}

function groupInquiriesByPerson(inquiries) {
  const map = new Map();
  (inquiries || []).map(normalizeInquiryRecord).forEach(item => {
    const key = item.personKey || item.personId || item.personName || "问询记录";
    if (!map.has(key)) {
      map.set(key, {
        personKey: key,
        personName: key,
        personaGeneration: item.personaGeneration || "",
        count: 0,
        latestAt: "",
        latestSort: 0,
        summary: "",
        inquiries: [],
      });
    }
    const group = map.get(key);
    group.personName = item.personName || group.personName || "问询记录";
    group.personaGeneration = item.personaGeneration || group.personaGeneration || "";
    group.count += 1;
    group.inquiries.push(item);
    const sortValue = parseTime(item.updatedAt || item.createdAt || "");
    if (sortValue >= group.latestSort) {
      group.latestSort = sortValue;
      group.latestAt = item.updatedAt || item.createdAt || "";
      group.summary = item.summary;
    }
  });
  return Array.from(map.values())
    .map(group => Object.assign(group, {
      inquiries: group.inquiries.sort((a, b) => parseTime(b.updatedAt || b.createdAt || "") - parseTime(a.updatedAt || a.createdAt || "")),
    }))
    .sort((a, b) => b.latestSort - a.latestSort);
}

function inquiryMatchesPersonScope(value = {}, scope = {}, options = {}) {
  const personId = String(scope.personId || scope.person_id || "").trim();
  if (!personId) return true;
  const item = value.personId !== undefined && value.personKey !== undefined
    ? value
    : normalizeInquiryRecord(value);
  if (String(item.personId || "") !== personId) return false;
  const personaGeneration = String(scope.personaGeneration || scope.persona_generation || "").trim();
  const itemGeneration = String(item.personaGeneration || "").trim();
  if (options.strictGeneration === true) return itemGeneration === personaGeneration;
  if (!personaGeneration) return true;
  return itemGeneration === personaGeneration;
}

function shouldShowInquiryForServiceUsers(value = {}, serviceUsers = []) {
  const item = value.personId !== undefined && value.personKey !== undefined
    ? value
    : normalizeInquiryRecord(value);
  const personId = String(item.personId || "").trim();
  if (!personId) return true;

  const matchingUsers = (serviceUsers || [])
    .map(compactServiceUser)
    .filter(user => String(user.id || "") === personId);
  if (!matchingUsers.length) return true;

  const personaGeneration = String(item.personaGeneration || "").trim();
  if (!personaGeneration) {
    const hasArchived = matchingUsers.some(user => user.archived === true);
    const hasActive = matchingUsers.some(user => user.archived !== true);
    if (hasArchived && hasActive) return false;
    return hasActive;
  }
  const exactGeneration = matchingUsers.filter(user => (
    String(user.personaGeneration || "").trim() === personaGeneration
  ));
  if (!exactGeneration.length) return false;
  return exactGeneration.every(user => user.archived !== true);
}

function inquiryFromAiCommand(command = {}) {
  if (command.type !== "AI_CHAT") return null;
  const payload = command.payload || {};
  const result = command.result || {};
  const commandId = command._id || command.id || command.commandId || "";
  const sessionId = firstPresent(result.session_id, result.sessionId, payload.session_id, payload.sessionId, "");
  const inquiryId = firstPresent(result.inquiry_id, result.inquiryId, sessionId, commandId);
  const question = firstPresent(payload.question, payload.message, payload.prompt, "");
  const reply = firstPresent(
    result.reply,
    result.answer,
    result.ai_message,
    result.message,
    result.content,
    result.text,
    result.summary,
    result.error,
    "",
  );
  const createdAt = firstPresent(command.createdAt, command.created_at, command.updatedAt, nowText());
  const updatedAt = firstPresent(command.updatedAt, command.updated_at, createdAt);
  // Command acknowledgements are transport feedback, not a saved dialogue.
  // The detail endpoint is the only source that can show the real process.
  const messageCount = firstPresent(result.messageCount, result.message_count, 0);
  const syncedMessageCount = firstPresent(result.syncedMessageCount, result.synced_message_count, 0);
  const conversationTruncated = result.conversationTruncated === true || result.conversation_truncated === true;
  return {
    _id: `command-${commandId}`,
    inquiry_id: inquiryId,
    session_id: sessionId,
    sourceCommandId: commandId,
    target_user_id: firstPresent(result.target_user_id, result.service_user_id, result.user_id, result.person_id, result.patient_id, payload.target_user_id, payload.service_user_id, payload.user_id, payload.person_id, payload.patient_id, ""),
    service_user_id: firstPresent(result.service_user_id, result.target_user_id, payload.service_user_id, ""),
    user_id: firstPresent(result.user_id, payload.user_id, ""),
    person_id: firstPresent(result.person_id, payload.person_id, ""),
    patient_id: firstPresent(result.patient_id, payload.patient_id, ""),
    persona_generation: firstPresent(result.persona_generation, result.personaGeneration, payload.persona_generation, payload.personaGeneration, ""),
    display_name: firstPresent(result.target_user_name, result.service_user_name, result.user_name, result.patient_name, result.person_name, payload.target_user_name, payload.service_user_name, payload.user_name, payload.patient_name, payload.person_name, ""),
    target_user_name: firstPresent(result.target_user_name, result.service_user_name, result.user_name, result.patient_name, result.person_name, payload.target_user_name, payload.user_name, payload.patient_name, "问询记录"),
    title: question || "AI问询",
    topic: question || "AI问询",
    symptoms_summary: question || "AI问询",
    reasoning_summary: firstPresent(result.reasoning_summary, result.summary, ""),
    reply,
    ai_message: reply,
    risk_label: firstPresent(result.risk_label, result.riskLevel, result.risk_level, ""),
    risk_level: firstPresent(result.risk_level, result.riskLevel, ""),
    final_assessment: firstPresent(result.final_assessment, result.finalAssessment, {}),
    next_steps: firstPresent(result.next_steps, result.nextSteps, []),
    seek_care_if: firstPresent(result.seek_care_if, result.seekCareIf, []),
    stage: firstPresent(result.stage, result.inquiry_stage, ""),
    next_action: firstPresent(result.next_action, result.nextAction, ""),
    status: firstPresent(result.inquiry_status, result.stage, command.status, "pending"),
    messages: [],
    messageCount,
    syncedMessageCount,
    conversationTruncated,
    created_at: createdAt,
    updated_at: updatedAt,
    createdAt,
    updatedAt,
  };
}

function mergeInquirySources(...sources) {
  const map = {};
  const rows = [];
  sources.forEach(source => {
    (source || []).forEach(row => rows.push(row));
  });
  rows.filter(Boolean).forEach(row => {
    const item = normalizeInquiryRecord(row);
    // A command acknowledgement and the saved session describe the same
    // inquiry. Session identity must win over the transport command id.
    const baseKey = String(firstPresent(item.sessionId, item.inquiryId, item.sourceCommandId, item.id));
    const key = item.personaGeneration ? `${baseKey}::${item.personaGeneration}` : baseKey;
    const current = map[key];
    const currentIsSavedSession = Boolean(current && !current.sourceCommandId);
    const nextIsSavedSession = !item.sourceCommandId;
    const currentMessages = current
      ? Math.max(Number(current.messageCount) || 0, (current.messages || []).length)
      : 0;
    const nextMessages = Math.max(Number(item.messageCount) || 0, (item.messages || []).length);
    const currentTime = parseTime(current && (current.updatedAt || current.createdAt)) || 0;
    const nextTime = parseTime(item.updatedAt || item.createdAt) || 0;
    if (!current ||
      (!currentIsSavedSession && nextIsSavedSession) ||
      (currentIsSavedSession === nextIsSavedSession &&
        (nextMessages > currentMessages || (nextMessages === currentMessages && nextTime >= currentTime)))) {
      map[key] = item;
    }
  });
  return Object.keys(map)
    .map(key => map[key])
    .sort((a, b) => (parseTime(b.updatedAt || b.createdAt) || 0) - (parseTime(a.updatedAt || a.createdAt) || 0));
}

function buildSlots(medicines) {
  const map = {};
  medicines.forEach(item => {
    const medicine = normalizeMedicine(item);
    map[medicine.slot] = medicine;
  });
  return Array.from({ length: CABINET_SLOT_COUNT }, (_, index) => {
    const slot = index + 1;
    return map[slot] || {
      deviceId: appData().deviceId,
      slot,
      name: "",
      spec: "",
      quantity: 0,
      expireDate: "",
      lowStockLine: 0,
    };
  });
}

function cloudFailToast(err) {
  console.warn("cloud api failed", err);
  wx.showToast({ title: "云端未就绪", icon: "none" });
}

async function getDevice(deviceIdOverride = "") {
  const requestDeviceId = firstPresent(deviceIdOverride, appData().deviceId);
  return getDeviceStrict(requestDeviceId);
}

async function getDeviceStrict(deviceIdOverride = "") {
  const requestDeviceId = firstPresent(deviceIdOverride, appData().deviceId);
  const data = await cloudAction("GET_DEVICE", {}, requestDeviceId);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const error = new Error("药箱状态暂不可用");
    error.code = "DEVICE_SNAPSHOT_INVALID";
    throw error;
  }
  const responseDeviceId = String(firstPresent(data.deviceId, data.device_id, data._id, "")).trim();
  if (!responseDeviceId || responseDeviceId !== String(requestDeviceId)) {
    const error = new Error("药箱状态返回范围不一致");
    error.code = "DEVICE_SCOPE_MISMATCH";
    throw error;
  }
  return normalizeDevice(data, requestDeviceId);
}

async function getCapabilitiesStrict(deviceIdOverride = "") {
  const requestDeviceId = firstPresent(deviceIdOverride, appData().deviceId);
  const data = await cloudAction("PING", {}, requestDeviceId, { accountScoped: true });
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("cloud capabilities unavailable");
  }
  const capabilities = data.capabilities && typeof data.capabilities === "object" && !Array.isArray(data.capabilities)
    ? data.capabilities
    : {};
  const snapshot = {
    schemaVersion: firstPresent(data.schemaVersion, data.schema_version, ""),
    schemaRevision: firstPresent(data.schemaRevision, data.schema_revision, ""),
    capabilities,
  };
  return Object.assign(snapshot, { compatibility: evaluateCompatibility(snapshot) });
}

async function getMyDevicesStrict() {
  const data = await cloudAction("GET_MY_DEVICES", {}, "", { accountScoped: true });
  const items = Array.isArray(data)
    ? data
    : (data && Object.prototype.hasOwnProperty.call(data, "items") ? data.items : null);
  if (!Array.isArray(items)) {
    throw new Error("授权药箱列表格式异常");
  }
  const normalized = items.map(normalizeAuthorizedDevice);
  if (normalized.some(item => !item)) {
    throw new Error("授权药箱记录缺少 deviceId");
  }
  const seen = new Set();
  return {
    items: normalized.filter(item => {
      if (seen.has(item.deviceId)) return false;
      seen.add(item.deviceId);
      return true;
    }),
  };
}

async function redeemDevicePairingCodeStrict(pairingCode) {
  const code = String(pairingCode || "").trim();
  if (!code) {
    const error = new Error("请输入一次性配对码");
    error.code = "PAIRING_CODE_REQUIRED";
    throw error;
  }
  const data = await cloudAction(
    "REDEEM_DEVICE_PAIRING_CODE",
    { pairingCode: code },
    "",
    { accountScoped: true },
  );
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("药箱配对结果格式异常");
  }
  const normalized = normalizeAuthorizedDevice(data);
  if (!normalized) throw new Error("药箱配对结果缺少 deviceId");
  return normalized;
}

async function getMedicationSafetyEventsStrict(options = {}) {
  const requestDeviceId = firstPresent(options.deviceId, appData().deviceId);
  const request = {
    limit: Math.min(Math.max(Number(options.limit) || 20, 1), 50),
  };
  if (options.personId) request.personId = options.personId;
  if (options.checkStatus) request.checkStatus = options.checkStatus;
  if (options.unreadOnly === true) request.unreadOnly = true;
  if (options.cursor) request.cursor = options.cursor;
  const data = await cloudAction("LIST_MEDICATION_SAFETY_EVENTS", request, requestDeviceId);
  const items = Array.isArray(data)
    ? data
    : firstPresent(data && data.items, data && data.events, data && data.rows);
  if (!Array.isArray(items)) {
    throw new Error("medication safety event list unavailable");
  }
  return {
    items,
    nextCursor: firstPresent(data && data.nextCursor, data && data.next_cursor, ""),
  };
}

async function getMedicationSafetyEventDetail(eventId, options = {}) {
  const id = String(eventId || "").trim();
  if (!id) throw new Error("medication safety event id is required");
  const requestDeviceId = firstPresent(options.deviceId, appData().deviceId);
  const data = await cloudAction("GET_MEDICATION_SAFETY_EVENT", { eventId: id }, requestDeviceId);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("medication safety event detail unavailable");
  }
  return data;
}

async function markMedicationSafetyEventRead(eventId, options = {}) {
  const id = String(eventId || "").trim();
  if (!id) throw new Error("medication safety event id is required");
  const requestDeviceId = firstPresent(options.deviceId, appData().deviceId);
  const data = await cloudAction("MARK_MEDICATION_SAFETY_EVENT_READ", { eventId: id }, requestDeviceId);
  return validateMedicationSafetyEventReadReceipt(data, id);
}

async function getMedicines(deviceIdOverride = "") {
  try {
    return await getMedicinesStrict(deviceIdOverride);
  } catch (err) {
    cloudFailToast(err);
    return [];
  }
}

function validateMedicineSnapshotEnvelope(data, requestDeviceId) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("medicine manifest unavailable");
  }
  const protocol = String(firstPresent(data.boardMedicineSnapshot, data.board_medicine_snapshot, ""));
  const manifestProtocol = String(data.protocol || "").trim();
  const kind = String(data.kind || "").trim();
  const canonicalDigestVersion = String(firstPresent(
    data.canonicalDigestVersion,
    data.canonical_digest_version,
    "",
  )).trim();
  const snapshotId = String(firstPresent(data.snapshotId, data.snapshot_id, "")).trim();
  const revision = Number(firstPresent(data.revision, data.snapshotRevision, data.snapshot_revision, 0));
  const digest = String(data.digest || "").trim().toLowerCase();
  const rows = data.rows;
  const responseDeviceId = String(firstPresent(data.deviceId, data.device_id, "")).trim();
  if (protocol !== "v1"
      || manifestProtocol !== "boardMedicineSnapshot:v1"
      || kind !== "medicines"
      || canonicalDigestVersion !== "jcs-sha256-v1"
      || data.snapshotComplete !== true
      || !snapshotId
      || !Number.isInteger(revision)
      || revision < 1
      || !/^[a-f0-9]{64}$/.test(digest)
      || !Array.isArray(rows)
      || Number(data.rowCount) !== rows.length
      || responseDeviceId !== String(requestDeviceId)) {
    const error = new Error("medicine manifest is incomplete");
    error.code = "MEDICINE_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  return {
    boardMedicineSnapshot: "v1",
    protocol: manifestProtocol,
    deviceId: responseDeviceId,
    kind,
    snapshotId,
    revision,
    digest,
    canonicalDigestVersion,
    snapshotComplete: true,
    rowCount: rows.length,
    finalizedAt: String(data.finalizedAt || ""),
    rows,
  };
}

async function getMedicineSnapshotStrict(deviceIdOverride = "") {
  const requestDeviceId = firstPresent(deviceIdOverride, appData().deviceId);
  const session = appData().deviceSession || {};
  const compatibility = session.compatibility || (
    session.schemaRevision || session.schemaVersion
      ? evaluateCompatibility(session)
      : null
  );
  if (compatibility && compatibility.compatible === false) {
    const error = new Error(compatibility.reason || "云端版本待升级");
    error.code = "CLOUD_VERSION_INCOMPATIBLE";
    throw error;
  }
  const data = await cloudAction("GET_MEDICINE_SNAPSHOT", {}, requestDeviceId);
  const envelope = validateMedicineSnapshotEnvelope(data, requestDeviceId);
  const rows = envelope.rows.map(item => normalizeMedicine(
    Object.assign({ deviceId: requestDeviceId }, item),
    { strictManifest: true },
  ));
  if (new Set(rows.map(item => item.medicineId)).size !== rows.length) {
    const error = new Error("medicine manifest contains duplicate identities");
    error.code = "MEDICINE_SNAPSHOT_CONFLICT";
    throw error;
  }
  return Object.assign({}, envelope, { rows });
}

async function getMedicinesStrict(deviceIdOverride = "") {
  return (await getMedicineSnapshotStrict(deviceIdOverride)).rows;
}

async function getCabinetSlots(deviceIdOverride = "") {
  const medicines = await getMedicines(deviceIdOverride);
  return buildSlots(medicines);
}

async function getCabinetSlotsStrict(deviceIdOverride = "") {
  const medicines = await getMedicinesStrict(deviceIdOverride);
  return buildSlots(medicines);
}

async function getLatestVitals(deviceIdOverride = "") {
  try {
    return await getLatestVitalsStrict(deviceIdOverride);
  } catch (err) {
    cloudFailToast(err);
    return null;
  }
}

async function getLatestVitalsStrict(deviceIdOverride = "") {
  const requestDeviceId = firstPresent(deviceIdOverride, appData().deviceId);
  const data = await cloudAction("GET_LATEST_VITALS", {}, requestDeviceId);
  return normalizeVitals(data);
}

async function getRecentVitals(limit = 50, deviceIdOverride = "") {
  try {
    return await getRecentVitalsStrict(limit, deviceIdOverride);
  } catch (err) {
    return [];
  }
}

async function getRecentVitalsStrict(limit = 50, deviceIdOverride = "") {
  const requestDeviceId = firstPresent(deviceIdOverride, appData().deviceId);
  const data = await cloudAction("LIST_VITALS", { limit }, requestDeviceId);
  if (!Array.isArray(data)) {
    throw new Error("vitals snapshot unavailable");
  }
  return data.map(normalizeVitals).filter(Boolean);
}

async function getRecentRecords(limit = 10, deviceIdOverride = "") {
  try {
    return await getRecentRecordsStrict(limit, deviceIdOverride);
  } catch (err) {
    return [];
  }
}

async function getRecentRecordsStrict(limit = 10, deviceIdOverride = "") {
  const requestDeviceId = firstPresent(deviceIdOverride, appData().deviceId);
  const data = await cloudAction("LIST_RECORDS", { limit }, requestDeviceId);
  if (!Array.isArray(data)) {
    throw new Error("records snapshot unavailable");
  }
  return data;
}

async function getRecentCommands(limit = 10, deviceIdOverride = "") {
  try {
    return await getRecentCommandsStrict(limit, deviceIdOverride);
  } catch (err) {
    return [];
  }
}

async function getRecentCommandsStrict(limit = 10, deviceIdOverride = "") {
  const requestDeviceId = firstPresent(deviceIdOverride, appData().deviceId);
  const data = await cloudAction("LIST_COMMANDS", { limit }, requestDeviceId);
  if (!Array.isArray(data)) {
    throw new Error("commands snapshot unavailable");
  }
  return data;
}

async function getRecentInquiries(limit = 50, options = {}) {
  const requestDeviceId = firstPresent(options.deviceId, appData().deviceId);
  try {
    return await getRecentInquiriesStrict(limit, Object.assign({}, options, { deviceId: requestDeviceId }));
  } catch (err) {
    const [device, commands] = await Promise.all([
      getDevice(requestDeviceId),
      getRecentCommands(Math.min(Number(limit) || 50, 50), requestDeviceId),
    ]);
    const summary = (device && device.syncSummary) || {};
    const commandInquiries = (commands || []).map(inquiryFromAiCommand).filter(Boolean);
    return mergeInquirySources(
      compactInquiryTransportRows(summary.recentInquiries || [], requestDeviceId),
      commandInquiries,
    ).slice(0, limit);
  }
}

async function getRecentInquiriesStrict(limit = 50, options = {}) {
  const requestDeviceId = firstPresent(options.deviceId, appData().deviceId);
  const data = await cloudAction("LIST_INQUIRIES", {
    limit,
    includeMessages: options.includeMessages === true,
  }, requestDeviceId);
  return mergeInquirySources(compactInquiryTransportRows(data || [], requestDeviceId));
}

async function getInquiryDetail(record = {}, options = {}) {
  const requestDeviceId = firstPresent(options.deviceId, appData().deviceId);
  const cached = cachedInquiryProcess(record, requestDeviceId);
  try {
    const data = await cloudAction("GET_INQUIRY_DETAIL", {
      id: record.id,
      inquiryId: record.inquiryId,
      sessionId: record.sessionId,
      sourceCommandId: record.sourceCommandId,
      includeMessages: true,
    }, requestDeviceId);
    if (data) rememberInquiryProcess(data, requestDeviceId);
    return normalizeInquiryRecord(data || cached || record);
  } catch (error) {
    if (cached) return normalizeInquiryRecord(cached);
    throw error;
  }
}

async function addCommand(type, payload = {}, options = {}) {
  const normalizedType = String(type || "").trim().toUpperCase();
  if (["OPEN_CABINET", "DISPENSE", "UPSERT_MEDICINE"].includes(normalizedType)
      || normalizedType.indexOf("LIGHT") >= 0) {
    const error = new Error("this physical medicine action is not available remotely");
    error.code = "REMOTE_MEDICINE_ACTION_FORBIDDEN";
    throw error;
  }
  const session = appData().deviceSession || {};
  const capabilities = session.capabilities || {};
  const remoteCommands = String(
    capabilities.remoteCommands || capabilities.remote_commands || "",
  ).trim().toLowerCase();
  if (remoteCommands !== "v1" && remoteCommands !== "1") {
    const error = new Error("remote commands are not enabled by the current cloud release");
    error.code = "REMOTE_COMMANDS_DISABLED";
    throw error;
  }
  const requestId = options.requestId || payload.request_id || payload.requestId || "";
  const result = await cloudAction("CREATE_COMMAND", { type, payload, requestId }, options.deviceId);
  const status = String((result && result.status) || "").toLowerCase();
  const commandId = result && firstPresent(result._id, result.id, result.commandId, result.command_id);
  if (!result || typeof result !== "object" || !commandId) {
    throw new Error("command submission returned no result");
  }
  if (status === "failed" || status === "error" || status === "rejected") {
    throw new Error((result && result.error) || "command submission failed");
  }
  return result;
}

function medicationReminderPayload(plan = {}, extra = {}) {
  const requestId = extra.requestId || `remind-${Date.now()}-${safeId(plan.id || plan._id || plan.time || "manual")}`;
  const targetName = firstPresent(
    plan.target_user_name,
    plan.target_user,
    plan.targetUser,
    plan.user_name,
    plan.person_name,
    plan.name,
    "老人",
  );
  const medicineName = plan.medicine || plan.medicine_name || plan.name || "";
  const text = extra.text || extra.speakText || `${targetName}请及时用药。`;
  const serviceUserId = firstPresent(plan.service_user_id, plan.target_user_id, plan.user_id, plan.person_id);
  return {
    request_id: requestId,
    reminder_kind: "missed_medication",
    plan_id: plan.id || plan._id || "",
    plan_time: plan.time || "",
    medicine_name: medicineName,
    target_user_id: serviceUserId,
    service_user_id: serviceUserId,
    target_user_name: targetName,
    text,
    message: text,
    volume: Number(extra.volume || 230),
    tts_mode: extra.ttsMode || "auto",
    actor_name: extra.actorName || "家属端",
    reason: extra.reason || "计划用药未确认，家属端发起远程提醒",
  };
}

async function requestMedicationReminder(plan = {}, extra = {}) {
  const payload = medicationReminderPayload(plan, extra);
  return addCommand("AUDIO_SPEAK", payload, {
    requestId: payload.request_id,
    deviceId: extra.deviceId,
  });
}

async function getSnapshot(options = {}) {
  const requestDeviceId = firstPresent(options.deviceId, appData().deviceId);
  return getSnapshotStrict(Object.assign({}, options, { deviceId: requestDeviceId }));
}

async function getSnapshotStrict(options = {}) {
  const requestDeviceId = firstPresent(options.deviceId, appData().deviceId);
  const inquiryLimit = Math.min(Number(options.inquiryLimit) || 30, 60);
  const includeMessages = options.includeInquiryMessages === true;
  const data = await cloudAction("GET_SNAPSHOT", { limit: inquiryLimit, includeMessages }, requestDeviceId);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("care snapshot unavailable");
  }
  const [inquiries, commands] = await Promise.all([
    getRecentInquiriesStrict(inquiryLimit, { includeMessages, deviceId: requestDeviceId }),
    getRecentCommandsStrict(50, requestDeviceId),
  ]);
  return Object.assign({}, data, {
    serviceUsersSnapshotComplete: data.serviceUsersSnapshotComplete === true
      || data.service_users_snapshot_complete === true,
    serviceUsers: (data.serviceUsers || data.service_users || []).map(compactServiceUser),
    plans: (data.plans || data.today_plans || []).map(compactPlan),
    inquiries: mergeInquirySources(
      compactInquiryTransportRows(data.inquiries || [], requestDeviceId),
      inquiries,
    ),
    commands,
  });
}

module.exports = {
  COLLECTIONS,
  nowText,
  compactServiceUser,
  compactPlan,
  planMatchesServiceUser,
  shouldShowPlanForServiceUsers,
  medicineDocId,
  buildSlots,
  normalizeMedicine,
  normalizeVitals,
  normalizeInquiryRecord,
  inquiryFromAiCommand,
  mergeInquirySources,
  inquiryPersonId,
  inquiryPersonName,
  inquiryTopic,
  inquirySummaryText,
  inquiryMessages,
  inquiryDetailLines,
  inquiryHasConversation,
  shouldShowCaregiverInquiry,
  groupInquiriesByPerson,
  inquiryMatchesPersonScope,
  shouldShowInquiryForServiceUsers,
  expiryInfo,
  buildHeader,
  isDeviceOnline,
  cloudAction,
  getDevice,
  getDeviceStrict,
  getCapabilitiesStrict,
  getMyDevicesStrict,
  redeemDevicePairingCodeStrict,
  getMedicationSafetyEventsStrict,
  getMedicationSafetyEventDetail,
  markMedicationSafetyEventRead,
  getMedicines,
  getMedicineSnapshotStrict,
  getMedicinesStrict,
  getCabinetSlots,
  getCabinetSlotsStrict,
  getLatestVitals,
  getLatestVitalsStrict,
  getRecentVitals,
  getRecentVitalsStrict,
  getRecentRecords,
  getRecentRecordsStrict,
  getRecentCommands,
  getRecentCommandsStrict,
  getRecentInquiries,
  getRecentInquiriesStrict,
  getInquiryDetail,
  getSnapshot,
  getSnapshotStrict,
  addCommand,
  requestMedicationReminder,
};
