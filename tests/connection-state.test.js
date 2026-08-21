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

test("only stale uses the waiting-for-connection copy", () => {
  const states = ["loading", "online", "stale", "unavailable", "unpaired", "incompatible"];
  states.forEach(state => {
    const title = connectionCopy({ state }).title;
    assert.equal(title === "等待药箱连接", state === "stale", state);
  });
});
