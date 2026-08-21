const crypto = require("crypto");
const {
  CANONICAL_DIGEST_VERSION,
  canonicalize,
  canonicalSnapshotDigest,
  sha256Hex,
} = require("./canonicalDigest");

const SNAPSHOT_PROTOCOL = "boardMedicineSnapshot:v1";
const SNAPSHOT_KIND = "medicines";
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const MIN_RETAIN_MS = 10 * 60 * 1000;
const VALID_STORAGE_BOXES = new Set(["DAILY", "CARE", "PRESCRIPTION"]);

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function numberField(value, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw protocolError(code);
  return number;
}

function safeId(value) {
  return text(value).replace(/[^A-Za-z0-9_.-]/g, "-");
}

function documentNotFound(value) {
  const code = text(value && (value.errCode ?? value.code)).toUpperCase();
  const message = text((value && (value.errMsg || value.message)) || value);
  return code === "DATABASE_DOCUMENT_NOT_EXIST"
    || code === "DOCUMENT_NOT_EXIST"
    || /document(?:\s+with\s+_id\s+\S+)?\s+(?:does\s+)?not\s+exist|document\s+not\s+found|missing\s+document|文档不存在/i.test(message);
}

function databaseFailed(value) {
  const code = value && (value.errCode ?? value.code);
  const message = text(value && (value.errMsg || value.message));
  return (code !== undefined && code !== null && code !== 0 && code !== "0")
    || /:fail\b/i.test(message);
}

async function documentOrNull(collection, id) {
  try {
    const result = await collection.doc(id).get();
    if (documentNotFound(result)) return null;
    if (databaseFailed(result)) throw protocolError("DATABASE_REQUEST_FAILED");
    return result && result.data ? result.data : null;
  } catch (error) {
    if (documentNotFound(error)) return null;
    throw error;
  }
}

function normalizeDigest(value) {
  const digest = text(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw protocolError("SNAPSHOT_DIGEST_INVALID");
  return digest;
}

function normalizeKind(value) {
  const kind = text(value);
  if (kind !== SNAPSHOT_KIND) throw protocolError("SNAPSHOT_KIND_NOT_FINALIZABLE");
  return kind;
}

function cleanSnapshotRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("SNAPSHOT_ROW_INVALID");
  }
  const row = Object.assign({}, value);
  [
    "_id",
    "_openid",
    "deviceSecret",
    "leaseToken",
    "snapshotLease",
    "serverReceivedAt",
    "serverReceivedAtEpochMs",
  ].forEach(field => delete row[field]);
  if (Object.prototype.hasOwnProperty.call(row, "cabinet_id")
      || Object.prototype.hasOwnProperty.call(row, "cabinetId")) {
    throw protocolError("PHYSICAL_CABINET_FIELD_FORBIDDEN");
  }
  // Canonicalization is also the strict JSON-value validator.
  canonicalize(row);
  return row;
}

function medicineRowIdentity(row = {}) {
  const camelId = text(row.medicineId);
  const snakeId = text(row.medicine_id);
  if (camelId && snakeId && camelId !== snakeId) {
    throw protocolError("MEDICINE_IDENTITY_CONFLICT");
  }
  const medicineId = camelId || snakeId;
  if (!medicineId) throw protocolError("MEDICINE_ID_REQUIRED");

  const camelBox = text(row.storageBox).toUpperCase();
  const snakeBox = text(row.storage_box).toUpperCase();
  if (camelBox && snakeBox && camelBox !== snakeBox) {
    throw protocolError("MEDICINE_STORAGE_BOX_CONFLICT");
  }
  const storageBox = camelBox || snakeBox;
  if (!VALID_STORAGE_BOXES.has(storageBox)) {
    throw protocolError("MEDICINE_STORAGE_BOX_INVALID");
  }
  return { medicineId, storageBox };
}

function snapshotInput(data = {}) {
  const deviceId = text(data.deviceId);
  const instanceId = text(data.instanceId || data.instance_id);
  const kind = normalizeKind(data.kind);
  const rowCount = numberField(data.rowCount ?? data.row_count, "SNAPSHOT_ROW_COUNT_INVALID");
  const digest = normalizeDigest(data.digest);
  const canonicalDigestVersion = text(
    data.canonicalDigestVersion || data.canonical_digest_version,
  );
  if (!deviceId) throw protocolError("DEVICE_ID_REQUIRED");
  if (!instanceId) throw protocolError("SNAPSHOT_INSTANCE_REQUIRED");
  if (rowCount > 2000) throw protocolError("SNAPSHOT_ROW_COUNT_INVALID");
  if (canonicalDigestVersion !== CANONICAL_DIGEST_VERSION) {
    throw protocolError("SNAPSHOT_DIGEST_VERSION_UNSUPPORTED");
  }
  return { deviceId, instanceId, kind, rowCount, digest, canonicalDigestVersion };
}

function assertRowDeviceScope(row, deviceId) {
  const camel = text(row.deviceId);
  const snake = text(row.device_id);
  if (camel && snake && camel !== snake) throw protocolError("SNAPSHOT_ROW_DEVICE_CONFLICT");
  const rowDeviceId = camel || snake;
  if (rowDeviceId && rowDeviceId !== deviceId) {
    throw protocolError("SNAPSHOT_ROW_DEVICE_SCOPE_MISMATCH");
  }
}

function envelopeInput(data = {}) {
  const base = snapshotInput(data);
  const snapshotId = text(data.snapshotId || data.snapshot_id);
  const snapshotRevision = numberField(
    data.snapshotRevision ?? data.snapshot_revision ?? data.revision,
    "SNAPSHOT_REVISION_INVALID",
  );
  const leaseToken = text(data.leaseToken || data.lease_token || data.snapshotLease);
  if (!snapshotId) throw protocolError("SNAPSHOT_ID_REQUIRED");
  if (snapshotRevision < 1) throw protocolError("SNAPSHOT_REVISION_INVALID");
  if (!leaseToken) throw protocolError("SNAPSHOT_LEASE_REQUIRED");
  return Object.assign(base, { snapshotId, snapshotRevision, leaseToken });
}

function headDocumentId(deviceId, kind) {
  return `${safeId(deviceId)}--${safeId(kind)}`;
}

function rowDocumentId(snapshotId, canonicalRowId) {
  return `${safeId(snapshotId)}--${sha256Hex(canonicalRowId)}`;
}

function sessionMatches(session, input, nowEpochMs) {
  return Boolean(
    session
    && text(session.state).toUpperCase() === "ACTIVE"
    && text(session.deviceId) === input.deviceId
    && text(session.kind) === input.kind
    && text(session.instanceId) === input.instanceId
    && text(session.digest).toLowerCase() === input.digest
    && Number(session.rowCount) === input.rowCount
    && Number(session.leaseExpiresAtEpochMs) > nowEpochMs,
  );
}

function assertActiveSession(head, session, input, nowEpochMs) {
  if (!head || text(head.activeSnapshotId) !== input.snapshotId
      || Number(head.activeSnapshotRevision) !== input.snapshotRevision) {
    throw protocolError("SNAPSHOT_FENCE_REJECTED");
  }
  if (!session || text(session.state).toUpperCase() !== "ACTIVE") {
    throw protocolError("SNAPSHOT_NOT_ACTIVE");
  }
  if (text(session.deviceId) !== input.deviceId
      || text(session.kind) !== input.kind
      || text(session.instanceId) !== input.instanceId
      || Number(session.snapshotRevision) !== input.snapshotRevision
      || text(session.digest).toLowerCase() !== input.digest
      || Number(session.rowCount) !== input.rowCount
      || text(session.canonicalDigestVersion) !== input.canonicalDigestVersion) {
    throw protocolError("SNAPSHOT_ENVELOPE_MISMATCH");
  }
  if (text(session.leaseTokenHash) !== sha256Hex(input.leaseToken)) {
    throw protocolError("SNAPSHOT_LEASE_INVALID");
  }
  if (Number(session.leaseExpiresAtEpochMs) <= nowEpochMs) {
    throw protocolError("SNAPSHOT_LEASE_EXPIRED");
  }
}

function createSnapshotStore({ db, collections, nowText, nowEpochMs = () => Date.now() }) {
  const names = Object.assign({
    snapshotHeads: "snapshot_heads",
    snapshotSessions: "snapshot_sessions",
    snapshotRows: "snapshot_rows",
    snapshotManifests: "snapshot_manifests",
  }, collections || {});

  async function listSnapshotRows(snapshotId, maximum = 2000) {
    const rows = [];
    for (let offset = 0; offset < maximum; offset += 100) {
      const result = await db.collection(names.snapshotRows)
        .where({ snapshotId })
        .skip(offset)
        .limit(100)
        .get();
      if (databaseFailed(result)) throw protocolError("DATABASE_REQUEST_FAILED");
      const page = result.data || [];
      rows.push(...page);
      if (page.length < 100) break;
    }
    return rows;
  }

  async function begin(data = {}) {
    if (typeof db.runTransaction !== "function") {
      throw protocolError("SNAPSHOT_TRANSACTION_UNAVAILABLE");
    }
    const input = snapshotInput(data);
    const startedAtEpochMs = Number(nowEpochMs());
    const headId = headDocumentId(input.deviceId, input.kind);
    return db.runTransaction(async transaction => {
      const heads = transaction.collection(names.snapshotHeads);
      const sessions = transaction.collection(names.snapshotSessions);
      const head = await documentOrNull(heads, headId);
      const activeSnapshotId = text(head && head.activeSnapshotId);
      const activeSession = activeSnapshotId
        ? await documentOrNull(sessions, activeSnapshotId)
        : null;

      if (sessionMatches(activeSession, input, startedAtEpochMs)) {
        const leaseToken = text(data.leaseToken || data.lease_token || data.snapshotLease);
        if (!leaseToken) throw protocolError("SNAPSHOT_LEASE_REQUIRED");
        if (text(activeSession.leaseTokenHash) !== sha256Hex(leaseToken)) {
          throw protocolError("SNAPSHOT_LEASE_INVALID");
        }
        const leaseExpiresAtEpochMs = startedAtEpochMs + DEFAULT_LEASE_MS;
        const resumed = Object.assign({}, activeSession, {
          leaseExpiresAtEpochMs,
          leaseExpiresAt: new Date(leaseExpiresAtEpochMs).toISOString(),
          updatedAt: nowText(),
        });
        delete resumed._id;
        await sessions.doc(activeSnapshotId).set({ data: resumed });
        return {
          deviceId: input.deviceId,
          instanceId: input.instanceId,
          kind: input.kind,
          snapshotId: activeSnapshotId,
          snapshotRevision: Number(activeSession.snapshotRevision),
          digest: input.digest,
          canonicalDigestVersion: input.canonicalDigestVersion,
          leaseToken,
          leaseExpiresAtEpochMs,
          resumed: true,
        };
      }

      if (activeSession && text(activeSession.state).toUpperCase() === "ACTIVE"
          && Number(activeSession.leaseExpiresAtEpochMs) > startedAtEpochMs) {
        throw protocolError("SNAPSHOT_LEASE_ACTIVE");
      }

      const previousRevision = Math.max(
        Number(head && head.nextRevision) || 0,
        Number(head && head.currentRevision) || 0,
        Number(head && head.activeSnapshotRevision) || 0,
      );
      const snapshotRevision = previousRevision + 1;
      const snapshotId = `${safeId(input.deviceId)}-${input.kind}-r${snapshotRevision}-${crypto.randomBytes(8).toString("hex")}`;
      const leaseToken = crypto.randomBytes(24).toString("hex");
      const leaseExpiresAtEpochMs = startedAtEpochMs + DEFAULT_LEASE_MS;
      const timestamp = nowText();
      const session = Object.assign({}, input, {
        snapshotId,
        snapshotRevision,
        state: "ACTIVE",
        leaseTokenHash: sha256Hex(leaseToken),
        leaseExpiresAtEpochMs,
        leaseExpiresAt: new Date(leaseExpiresAtEpochMs).toISOString(),
        batches: [],
        receivedCanonicalIds: [],
        receivedCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await sessions.doc(snapshotId).set({ data: session });
      await heads.doc(headId).set({ data: Object.assign({}, head || {}, {
        deviceId: input.deviceId,
        kind: input.kind,
        nextRevision: snapshotRevision,
        activeSnapshotId: snapshotId,
        activeSnapshotRevision: snapshotRevision,
        activeInstanceId: input.instanceId,
        updatedAt: timestamp,
      }) });
      return {
        deviceId: input.deviceId,
        instanceId: input.instanceId,
        kind: input.kind,
        snapshotId,
        snapshotRevision,
        digest: input.digest,
        canonicalDigestVersion: input.canonicalDigestVersion,
        leaseToken,
        leaseExpiresAtEpochMs,
        resumed: false,
      };
    });
  }

  async function upsertBatch(data = {}) {
    if (typeof db.runTransaction !== "function") {
      throw protocolError("SNAPSHOT_TRANSACTION_UNAVAILABLE");
    }
    const input = envelopeInput(data);
    const batchOrdinal = numberField(
      data.batchOrdinal ?? data.batch_ordinal,
      "SNAPSHOT_BATCH_ORDINAL_INVALID",
    );
    const rowOffset = numberField(
      data.rowOffset ?? data.row_offset,
      "SNAPSHOT_ROW_OFFSET_INVALID",
    );
    const sourceRows = Array.isArray(data.rows) ? data.rows : null;
    if (!sourceRows || !sourceRows.length) throw protocolError("SNAPSHOT_BATCH_EMPTY");
    if (sourceRows.length > 100) throw protocolError("SNAPSHOT_BATCH_TOO_LARGE");
    if (rowOffset + sourceRows.length > input.rowCount) {
      throw protocolError("SNAPSHOT_BATCH_RANGE_INVALID");
    }
    const rows = sourceRows.map(cleanSnapshotRow);
    rows.forEach(row => assertRowDeviceScope(row, input.deviceId));
    const ids = rows.map(row => medicineRowIdentity(row).medicineId);
    if (new Set(ids).size !== ids.length) throw protocolError("SNAPSHOT_DUPLICATE_ROW_ID");
    const rowBytes = rows.map(canonicalize);
    const rowHashes = rowBytes.map(sha256Hex);
    const now = Number(nowEpochMs());
    const headId = headDocumentId(input.deviceId, input.kind);

    return db.runTransaction(async transaction => {
      const heads = transaction.collection(names.snapshotHeads);
      const sessions = transaction.collection(names.snapshotSessions);
      const rowCollection = transaction.collection(names.snapshotRows);
      const head = await documentOrNull(heads, headId);
      const session = await documentOrNull(sessions, input.snapshotId);
      assertActiveSession(head, session, input, now);

      const batches = Array.isArray(session.batches) ? session.batches.slice() : [];
      const existingBatch = batches.find(batch => Number(batch.batchOrdinal) === batchOrdinal);
      if (existingBatch) {
        const same = Number(existingBatch.rowOffset) === rowOffset
          && Number(existingBatch.count) === rows.length
          && JSON.stringify(existingBatch.ids || []) === JSON.stringify(ids)
          && JSON.stringify(existingBatch.rowHashes || []) === JSON.stringify(rowHashes);
        if (!same) throw protocolError("SNAPSHOT_BATCH_CONFLICT");
        return {
          deviceId: input.deviceId,
          kind: input.kind,
          snapshotId: input.snapshotId,
          snapshotRevision: input.snapshotRevision,
          digest: input.digest,
          count: ids.length,
          ids,
          idempotent: true,
        };
      }

      const rangeEnd = rowOffset + rows.length;
      if (batches.some(batch => {
        const start = Number(batch.rowOffset);
        const end = start + Number(batch.count);
        return rowOffset < end && start < rangeEnd;
      })) throw protocolError("SNAPSHOT_BATCH_RANGE_OVERLAP");

      const receivedIds = new Set(session.receivedCanonicalIds || []);
      if (ids.some(id => receivedIds.has(id))) {
        throw protocolError("SNAPSHOT_DUPLICATE_ROW_ID");
      }

      for (let index = 0; index < rows.length; index += 1) {
        const canonicalRowId = ids[index];
        const documentId = rowDocumentId(input.snapshotId, canonicalRowId);
        const existing = await documentOrNull(rowCollection, documentId);
        if (existing) {
          if (text(existing.canonicalBytes) !== rowBytes[index]) {
            throw protocolError("SNAPSHOT_ROW_CONFLICT");
          }
        } else {
          await rowCollection.doc(documentId).set({ data: {
            deviceId: input.deviceId,
            kind: input.kind,
            snapshotId: input.snapshotId,
            snapshotRevision: input.snapshotRevision,
            canonicalRowId,
            ordinal: rowOffset + index,
            canonicalBytes: rowBytes[index],
            rowDigest: rowHashes[index],
            row: rows[index],
            state: "STAGING",
            createdAt: nowText(),
          } });
        }
      }

      const leaseExpiresAtEpochMs = now + DEFAULT_LEASE_MS;
      const batch = { batchOrdinal, rowOffset, count: rows.length, ids, rowHashes };
      const updated = Object.assign({}, session, {
        batches: batches.concat(batch),
        receivedCanonicalIds: (session.receivedCanonicalIds || []).concat(ids),
        receivedCount: Number(session.receivedCount || 0) + rows.length,
        leaseExpiresAtEpochMs,
        leaseExpiresAt: new Date(leaseExpiresAtEpochMs).toISOString(),
        updatedAt: nowText(),
      });
      delete updated._id;
      await sessions.doc(input.snapshotId).set({ data: updated });
      return {
        deviceId: input.deviceId,
        kind: input.kind,
        snapshotId: input.snapshotId,
        snapshotRevision: input.snapshotRevision,
        digest: input.digest,
        count: ids.length,
        ids,
        idempotent: false,
      };
    });
  }

  async function finalize(data = {}) {
    if (typeof db.runTransaction !== "function") {
      throw protocolError("SNAPSHOT_TRANSACTION_UNAVAILABLE");
    }
    const input = envelopeInput(data);
    const now = Number(nowEpochMs());
    const headId = headDocumentId(input.deviceId, input.kind);
    const headBefore = await documentOrNull(db.collection(names.snapshotHeads), headId);
    const sessionBefore = await documentOrNull(
      db.collection(names.snapshotSessions),
      input.snapshotId,
    );
    assertActiveSession(headBefore, sessionBefore, input, now);

    const staged = await listSnapshotRows(input.snapshotId);
    const ids = staged.map(item => text(item.canonicalRowId));
    const ordinals = staged.map(item => Number(item.ordinal));
    if (staged.length !== input.rowCount
        || Number(sessionBefore.receivedCount) !== input.rowCount
        || new Set(ids).size !== input.rowCount
        || new Set(sessionBefore.receivedCanonicalIds || []).size !== input.rowCount
        || new Set(ordinals).size !== input.rowCount
        || ordinals.some(value => !Number.isInteger(value) || value < 0 || value >= input.rowCount)) {
      throw protocolError("SNAPSHOT_INCOMPLETE");
    }
    const rows = staged.map(item => cleanSnapshotRow(item.row));
    const actualDigest = canonicalSnapshotDigest(
      input.deviceId,
      input.kind,
      rows,
      row => medicineRowIdentity(row).medicineId,
    );
    if (actualDigest !== input.digest) throw protocolError("SNAPSHOT_DIGEST_MISMATCH");

    return db.runTransaction(async transaction => {
      const heads = transaction.collection(names.snapshotHeads);
      const sessions = transaction.collection(names.snapshotSessions);
      const manifests = transaction.collection(names.snapshotManifests);
      const head = await documentOrNull(heads, headId);
      const session = await documentOrNull(sessions, input.snapshotId);
      assertActiveSession(head, session, input, Number(nowEpochMs()));

      const timestamp = nowText();
      const finalizedAtEpochMs = Number(nowEpochMs());
      const manifest = {
        protocol: SNAPSHOT_PROTOCOL,
        deviceId: input.deviceId,
        kind: input.kind,
        snapshotId: input.snapshotId,
        revision: input.snapshotRevision,
        snapshotRevision: input.snapshotRevision,
        digest: input.digest,
        canonicalDigestVersion: input.canonicalDigestVersion,
        ids: ids.slice().sort(),
        rowCount: input.rowCount,
        snapshotComplete: true,
        state: "FINALIZED",
        finalizedAt: timestamp,
        finalizedAtEpochMs,
      };
      await manifests.doc(input.snapshotId).set({ data: manifest });

      const previousSnapshotId = text(head.currentSnapshotId);
      if (previousSnapshotId && previousSnapshotId !== input.snapshotId) {
        const previousManifest = await documentOrNull(manifests, previousSnapshotId);
        if (previousManifest) {
          const superseded = Object.assign({}, previousManifest, {
            state: "SUPERSEDED",
            supersededAt: timestamp,
            supersededAtEpochMs: finalizedAtEpochMs,
            retainUntilEpochMs: finalizedAtEpochMs + MIN_RETAIN_MS,
          });
          delete superseded._id;
          await manifests.doc(previousSnapshotId).set({ data: superseded });
        }
      }

      const finalizedSession = Object.assign({}, session, {
        state: "FINALIZED",
        finalizedAt: timestamp,
        finalizedAtEpochMs,
        updatedAt: timestamp,
      });
      delete finalizedSession._id;
      await sessions.doc(input.snapshotId).set({ data: finalizedSession });
      await heads.doc(headId).set({ data: Object.assign({}, head, {
        currentSnapshotId: input.snapshotId,
        currentRevision: input.snapshotRevision,
        currentDigest: input.digest,
        currentRowCount: input.rowCount,
        currentFinalizedAt: timestamp,
        currentFinalizedAtEpochMs: finalizedAtEpochMs,
        activeSnapshotId: "",
        activeSnapshotRevision: 0,
        activeInstanceId: "",
        updatedAt: timestamp,
      }) });
      return Object.assign({}, manifest, { boardMedicineSnapshot: "v1" });
    });
  }

  async function abort(data = {}) {
    if (typeof db.runTransaction !== "function") {
      throw protocolError("SNAPSHOT_TRANSACTION_UNAVAILABLE");
    }
    const input = envelopeInput(data);
    const headId = headDocumentId(input.deviceId, input.kind);
    return db.runTransaction(async transaction => {
      const heads = transaction.collection(names.snapshotHeads);
      const sessions = transaction.collection(names.snapshotSessions);
      const head = await documentOrNull(heads, headId);
      const session = await documentOrNull(sessions, input.snapshotId);
      assertActiveSession(head, session, input, Number(nowEpochMs()));
      const timestamp = nowText();
      const aborted = Object.assign({}, session, {
        state: "ABORTED",
        abortedAt: timestamp,
        abortedAtEpochMs: Number(nowEpochMs()),
        updatedAt: timestamp,
      });
      delete aborted._id;
      await sessions.doc(input.snapshotId).set({ data: aborted });
      await heads.doc(headId).set({ data: Object.assign({}, head, {
        activeSnapshotId: "",
        activeSnapshotRevision: 0,
        activeInstanceId: "",
        updatedAt: timestamp,
      }) });
      return {
        deviceId: input.deviceId,
        kind: input.kind,
        snapshotId: input.snapshotId,
        snapshotRevision: input.snapshotRevision,
        digest: input.digest,
        state: "ABORTED",
      };
    });
  }

  async function readMedicineSnapshot(deviceId, versionToken = {}) {
    const normalizedDeviceId = text(deviceId);
    if (!normalizedDeviceId) throw protocolError("DEVICE_ID_REQUIRED");
    const requestedSnapshotId = text(versionToken.snapshotId || versionToken.snapshot_id);
    let snapshotId = requestedSnapshotId;
    if (!snapshotId) {
      const headId = headDocumentId(normalizedDeviceId, SNAPSHOT_KIND);
      const head = await documentOrNull(db.collection(names.snapshotHeads), headId);
      snapshotId = text(head && head.currentSnapshotId);
    }
    if (!snapshotId) throw protocolError("MEDICINE_SNAPSHOT_NOT_FOUND");
    const manifest = await documentOrNull(
      db.collection(names.snapshotManifests),
      snapshotId,
    );
    const manifestState = text(manifest && manifest.state).toUpperCase();
    const readableSuperseded = manifestState === "SUPERSEDED"
      && Number(manifest.retainUntilEpochMs || 0) >= Number(nowEpochMs());
    if (!manifest
        || (manifestState !== "FINALIZED" && !readableSuperseded)
        || manifest.snapshotComplete !== true
        || text(manifest.deviceId) !== normalizedDeviceId
        || text(manifest.kind) !== SNAPSHOT_KIND) {
      throw protocolError("MEDICINE_SNAPSHOT_INCOMPLETE");
    }
    const requestedRevision = Number(
      versionToken.snapshotRevision ?? versionToken.snapshot_revision ?? versionToken.revision,
    );
    if (Number.isFinite(requestedRevision) && requestedRevision > 0
        && requestedRevision !== Number(manifest.revision || manifest.snapshotRevision)) {
      throw protocolError("MEDICINE_SNAPSHOT_VERSION_MISMATCH");
    }
    const requestedDigest = text(versionToken.digest).toLowerCase();
    if (requestedDigest && requestedDigest !== text(manifest.digest).toLowerCase()) {
      throw protocolError("MEDICINE_SNAPSHOT_VERSION_MISMATCH");
    }
    const staged = await listSnapshotRows(snapshotId);
    const rows = staged
      .slice()
      .sort((left, right) => (
        text(left.canonicalRowId) < text(right.canonicalRowId)
          ? -1
          : (text(left.canonicalRowId) > text(right.canonicalRowId) ? 1 : 0)
      ))
      .map(item => cleanSnapshotRow(item.row));
    const ids = rows.map(row => medicineRowIdentity(row).medicineId);
    if (rows.length !== Number(manifest.rowCount)
        || new Set(ids).size !== rows.length
        || JSON.stringify(ids.slice().sort()) !== JSON.stringify((manifest.ids || []).slice().sort())) {
      throw protocolError("MEDICINE_SNAPSHOT_INCOMPLETE");
    }
    const digest = canonicalSnapshotDigest(
      normalizedDeviceId,
      SNAPSHOT_KIND,
      rows,
      row => medicineRowIdentity(row).medicineId,
    );
    if (digest !== text(manifest.digest).toLowerCase()) {
      throw protocolError("MEDICINE_SNAPSHOT_DIGEST_INVALID");
    }
    return {
      boardMedicineSnapshot: "v1",
      protocol: SNAPSHOT_PROTOCOL,
      deviceId: normalizedDeviceId,
      kind: SNAPSHOT_KIND,
      snapshotId,
      revision: Number(manifest.revision || manifest.snapshotRevision),
      snapshotRevision: Number(manifest.revision || manifest.snapshotRevision),
      digest,
      canonicalDigestVersion: CANONICAL_DIGEST_VERSION,
      snapshotComplete: true,
      rowCount: rows.length,
      finalizedAt: text(manifest.finalizedAt),
      finalizedAtEpochMs: Number(manifest.finalizedAtEpochMs) || 0,
      versionState: manifestState,
      rows,
    };
  }

  async function listMedicines(deviceId) {
    return (await readMedicineSnapshot(deviceId)).rows;
  }

  async function readCurrentManifest(deviceId) {
    const snapshot = await readMedicineSnapshot(deviceId);
    return {
      boardMedicineSnapshot: snapshot.boardMedicineSnapshot,
      protocol: snapshot.protocol,
      deviceId: snapshot.deviceId,
      kind: snapshot.kind,
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      snapshotRevision: snapshot.snapshotRevision,
      digest: snapshot.digest,
      canonicalDigestVersion: snapshot.canonicalDigestVersion,
      snapshotComplete: snapshot.snapshotComplete,
      rowCount: snapshot.rowCount,
      finalizedAt: snapshot.finalizedAt,
      finalizedAtEpochMs: snapshot.finalizedAtEpochMs,
      versionState: snapshot.versionState,
    };
  }

  return {
    abort,
    begin,
    finalize,
    listMedicines,
    readCurrentManifest,
    readMedicineSnapshot,
    upsertBatch,
  };
}

module.exports = {
  DEFAULT_LEASE_MS,
  MIN_RETAIN_MS,
  SNAPSHOT_KIND,
  SNAPSHOT_PROTOCOL,
  VALID_STORAGE_BOXES,
  cleanSnapshotRow,
  createSnapshotStore,
  medicineRowIdentity,
};
