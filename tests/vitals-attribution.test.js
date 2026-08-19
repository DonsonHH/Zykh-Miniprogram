const test = require("node:test");
const assert = require("node:assert/strict");

const vitalsAttribution = require("../miniprogram/modules/vitalsAttribution");
const api = require("../miniprogram/utils/api");

test("vitals transport normalization exposes one canonical attribution contract", () => {
  const record = api.normalizeVitals({
    id: "vitals-1",
    device_id: "box-1",
    heart_rate: 72,
    spo2_percent: 98,
    body_temp_c: 36.5,
    measured_at: "2026-08-10 15:20:00",
    service_user_id: "member-1",
    service_user_name_snapshot: "同步时姓名",
    service_user_name: "旧别名姓名",
    persona_generation: "v2",
    inquiry_session_id: "inquiry-1",
    attribution_source: "inquiry_session",
    attribution_revision: 3,
  });

  assert.equal(record.recordId, "vitals-1");
  assert.equal(record.deviceId, "box-1");
  assert.equal(record.personId, "member-1");
  assert.equal(record.personName, "同步时姓名");
  assert.equal(record.personaGeneration, "v2");
  assert.equal(record.inquirySessionId, "inquiry-1");
  assert.equal(record.attributionSource, "INQUIRY_SESSION");
  assert.equal(record.attributionRevision, 3);
  assert.equal(record.createdAt, "2026-08-10 15:20:00");
});

test("vitals normalization prefers canonical snake fields and fails closed on identity conflicts", () => {
  const canonical = api.normalizeVitals({
    personName: "旧别名姓名",
    service_user_name_snapshot: "测量时姓名",
    attribution_source: "standalone",
  });
  assert.equal(canonical.personName, "测量时姓名");
  assert.equal(canonical.attributionSource, "STANDALONE");

  const conflicted = api.normalizeVitals({
    personId: "legacy-person",
    service_user_id: "canonical-person",
    personaGeneration: "legacy-generation",
    persona_generation: "canonical-generation",
    inquirySessionId: "legacy-session",
    inquiry_session_id: "canonical-session",
    attributionSource: "STANDALONE",
    attribution_source: "INQUIRY_SESSION",
  });

  assert.equal(conflicted.personId, "");
  assert.equal(conflicted.personaGeneration, "");
  assert.equal(conflicted.inquirySessionId, "");
  assert.equal(conflicted.attributionSource, "");
  assert.equal(conflicted.attributionConflict, true);
  assert.deepEqual(
    [...conflicted.attributionConflictFields].sort(),
    ["attributionSource", "inquirySessionId", "personId", "personaGeneration"],
  );
});

test("canonical attribution remains legacy until the capability is declared", () => {
  const record = {
    personId: "member-1",
    personaGeneration: "generation-2",
    attributionSource: "INQUIRY_SESSION",
  };
  const activeUsers = [{ id: "member-1", personaGeneration: "generation-2" }];

  const unsupported = vitalsAttribution.classifyVitalsAttribution(record, {
    activeUsers,
    attributionSupported: false,
  });
  const supported = vitalsAttribution.classifyVitalsAttribution(record, {
    activeUsers,
    attributionSupported: true,
  });

  assert.equal(unsupported.kind, "LEGACY");
  assert.equal(unsupported.canAttach, false);
  assert.equal(supported.kind, "MEMBER");
  assert.equal(vitalsAttribution.supportsVitalsAttribution({
    capabilities: { vitalsAttribution: "v1" },
  }), true);
  assert.equal(vitalsAttribution.supportsVitalsAttribution({ capabilities: {} }), false);
});

test("a transport identity conflict is broken and never becomes a member", () => {
  const attribution = vitalsAttribution.classifyVitalsAttribution({
    personId: "member-1",
    personaGeneration: "generation-2",
    attributionSource: "INQUIRY_SESSION",
    attributionConflict: true,
    attributionConflictFields: ["personId"],
  }, {
    attributionSupported: true,
    activeUsers: [{ id: "member-1", personaGeneration: "generation-2" }],
  });

  assert.equal(attribution.kind, "BROKEN_INQUIRY");
  assert.equal(attribution.canAttach, false);
  assert.equal(attribution.label, "归属信息同步异常");
});

test("an inquiry measurement becomes a member only through an exact active id and generation", () => {
  const attribution = vitalsAttribution.classifyVitalsAttribution({
    recordId: "vitals-001",
    personId: "member-1",
    personName: "测量时的王奶奶",
    personaGeneration: "generation-2",
    inquirySessionId: "inquiry-001",
    attributionSource: "INQUIRY_SESSION",
  }, {
    activeUsers: [
      { id: "same-name-other-id", name: "测量时的王奶奶", personaGeneration: "generation-2" },
      { id: "member-1", name: "旧代人物", personaGeneration: "generation-1" },
      { id: "member-1", name: "当前人物", personaGeneration: "generation-2" },
    ],
  });

  assert.equal(attribution.kind, "MEMBER");
  assert.equal(attribution.canAttach, true);
  assert.equal(attribution.personId, "member-1");
  assert.equal(attribution.personaGeneration, "generation-2");
  assert.equal(attribution.label, "测量时的王奶奶");
  assert.equal(attribution.recordId, "vitals-001");
  assert.equal(attribution.inquirySessionId, "inquiry-001");
  assert.equal(attribution.attributionSource, "INQUIRY_SESSION");
});

test("a remote command measurement becomes a member only through the same exact persona tuple", () => {
  const attribution = vitalsAttribution.classifyVitalsAttribution({
    recordId: "vitals-remote-001",
    personId: "member-1",
    personName: "王奶奶",
    personaGeneration: "generation-2",
    attributionSource: "REMOTE_COMMAND",
  }, {
    attributionSupported: true,
    activeUsers: [
      { id: "member-1", name: "王奶奶", personaGeneration: "generation-2" },
    ],
  });

  assert.equal(attribution.kind, "MEMBER");
  assert.equal(attribution.canAttach, true);
  assert.equal(attribution.attributionSource, "REMOTE_COMMAND");
  assert.equal(vitalsAttribution.matchesVitalsPersonScope(attribution, {
    personId: "member-1",
    personaGeneration: "generation-2",
  }), true);
});

test("an inquiry measurement without a stable id is broken even when its name matches", () => {
  const attribution = vitalsAttribution.classifyVitalsAttribution({
    recordId: "vitals-broken",
    personName: "王奶奶",
    personaGeneration: "generation-2",
    inquirySessionId: "inquiry-broken",
    attributionSource: "INQUIRY_SESSION",
  }, {
    activeUsers: [
      { id: "member-1", name: "王奶奶", personaGeneration: "generation-2" },
    ],
  });

  assert.equal(attribution.kind, "BROKEN_INQUIRY");
  assert.equal(attribution.canAttach, false);
  assert.equal(attribution.label, "归属信息同步异常");
  assert.equal(attribution.recordId, "vitals-broken");
  assert.equal(attribution.inquirySessionId, "inquiry-broken");
  assert.equal(attribution.attributionSource, "INQUIRY_SESSION");
});

test("an inquiry measurement cannot attach to an archived exact identity", () => {
  const attribution = vitalsAttribution.classifyVitalsAttribution({
    personId: "member-archived",
    personName: "归档人物",
    personaGeneration: "generation-1",
    attributionSource: "INQUIRY_SESSION",
  }, {
    activeUsers: [
      { id: "member-archived", name: "归档人物", personaGeneration: "generation-1", archived: true },
    ],
  });

  assert.equal(attribution.kind, "BROKEN_INQUIRY");
  assert.equal(attribution.canAttach, false);
});

test("a conflicting active row cannot revive an exact archived identity", () => {
  for (const activeUsers of [[
    { id: "member-conflict", personaGeneration: "generation-1", archived: false },
    { id: "member-conflict", personaGeneration: "generation-1", archived: true },
  ], [
    { id: "member-conflict", personaGeneration: "generation-1", archived: true },
    { id: "member-conflict", personaGeneration: "generation-1", archived: false },
  ]]) {
    const attribution = vitalsAttribution.classifyVitalsAttribution({
      personId: "member-conflict",
      personaGeneration: "generation-1",
      attributionSource: "INQUIRY_SESSION",
    }, { activeUsers });

    assert.equal(attribution.kind, "BROKEN_INQUIRY");
    assert.equal(attribution.canAttach, false);
  }
});

test("a standalone measurement stays unregistered even if stale identity fields are present", () => {
  const attribution = vitalsAttribution.classifyVitalsAttribution({
    personId: "stale-member",
    personName: "不应沿用的人物",
    personaGeneration: "generation-1",
    attributionSource: "STANDALONE",
  }, {
    activeUsers: [
      { id: "stale-member", name: "不应沿用的人物", personaGeneration: "generation-1" },
    ],
  });

  assert.equal(attribution.kind, "STANDALONE");
  assert.equal(attribution.canAttach, false);
  assert.equal(attribution.label, "未登记人员");
});

test("a legacy measurement may display its saved name but never gains member attachment", () => {
  const attribution = vitalsAttribution.classifyVitalsAttribution({
    personId: "legacy-member",
    personName: "旧记录姓名",
    personaGeneration: "legacy-generation",
  }, {
    activeUsers: [
      { id: "legacy-member", name: "旧记录姓名", personaGeneration: "legacy-generation" },
    ],
  });

  assert.equal(attribution.kind, "LEGACY");
  assert.equal(attribution.canAttach, false);
  assert.equal(attribution.label, "旧记录姓名（旧记录）");
});

test("person scope matching requires a member attribution with the exact id and generation", () => {
  const member = vitalsAttribution.classifyVitalsAttribution({
    personId: "member-1",
    personName: "同名人物",
    personaGeneration: "generation-2",
    attributionSource: "INQUIRY_SESSION",
  }, {
    activeUsers: [
      { id: "member-1", name: "同名人物", personaGeneration: "generation-2" },
    ],
  });
  const standalone = vitalsAttribution.classifyVitalsAttribution({
    personId: "member-1",
    personName: "同名人物",
    personaGeneration: "generation-2",
    attributionSource: "STANDALONE",
  });

  assert.equal(vitalsAttribution.matchesVitalsPersonScope(member, {
    personId: "member-1",
    personaGeneration: "generation-2",
  }), true);
  assert.equal(vitalsAttribution.matchesVitalsPersonScope(member, {
    personId: "same-name-other-id",
    personaGeneration: "generation-2",
    personName: "同名人物",
  }), false);
  assert.equal(vitalsAttribution.matchesVitalsPersonScope(member, {
    personId: "member-1",
    personaGeneration: "generation-1",
  }), false);
  assert.equal(vitalsAttribution.matchesVitalsPersonScope(standalone, {
    personId: "member-1",
    personaGeneration: "generation-2",
  }), false);
});
