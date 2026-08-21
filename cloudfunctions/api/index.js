const cloud = require("wx-server-sdk");
const {
  canonicalPayloadDigest,
  createMedicationSafetyEventModule,
} = require("./medicationSafetyEvents");
const { createMembershipModule } = require("./memberships");
const { createSnapshotStore } = require("./snapshotStore");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const schemaRevision = "3.0-three-box-library";
const capabilities = Object.freeze({
  snapshotBatch: "v2",
  snapshotFencing: "v1",
  snapshotCanonicalDigest: "jcs-sha256-v1",
  boardMedicineSnapshot: "v1",
  explicitInventoryState: "v1",
  medicineStorageBoxes: "v1",
  caregiverMembership: "v1",
});

const collections = {
  devices: "devices",
  medicines: "medicines",
  vitals: "vitals",
  records: "records",
  commands: "commands",
  serviceUsers: "service_users",
  plans: "today_plans",
  inquiries: "inquiries",
  medicationSafetyEvents: "medication_safety_events",
  caregiverEventReceipts: "caregiver_event_receipts",
  caregiverNotificationOutbox: "caregiver_notification_outbox",
  caregiverNotificationSubscriptions: "caregiver_notification_subscriptions",
  deviceMemberships: "device_memberships",
  devicePairingCodes: "device_pairing_codes",
  snapshotHeads: "snapshot_heads",
  snapshotSessions: "snapshot_sessions",
  snapshotRows: "snapshot_rows",
  snapshotManifests: "snapshot_manifests",
};

const memberships = createMembershipModule({
  db,
  collections,
  nowText,
  nowEpochMs: () => Date.now(),
});
const medicationSafetyEvents = createMedicationSafetyEventModule({
  db,
  collections,
  memberships,
  nowText,
  safeId,
});
const snapshots = createSnapshotStore({
  db,
  collections,
  nowText,
  nowEpochMs: () => Date.now(),
});

const boardActions = new Set([
  "REPORT_DEVICE",
  "UPLOAD_MEDICINES",
  "UPLOAD_VITALS",
  "UPLOAD_RECORD",
  "UPLOAD_SNAPSHOT",
  "BEGIN_SNAPSHOT",
  "UPSERT_SNAPSHOT_BATCH",
  "FINALIZE_SNAPSHOT",
  "ABORT_SNAPSHOT",
  "GET_BOARD_MEDICINE_MANIFEST",
  "PULL_COMMANDS",
  "ACK_COMMAND",
]);

const readActions = new Set([
  "GET_DEVICE",
  "GET_MEDICINE_SNAPSHOT",
  "LIST_MEDICINES",
  "GET_LATEST_VITALS",
  "LIST_VITALS",
  "LIST_RECORDS",
  "LIST_COMMANDS",
  "LIST_INQUIRIES",
  "GET_INQUIRY_DETAIL",
  "GET_SNAPSHOT",
  "LIST_MEDICATION_SAFETY_EVENTS",
  "GET_MEDICATION_SAFETY_EVENT",
  "MARK_MEDICATION_SAFETY_EVENT_READ",
]);

const readActionPermissions = Object.freeze({
  GET_LATEST_VITALS: "READ_VITALS",
  GET_INQUIRY_DETAIL: "READ_INQUIRY",
  GET_MEDICINE_SNAPSHOT: "READ_MEDICINE",
  LIST_MEDICINES: "READ_MEDICINE",
  LIST_COMMANDS: "CREATE_COMMAND",
  LIST_INQUIRIES: "READ_INQUIRY",
  LIST_RECORDS: "READ_RECORD",
  LIST_VITALS: "READ_VITALS",
});

const releaseAPersonaReadActions = new Set([
  "GET_LATEST_VITALS",
  "LIST_VITALS",
  "LIST_RECORDS",
  "LIST_COMMANDS",
  "LIST_INQUIRIES",
  "GET_INQUIRY_DETAIL",
  "GET_SNAPSHOT",
  "LIST_MEDICATION_SAFETY_EVENTS",
  "GET_MEDICATION_SAFETY_EVENT",
  "MARK_MEDICATION_SAFETY_EVENT_READ",
]);

const allowedCommandTypes = new Set([
  "AUDIO_BEEP",
  "AUDIO_SPEAK",
  "READ_VITALS_ALL",
  "AI_CHAT",
  "UPSERT_SERVICE_USER",
  "UPSERT_TODAY_PLAN",
]);

const releaseADeviceReportFields = Object.freeze([
  "name",
  "displayName",
  "display_name",
  "network",
  "networkType",
  "network_type",
  "signal",
  "signalStrength",
  "signal_strength",
  "ip",
  "ipAddress",
  "ip_address",
  "localApi",
  "local_api",
  "cloudAgent",
  "cloud_agent",
  "board",
  "stm32",
  "schemaVersion",
  "schema_version",
  "schemaRevision",
  "schema_revision",
  "agentVersion",
  "agent_version",
  "appVersion",
  "app_version",
  "firmwareVersion",
  "firmware_version",
  "uptimeSeconds",
  "uptime_seconds",
]);

function nowText() {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = value => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function cleanData(value) {
  const result = Object.assign({}, value || {});
  delete result._id;
  delete result._openid;
  delete result.deviceSecret;
  return result;
}

function releaseADeviceReport(data = {}) {
  return releaseADeviceReportFields.reduce((result, field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) result[field] = data[field];
    return result;
  }, {});
}

function compactTextList(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.map(item => String(item || "").trim()).filter(Boolean).slice(0, 3);
    }
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return [];
}

function compactInquiryCare(row = {}) {
  const extracted = row.extracted_information || row.extractedInformation || {};
  const assessment = row.final_assessment
    || row.finalAssessment
    || extracted.final_assessment
    || extracted.finalAssessment
    || {};
  return {
    summary: firstPresent(
      row.reasoning_summary,
      row.reasoningSummary,
      row.summary,
      assessment.summary,
      "",
    ),
    next_steps: compactTextList(
      row.next_steps,
      row.nextSteps,
      assessment.next_steps,
      assessment.nextSteps,
    ),
    seek_care_if: compactTextList(
      row.seek_care_if,
      row.seekCareIf,
      assessment.seek_care_if,
      assessment.seekCareIf,
    ),
  };
}

function inquiryMessageCount(row = {}, sourceMessages = []) {
  const declared = Number(firstPresent(row.messageCount, row.message_count, ""));
  const declaredCount = Number.isInteger(declared) && declared >= 0 ? declared : 0;
  return Math.max(sourceMessages.length, declaredCount);
}

function compactInquiryMessage(message = {}, index = 0) {
  return {
    id: firstPresent(message.id, message._id, `msg-${index}`),
    role: firstPresent(message.role, message.sender, ""),
    content: firstPresent(message.content, message.text, message.message, ""),
    source: firstPresent(message.source, message.origin, ""),
    created_at: firstPresent(message.created_at, message.createdAt, message.time, ""),
  };
}

function compactInquiryForClient(row = {}, options = {}) {
  const includeMessages = options.includeMessages === true;
  const sourceMessages = Array.isArray(row.messages) ? row.messages : [];
  const care = compactInquiryCare(row);
  const messages = includeMessages
    ? sourceMessages.map(compactInquiryMessage).filter(item => item.content).slice(-80)
    : [];
  return {
    _id: firstPresent(row._id, ""),
    deviceId: firstPresent(row.deviceId, row.device_id, ""),
    inquiry_id: firstPresent(row.inquiry_id, row.session_id, row._id, ""),
    session_id: firstPresent(row.session_id, row.inquiry_session_id, ""),
    sourceCommandId: firstPresent(row.sourceCommandId, row.source_command_id, ""),
    target_user_id: firstPresent(
      row.target_user_id,
      row.service_user_id,
      row.user_id,
      row.person_id,
      row.patient_id,
      "",
    ),
    service_user_id: firstPresent(row.service_user_id, row.target_user_id, ""),
    user_id: firstPresent(row.user_id, ""),
    person_id: firstPresent(row.person_id, ""),
    patient_id: firstPresent(row.patient_id, ""),
    service_user_name_snapshot: firstPresent(
      row.service_user_name_snapshot,
      row.service_user_name,
      row.target_user_name,
      "",
    ),
    display_name: firstPresent(
      row.service_user_name_snapshot,
      row.target_user_name,
      row.service_user_name,
      row.patient_name,
      row.user_name,
      row.person_name,
      "",
    ),
    target_user_name: firstPresent(
      row.target_user_name,
      row.service_user_name_snapshot,
      row.patient_name,
      row.user_name,
      "家庭成员",
    ),
    persona_generation: firstPresent(row.persona_generation, row.personaGeneration, ""),
    identity_kind: firstPresent(row.identity_kind, row.identityKind, ""),
    title: firstPresent(row.title, row.topic, row.symptoms_summary, "AI 问询"),
    topic: firstPresent(row.topic, row.title, row.symptoms_summary, "AI 问询"),
    symptoms_summary: firstPresent(
      row.symptoms_summary,
      row.symptomsText,
      row.symptoms_text,
      row.title,
      "",
    ),
    reasoning_summary: care.summary,
    reply: firstPresent(row.reply, row.ai_message, row.message, ""),
    ai_message: firstPresent(row.ai_message, row.reply, ""),
    risk_label: firstPresent(row.risk_label, row.riskLevel, row.risk_level, ""),
    risk_level: firstPresent(row.risk_level, row.riskLevel, ""),
    final_assessment: care,
    next_steps: care.next_steps,
    seek_care_if: care.seek_care_if,
    status: firstPresent(row.status, row.action_status, "done"),
    stage: firstPresent(row.stage, row.inquiry_stage, ""),
    next_action: firstPresent(row.next_action, row.nextAction, ""),
    messageCount: inquiryMessageCount(row, sourceMessages),
    syncedMessageCount: Number(firstPresent(
      row.syncedMessageCount,
      row.synced_message_count,
      sourceMessages.length,
      0,
    )) || 0,
    conversationTruncated: row.conversationTruncated === true || row.conversation_truncated === true,
    messages,
    created_at: firstPresent(row.created_at, row.createdAt, ""),
    updated_at: firstPresent(row.updated_at, row.updatedAt, row.created_at, row.createdAt, ""),
    createdAt: firstPresent(row.created_at, row.createdAt, ""),
    updatedAt: firstPresent(row.updated_at, row.created_at, row.updatedAt, row.createdAt, ""),
    syncOwner: firstPresent(row.syncOwner, ""),
  };
}

function archivedValue(row = {}) {
  return row.archived === true
    || Number(row.archived) === 1
    || String(row.archived || "").toLowerCase() === "true";
}

function compactSummaryUser(user = {}) {
  const archived = archivedValue(user);
  const lifecycle = {
    id: firstPresent(user.id, user.user_id, user._id, user.service_user_id, ""),
    name: firstPresent(user.name, user.user_name, user.nickname, user.display_name, "家庭成员"),
    persona_generation: firstPresent(user.persona_generation, user.personaGeneration, "legacy"),
    archived,
    profile_version: firstPresent(user.profile_version, user.profileVersion, ""),
    persona_revision: firstPresent(user.persona_revision, user.personaRevision, ""),
    archived_at: firstPresent(user.archived_at, user.archivedAt, ""),
    source_updated_at: firstPresent(user.source_updated_at, user.sourceUpdatedAt, user.updated_at, user.updatedAt, ""),
  };
  if (archived) return lifecycle;
  return Object.assign(lifecycle, {
    age: firstPresent(user.age, ""),
    profile: firstPresent(user.profile, user.disease, user.note, ""),
    status: firstPresent(user.status, ""),
  });
}

function compactSummaryPlan(plan = {}) {
  return {
    id: firstPresent(plan.id, plan.plan_id, plan._id, ""),
    time: firstPresent(plan.time, ""),
    timing_label: firstPresent(plan.timing_label, plan.timingLabel, ""),
    medicine: firstPresent(plan.medicine, plan.medicine_name, plan.name, ""),
    dose: firstPresent(plan.dose, plan.dosage, ""),
    target_user: firstPresent(plan.target_user, plan.target_user_name, plan.user_name, ""),
    target_user_name: firstPresent(plan.target_user_name, plan.target_user, plan.user_name, ""),
    service_user_id: firstPresent(plan.service_user_id, plan.target_user_id, plan.user_id, ""),
    persona_generation: firstPresent(plan.persona_generation, plan.personaGeneration, ""),
    archived: archivedValue(plan),
    status: firstPresent(plan.status, ""),
    due_today: plan.due_today,
    next_due_date: firstPresent(plan.next_due_date, ""),
    last_action_date: firstPresent(plan.last_action_date, ""),
  };
}

function compactSyncSummary(summary = {}) {
  const result = { counts: summary.counts || {} };
  if (Object.prototype.hasOwnProperty.call(summary, "serviceUsers")) {
    result.serviceUsers = (summary.serviceUsers || []).slice(0, 100).map(compactSummaryUser);
  }
  if (Object.prototype.hasOwnProperty.call(summary, "plans")) {
    result.plans = (summary.plans || []).slice(0, 200).map(compactSummaryPlan);
  }
  if (Object.prototype.hasOwnProperty.call(summary, "recentInquiries")) {
    result.recentInquiries = (summary.recentInquiries || [])
      .slice(0, 20)
      .map(row => compactInquiryForClient(row, { includeMessages: false }));
  }
  if (Object.prototype.hasOwnProperty.call(summary, "serviceUsersSnapshotComplete")) {
    result.serviceUsersSnapshotComplete = summary.serviceUsersSnapshotComplete === true;
  }
  for (const key of ["snapshotRevision", "snapshot_revision", "sourceRevision", "source_revision"]) {
    if (Object.prototype.hasOwnProperty.call(summary, key)) result[key] = summary[key];
  }
  return result;
}

function safeId(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "-");
}

function medicineSnapshotId(deviceId, row = {}) {
  const identity = firstPresent(
    row.medicineId,
    row.medicine_id,
    row.traceCode,
    row.trace_code,
    row.barcode,
    row.code,
    row.id,
    row._id,
    row.slot || row.hardware_slot ? `legacy-slot-${row.slot || row.hardware_slot}` : null,
    `${row.name || "medicine"}-${row.expireDate || row.expire_date || "unknown"}-${row.spec || ""}`,
  );
  return `${deviceId}-medicine-${safeId(identity)}`;
}

function serviceUserSnapshotId(deviceId, row = {}) {
  const serviceUserId = firstPresent(
    row.id,
    row.service_user_id,
    row.serviceUserId,
    row.user_id,
    row.userId,
    row.name,
    "unknown",
  );
  const personaGeneration = firstPresent(
    row.persona_generation,
    row.personaGeneration,
    "legacy",
  );
  return `${deviceId}-user-${safeId(serviceUserId)}-generation-${safeId(personaGeneration)}`;
}

function validCloudTime(value) {
  if (!value) return "";
  const text = String(value).trim();
  const time = Date.parse(text.replace(/-/g, "/"));
  if (!Number.isFinite(time)) return "";
  const year = new Date(time).getFullYear();
  return year >= 2024 ? text : "";
}

function cloudTimeOr(value, fallback) {
  return validCloudTime(value) || validCloudTime(fallback) || nowText();
}

function normalizeVitals(vitals = {}, fallbackTime = "") {
  return Object.assign({}, vitals, {
    heartRate: firstPresent(vitals.heartRate, vitals.heart_rate, vitals.heart_rate_bpm),
    spo2: firstPresent(vitals.spo2, vitals.spo2_percent),
    bodyTemp: firstPresent(vitals.bodyTemp, vitals.body_temp_c, vitals.target_temp_c, vitals.temperature),
    quality: firstPresent(vitals.quality, vitals.signal_quality, vitals.status, "unknown"),
    createdAt: cloudTimeOr(
      firstPresent(vitals.createdAt, vitals.created_at, vitals.measured_at, vitals.time),
      fallbackTime,
    ),
  });
}

function configuredDeviceSecrets() {
  try {
    const map = JSON.parse((process.env.DEVICE_SECRETS || "{}").trim() || "{}");
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  } catch (error) {
    return {};
  }
}

function expectedPerDeviceSecret(deviceId) {
  const map = configuredDeviceSecrets();
  return Object.prototype.hasOwnProperty.call(map, deviceId)
    ? String(map[deviceId] || "").trim()
    : "";
}

function validateDevice(data) {
  if (!data || !data.deviceId) return { ok: false, error: "deviceId required" };
  const expected = expectedPerDeviceSecret(data.deviceId);
  if (!expected) return { ok: false, error: "device secret is not configured" };
  if (data.deviceSecret !== expected) return { ok: false, error: "unauthorized" };
  return null;
}

function validatePairingIssuer(data) {
  if (!data || !data.deviceId) return { ok: false, error: "deviceId required" };
  const expected = expectedPerDeviceSecret(data.deviceId);
  if (!expected) return { ok: false, error: "per-device secret is not configured" };
  if (data.deviceSecret !== expected) return { ok: false, error: "unauthorized" };
  return null;
}

function validateSafetyEventReporter(data) {
  if (!data || !data.deviceId) return { ok: false, error: "deviceId required" };
  const expected = expectedPerDeviceSecret(data.deviceId);
  if (!expected) return { ok: false, error: "device secret is not configured" };
  if (data.deviceSecret !== expected) return { ok: false, error: "unauthorized" };
  return null;
}

function validateDeviceId(data) {
  return data && data.deviceId ? null : { ok: false, error: "deviceId required" };
}

function isDocumentNotFoundError(value) {
  const code = String((value && (value.errCode ?? value.code)) || "").toUpperCase();
  const message = String((value && (value.errMsg || value.message)) || value || "");
  return code === "DATABASE_DOCUMENT_NOT_EXIST"
    || code === "DOCUMENT_NOT_EXIST"
    || /document(?:\s+with\s+_id\s+\S+)?\s+(?:does\s+)?not\s+exist|document\s+not\s+found|missing\s+document|文档不存在/i.test(message);
}

function actionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseEvent(event = {}) {
  if (event.action) return { payload: event, isHttp: false };
  let body = event.body;
  if (event.isBase64Encoded && typeof body === "string") {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  if (typeof body === "string") {
    try {
      body = body ? JSON.parse(body) : {};
    } catch (error) {
      body = {};
    }
  }
  if (body && body.action) return { payload: body, isHttp: true };
  if (event.queryStringParameters && event.queryStringParameters.action) {
    return {
      payload: {
        action: event.queryStringParameters.action,
        data: event.queryStringParameters,
      },
      isHttp: true,
    };
  }
  return { payload: event, isHttp: Boolean(event.httpMethod || event.headers || event.requestContext) };
}

function httpResult(result) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    },
    body: JSON.stringify(result),
  };
}

async function setDocument(collection, id, data) {
  await db.collection(collection).doc(id).set({ data: cleanData(data) });
}

function personaRevision(row = {}) {
  const value = Number(firstPresent(row.persona_revision, row.personaRevision, ""));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function personaSourceTime(row = {}) {
  const value = firstPresent(
    row.source_updated_at,
    row.sourceUpdatedAt,
    row.archived_at,
    row.archivedAt,
    row.updated_at,
    row.updatedAt,
    "",
  );
  const time = Date.parse(String(value || "").replace(/-/g, "/"));
  return Number.isFinite(time) ? time : null;
}

function shouldKeepExistingPersona(existing = {}, incoming = {}) {
  if (archivedValue(existing) && !archivedValue(incoming)) return true;
  const existingRevision = personaRevision(existing);
  const incomingRevision = personaRevision(incoming);
  if (
    existingRevision !== null
    && incomingRevision !== null
    && incomingRevision < existingRevision
  ) return true;
  const existingTime = personaSourceTime(existing);
  const incomingTime = personaSourceTime(incoming);
  return (
    existingRevision === incomingRevision
    && existingTime !== null
    && incomingTime !== null
    && incomingTime < existingTime
  );
}

async function setSnapshotDocument(collection, id, data, kind = "") {
  if (kind === "serviceUsers") {
    try {
      const existing = (await db.collection(collection).doc(id).get()).data || null;
      if (existing && shouldKeepExistingPersona(existing, data)) return existing;
    } catch (error) {
      // A missing persona document is created below.
    }
  }
  await setDocument(collection, id, data);
  return data;
}

async function listAllDeviceRows(collection, deviceId, maximum = 2000) {
  const rows = [];
  for (let offset = 0; offset < maximum; offset += 100) {
    const result = await db.collection(collection)
      .where({ deviceId })
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(100)
      .get();
    const batch = result.data || [];
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

async function replaceDeviceRows(collection, deviceId, rows, idForRow, kind = "") {
  const ids = [];
  for (const row of rows || []) {
    const id = idForRow(row);
    ids.push(id);
    await setSnapshotDocument(collection, id, Object.assign(cleanData(row), {
      deviceId,
      syncOwner: "zykh_station_app",
      updatedAt: nowText(),
    }), kind);
  }
  const existing = await listAllDeviceRows(collection, deviceId);
  const keep = new Set(ids);
  await Promise.all(existing
    .filter(item => item.syncOwner === "zykh_station_app" && !keep.has(item._id))
    .map(item => db.collection(collection).doc(item._id).remove()));
  return ids.length;
}

async function listRows(collection, deviceId, limit = 100, order = "updatedAt", direction = "desc") {
  let query = db.collection(collection).where({ deviceId });
  if (order) query = query.orderBy(order, direction);
  const result = await query.limit(Math.min(Number(limit) || 20, 100)).get();
  return result.data || [];
}

async function tryListRows(collection, deviceId, limit = 100, order = "updatedAt", direction = "desc") {
  try {
    return await listRows(collection, deviceId, limit, order, direction);
  } catch (error) {
    return [];
  }
}

function commandToInquiry(command = {}) {
  const payload = command.payload || {};
  const result = command.result || {};
  const commandId = command._id || command.id || command.commandId || "";
  const sessionId = firstPresent(result.session_id, result.sessionId, payload.session_id, payload.sessionId, "");
  const inquiryId = firstPresent(result.inquiry_id, result.inquiryId, sessionId, commandId);
  const question = firstPresent(payload.question, payload.message, payload.prompt, result.question, "");
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
  const messages = [];
  if (question) {
    messages.push({
      id: `${commandId || "ai"}-question`,
      role: "user",
      content: question,
      source: "miniprogram",
      created_at: createdAt,
    });
  }
  if (reply) {
    messages.push({
      id: `${commandId || "ai"}-reply`,
      role: command.status === "failed" ? "system" : "assistant",
      content: reply,
      source: "board",
      created_at: updatedAt,
    });
  }
  return {
    deviceId: command.deviceId,
    inquiry_id: inquiryId,
    session_id: sessionId,
    sourceCommandId: commandId,
    target_user_id: firstPresent(
      result.target_user_id,
      result.service_user_id,
      result.user_id,
      payload.target_user_id,
      payload.service_user_id,
      payload.user_id,
      "",
    ),
    service_user_id: firstPresent(result.service_user_id, payload.service_user_id, ""),
    target_user_name: firstPresent(
      result.target_user_name,
      result.service_user_name_snapshot,
      result.service_user_name,
      payload.target_user_name,
      payload.user_name,
      payload.patient_name,
      "家庭成员",
    ),
    title: question || "AI 问诊",
    topic: question || "AI 问诊",
    symptoms_summary: question || "AI 问诊",
    reasoning_summary: firstPresent(result.reasoning_summary, result.summary, ""),
    reply,
    ai_message: reply,
    risk_label: firstPresent(result.risk_label, result.riskLevel, result.risk_level, ""),
    risk_level: firstPresent(result.risk_level, result.riskLevel, ""),
    persona_generation: firstPresent(
      result.persona_generation,
      result.personaGeneration,
      payload.persona_generation,
      payload.personaGeneration,
      "",
    ),
    identity_kind: firstPresent(result.identity_kind, payload.identity_kind, ""),
    stage: firstPresent(result.stage, result.inquiry_stage, ""),
    next_action: firstPresent(result.next_action, result.nextAction, ""),
    final_assessment: firstPresent(result.final_assessment, result.finalAssessment, {}),
    next_steps: firstPresent(result.next_steps, result.nextSteps, []),
    seek_care_if: firstPresent(result.seek_care_if, result.seekCareIf, []),
    status: firstPresent(result.inquiry_status, result.stage, command.status, "done"),
    messages,
    created_at: createdAt,
    updated_at: updatedAt,
    createdAt,
    updatedAt,
    syncOwner: "ai_command",
  };
}

function summaryInquiryRows(device = {}) {
  const summary = device.syncSummary || {};
  return (summary.recentInquiries || []).map(row => Object.assign({}, row, {
    deviceId: device.deviceId || device._id,
    updatedAt: firstPresent(row.updatedAt, row.updated_at, row.createdAt, row.created_at, row.created_at),
    syncOwner: "device_summary",
  }));
}

function inquiryRowKey(row = {}) {
  return String(firstPresent(row.session_id, row.inquiry_id, row.sourceCommandId, row._id, `${row.createdAt || row.created_at}-${row.title || row.symptoms_summary}`));
}

function inquiryTime(row = {}) {
  const text = String(firstPresent(row.updatedAt, row.updated_at, row.createdAt, row.created_at, "")).replace(/-/g, "/");
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : 0;
}

async function listInquiries(data) {
  const limit = Math.min(Math.max(Number(data.limit) || 100, 1), 2000);
  const rows = await listAllDeviceRows(collections.inquiries, data.deviceId);
  const commandRows = (await listAllDeviceRows(collections.commands, data.deviceId))
    .filter(command => command.type === "AI_CHAT")
    .map(commandToInquiry);
  let summaryRows = [];
  try {
    const device = (await db.collection(collections.devices).doc(data.deviceId).get()).data || {};
    summaryRows = summaryInquiryRows(Object.assign({ deviceId: data.deviceId }, device));
  } catch (error) {
    summaryRows = [];
  }
  const map = new Map();
  rows.concat(commandRows, summaryRows).forEach(row => {
    const key = inquiryRowKey(row);
    const current = map.get(key);
    const currentMessages = Array.isArray(current && current.messages) ? current.messages.length : 0;
    const nextMessages = Array.isArray(row.messages) ? row.messages.length : 0;
    if (!current || nextMessages >= currentMessages || inquiryTime(row) >= inquiryTime(current)) {
      map.set(key, row);
    }
  });
  return Array.from(map.values())
    .sort((a, b) => inquiryTime(b) - inquiryTime(a))
    .slice(0, limit)
    .map(row => compactInquiryForClient(row, { includeMessages: false }));
}

function membershipScopes(membership = {}) {
  const value = membership.service_user_scopes || membership.serviceUserScopes;
  return Array.isArray(value)
    ? value.map(item => String(item || "").trim()).filter(Boolean)
    : [];
}

function membershipHasPermission(membership = {}, permission) {
  return Array.isArray(membership.permissions)
    && membership.permissions.includes(permission);
}

function rowPersonId(row = {}, kind = "") {
  if (kind === "serviceUsers") {
    return String(firstPresent(row.id, row.user_id, row.userId, row.service_user_id, row.serviceUserId) || "").trim();
  }
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  return String(firstPresent(
    row.service_user_id,
    row.serviceUserId,
    row.user_id,
    row.userId,
    row.target_user_id,
    row.targetUserId,
    row.person_id,
    row.personId,
    payload.service_user_id,
    payload.serviceUserId,
    payload.user_id,
    payload.userId,
    payload.target_user_id,
    payload.targetUserId,
    payload.person_id,
    payload.personId,
  ) || "").trim();
}

function rowsVisibleToMembership(rows, membership, kind = "") {
  const scopes = membershipScopes(membership);
  if (!scopes.length) return rows;
  const allowed = new Set(scopes);
  return (rows || []).filter(row => allowed.has(rowPersonId(row, kind)));
}

function deviceVisibleToMembership(device) {
  if (!device) return device;
  const visible = cleanData(device);
  [
    "syncSummary",
    "serviceUsers",
    "service_users",
    "plans",
    "todayPlans",
    "today_plans",
    "recentInquiries",
    "recent_inquiries",
    "inquiries",
    "vitals",
    "lastVitals",
    "last_vitals",
    "records",
    "commands",
    "medicationSafetyEvents",
    "medication_safety_events",
    "patientProfile",
    "patient_profile",
    "healthMemories",
    "health_memories",
  ].forEach(field => delete visible[field]);
  return visible;
}

function commandPersonId(type, payload = {}) {
  if (type === "UPSERT_SERVICE_USER") {
    return String(firstPresent(
      payload.id,
      payload.service_user_id,
      payload.serviceUserId,
      payload.user_id,
      payload.userId,
    ) || "").trim();
  }
  return rowPersonId({ payload }, "commands");
}

function commandPersonaGeneration(payload = {}) {
  return String(firstPresent(
    payload.persona_generation,
    payload.personaGeneration,
  ) || "").trim();
}

function requestedLimit(data, fallback = 20) {
  return Math.min(Math.max(Number(data.limit) || fallback, 1), 100);
}

async function scopedRows(collection, data, membership, order, direction = "desc", kind = "") {
  const rows = await listAllDeviceRows(collection, data.deviceId);
  const multiplier = direction === "asc" ? 1 : -1;
  rows.sort((left, right) => {
    const byOrder = String(left[order] || "").localeCompare(String(right[order] || ""));
    if (byOrder) return byOrder * multiplier;
    return String(left._id || "").localeCompare(String(right._id || "")) * multiplier;
  });
  return rowsVisibleToMembership(rows, membership, kind).slice(0, requestedLimit(data));
}

async function snapshotVisibleToMembership(data, membership) {
  const snapshot = {};
  if (membershipHasPermission(membership, "READ_PROFILE")) {
    snapshot.serviceUsers = rowsVisibleToMembership(
      await listAllDeviceRows(collections.serviceUsers, data.deviceId),
      membership,
      "serviceUsers",
    );
  }
  if (membershipHasPermission(membership, "READ_PLAN")) {
    snapshot.plans = rowsVisibleToMembership(
      await listAllDeviceRows(collections.plans, data.deviceId),
      membership,
      "plans",
    );
  }
  if (membershipHasPermission(membership, "READ_INQUIRY")) {
    snapshot.inquiries = rowsVisibleToMembership(
      await listInquiries(Object.assign({}, data, { limit: 2000 })),
      membership,
      "inquiries",
    );
  }
  if (membershipHasPermission(membership, "READ_VITALS")) {
    snapshot.vitals = rowsVisibleToMembership(
      await listAllDeviceRows(collections.vitals, data.deviceId),
      membership,
      "vitals",
    );
  }
  return snapshot;
}

async function getInquiryDetail(data, membership) {
  const inquiryId = String(data.inquiryId || data.inquiry_id || data.sessionId || data.session_id || "").trim();
  if (!inquiryId) throw new Error("inquiryId required");

  const storedRows = await listAllDeviceRows(collections.inquiries, data.deviceId);
  const commandRows = (await listAllDeviceRows(collections.commands, data.deviceId))
    .filter(command => command.type === "AI_CHAT")
    .map(commandToInquiry);
  let summaryRows = [];
  try {
    const device = (await db.collection(collections.devices).doc(data.deviceId).get()).data || {};
    summaryRows = summaryInquiryRows(Object.assign({ deviceId: data.deviceId }, device));
  } catch (error) {
    summaryRows = [];
  }
  const visible = rowsVisibleToMembership(
    storedRows.concat(commandRows, summaryRows),
    membership,
    "inquiries",
  );
  const row = visible.find(item => [
    item._id,
    item.inquiry_id,
    item.session_id,
    item.sourceCommandId,
  ].some(value => String(value || "") === inquiryId));
  if (!row) throw new Error("NOT_FOUND");
  return compactInquiryForClient(row, { includeMessages: true });
}

async function reportDevice(data) {
  let current = {};
  try {
    current = (await db.collection(collections.devices).doc(data.deviceId).get()).data || {};
    if (Number(firstPresent(current.schemaVersion, current.schema_version, 0)) >= 2
        && Number(firstPresent(data.schemaVersion, data.schema_version, 0)) < 2) {
      throw new Error("DEVICE_SCHEMA_DOWNGRADE_REJECTED");
    }
  } catch (error) {
    if (error && error.message === "DEVICE_SCHEMA_DOWNGRADE_REJECTED") throw error;
    if (isDocumentNotFoundError(error)) current = {};
    else throw actionError("DATABASE_REQUEST_FAILED");
  }
  const timestamp = nowText();
  const lastSeenAtEpochMs = Date.now();
  const patch = Object.assign({}, cleanData(current), releaseADeviceReport(data), {
    deviceId: data.deviceId,
    online: true,
    lastSeenAt: timestamp,
    lastSeenAtEpochMs,
    updatedAt: timestamp,
  });
  await setDocument(collections.devices, data.deviceId, patch);
  return Object.assign(deviceVisibleToMembership(patch), { heartbeatAgeMs: 0 });
}

function projectDeviceHeartbeat(device = {}) {
  const lastSeenAtEpochMs = Number(device.lastSeenAtEpochMs || 0);
  const heartbeatAgeMs = lastSeenAtEpochMs > 0
    ? Math.max(0, Date.now() - lastSeenAtEpochMs)
    : null;
  return Object.assign(cleanData(device), {
    lastSeenAt: String(device.lastSeenAt || ""),
    lastSeenAtEpochMs,
    heartbeatAgeMs,
    online: heartbeatAgeMs !== null && heartbeatAgeMs < 60 * 1000,
  });
}

async function pullCommands(data) {
  try {
    const current = (await db.collection(collections.devices).doc(data.deviceId).get()).data || {};
    if (Number(current.schemaVersion || 0) >= 2 && Number(data.agentVersion || 0) < 2) {
      return [];
    }
  } catch (error) {
    // Missing device state is handled by the normal query below.
  }

  const running = await db.collection(collections.commands)
    .where({ deviceId: data.deviceId, status: "running" })
    .limit(20)
    .get();
  const staleBefore = Date.now() - 120 * 1000;
  await Promise.all((running.data || []).map(command => {
    const text = String(command.pulledAt || command.updatedAt || "").replace(/-/g, "/");
    const timestamp = Date.parse(text);
    if (!Number.isFinite(timestamp) || timestamp >= staleBefore) return Promise.resolve();
    return db.collection(collections.commands).doc(command._id).update({
      data: { status: "pending", recoveryReason: "stale-running", updatedAt: nowText() },
    });
  }));

  const result = await db.collection(collections.commands)
    .where({ deviceId: data.deviceId, status: "pending" })
    .orderBy("createdAt", "asc")
    .limit(Math.min(Number(data.limit) || 10, 20))
    .get();
  const pulledAt = nowText();
  await Promise.all((result.data || []).map(command => db.collection(collections.commands).doc(command._id).update({
    data: { status: "running", pulledAt, updatedAt: pulledAt },
  })));
  return (result.data || []).map(command => Object.assign({}, command, { status: "running", pulledAt, updatedAt: pulledAt }));
}

async function ackCommand(data) {
  if (!data.commandId) throw new Error("commandId required");
  const command = await db.collection(collections.commands).doc(data.commandId).get();
  if (command.data && command.data.deviceId !== data.deviceId) throw new Error("unauthorized command");
  const status = data.status || "done";
  const result = data.result || {};
  await db.collection(collections.commands).doc(data.commandId).update({
    data: { status, result, updatedAt: nowText() },
  });
  if (command.data && command.data.type === "AI_CHAT") {
    try {
      const mirrored = commandToInquiry(Object.assign({}, command.data, {
        _id: data.commandId,
        status,
        result,
        updatedAt: nowText(),
      }));
      const inquiryId = firstPresent(mirrored.session_id, mirrored.inquiry_id, data.commandId);
      await setDocument(collections.inquiries, `${data.deviceId}-inquiry-${safeId(inquiryId)}`, mirrored);
    } catch (error) {
      // Command ACK must remain reliable even if the optional inquiry mirror is not ready.
    }
  }
  if (command.data && command.data.type === "READ_VITALS_ALL" && status === "done") {
    try {
      await mirrorVitalsCommand(data.deviceId, data.commandId, command.data, result);
    } catch (error) {
      // Command ACK must remain reliable even if the optional vitals mirror is not ready.
    }
  }
  return { commandId: data.commandId, status };
}

function commandVitalsPayload(result = {}) {
  if (result.vitals && typeof result.vitals === "object") return result.vitals;
  if (result.data && typeof result.data === "object") return result.data;
  if (result.result && typeof result.result === "object") return result.result;
  return result;
}

function hasVitalsSignal(row = {}) {
  return [
    row.heartRate,
    row.heart_rate,
    row.heart_rate_bpm,
    row.spo2,
    row.spo2_percent,
    row.bodyTemp,
    row.body_temp_c,
    row.target_temp_c,
    row.temperature,
    row.body_temperature,
    row.status,
    row.quality,
  ].some(value => value !== undefined && value !== null && value !== "");
}

async function mirrorVitalsCommand(deviceId, commandId, command, result) {
  const measured = commandVitalsPayload(result);
  const authoritative = Object.assign({}, result, measured);
  const payload = command && command.payload && typeof command.payload === "object"
    ? command.payload
    : {};
  const normalized = normalizeVitals(authoritative, command.updatedAt || nowText());
  if (!hasVitalsSignal(normalized)) return null;
  const createdAt = cloudTimeOr(firstPresent(
    authoritative.measured_at,
    authoritative.measuredAt,
    authoritative.createdAt,
    authoritative.created_at,
    normalized.createdAt,
  ), command.updatedAt || nowText());
  const serviceUserId = firstPresent(
    authoritative.service_user_id,
    authoritative.serviceUserId,
    authoritative.person_id,
    authoritative.personId,
    payload.service_user_id,
    payload.serviceUserId,
    payload.person_id,
    payload.personId,
    "",
  );
  const serviceUserName = firstPresent(
    authoritative.service_user_name_snapshot,
    authoritative.serviceUserNameSnapshot,
    authoritative.service_user_name,
    authoritative.serviceUserName,
    authoritative.person_name,
    authoritative.personName,
    payload.service_user_name_snapshot,
    payload.serviceUserNameSnapshot,
    payload.person_name,
    payload.personName,
    "",
  );
  const attributionSource = firstPresent(
    authoritative.attribution_source,
    authoritative.attributionSource,
    payload.attribution_source,
    payload.attributionSource,
    serviceUserId ? "" : "STANDALONE",
  );
  const row = Object.assign({}, normalized, {
    deviceId,
    device_id: deviceId,
    createdAt,
    measured_at: firstPresent(authoritative.measured_at, authoritative.measuredAt, createdAt),
    updatedAt: nowText(),
    sourceCommandId: commandId,
    source: firstPresent(authoritative.source, result.source, "READ_VITALS_ALL"),
    service_user_id: serviceUserId,
    service_user_name_snapshot: serviceUserName,
    persona_generation: firstPresent(
      authoritative.persona_generation,
      authoritative.personaGeneration,
      payload.persona_generation,
      payload.personaGeneration,
      "",
    ),
    inquiry_session_id: firstPresent(
      authoritative.inquiry_session_id,
      authoritative.inquirySessionId,
      "",
    ),
    attribution_source: attributionSource,
    target_user_id: serviceUserId,
    target_user_name: serviceUserName,
    syncOwner: "command_ack",
  });
  const id = `${deviceId}-vitals-command-${safeId(commandId)}`;
  await setDocument(collections.vitals, id, row);
  return Object.assign({ _id: id }, row);
}

function commandToVitals(command = {}) {
  if (command.type !== "READ_VITALS_ALL" || command.status !== "done") return null;
  const result = command.result || {};
  const measured = commandVitalsPayload(result);
  const authoritative = Object.assign({}, result, measured);
  const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
  if (!hasVitalsSignal(authoritative)) return null;
  const normalized = normalizeVitals(authoritative, command.updatedAt || command.createdAt || nowText());
  const commandId = String(command._id || command.id || command.commandId || "");
  const serviceUserId = firstPresent(
    authoritative.service_user_id,
    authoritative.serviceUserId,
    authoritative.person_id,
    authoritative.personId,
    payload.service_user_id,
    payload.serviceUserId,
    payload.person_id,
    payload.personId,
    "",
  );
  const serviceUserName = firstPresent(
    authoritative.service_user_name_snapshot,
    authoritative.serviceUserNameSnapshot,
    authoritative.service_user_name,
    authoritative.serviceUserName,
    authoritative.person_name,
    authoritative.personName,
    payload.service_user_name_snapshot,
    payload.serviceUserNameSnapshot,
    payload.person_name,
    payload.personName,
    "",
  );
  return Object.assign({}, normalized, {
    _id: `${command.deviceId}-vitals-command-${safeId(commandId)}`,
    deviceId: command.deviceId,
    device_id: command.deviceId,
    sourceCommandId: commandId,
    source: firstPresent(authoritative.source, result.source, "READ_VITALS_ALL"),
    service_user_id: serviceUserId,
    service_user_name_snapshot: serviceUserName,
    persona_generation: firstPresent(
      authoritative.persona_generation,
      authoritative.personaGeneration,
      payload.persona_generation,
      payload.personaGeneration,
      "",
    ),
    inquiry_session_id: firstPresent(
      authoritative.inquiry_session_id,
      authoritative.inquirySessionId,
      "",
    ),
    attribution_source: firstPresent(
      authoritative.attribution_source,
      authoritative.attributionSource,
      payload.attribution_source,
      payload.attributionSource,
      serviceUserId ? "" : "STANDALONE",
    ),
    target_user_id: serviceUserId,
    target_user_name: serviceUserName,
    syncOwner: "command_result",
    updatedAt: command.updatedAt || command.createdAt || normalized.createdAt,
  });
}

function rowTime(row = {}) {
  const text = String(firstPresent(
    row.createdAt,
    row.created_at,
    row.measured_at,
    row.updatedAt,
    row.updated_at,
    "",
  )).replace(/-/g, "/");
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : 0;
}

async function listVitals(data, membership) {
  const [storedRows, commandRows] = await Promise.all([
    listAllDeviceRows(collections.vitals, data.deviceId),
    listAllDeviceRows(collections.commands, data.deviceId),
  ]);
  const map = new Map();
  storedRows.concat(commandRows.map(commandToVitals).filter(Boolean)).forEach(row => {
    const key = String(firstPresent(
      row.sourceCommandId,
      row.source_command_id,
      row._id,
      row.id,
      row.createdAt,
      row.created_at,
    ));
    const current = map.get(key);
    if (!current || rowTime(row) >= rowTime(current)) map.set(key, row);
  });
  const visible = rowsVisibleToMembership(Array.from(map.values()), membership, "vitals");
  return visible
    .sort((left, right) => rowTime(right) - rowTime(left))
    .slice(0, requestedLimit(data, 100));
}

async function createCommand(data, wxContext, isHttp) {
  if (isHttp) throw new Error("miniprogram function invocation required");
  if (!wxContext.OPENID) throw new Error("miniprogram identity required");
  const personScopedTypes = new Set([
    "AI_CHAT",
    "READ_VITALS_ALL",
    "UPSERT_SERVICE_USER",
    "UPSERT_TODAY_PLAN",
  ]);
  const personId = commandPersonId(data.type, data.payload || {});
  const membership = await memberships.requireCommandAccess({
    openId: wxContext.OPENID,
    deviceId: data.deviceId,
    personId,
  });
  if (
    personScopedTypes.has(data.type)
    && membershipScopes(membership).length
    && !personId
  ) throw new Error("NOT_FOUND");
  if (
    data.type === "READ_VITALS_ALL"
    && membershipScopes(membership).length
    && !commandPersonaGeneration(data.payload || {})
  ) throw new Error("INVALID_ARGUMENT");
  if (!allowedCommandTypes.has(data.type)) throw new Error("unsupported command type");
  const row = {
    deviceId: data.deviceId,
    type: data.type,
    payload: data.payload || {},
    status: "pending",
    source: "miniprogram",
    sourceOpenId: wxContext.OPENID || "",
    createdAt: nowText(),
    updatedAt: nowText(),
  };
  if (data.requestId) {
    const documentId = `${data.deviceId}-request-${safeId(data.requestId)}`;
    const requestPayloadDigest = canonicalPayloadDigest({
      deviceId: data.deviceId,
      type: data.type,
      payload: data.payload || {},
    });
    row.requestPayloadDigest = requestPayloadDigest;
    if (typeof db.runTransaction !== "function") {
      throw new Error("database transaction is unavailable");
    }
    return db.runTransaction(async transaction => {
      const document = transaction.collection(collections.commands).doc(documentId);
      try {
        const existing = (await document.get()).data;
        if (existing) {
          const existingDigest = String(existing.requestPayloadDigest || "");
          if (!existingDigest || existingDigest !== requestPayloadDigest) {
            throw new Error("IDEMPOTENCY_CONFLICT");
          }
          return existing;
        }
      } catch (error) {
        if (error && error.message === "IDEMPOTENCY_CONFLICT") throw error;
        // A missing document is created below while the transaction holds the key.
      }
      await document.set({ data: cleanData(row) });
      return Object.assign({ _id: documentId }, row);
    });
  }
  const result = await db.collection(collections.commands).add({ data: row });
  return Object.assign({ _id: result._id }, row);
}

function requireMiniprogramIdentity(wxContext, isHttp) {
  if (isHttp) throw new Error("miniprogram function invocation required");
  const openId = String((wxContext && wxContext.OPENID) || "").trim();
  if (!openId) throw new Error("miniprogram identity required");
  return openId;
}

async function handleAction(payload, wxContext, isHttp = false) {
  const action = payload.action;
  const data = payload.data || {};
  const safetyReadActions = new Set([
    "LIST_MEDICATION_SAFETY_EVENTS",
    "GET_MEDICATION_SAFETY_EVENT",
    "MARK_MEDICATION_SAFETY_EVENT_READ",
  ]);
  let readMembership = null;
  if (action === "PING") {
    return { ok: true, time: nowText(), schemaVersion: 2, schemaRevision, capabilities };
  }
  if (action === "ISSUE_DEVICE_PAIRING_CODE" || action === "REDEEM_DEVICE_PAIRING_CODE") {
    throw actionError("DEVICE_PAIRING_NOT_AVAILABLE");
  }
  if (action === "REPORT_MEDICATION_SAFETY_EVENT") {
    const error = validateSafetyEventReporter(data);
    if (error) return error;
    throw actionError("PERSONA_DATA_MIGRATION_IN_PROGRESS");
  } else if (boardActions.has(action)) {
    const error = validateDevice(data);
    if (error) return error;
  } else if (readActions.has(action) || action === "CREATE_COMMAND") {
    const error = validateDeviceId(data);
    if (error) return error;
    if (readActions.has(action)) {
      const openId = requireMiniprogramIdentity(wxContext, isHttp);
      if (safetyReadActions.has(action)) {
        // The safety-event module performs its own permission and person-scope check.
      } else {
        const membershipInput = {
          openId,
          deviceId: data.deviceId,
        };
        readMembership = readActionPermissions[action]
          ? await memberships.requirePermission(membershipInput, readActionPermissions[action])
          : await memberships.requireMembership(membershipInput);
      }
    }
  }
  if (releaseAPersonaReadActions.has(action)) {
    throw actionError("PERSONA_DATA_MIGRATION_IN_PROGRESS");
  }
  if (action === "CREATE_COMMAND") {
    requireMiniprogramIdentity(wxContext, isHttp);
    throw actionError("REMOTE_COMMANDS_DISABLED");
  }

  switch (action) {
    case "REPORT_DEVICE": return reportDevice(data);
    case "BEGIN_SNAPSHOT": return snapshots.begin(data);
    case "UPSERT_SNAPSHOT_BATCH": return snapshots.upsertBatch(data);
    case "FINALIZE_SNAPSHOT": return snapshots.finalize(data);
    case "ABORT_SNAPSHOT": return snapshots.abort(data);
    case "GET_BOARD_MEDICINE_MANIFEST": return snapshots.readCurrentManifest(data.deviceId);
    case "UPLOAD_MEDICINES":
    case "UPLOAD_SNAPSHOT": throw actionError("SNAPSHOT_PROTOCOL_REQUIRED");
    case "UPLOAD_VITALS":
    case "UPLOAD_RECORD": throw actionError("PERSONA_DATA_MIGRATION_IN_PROGRESS");
    case "PULL_COMMANDS":
    case "ACK_COMMAND": throw actionError("REMOTE_COMMANDS_DISABLED");
    case "GET_MY_DEVICES": return memberships.listMyDevices({
      openId: requireMiniprogramIdentity(wxContext, isHttp),
    });
    case "GET_DEVICE": {
      try {
        const result = await db.collection(collections.devices).doc(data.deviceId).get();
        const device = result && result.data ? result.data : null;
        if (!device || String(device.deviceId || device._id || "") !== String(data.deviceId)) {
          throw actionError("NOT_FOUND");
        }
        return deviceVisibleToMembership(projectDeviceHeartbeat(device), readMembership);
      } catch (error) {
        if (error && error.code === "NOT_FOUND") throw error;
        if (isDocumentNotFoundError(error)) throw actionError("NOT_FOUND");
        throw actionError("DATABASE_REQUEST_FAILED");
      }
    }
    case "GET_MEDICINE_SNAPSHOT": return snapshots.readMedicineSnapshot(data.deviceId, data);
    case "LIST_MEDICINES": return snapshots.listMedicines(data.deviceId);
    default: throw new Error(`unknown action: ${action}`);
  }
}

exports.main = async event => {
  const parsed = parseEvent(event);
  if (parsed.isHttp && event.httpMethod === "OPTIONS") return httpResult({ ok: true });
  try {
    const result = await handleAction(parsed.payload, cloud.getWXContext(), parsed.isHttp);
    return parsed.isHttp ? httpResult(result) : result;
  } catch (error) {
    const result = {
      ok: false,
      error: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : undefined,
    };
    return parsed.isHttp ? httpResult(result) : result;
  }
};
