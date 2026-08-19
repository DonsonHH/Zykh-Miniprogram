const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPersonaVisibilityPolicy,
} = require("../miniprogram/modules/personaVisibility");

const users = [{
  id: "member-1",
  name: "当前成员",
  personaGeneration: "v2",
  archived: false,
}, {
  id: "member-1",
  name: "旧成员",
  personaGeneration: "v1",
  archived: true,
}, {
  id: "retired",
  name: "已归档成员",
  personaGeneration: "legacy",
  archived: true,
}];

function strictPolicy(onViolation) {
  return createPersonaVisibilityPolicy(users, {
    capabilities: { personaLifecycle: "v1" },
    serviceUsersSnapshotComplete: true,
    onViolation,
  });
}

test("persona lifecycle strict mode requires both capability and a complete snapshot", () => {
  assert.equal(createPersonaVisibilityPolicy(users, {
    capabilities: {},
    serviceUsersSnapshotComplete: true,
  }).strict, false);
  assert.equal(createPersonaVisibilityPolicy(users, {
    capabilities: { personaLifecycle: "v1" },
    serviceUsersSnapshotComplete: false,
  }).strict, false);
  assert.equal(strictPolicy().strict, true);
});

test("legacy and incomplete snapshots retain unknown identities without reviving known tombstones", () => {
  const policy = createPersonaVisibilityPolicy(users, {
    capabilities: { personaLifecycle: "v1" },
    serviceUsersSnapshotComplete: false,
  });

  assert.equal(policy.allowsPlan({ service_user_id: "unknown", persona_generation: "v1" }), true);
  assert.equal(policy.allowsInquiry({ personId: "unknown", personaGeneration: "v1" }), true);
  assert.equal(policy.allowsPlan({ service_user_id: "retired", persona_generation: "legacy" }), false);
});

test("strict policy accepts only the active stable id and generation tuple", () => {
  const policy = strictPolicy();

  assert.equal(policy.allowsPlan({ service_user_id: "member-1", persona_generation: "v2" }), true);
  assert.equal(policy.allowsPlan({ service_user_id: "member-1", persona_generation: "v1" }), false);
  assert.equal(policy.allowsPlan({ service_user_id: "member-1" }), false);
  assert.equal(policy.allowsPlan({ service_user_id: "unknown", persona_generation: "v1" }), false);
  assert.equal(policy.allowsPlan({ target_user_name: "当前成员" }), false);
});

test("strict policy keeps true guest inquiries but never attaches them by display name", () => {
  const policy = strictPolicy();

  assert.equal(policy.allowsInquiry({ id: "inquiry-1", guest_name: "当前成员" }), true);
  assert.equal(policy.allowsInquiry({ personId: "member-1", personName: "当前成员", personaGeneration: "v2" }), true);
  assert.equal(policy.allowsInquiry({ personId: "member-1", personName: "当前成员" }), false);
  assert.equal(policy.allowsInquiry({ personId: "unknown", personName: "当前成员", personaGeneration: "v2" }), false);
});

test("current-record policy makes unlinked records an explicit caller choice", () => {
  const policy = strictPolicy();

  assert.equal(policy.allowsCurrentRecord({ service_user_id: "member-1", persona_generation: "v2" }), true);
  assert.equal(policy.allowsCurrentRecord({ service_user_id: "unknown", persona_generation: "v2" }), false);
  assert.equal(policy.allowsCurrentRecord({}, { allowUnlinked: false }), false);
  assert.equal(policy.allowsCurrentRecord({}, { allowUnlinked: true }), true);
});

test("strict rejections expose diagnostics without leaking names into identity matching", () => {
  const diagnostics = [];
  const policy = strictPolicy(item => diagnostics.push(item));

  policy.allowsPlan({ service_user_id: "unknown", target_user_name: "当前成员", persona_generation: "v2" });
  policy.allowsInquiry({ personId: "member-1", personaGeneration: "v1" });

  assert.deepEqual(diagnostics.map(item => item.reason), ["unknown_person", "archived_person"]);
  assert.deepEqual(diagnostics.map(item => item.kind), ["plan", "inquiry"]);
});

test("an archived tombstone always wins an exact active tuple regardless of row order", () => {
  const active = {
    id: "conflicted-person",
    name: "迟到的当前行",
    personaGeneration: "generation-1",
    archived: false,
  };
  const tombstone = {
    id: "conflicted-person",
    name: "归档标记",
    personaGeneration: "generation-1",
    archived: true,
  };

  for (const rows of [[active, tombstone], [tombstone, active]]) {
    const policy = createPersonaVisibilityPolicy(rows, {
      capabilities: { personaLifecycle: "v1" },
      serviceUsersSnapshotComplete: true,
    });
    assert.equal(policy.allowsPlan({
      service_user_id: "conflicted-person",
      persona_generation: "generation-1",
    }), false);
    assert.deepEqual(policy.activeUsers(), []);
  }
});

test("strict current-person projection excludes contract-invalid users without a generation", () => {
  const policy = createPersonaVisibilityPolicy([{
    id: "missing-generation",
    name: "不完整人物",
    archived: false,
  }], {
    capabilities: { personaLifecycle: "v1" },
    serviceUsersSnapshotComplete: true,
  });

  assert.deepEqual(policy.activeUsers(), []);
});
