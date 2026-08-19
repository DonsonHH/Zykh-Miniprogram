const crypto = require("crypto");

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
      return result;
    }, {});
}

function canonicalPayloadDigest(payload) {
  const encoded = JSON.stringify(canonicalValue(payload));
  return crypto.createHash("sha256").update(encoded, "utf8").digest("hex");
}

function stableDigest(parts) {
  return crypto.createHash("sha256")
    .update(parts.map(value => String(value || "")).join("\u0000"), "utf8")
    .digest("hex");
}

function requiredText(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${fieldName} required`);
  return text;
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function textValue(...values) {
  return String(firstPresent(...values) || "");
}

function eventPersonId(event) {
  return textValue(event.service_user_id, event.serviceUserId, event.personId);
}

function eventIdentifier(event) {
  return textValue(event.eventId, event.event_id);
}

function eventTime(event) {
  return textValue(event.occurred_at, event.occurredAt, event.createdAt);
}

function normalizedCheckStatus(value) {
  const status = textValue(value).trim().toUpperCase();
  return new Set(["PASSED", "BLOCKED", "CHECK_FAILED"]).has(status)
    ? status
    : "CHECK_FAILED";
}

function normalizedDispenseStatus(value) {
  const status = textValue(value).trim().toUpperCase();
  return new Set(["NOT_STARTED", "BLOCKED", "DISPENSED", "HARDWARE_FAILED", "RESULT_UNKNOWN"]).has(status)
    ? status
    : "NOT_STARTED";
}

function projectListItem(event, read) {
  const medicine = event.medicine && typeof event.medicine === "object" ? event.medicine : {};
  return {
    eventId: eventIdentifier(event),
    personId: eventPersonId(event),
    personName: textValue(
      event.person_display_name,
      event.personDisplayName,
      event.service_user_name,
      event.serviceUserName,
      "家庭成员",
    ),
    medicineId: textValue(medicine.id, event.medicine_id, event.medicineId),
    medicineName: textValue(medicine.name, event.medicine_name, event.medicineName, "未命名药品"),
    slot: Number(firstPresent(medicine.slot, event.slot, 0)) || 0,
    checkStatus: normalizedCheckStatus(firstPresent(event.check_status, event.checkStatus)),
    dispenseStatus: normalizedDispenseStatus(firstPresent(event.dispense_status, event.dispenseStatus)),
    summary: textValue(
      event.caregiver_summary,
      event.caregiverSummary,
      event.reason_summary,
      event.reasonSummary,
    ),
    occurredAt: eventTime(event),
    read: Boolean(read),
  };
}

function projectDetail(event, read) {
  return Object.assign(projectListItem(event, read), {
    reasonCodes: Array.isArray(event.reason_codes || event.reasonCodes)
      ? (event.reason_codes || event.reasonCodes).map(value => String(value))
      : [],
    profileRevision: Number(firstPresent(event.profile_revision, event.profileRevision, 0)) || 0,
    rulesetVersion: textValue(event.ruleset_version, event.rulesetVersion),
    medicineReviewFingerprint: textValue(
      event.medicine_review_fingerprint,
      event.medicineReviewFingerprint,
    ),
    qsmOperationId: textValue(event.qsm_operation_id, event.qsmOperationId),
    physicalFailureSummary: textValue(
      event.physical_failure_summary,
      event.physicalFailureSummary,
    ),
  });
}

function requireDatabaseSuccess(result) {
  const code = result && (result.errCode ?? result.code);
  const failedCode = (
    code !== undefined
    && code !== null
    && code !== 0
    && code !== "0"
    && String(code).toUpperCase() !== "OK"
  );
  const message = String((result && (result.errMsg || result.message)) || "");
  if (failedCode || /:fail\b/i.test(message)) throw new Error("DATABASE_REQUEST_FAILED");
  return result;
}

function documentNotFound(value) {
  const code = String((value && (value.errCode ?? value.code)) || "").toUpperCase();
  const message = String((value && (value.errMsg || value.message)) || value || "");
  return (
    code === "DATABASE_DOCUMENT_NOT_EXIST"
    || code === "DOCUMENT_NOT_EXIST"
    || /document(?:\s+with\s+_id\s+\S+)?\s+(?:does\s+)?not\s+exist|document\s+not\s+found|missing\s+document|文档不存在/i.test(message)
  );
}

async function documentOrNull(collection, id) {
  try {
    const result = await collection.doc(id).get();
    if (documentNotFound(result)) return null;
    requireDatabaseSuccess(result);
    return result && result.data ? result.data : null;
  } catch (error) {
    if (documentNotFound(error)) return null;
    throw new Error("DATABASE_REQUEST_FAILED");
  }
}

async function listAllRows(collection, filter) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const result = await collection.where(filter).skip(offset).limit(100).get();
    const page = result.data || [];
    rows.push(...page);
    if (page.length < 100) return rows;
  }
}

function compareEvents(left, right) {
  const byTime = eventTime(right).localeCompare(eventTime(left));
  return byTime || eventIdentifier(right).localeCompare(eventIdentifier(left));
}

function encodeCursor(event) {
  return Buffer.from(JSON.stringify({
    occurredAt: eventTime(event),
    eventId: eventIdentifier(event),
  }), "utf8").toString("base64");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
    if (!parsed || typeof parsed.occurredAt !== "string" || typeof parsed.eventId !== "string") {
      throw new Error("invalid cursor");
    }
    return parsed;
  } catch (error) {
    throw new Error("invalid cursor");
  }
}

function eventFollowsCursor(event, cursor) {
  if (!cursor) return true;
  const byTime = eventTime(event).localeCompare(cursor.occurredAt);
  if (byTime !== 0) return byTime < 0;
  return eventIdentifier(event).localeCompare(cursor.eventId) < 0;
}

function createMedicationSafetyEventModule({ db, collections, memberships, nowText, safeId }) {
  async function ensureCaregiverDelivery(event, deviceId) {
    if (typeof db.runTransaction !== "function") {
      throw new Error("database transaction is unavailable");
    }
    const eventId = eventIdentifier(event);
    const recipients = await memberships.listSafetyRecipients({
      deviceId,
      personId: eventPersonId(event),
    });
    const deliveredOpenIds = new Set();
    for (const recipient of recipients) {
      if (deliveredOpenIds.has(recipient.openid)) continue;
      const receiptId = `${safeId(deviceId)}-${safeId(eventId)}-${safeId(recipient.openid)}`;
      const notificationId = `safety-notification-${stableDigest([
        deviceId,
        eventId,
        recipient.openid,
      ])}`;
      const writeIfAuthorized = async database => {
        const stillAuthorized = await memberships.isCurrentSafetyRecipient({
          database,
          membershipId: recipient.membershipId,
          openid: recipient.openid,
          deviceId,
          personId: eventPersonId(event),
        });
        if (!stillAuthorized) return false;

        const timestamp = nowText();
        const receiptCollection = database.collection(collections.caregiverEventReceipts);
        const existingReceipt = await documentOrNull(receiptCollection, receiptId);
        if (existingReceipt) {
          if (
            textValue(existingReceipt.eventId, existingReceipt.event_id) !== eventId
            || textValue(existingReceipt.deviceId, existingReceipt.device_id) !== deviceId
            || textValue(existingReceipt.openid) !== recipient.openid
          ) throw new Error("IDEMPOTENCY_CONFLICT");
        } else {
          requireDatabaseSuccess(await receiptCollection.doc(receiptId).set({
            data: {
              receiptId,
              eventId,
              deviceId,
              openid: recipient.openid,
              state: "UNREAD",
              readAt: "",
              notificationState: "NOT_REQUESTED",
              notificationAttempts: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          }));
        }

        const notificationCollection = database.collection(
          collections.caregiverNotificationOutbox,
        );
        const existingNotification = await documentOrNull(
          notificationCollection,
          notificationId,
        );
        if (existingNotification) {
          if (
            textValue(existingNotification.eventId, existingNotification.event_id) !== eventId
            || textValue(existingNotification.deviceId, existingNotification.device_id) !== deviceId
            || textValue(existingNotification.recipientOpenId) !== recipient.openid
          ) throw new Error("IDEMPOTENCY_CONFLICT");
          return true;
        }
        requireDatabaseSuccess(await notificationCollection.doc(notificationId).set({
          data: {
            notificationId,
            type: "MEDICATION_SAFETY_EVENT",
            templateKey: "MEDICATION_SAFETY_ALERT",
            deviceId,
            eventId,
            membershipId: recipient.membershipId,
            recipientOpenId: recipient.openid,
            sourcePayloadDigest: textValue(event.payloadDigest),
            state: "PENDING",
            attempts: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }));
        return true;
      };
      const delivered = await db.runTransaction(
        transaction => writeIfAuthorized(transaction),
      );
      if (delivered) deliveredOpenIds.add(recipient.openid);
    }
  }

  async function receiptIsRead(deviceId, eventId, openid) {
    const result = await db.collection(collections.caregiverEventReceipts)
      .where({ deviceId, eventId, openid })
      .limit(1)
      .get();
    const receipt = (result.data || [])[0];
    return Boolean(receipt && receipt.state === "READ");
  }

  async function report(data) {
    const event = data.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("event required");
    }
    const payloadEventId = requiredText(event.event_id || event.eventId, "event.event_id");
    const eventId = requiredText(data.eventId || data.event_id || payloadEventId, "eventId");
    if (payloadEventId !== eventId) throw new Error("eventId does not match event payload");

    const providedDigest = requiredText(
      data.payloadDigest || data.payload_digest,
      "payloadDigest",
    ).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(providedDigest)) throw new Error("invalid payloadDigest");
    const calculatedDigest = canonicalPayloadDigest(event);
    if (providedDigest !== calculatedDigest) throw new Error("PAYLOAD_DIGEST_MISMATCH");

    if (typeof db.runTransaction !== "function") {
      throw new Error("database transaction is unavailable");
    }
    const documentId = `${safeId(data.deviceId)}-${safeId(eventId)}`;
    const persisted = await db.runTransaction(async transaction => {
      const collection = transaction.collection(collections.medicationSafetyEvents);
      const existing = await documentOrNull(collection, documentId);
      if (existing) {
        if (
          eventIdentifier(existing) !== eventId
          || String(existing.payloadDigest || "") !== providedDigest
        ) {
          throw new Error("IDEMPOTENCY_CONFLICT");
        }
        return { event: existing, replay: true };
      }

      const timestamp = nowText();
      const storedEvent = Object.assign({}, event, {
        deviceId: data.deviceId,
        eventId,
        payloadDigest: providedDigest,
        syncOwner: "medication_safety_event",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      requireDatabaseSuccess(await collection.doc(documentId).set({ data: storedEvent }));
      return { event: storedEvent, replay: false };
    });
    await ensureCaregiverDelivery(persisted.event, data.deviceId);
    return { ok: true, eventId, payloadDigest: providedDigest, replay: persisted.replay };
  }

  async function list(data, wxContext) {
    const membership = await memberships.requireCaregiverAccess({
      openId: wxContext.OPENID,
      deviceId: data.deviceId,
      personId: data.personId || data.person_id,
    });
    const requestedPersonId = String(data.personId || data.person_id || "").trim();
    const scopes = membership.service_user_scopes || [];
    const eventRows = await listAllRows(
      db.collection(collections.medicationSafetyEvents),
      { deviceId: data.deviceId },
    );
    const receiptRows = await listAllRows(
      db.collection(collections.caregiverEventReceipts),
      { deviceId: data.deviceId, openid: membership.openid },
    );
    const readEventIds = new Set(receiptRows
      .filter(receipt => receipt.state === "READ")
      .map(receipt => String(receipt.eventId || receipt.event_id || "")));
    const limit = Math.min(Math.max(Number(data.limit) || 20, 1), 50);
    const cursor = decodeCursor(data.cursor);
    const unreadOnly = data.unreadOnly === true || data.unread_only === true;
    const requestedCheckStatus = textValue(data.checkStatus, data.check_status);
    const events = eventRows
      .filter(event => !requestedPersonId || eventPersonId(event) === requestedPersonId)
      .filter(event => !scopes.length || scopes.includes(eventPersonId(event)))
      .filter(event => !requestedCheckStatus || projectListItem(event, false).checkStatus === requestedCheckStatus)
      .filter(event => !unreadOnly || !readEventIds.has(eventIdentifier(event)))
      .sort(compareEvents)
      .filter(event => eventFollowsCursor(event, cursor));
    const items = events.slice(0, limit)
      .map(event => projectListItem(event, readEventIds.has(eventIdentifier(event))));
    const nextCursor = events.length > limit ? encodeCursor(events[limit - 1]) : "";
    return { ok: true, items, nextCursor };
  }

  async function get(data, wxContext) {
    const eventId = requiredText(data.eventId || data.event_id, "eventId");
    await memberships.requireCaregiverAccess({
      openId: wxContext.OPENID,
      deviceId: data.deviceId,
    });
    const documentId = `${safeId(data.deviceId)}-${safeId(eventId)}`;
    const event = await documentOrNull(
      db.collection(collections.medicationSafetyEvents),
      documentId,
    );
    if (
      !event
      || textValue(event.deviceId, event.device_id) !== data.deviceId
      || eventIdentifier(event) !== eventId
    ) {
      throw new Error("NOT_FOUND");
    }
    const membership = await memberships.requireCaregiverAccess({
      openId: wxContext.OPENID,
      deviceId: data.deviceId,
      personId: eventPersonId(event),
    });
    const read = await receiptIsRead(data.deviceId, eventId, membership.openid);
    return { ok: true, event: projectDetail(event, read) };
  }

  async function markRead(data, wxContext) {
    const eventId = requiredText(data.eventId || data.event_id, "eventId");
    await memberships.requireCaregiverAccess({
      openId: wxContext.OPENID,
      deviceId: data.deviceId,
    });
    const eventDocumentId = `${safeId(data.deviceId)}-${safeId(eventId)}`;
    const event = await documentOrNull(
      db.collection(collections.medicationSafetyEvents),
      eventDocumentId,
    );
    if (
      !event
      || textValue(event.deviceId, event.device_id) !== data.deviceId
      || eventIdentifier(event) !== eventId
    ) {
      throw new Error("NOT_FOUND");
    }
    const membership = await memberships.requireCaregiverAccess({
      openId: wxContext.OPENID,
      deviceId: data.deviceId,
      personId: eventPersonId(event),
    });
    const receiptId = `${safeId(data.deviceId)}-${safeId(eventId)}-${safeId(membership.openid)}`;

    const writeReceipt = async database => {
      const collection = database.collection(collections.caregiverEventReceipts);
      const existing = await documentOrNull(collection, receiptId);
      if (existing && existing.state === "READ") {
        return {
          ok: true,
          eventId,
          state: "READ",
          readAt: textValue(existing.readAt, existing.read_at),
          replay: true,
        };
      }
      const timestamp = nowText();
      const receipt = Object.assign({}, existing || {}, {
        receiptId,
        eventId,
        deviceId: data.deviceId,
        openid: membership.openid,
        state: "READ",
        readAt: textValue(existing && existing.readAt, existing && existing.read_at) || timestamp,
        notificationState: textValue(
          existing && existing.notificationState,
          existing && existing.notification_state,
        ) || "NOT_REQUESTED",
        notificationAttempts: Number(firstPresent(
          existing && existing.notificationAttempts,
          existing && existing.notification_attempts,
          0,
        )) || 0,
        createdAt: textValue(existing && existing.createdAt, existing && existing.created_at) || timestamp,
        updatedAt: timestamp,
      });
      requireDatabaseSuccess(await collection.doc(receiptId).set({ data: receipt }));
      return { ok: true, eventId, state: "READ", readAt: receipt.readAt, replay: false };
    };

    if (typeof db.runTransaction !== "function") {
      throw new Error("database transaction is unavailable");
    }
    return db.runTransaction(transaction => writeReceipt(transaction));
  }

  return { get, list, markRead, report };
}

module.exports = { canonicalPayloadDigest, createMedicationSafetyEventModule };
