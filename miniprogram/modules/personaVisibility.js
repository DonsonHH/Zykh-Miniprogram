function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return "";
}

function supportsV1(value) {
  if (value === true || value === 1) return true;
  const version = text(value).toLowerCase();
  return version === "v1" || version === "1" || version.indexOf("v1.") === 0;
}

function personIdOf(value = {}) {
  const payload = value.payload && typeof value.payload === "object" ? value.payload : {};
  return firstText(
    value.personId,
    value.person_id,
    value.serviceUserId,
    value.service_user_id,
    value.targetUserId,
    value.target_user_id,
    value.userId,
    value.user_id,
    payload.personId,
    payload.person_id,
    payload.serviceUserId,
    payload.service_user_id,
    payload.targetUserId,
    payload.target_user_id,
    payload.userId,
    payload.user_id,
  );
}

function personaGenerationOf(value = {}) {
  const payload = value.payload && typeof value.payload === "object" ? value.payload : {};
  return firstText(
    value.personaGeneration,
    value.persona_generation,
    value.personGeneration,
    value.person_generation,
    payload.personaGeneration,
    payload.persona_generation,
    payload.personGeneration,
    payload.person_generation,
  );
}

function normalizeUser(value = {}) {
  return Object.assign({}, value, {
    id: firstText(value.id, personIdOf(value)),
    personaGeneration: personaGenerationOf(value),
    archived: value.archived === true || value.is_archived === true,
  });
}

function createPersonaVisibilityPolicy(serviceUsers = [], options = {}) {
  const capabilities = options.capabilities && typeof options.capabilities === "object"
    ? options.capabilities
    : {};
  const lifecycleCapability = capabilities.personaLifecycle !== undefined
    ? capabilities.personaLifecycle
    : capabilities.persona_lifecycle;
  const snapshotComplete = options.serviceUsersSnapshotComplete === true
    || options.service_users_snapshot_complete === true;
  const strict = supportsV1(lifecycleCapability) && snapshotComplete;
  const users = (Array.isArray(serviceUsers) ? serviceUsers : [])
    .map(normalizeUser)
    .filter(user => user.id);
  const byId = new Map();
  users.forEach(user => {
    const rows = byId.get(user.id) || [];
    rows.push(user);
    byId.set(user.id, rows);
  });
  // A complete v1 snapshot is authoritative.  Multiple active rows for one
  // stable id are an identity conflict; fail closed instead of guessing.
  const conflictedIds = new Set();
  byId.forEach((rows, id) => {
    const active = rows.filter(user => user.archived !== true);
    if (active.length > 1) conflictedIds.add(id);
  });
  const onViolation = typeof options.onViolation === "function"
    ? options.onViolation
    : () => {};

  function reject(kind, reason, personId, personaGeneration) {
    onViolation({ kind, reason, personId, personaGeneration });
    return false;
  }

  function exactRows(personId, personaGeneration) {
    return (byId.get(personId) || [])
      .filter(user => user.personaGeneration === personaGeneration);
  }

  function allowsIdentity(value, kind, allowUnlinked) {
    const personId = personIdOf(value);
    const personaGeneration = personaGenerationOf(value);
    if (!personId) {
      if (allowUnlinked) return true;
      return strict
        ? reject(kind, "missing_person_id", "", personaGeneration)
        : true;
    }

    const candidates = byId.get(personId) || [];
    if (strict && conflictedIds.has(personId)) {
      return reject(kind, "conflicting_person", personId, personaGeneration);
    }
    if (!candidates.length) {
      return strict
        ? reject(kind, "unknown_person", personId, personaGeneration)
        : true;
    }

    if (!personaGeneration) {
      if (strict) return reject(kind, "missing_persona_generation", personId, "");
      const active = candidates.filter(user => user.archived !== true);
      return active.length === 1 && candidates.length === 1;
    }

    const exact = exactRows(personId, personaGeneration);
    if (!exact.length) {
      return reject(kind, "persona_generation_mismatch", personId, personaGeneration);
    }
    if (exact.some(user => user.archived === true)) {
      return reject(kind, "archived_person", personId, personaGeneration);
    }
    return true;
  }

  return {
    strict,
    activeUsers() {
      const seen = new Set();
      return users.filter(user => {
        if (user.archived === true) return false;
        if (strict && conflictedIds.has(user.id)) return false;
        if (strict && !user.personaGeneration) return false;
        const tuple = `${user.id}\u0000${user.personaGeneration}`;
        if (exactRows(user.id, user.personaGeneration).some(row => row.archived === true)) return false;
        if (seen.has(tuple)) return false;
        seen.add(tuple);
        return true;
      });
    },
    allowsPlan(plan = {}) {
      return allowsIdentity(plan, "plan", false);
    },
    allowsInquiry(inquiry = {}) {
      return allowsIdentity(inquiry, "inquiry", true);
    },
    allowsCurrentRecord(record = {}, recordOptions = {}) {
      return allowsIdentity(record, "record", recordOptions.allowUnlinked === true);
    },
  };
}

module.exports = {
  createPersonaVisibilityPolicy,
  personIdOf,
  personaGenerationOf,
};
