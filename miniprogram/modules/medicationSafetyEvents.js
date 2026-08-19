const CHECK_STATUSES = ["PASSED", "BLOCKED", "CHECK_FAILED"];
const DISPENSE_STATUSES = ["NOT_STARTED", "BLOCKED", "DISPENSED", "HARDWARE_FAILED", "RESULT_UNKNOWN"];

function firstPresent(...values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function text(value, fallback = "") {
  const normalized = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function uppercase(value) {
  return text(value).toUpperCase();
}

function isTrueFlag(value) {
  if (value === true || value === 1) return true;
  return ["true", "1", "yes", "是"].includes(text(value).toLowerCase());
}

function isFalseFlag(value) {
  if (value === false || value === 0) return true;
  return ["false", "0", "no", "否"].includes(text(value).toLowerCase());
}

function safetyType(raw = {}) {
  const payload = raw.payload || {};
  return uppercase(firstPresent(
    raw.type,
    raw.eventType,
    raw.event_type,
    raw.category,
    payload.type,
    payload.eventType,
    payload.event_type,
  ));
}

const SAFETY_IDENTITY_FIELDS = {
  eventId: ["eventId", "event_id"],
  deviceId: ["deviceId", "device_id"],
  personId: ["personId", "person_id", "serviceUserId", "service_user_id"],
  personaGeneration: ["personaGeneration", "persona_generation"],
};

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function safetyIdentitySources(raw = {}, includeReceipt = false) {
  const root = objectValue(raw) || {};
  const payload = objectValue(root.payload);
  const sources = [root];
  if (payload) sources.push(payload);
  if (!includeReceipt) return sources;

  const nested = objectValue(root.receipt);
  const payloadReceipt = payload && objectValue(payload.receipt);
  if (nested) {
    sources.push(nested);
    const nestedPayload = objectValue(nested.payload);
    if (nestedPayload) sources.push(nestedPayload);
  }
  if (payloadReceipt) {
    sources.push(payloadReceipt);
    const payloadReceiptPayload = objectValue(payloadReceipt.payload);
    if (payloadReceiptPayload) sources.push(payloadReceiptPayload);
  }
  return sources;
}

function safetyIdentity(raw = {}, options = {}) {
  const sources = safetyIdentitySources(raw, options.includeReceipt === true);
  const values = {};
  const conflictFields = [];
  Object.keys(SAFETY_IDENTITY_FIELDS).forEach(field => {
    const supplied = [];
    sources.forEach(source => {
      SAFETY_IDENTITY_FIELDS[field].forEach(alias => {
        const value = text(source && source[alias]);
        if (value && !supplied.includes(value)) supplied.push(value);
      });
    });
    if (supplied.length > 1) conflictFields.push(field);
    values[field] = supplied.length === 1 ? supplied[0] : "";
  });
  return { values, conflictFields };
}

function hasSafetyIdentityConflict(raw = {}, options = {}) {
  return safetyIdentity(raw, options).conflictFields.length > 0;
}

function matchesRequestedDeviceScope(raw = {}, requestedDeviceId = "") {
  const expectedDeviceId = text(requestedDeviceId);
  if (!expectedDeviceId) return true;
  const identity = safetyIdentity(raw);
  if (identity.conflictFields.includes("deviceId")) return false;
  return !identity.values.deviceId || identity.values.deviceId === expectedDeviceId;
}

function medicationSafetyEventId(raw = {}) {
  const identity = safetyIdentity(raw);
  if (identity.conflictFields.includes("eventId")) return "";
  return identity.values.eventId || text(firstPresent(raw.id, raw._id));
}

function isMedicationSafetyEvent(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (hasSafetyIdentityConflict(raw)) return false;
  const type = safetyType(raw);
  if ([
    "MEDICATION_SAFETY_CHECK",
    "MEDICATION_SAFETY_EVENT",
    "MEDICATION_SAFETY_CHECK_RECORDED",
  ].includes(type)) return true;
  const payload = raw.payload || {};
  const checkStatus = firstPresent(raw.checkStatus, raw.check_status, payload.checkStatus, payload.check_status);
  const eventId = medicationSafetyEventId(raw);
  return Boolean(checkStatus && eventId);
}

function normalizeCheckStatus(value) {
  const status = uppercase(value);
  return CHECK_STATUSES.includes(status) ? status : "CHECK_FAILED";
}

function normalizeDispenseStatus(value) {
  const status = uppercase(value);
  return DISPENSE_STATUSES.includes(status) ? status : "NOT_STARTED";
}

function normalizeReadState(raw = {}, payload = {}) {
  const receipt = raw.receipt || payload.receipt || {};
  const state = uppercase(firstPresent(
    raw.readState,
    raw.read_state,
    raw.receiptState,
    raw.receipt_state,
    receipt.state,
    payload.readState,
    payload.read_state,
  ));
  if (state === "READ" || state === "UNREAD") return state;
  const read = firstPresent(raw.read, raw.isRead, raw.is_read, payload.read, payload.isRead, payload.is_read);
  if (isTrueFlag(read)) return "READ";
  if (isFalseFlag(read)) return "UNREAD";
  return "UNKNOWN";
}

function validateMedicationSafetyEventReadReceipt(receipt, eventId, options = {}) {
  const expectedId = text(eventId);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || !expectedId) {
    throw new Error("medication safety event read receipt unavailable");
  }
  const nested = receipt.receipt && typeof receipt.receipt === "object" && !Array.isArray(receipt.receipt)
    ? receipt.receipt
    : {};
  const receiptIdentity = safetyIdentity(receipt, { includeReceipt: true });
  const expectedIdentity = safetyIdentity(Object.assign({}, options, { eventId: expectedId }));
  if (receiptIdentity.conflictFields.length || expectedIdentity.conflictFields.length) {
    throw new Error("medication safety event read receipt identity mismatch");
  }
  const actualId = receiptIdentity.values.eventId;
  if (!actualId || actualId !== expectedId) {
    throw new Error("medication safety event read receipt identity mismatch");
  }
  Object.keys(expectedIdentity.values).forEach(field => {
    const expected = expectedIdentity.values[field];
    const actual = receiptIdentity.values[field];
    if (expected && actual && expected !== actual) {
      throw new Error("medication safety event read receipt identity mismatch");
    }
  });

  const state = uppercase(firstPresent(
    receipt.state,
    receipt.readState,
    receipt.read_state,
    nested.state,
    nested.readState,
    nested.read_state,
  ));
  const readFlag = firstPresent(
    receipt.read,
    receipt.isRead,
    receipt.is_read,
    nested.read,
    nested.isRead,
    nested.is_read,
  );
  const status = uppercase(firstPresent(receipt.status, nested.status));
  const explicitlyFailed = receipt.ok === false
    || receipt.success === false
    || nested.ok === false
    || nested.success === false
    || ["FAILED", "FAILURE", "ERROR", "REJECTED"].includes(status);
  if (explicitlyFailed || (state && state !== "READ") || isFalseFlag(readFlag)) {
    throw new Error("medication safety event read receipt did not confirm READ");
  }
  const explicitlyRead = state === "READ" || isTrueFlag(readFlag);
  if (!explicitlyRead) {
    throw new Error("medication safety event read receipt did not confirm success");
  }
  return receipt;
}

function normalizeReasonCodes(value) {
  if (Array.isArray(value)) return value.map(item => uppercase(item)).filter(Boolean);
  const single = uppercase(value);
  return single ? [single] : [];
}

function normalizeMedicationSafetyEvent(raw = {}) {
  const payload = raw.payload || {};
  const medicine = raw.medicine || payload.medicine || {};
  const identity = safetyIdentity(raw);
  const eventId = medicationSafetyEventId(raw);
  const personId = identity.values.personId;
  const occurredAt = firstPresent(
    raw.occurredAt,
    raw.occurred_at,
    raw.createdAt,
    raw.created_at,
    payload.occurredAt,
    payload.occurred_at,
  );
  const checkStatus = normalizeCheckStatus(firstPresent(
    raw.checkStatus,
    raw.check_status,
    payload.checkStatus,
    payload.check_status,
  ));
  const dispenseStatus = normalizeDispenseStatus(firstPresent(
    raw.dispenseStatus,
    raw.dispense_status,
    payload.dispenseStatus,
    payload.dispense_status,
  ));
  const qsmOk = firstPresent(raw.qsmOk, raw.qsm_ok, payload.qsmOk, payload.qsm_ok);
  const dryRun = firstPresent(raw.dryRun, raw.dry_run, payload.dryRun, payload.dry_run);

  return {
    id: identity.conflictFields.length ? "" : text(eventId, `safety-${text(personId, "unknown")}-${text(occurredAt, "unknown")}`),
    deviceId: identity.values.deviceId,
    personId: text(personId),
    personaGeneration: identity.values.personaGeneration,
    identityConflict: identity.conflictFields.length > 0,
    identityConflictFields: identity.conflictFields,
    personName: text(firstPresent(
      raw.personName,
      raw.person_name,
      raw.personDisplayName,
      raw.person_display_name,
      raw.serviceUserName,
      raw.service_user_name,
      payload.personName,
      payload.person_name,
      payload.personDisplayName,
      payload.person_display_name,
    ), "家庭成员"),
    medicineId: text(firstPresent(
      medicine.id,
      medicine.medicineId,
      medicine.medicine_id,
      raw.medicineId,
      raw.medicine_id,
      payload.medicineId,
      payload.medicine_id,
    )),
    medicineName: text(firstPresent(
      medicine.name,
      medicine.medicineName,
      medicine.medicine_name,
      raw.medicineName,
      raw.medicine_name,
      payload.medicineName,
      payload.medicine_name,
    ), "未命名药品"),
    slot: firstPresent(medicine.slot, raw.slot, payload.slot),
    checkStatus,
    dispenseStatus,
    reasonCodes: normalizeReasonCodes(firstPresent(
      raw.reasonCodes,
      raw.reason_codes,
      payload.reasonCodes,
      payload.reason_codes,
    )),
    summary: text(firstPresent(
      raw.summary,
      raw.caregiverSummary,
      raw.caregiver_summary,
      raw.reasonSummary,
      raw.reason_summary,
      payload.summary,
      payload.caregiverSummary,
      payload.caregiver_summary,
      payload.reasonSummary,
      payload.reason_summary,
    )),
    occurredAt: text(occurredAt),
    readState: normalizeReadState(raw, payload),
    profileRevision: firstPresent(raw.profileRevision, raw.profile_revision, payload.profileRevision, payload.profile_revision),
    rulesetVersion: text(firstPresent(raw.rulesetVersion, raw.ruleset_version, payload.rulesetVersion, payload.ruleset_version)),
    medicineReviewFingerprint: text(firstPresent(
      raw.medicineReviewFingerprint,
      raw.medicine_review_fingerprint,
      payload.medicineReviewFingerprint,
      payload.medicine_review_fingerprint,
    )),
    qsmOperationId: text(firstPresent(raw.qsmOperationId, raw.qsm_operation_id, payload.qsmOperationId, payload.qsm_operation_id)),
    qsmOk: isTrueFlag(qsmOk) ? true : (isFalseFlag(qsmOk) ? false : null),
    dryRun: isTrueFlag(dryRun) ? true : (isFalseFlag(dryRun) ? false : null),
  };
}

function isCompletedPhysicalDispense(value = {}) {
  const event = value.checkStatus ? value : normalizeMedicationSafetyEvent(value);
  if (event.checkStatus !== "PASSED") return false;
  if (event.dispenseStatus === "DISPENSED") return true;
  return event.qsmOk === true && event.dryRun === false;
}

function eventPresentation(value = {}) {
  const event = value.checkStatus ? value : normalizeMedicationSafetyEvent(value);
  if (event.checkStatus === "BLOCKED") {
    return {
      title: `${event.personName} · 已阻止取药`,
      subtitle: `${event.medicineName} · 药箱未出药`,
      state: { kind: "risk", label: "安全拦截" },
      outcomeText: "药箱未出药",
    };
  }
  if (event.checkStatus === "CHECK_FAILED") {
    return {
      title: `${event.personName} · 未能完成安全核查`,
      subtitle: `${event.medicineName} · 药箱未出药`,
      state: { kind: "pending", label: "核查未完成" },
      outcomeText: "药箱未出药",
    };
  }
  if (event.dispenseStatus === "DISPENSED" || isCompletedPhysicalDispense(event)) {
    return {
      title: `${event.personName} · 安全核查通过`,
      subtitle: `${event.medicineName} · 已继续现场取药`,
      state: { kind: "normal", label: "已完成取药" },
      outcomeText: "已继续现场取药",
    };
  }
  if (event.dispenseStatus === "HARDWARE_FAILED") {
    return {
      title: `${event.personName} · 核查通过但开柜失败`,
      subtitle: `${event.medicineName} · 未确认取出药品`,
      state: { kind: "risk", label: "开柜失败" },
      outcomeText: "未确认取出药品",
    };
  }
  if (event.dispenseStatus === "RESULT_UNKNOWN") {
    return {
      title: `${event.personName} · 柜门结果待确认`,
      subtitle: `${event.medicineName} · 请联系现场确认`,
      state: { kind: "pending", label: "结果待确认" },
      outcomeText: "请联系现场确认",
    };
  }
  return {
    title: `${event.personName} · 安全核查通过`,
    subtitle: `${event.medicineName} · 尚未确认现场取药结果`,
    state: { kind: "actionable", label: "核查通过" },
    outcomeText: "尚未确认现场取药结果",
  };
}

function projectRecords(events = []) {
  return (events || [])
    .filter(Boolean)
    .map(value => value.checkStatus ? value : normalizeMedicationSafetyEvent(value))
    .filter(event => !event.identityConflict)
    .map(event => Object.assign({}, event, eventPresentation(event), {
      type: "safety",
      typeLabel: "安全核查",
      rawTime: event.occurredAt,
      sortTime: Date.parse(String(event.occurredAt || "").replace(/-/g, "/")) || 0,
    }))
    .sort((left, right) => right.sortTime - left.sortTime);
}

function sameCalendarDay(time, now) {
  if (!time) return false;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) &&
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
}

function projectHome(events = [], options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const normalized = (events || [])
    .filter(Boolean)
    .map(value => value.checkStatus ? value : normalizeMedicationSafetyEvent(value))
    .filter(event => !event.identityConflict)
    .sort((left, right) => {
      const leftTime = Date.parse(String(left.occurredAt || "").replace(/-/g, "/")) || 0;
      const rightTime = Date.parse(String(right.occurredAt || "").replace(/-/g, "/")) || 0;
      return rightTime - leftTime || String(left.id).localeCompare(String(right.id));
    });
  const unread = normalized.filter(event => event.readState === "UNREAD");
  const blocked = unread.filter(event => event.checkStatus === "BLOCKED");
  const checkFailed = unread.filter(event => event.checkStatus === "CHECK_FAILED");
  return {
    events: normalized,
    unread,
    focusBlocked: blocked[0] || null,
    focusCheckFailed: checkFailed[0] || null,
    unreadBlockedCount: blocked.length,
    unreadCheckFailedCount: checkFailed.length,
    todayBlockedCount: normalized.filter(event => {
      const time = Date.parse(String(event.occurredAt || "").replace(/-/g, "/")) || 0;
      return event.checkStatus === "BLOCKED" && sameCalendarDay(time, now);
    }).length,
  };
}

function supportsMedicationSafetyEvents(capabilitySnapshot = {}) {
  const capabilities = capabilitySnapshot && capabilitySnapshot.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const value = firstPresent(
    capabilities.medicationSafetyEvents,
    capabilities.medication_safety_events,
  );
  if (value === true || value === 1) return true;
  const version = text(value).toLowerCase();
  return version === "v1" || version === "1" || version.indexOf("v1.") === 0;
}

function isForbiddenError(error) {
  const code = uppercase(error && error.code);
  return [
    "FORBIDDEN",
    "UNAUTHORIZED",
    "PERMISSION_DENIED",
    "CAREGIVER_MEMBERSHIP_REQUIRED",
    "CAREGIVER_PERMISSION_DENIED",
  ].includes(code);
}

function forbiddenState(error, extra = {}) {
  return Object.assign({
    availability: "forbidden",
    message: "当前微信账号无权查看该药箱",
    events: [],
    nextCursor: "",
    error,
  }, extra);
}

function createMedicationSafetyEventModule(gateway = {}) {
  return {
    async list(options = {}) {
      let capabilitySnapshot;
      try {
        capabilitySnapshot = await gateway.getCapabilitiesStrict(options.deviceId || "");
      } catch (error) {
        if (isForbiddenError(error)) return forbiddenState(error);
        return {
          availability: "unknown",
          message: "暂时无法确认安全记录是否为最新",
          events: [],
          nextCursor: "",
          error,
        };
      }
      if (!supportsMedicationSafetyEvents(capabilitySnapshot)) {
        return {
          availability: "unsupported",
          message: "当前云端版本尚未支持安全记录",
          events: [],
          nextCursor: "",
          capabilitySnapshot,
        };
      }
      try {
        const result = await gateway.getMedicationSafetyEventsStrict(options);
        const rows = Array.isArray(result) ? result : (result && result.items);
        if (!Array.isArray(rows)) throw new Error("medication safety event list unavailable");
        if (!matchesRequestedDeviceScope(result, options.deviceId) ||
            rows.some(row => !matchesRequestedDeviceScope(row, options.deviceId))) {
          throw new Error("medication safety event list device scope mismatch");
        }
        if (rows.some(row => !isMedicationSafetyEvent(row) || !medicationSafetyEventId(row))) {
          throw new Error("medication safety event list contains an invalid row");
        }
        return {
          availability: "ready",
          message: rows.length ? "" : "暂无安全核查记录",
          events: rows.map(normalizeMedicationSafetyEvent),
          nextCursor: text(result && (result.nextCursor || result.next_cursor)),
          capabilitySnapshot,
        };
      } catch (error) {
        if (isForbiddenError(error)) return forbiddenState(error, { capabilitySnapshot });
        return {
          availability: "error",
          message: "安全记录读取失败，请稍后重试",
          events: [],
          nextCursor: "",
          capabilitySnapshot,
          error,
        };
      }
    },

    async getDetail(eventId, options = {}) {
      const raw = await gateway.getMedicationSafetyEventDetail(eventId, options);
      const expectedId = text(eventId);
      const actualId = medicationSafetyEventId(raw);
      if (hasSafetyIdentityConflict(raw)) {
        throw new Error("medication safety event detail identity mismatch");
      }
      if (!isMedicationSafetyEvent(raw) || !actualId) {
        throw new Error("medication safety event detail unavailable");
      }
      if (actualId !== expectedId) {
        throw new Error("medication safety event detail identity mismatch");
      }
      if (!matchesRequestedDeviceScope(raw, options.deviceId)) {
        throw new Error("medication safety event detail device scope mismatch");
      }
      return normalizeMedicationSafetyEvent(raw);
    },

    async markRead(eventId, options = {}) {
      const receipt = await gateway.markMedicationSafetyEventRead(eventId, options);
      return validateMedicationSafetyEventReadReceipt(receipt, eventId, options);
    },

    projectRecords,
    projectHome,
  };
}

module.exports = {
  isMedicationSafetyEvent,
  normalizeMedicationSafetyEvent,
  isCompletedPhysicalDispense,
  eventPresentation,
  projectRecords,
  projectHome,
  supportsMedicationSafetyEvents,
  validateMedicationSafetyEventReadReceipt,
  createMedicationSafetyEventModule,
};
