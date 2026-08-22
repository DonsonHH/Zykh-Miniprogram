const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REQUIRED_CAPABILITIES,
  connectionCopy,
  evaluateCompatibility,
  projectConnection,
} = require("../miniprogram/utils/connectionState");

test("only an exact Release A capability profile is compatible", () => {
  const compatible = evaluateCompatibility({
    schemaVersion: 2,
    schemaRevision: "3.0-three-box-library",
    capabilities: REQUIRED_CAPABILITIES,
  });
  assert.equal(compatible.compatible, true);

  const oldCloud = evaluateCompatibility({
    schemaVersion: 2,
    schemaRevision: "2.7-runtime-consistency",
    capabilities: { snapshotBatch: "v2" },
  });
  assert.equal(oldCloud.compatible, false);
  assert.equal(oldCloud.reason, "云端版本待升级");
});

test("server heartbeat age wins over the phone clock", () => {
  const connection = projectConnection({
    heartbeatAgeMs: 2000,
    lastSeenAtEpochMs: 1,
  }, { nowEpochMs: Date.now() + 999999999 });
  assert.equal(connection.state, "online");
  assert.equal(connection.online, true);
  assert.equal(connection.heartbeatAgeMs, 2000);
});

test("connection states preserve loading, stale, unavailable, unpaired and incompatible", () => {
  assert.equal(projectConnection({}, { loading: true }).state, "loading");
  assert.equal(projectConnection({ heartbeatAgeMs: 60000 }).state, "stale");
  assert.equal(projectConnection({}, { unavailable: true }).state, "unavailable");
  assert.equal(projectConnection({}, { unpaired: true }).state, "unpaired");
  assert.equal(projectConnection({}, { compatible: false }).state, "incompatible");
});

test("non-blocking connection states keep browsing copy explicit", () => {
  assert.equal(connectionCopy({ state: "loading" }).title, "正在确认药箱状态");
  assert.equal(connectionCopy({ state: "online" }).title, "药箱在线");
  assert.equal(connectionCopy({ state: "stale" }).title, "等待同步");
  assert.equal(connectionCopy({ state: "unavailable" }).title, "等待同步");
  assert.equal(connectionCopy({ state: "incompatible" }).title, "等待同步");
  assert.equal(connectionCopy({ state: "unpaired" }).title, "尚未连接药箱");
});
