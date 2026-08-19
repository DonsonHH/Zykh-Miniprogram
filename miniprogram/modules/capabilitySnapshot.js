function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function mergeCapabilitySnapshots(...sources) {
  const result = { capabilities: {} };
  sources.forEach(sourceValue => {
    const source = objectValue(sourceValue);
    Object.assign(result.capabilities, objectValue(source.capabilities));
    const schemaVersion = present(source.schemaVersion) ? source.schemaVersion : source.schema_version;
    const schemaRevision = present(source.schemaRevision) ? source.schemaRevision : source.schema_revision;
    if (present(schemaVersion)) result.schemaVersion = schemaVersion;
    if (present(schemaRevision)) result.schemaRevision = schemaRevision;
  });
  return result;
}

module.exports = {
  mergeCapabilitySnapshots,
};
