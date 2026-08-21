function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function textList(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(text).filter(Boolean)))
    : [];
}

function generationMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.keys(value).reduce((result, personId) => {
    const id = text(personId);
    const generation = text(value[personId]);
    if (id && generation) result[id] = generation;
    return result;
  }, {});
}

function membershipIdentity(membership = {}) {
  const scopes = textList(
    membership.service_user_scopes || membership.serviceUserScopes,
  );
  const generations = generationMap(
    membership.service_user_generations || membership.serviceUserGenerations,
  );
  const generationKeys = Object.keys(generations).sort();
  const scopeKeys = scopes.slice().sort();
  const exact = scopeKeys.length > 0
    && scopeKeys.length === generationKeys.length
    && scopeKeys.every((personId, index) => personId === generationKeys[index]);
  return { scopes, generations, exact };
}

function rowIdentity(row = {}) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  return {
    personId: text(
      row.service_user_id
      || row.serviceUserId
      || row.target_user_id
      || row.targetUserId
      || row.person_id
      || row.personId
      || row.user_id
      || row.userId
      || payload.service_user_id
      || payload.serviceUserId
      || payload.target_user_id
      || payload.targetUserId
      || payload.person_id
      || payload.personId,
    ),
    personaGeneration: text(
      row.persona_generation
      || row.personaGeneration
      || payload.persona_generation
      || payload.personaGeneration,
    ),
  };
}

function allowsPersona(membership = {}, personId = "", personaGeneration = "") {
  const identity = membershipIdentity(membership);
  const id = text(personId);
  const generation = text(personaGeneration);
  if (!identity.exact || !id || !generation) return false;
  return identity.scopes.includes(id) && identity.generations[id] === generation;
}

function assertStrictMembership(membership = {}) {
  const identity = membershipIdentity(membership);
  if (!identity.exact) {
    const error = new Error("PERSONA_MEMBERSHIP_MIGRATION_REQUIRED");
    error.code = "PERSONA_MEMBERSHIP_MIGRATION_REQUIRED";
    throw error;
  }
  return identity;
}

module.exports = {
  allowsPersona,
  assertStrictMembership,
  generationMap,
  membershipIdentity,
  rowIdentity,
  textList,
};
