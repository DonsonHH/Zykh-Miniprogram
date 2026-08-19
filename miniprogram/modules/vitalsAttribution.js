function text(value, fallback = "") {
  const normalized = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function supportsVitalsAttribution(capabilitySnapshot = {}) {
  const capabilities = capabilitySnapshot.capabilities || capabilitySnapshot || {};
  const value = capabilities.vitalsAttribution !== undefined
    ? capabilities.vitalsAttribution
    : capabilities.vitals_attribution;
  if (value === true || value === 1) return true;
  return /^v?1(?:$|[.\-_])/.test(text(value).toLowerCase());
}

function classifyVitalsAttribution(record = {}, options = {}) {
  const personId = text(record.personId);
  const personName = text(record.personName);
  const personaGeneration = text(record.personaGeneration);
  const attributionSource = text(record.attributionSource).toUpperCase();
  const identity = {
    recordId: text(record.recordId),
    personId,
    personName,
    personaGeneration,
    inquirySessionId: text(record.inquirySessionId),
    attributionSource,
    attributionConflict: record.attributionConflict === true,
    attributionConflictFields: Array.isArray(record.attributionConflictFields)
      ? record.attributionConflictFields.slice()
      : [],
  };
  const attributionSupported = Object.prototype.hasOwnProperty.call(options, "attributionSupported")
    ? options.attributionSupported === true
    : true;
  if (!attributionSupported) {
    return Object.assign({}, identity, {
      kind: "LEGACY",
      canAttach: false,
      label: personName ? `${personName}（旧记录）` : "未登记人员（旧记录）",
    });
  }
  if (record.attributionConflict === true) {
    return Object.assign({}, identity, {
      kind: "BROKEN_INQUIRY",
      canAttach: false,
      label: "归属信息同步异常",
    });
  }
  const exactUsers = (options.activeUsers || []).filter(user => (
    user
    && text(user.id) === personId
    && text(user.personaGeneration) === personaGeneration
  ));
  const hasArchivedExactUser = exactUsers.some(user => user.archived === true);
  const activeUser = hasArchivedExactUser
    ? null
    : exactUsers.find(user => user.archived !== true);

  const memberSources = ["INQUIRY_SESSION", "REMOTE_COMMAND"];
  if (memberSources.includes(attributionSource) && personId && personaGeneration && activeUser) {
    return Object.assign({}, identity, {
      kind: "MEMBER",
      canAttach: true,
      label: personName || text(activeUser.name, "已登记人员"),
    });
  }

  if (memberSources.includes(attributionSource)) {
    return Object.assign({}, identity, {
      kind: "BROKEN_INQUIRY",
      canAttach: false,
      label: "归属信息同步异常",
    });
  }

  if (attributionSource === "STANDALONE") {
    return Object.assign({}, identity, {
      kind: "STANDALONE",
      canAttach: false,
      label: "未登记人员",
    });
  }

  return Object.assign({}, identity, {
    kind: "LEGACY",
    canAttach: false,
    label: personName ? `${personName}（旧记录）` : "未登记人员（旧记录）",
  });
}

function matchesVitalsPersonScope(attribution = {}, scope = {}) {
  if (attribution.kind !== "MEMBER" || attribution.canAttach !== true) return false;
  const personId = text(attribution.personId);
  const personaGeneration = text(attribution.personaGeneration);
  return Boolean(personId && personaGeneration)
    && personId === text(scope.personId)
    && personaGeneration === text(scope.personaGeneration);
}

module.exports = {
  supportsVitalsAttribution,
  classifyVitalsAttribution,
  matchesVitalsPersonScope,
};
