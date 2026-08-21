const { parseTimestamp } = require("./dateTime");

const SCHEMA_VERSION = 2;
const SCHEMA_REVISION = "3.0-three-box-library";
const ONLINE_THRESHOLD_MS = 60 * 1000;
const CONNECTION_STATES = Object.freeze([
  "loading",
  "online",
  "stale",
  "unavailable",
  "unpaired",
  "incompatible",
]);
const REQUIRED_CAPABILITIES = Object.freeze({
  snapshotBatch: "v2",
  snapshotFencing: "v1",
  snapshotCanonicalDigest: "jcs-sha256-v1",
  boardMedicineSnapshot: "v1",
  explicitInventoryState: "v1",
  medicineStorageBoxes: "v1",
  caregiverMembership: "v1",
});

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function capabilityValue(capabilities, key) {
  const snake = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  return text(capabilities[key] !== undefined ? capabilities[key] : capabilities[snake]);
}

function evaluateCompatibility(snapshot = {}) {
  const capabilities = objectValue(snapshot.capabilities);
  const schemaVersion = Number(snapshot.schemaVersion ?? snapshot.schema_version);
  const schemaRevision = text(snapshot.schemaRevision || snapshot.schema_revision);
  const missingCapabilities = Object.keys(REQUIRED_CAPABILITIES).filter(key => (
    capabilityValue(capabilities, key) !== REQUIRED_CAPABILITIES[key]
  ));
  const compatible = schemaVersion === SCHEMA_VERSION
    && schemaRevision === SCHEMA_REVISION
    && missingCapabilities.length === 0;
  return {
    compatible,
    schemaVersion,
    schemaRevision,
    capabilities,
    missingCapabilities,
    reason: compatible
      ? ""
      : (schemaRevision && schemaRevision !== SCHEMA_REVISION
        ? "云端版本待升级"
        : (missingCapabilities.length ? "云端同步能力待升级" : "暂时无法确认云端版本")),
  };
}

function heartbeatAge(device = {}, nowEpochMs = Date.now()) {
  const serverAge = Number(device.heartbeatAgeMs ?? device.heartbeat_age_ms);
  if (Number.isFinite(serverAge) && serverAge >= 0) return serverAge;
  const epoch = Number(device.lastSeenAtEpochMs ?? device.last_seen_at_epoch_ms);
  if (Number.isFinite(epoch) && epoch > 0) return Math.max(0, nowEpochMs - epoch);
  const parsed = parseTimestamp(device.lastSeenAt || device.last_seen_at || device.updatedAt);
  return parsed ? Math.max(0, nowEpochMs - parsed) : null;
}

function projection(values = {}) {
  const state = CONNECTION_STATES.includes(values.state) ? values.state : "unavailable";
  return {
    state,
    online: state === "online" ? true : (state === "stale" ? false : null),
    lastSeenAt: text(values.lastSeenAt),
    lastSeenAtEpochMs: Number(values.lastSeenAtEpochMs) || 0,
    heartbeatAgeMs: Number.isFinite(values.heartbeatAgeMs) ? values.heartbeatAgeMs : null,
    reason: text(values.reason),
  };
}

function projectConnection(device = {}, options = {}) {
  const lastSeenAt = text(device.lastSeenAt || device.last_seen_at || device.updatedAt);
  const lastSeenAtEpochMs = Number(device.lastSeenAtEpochMs ?? device.last_seen_at_epoch_ms) || 0;
  const availability = text(options.availability).toLowerCase();
  if (options.loading === true || availability === "loading") {
    return projection({ state: "loading", lastSeenAt, lastSeenAtEpochMs, reason: "正在确认药箱状态" });
  }
  if (["unpaired", "pairing-unavailable"].includes(availability) || options.unpaired === true) {
    return projection({ state: "unpaired", lastSeenAt, lastSeenAtEpochMs, reason: options.reason || "请先配对药箱" });
  }
  if (availability === "incompatible" || options.compatible === false) {
    return projection({ state: "incompatible", lastSeenAt, lastSeenAtEpochMs, reason: options.reason || "云端版本待升级" });
  }
  if (["error", "forbidden", "unavailable"].includes(availability) || options.unavailable === true) {
    return projection({ state: "unavailable", lastSeenAt, lastSeenAtEpochMs, reason: options.reason || "药箱状态暂不可用" });
  }
  const age = heartbeatAge(device, Number(options.nowEpochMs) || Date.now());
  if (age === null) {
    return projection({ state: "unavailable", lastSeenAt, lastSeenAtEpochMs, reason: options.reason || "尚未收到药箱心跳" });
  }
  if (age < ONLINE_THRESHOLD_MS) {
    return projection({ state: "online", lastSeenAt, lastSeenAtEpochMs, heartbeatAgeMs: age, reason: "药箱已同步" });
  }
  return projection({ state: "stale", lastSeenAt, lastSeenAtEpochMs, heartbeatAgeMs: age, reason: "等待药箱连接" });
}

function connectionCopy(connection = {}) {
  const state = CONNECTION_STATES.includes(connection.state) ? connection.state : "unavailable";
  const copy = {
    loading: { title: "正在确认药箱状态", hint: "请稍候", kind: "loading" },
    online: { title: "药箱在线", hint: "同步正常", kind: "online" },
    stale: { title: "等待药箱连接", hint: "可查看上次同步内容", kind: "stale" },
    unavailable: { title: "药箱状态暂不可用", hint: "请稍后重试", kind: "unavailable" },
    unpaired: { title: "请先配对药箱", hint: "完成授权后查看", kind: "unpaired" },
    incompatible: { title: "云端版本待升级", hint: "上次内容仍可查看", kind: "incompatible" },
  }[state];
  return Object.assign({}, copy, { reason: text(connection.reason) });
}

module.exports = {
  CONNECTION_STATES,
  ONLINE_THRESHOLD_MS,
  REQUIRED_CAPABILITIES,
  SCHEMA_REVISION,
  SCHEMA_VERSION,
  connectionCopy,
  evaluateCompatibility,
  heartbeatAge,
  projectConnection,
};
