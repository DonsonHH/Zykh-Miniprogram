const test = require("node:test");
const assert = require("node:assert/strict");
const {
  groupInquiriesByPerson,
  inquiryFromAiCommand,
  inquiryMatchesPersonScope,
  mergeInquirySources,
  normalizeInquiryRecord,
  shouldShowInquiryForServiceUsers,
  shouldShowCaregiverInquiry,
} = require("../miniprogram/utils/api");

test("hides an inquiry for the explicitly archived generation of a stable service user", () => {
  const serviceUsers = [{
    id: "member-rebuilt",
    personaGeneration: "generation-v1",
    archived: true,
  }];

  assert.equal(shouldShowInquiryForServiceUsers({
    service_user_id: "member-rebuilt",
    persona_generation: "generation-v1",
  }, serviceUsers), false);
});

test("does not guess a generation when the same stable id has active and archived personas", () => {
  const serviceUsers = [
    { id: "member-rebuilt", personaGeneration: "generation-v1", archived: true },
    { id: "member-rebuilt", personaGeneration: "generation-v2", archived: false },
  ];

  assert.equal(shouldShowInquiryForServiceUsers({
    service_user_id: "member-rebuilt",
  }, serviceUsers), false);
});

test("fails closed on a known stable id with an unmatched persona generation", () => {
  const serviceUsers = [{
    id: "member-rebuilt",
    personaGeneration: "generation-v2",
    archived: false,
  }];

  assert.equal(shouldShowInquiryForServiceUsers({
    service_user_id: "member-rebuilt",
    persona_generation: "generation-v1",
  }, serviceUsers), false);
});

test("shows an active matching generation while preserving unknown legacy identities", () => {
  const serviceUsers = [{
    id: "member-active",
    personaGeneration: "generation-v2",
    archived: false,
  }];

  assert.equal(shouldShowInquiryForServiceUsers({
    service_user_id: "member-active",
    persona_generation: "generation-v2",
  }, serviceUsers), true);
  assert.equal(shouldShowInquiryForServiceUsers({
    service_user_id: "unknown-member",
  }, serviceUsers), true);
  assert.equal(shouldShowInquiryForServiceUsers({ title: "legacy-unlinked" }, serviceUsers), true);
});

test("keeps each family member's inquiry summaries in a separate group", () => {
  const groups = groupInquiriesByPerson([
    {
      inquiry_id: "alice-1",
      target_user_id: "alice",
      target_user_name: "Alice",
      topic: "头痛怎么办？",
      summary: "观察症状并按需就医。",
      updated_at: "2026-08-01 09:00:00",
    },
    {
      inquiry_id: "bob-1",
      target_user_id: "bob",
      target_user_name: "Bob",
      topic: "血氧偏低怎么办？",
      summary: "建议重新测量。",
      updated_at: "2026-08-01 10:00:00",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.personName).sort(), ["Alice", "Bob"]);
  assert.deepEqual(groups.find(group => group.personName === "Alice").inquiries.map(item => item.topic), ["头痛怎么办？"]);
  assert.deepEqual(groups.find(group => group.personName === "Bob").inquiries.map(item => item.topic), ["血氧偏低怎么办？"]);
});

test("keeps same-name family members separate when only service user ids differ", () => {
  const groups = groupInquiriesByPerson([
    {
      inquiry_id: "alex-1",
      service_user_id: "service-alex-1",
      display_name: "Alex",
      topic: "question-one",
      updated_at: "2026-08-01 09:00:00",
    },
    {
      inquiry_id: "alex-2",
      service_user_id: "service-alex-2",
      display_name: "Alex",
      topic: "question-two",
      updated_at: "2026-08-01 10:00:00",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.personKey).sort(), ["service-alex-1", "service-alex-2"]);
});

test("keeps rebuilt personas separate when a stable id is reused with a new generation", () => {
  const groups = groupInquiriesByPerson([
    {
      inquiry_id: "old-session",
      service_user_id: "member-rebuilt",
      persona_generation: "generation-v1",
      display_name: "同名家人",
      updated_at: "2026-08-01 09:00:00",
    },
    {
      inquiry_id: "new-session",
      service_user_id: "member-rebuilt",
      persona_generation: "generation-v2",
      display_name: "同名家人",
      updated_at: "2026-08-02 09:00:00",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.personKey).sort(), [
    "member-rebuilt::generation-v1",
    "member-rebuilt::generation-v2",
  ]);
  assert.deepEqual(groups.map(group => group.personaGeneration).sort(), ["generation-v1", "generation-v2"]);
});

test("keeps same-name generated inquiries separate even when their stable person id is absent", () => {
  const groups = groupInquiriesByPerson([
    {
      inquiry_id: "legacy-persona-v1",
      target_user_name: "同名家人",
      persona_generation: "generation-v1",
      updated_at: "2026-08-01 09:00:00",
    },
    {
      inquiry_id: "legacy-persona-v2",
      target_user_name: "同名家人",
      personaGeneration: "generation-v2",
      updated_at: "2026-08-02 09:00:00",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.personKey).sort(), [
    "同名家人::generation-v1",
    "同名家人::generation-v2",
  ]);
});

test("strict person scope treats a missing generation as a legacy tuple instead of a wildcard", () => {
  const generatedInquiry = {
    service_user_id: "member-legacy-id",
    persona_generation: "generation-v1",
  };

  assert.equal(inquiryMatchesPersonScope(generatedInquiry, {
    personId: "member-legacy-id",
  }), true);
  assert.equal(inquiryMatchesPersonScope(generatedInquiry, {
    personId: "member-legacy-id",
  }, { strictGeneration: true }), false);
  assert.equal(inquiryMatchesPersonScope({
    service_user_id: "member-legacy-id",
  }, {
    personId: "member-legacy-id",
  }, { strictGeneration: true }), true);
});

test("AI command summaries retain a service user identity", () => {
  const inquiry = inquiryFromAiCommand({
    _id: "command-1",
    type: "AI_CHAT",
    payload: {
      service_user_id: "service-alex-1",
      service_user_name: "Alex",
      question: "question",
    },
    result: { summary: "summary" },
  });

  assert.equal(inquiry.target_user_id, "service-alex-1");
  assert.equal(inquiry.service_user_id, "service-alex-1");
  assert.equal(inquiry.display_name, "Alex");
  assert.deepEqual(inquiry.messages, []);
});

test("an AI command fallback and its saved session merge by session id", () => {
  const command = inquiryFromAiCommand({
    _id: "command-7",
    type: "AI_CHAT",
    status: "done",
    created_at: "2026-08-08 09:00:00",
    payload: {
      service_user_id: "member-7",
      service_user_name: "妈妈",
      question: "持续咳嗽怎么办？",
    },
    result: {
      session_id: "session-7",
      summary: "已收到药箱端回复。",
      messageCount: 2,
    },
  });
  const savedSession = {
    inquiry_id: "session-7",
    session_id: "session-7",
    target_user_id: "member-7",
    target_user_name: "妈妈",
    title: "持续咳嗽",
    reasoning_summary: "先观察体温、精神状态和呼吸是否费力。",
    next_steps: ["记录体温", "补充水分"],
    messageCount: 4,
    updated_at: "2026-08-08 09:01:00",
  };

  const rows = mergeInquirySources([savedSession], [command]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "session-7");
  assert.equal(rows[0].summary, "先观察体温、精神状态和呼吸是否费力。");
  assert.deepEqual(rows[0].messages, []);
});

test("a raw legacy transcript is labelled as a record instead of fabricated dialogue turns", () => {
  const inquiry = normalizeInquiryRecord({
    inquiry_id: "legacy-text",
    target_user_name: "妈妈",
    messages: "第一段原始记录\n第二段原始记录",
  });

  assert.deepEqual(inquiry.messages.map(item => item.role), ["system", "system"]);
  assert.deepEqual(inquiry.messages.map(item => item.roleText), ["药箱原始记录", "药箱原始记录"]);
});

test("a compact inquiry advertises an available process without fabricating dialogue", () => {
  const inquiry = normalizeInquiryRecord({
    inquiry_id: "session-1",
    target_user_id: "member-1",
    target_user_name: "妈妈",
    title: "头痛",
    reasoning_summary: "先休息并补充水分。",
    messageCount: 3,
  });

  assert.equal(inquiry.conversationReady, true);
  assert.equal(inquiry.messages.length, 0);
  assert.equal(inquiry.hasDetail, true);
});

test("gives an unlinked completed record a neutral label", () => {
  const inquiry = normalizeInquiryRecord({
    inquiry_id: "unlinked-1",
    title: "Free-text person question",
    summary: "Saved summary.",
  });

  assert.equal(inquiry.personName, "问询记录");
  assert.equal(groupInquiriesByPerson([inquiry])[0].personName, "问询记录");
});

test("only exposes completed inquiries in the summary", () => {
  const visibleIds = [
    {
      inquiry_id: "finished-result",
      service_user_id: "member-mom",
      service_user_name: "妈妈",
      stage: "result",
      next_action: "show_recommendation",
      reasoning_summary: "已形成照护建议。",
    },
    {
      inquiry_id: "finished-escalation",
      target_user_id: "member-dad",
      target_user_name: "爸爸",
      stage: "escalated",
      next_action: "escalate",
      risk_level: "high",
    },
    {
      inquiry_id: "legacy-finished",
      target_user_id: "member-grandma",
      target_user_name: "奶奶",
      reasoning_summary: "保留的旧版照护结论。",
      next_steps: ["继续观察"],
    },
    {
      inquiry_id: "legacy-risk-decision",
      target_user_id: "member-grandpa",
      target_user_name: "爷爷",
      reasoning_summary: "旧版同步仅保留了风险判断。",
      risk_level: "medium",
      status: "idle",
      messageCount: 11,
    },
    {
      inquiry_id: "ambiguous-summary-only",
      target_user_id: "member-grandma",
      target_user_name: "奶奶",
      title: "奶奶的新问询",
      reasoning_summary: "您好，今天感觉哪里不舒服呢？",
    },
    {
      inquiry_id: "ambiguous-assessment-only",
      target_user_id: "member-grandma",
      target_user_name: "奶奶",
      title: "奶奶的新问询",
      final_assessment: { summary: "您好，今天感觉哪里不舒服呢？" },
    },
    {
      inquiry_id: "still-asking",
      target_user_id: "member-mom",
      stage: "clarification",
      next_action: "ask",
      reasoning_summary: "仍在收集症状。",
    },
    {
      inquiry_id: "waiting-vitals",
      target_user_id: "member-dad",
      stage: "vitals",
      next_action: "measure_vitals",
      reasoning_summary: "等待现场测量。",
    },
    {
      inquiry_id: "visitor-still-asking",
      guest_id: "guest-1",
      guest_name: "访客",
      stage: "clarification",
      next_action: "ask",
      reasoning_summary: "仍在收集访客症状。",
    },
    {
      inquiry_id: "visitor-finished",
      guest_id: "guest-1",
      guest_name: "访客",
      stage: "result",
      next_action: "complete",
      reasoning_summary: "访客问询结论。",
    },
    {
      inquiry_id: "unlinked-finished",
      stage: "result",
      next_action: "complete",
      reasoning_summary: "没有关联到家属。",
    },
    {
      inquiry_id: "command-ack-only",
      sourceCommandId: "command-1",
      target_user_id: "member-mom",
      reasoning_summary: "仅是传输确认。",
    },
  ].filter(shouldShowCaregiverInquiry).map(item => item.inquiry_id);

  assert.deepEqual(visibleIds, [
    "finished-result",
    "finished-escalation",
    "legacy-finished",
    "legacy-risk-decision",
    "visitor-finished",
    "unlinked-finished",
  ]);
});

test("keeps a useful legacy care summary while skipping a legacy opening prompt", () => {
  const usefulLegacySummary = {
    inquiry_id: "legacy-useful-summary",
    guest_id: "guest-legacy",
    guest_name: "访客",
    title: "有点感冒了",
    reasoning_summary: "建议补充水分、充分休息，并观察体温和呼吸变化。",
    risk_level: "medium",
    final_assessment: {
      summary: "普通感冒症状，暂未出现紧急风险。",
    },
    // Historical cloud rows did not include stage / next_action.
  };
  const legacyOpening = {
    inquiry_id: "legacy-opening",
    guest_name: "访客",
    title: "访客的新问询",
    reply: "您好，今天感觉哪里不舒服呢？",
  };

  assert.equal(shouldShowCaregiverInquiry(usefulLegacySummary), true);
  assert.equal(shouldShowCaregiverInquiry(legacyOpening), false);
});

test("localizes Station risk codes for the family-facing summary", () => {
  const emergency = normalizeInquiryRecord({ inquiry_id: "risk-1", risk_level: "emergency" });
  const low = normalizeInquiryRecord({ inquiry_id: "risk-2", risk_label: "low" });

  assert.equal(emergency.riskLabel, "紧急风险");
  assert.equal(low.riskLabel, "低风险");
  assert.equal(emergency.detailLines.find(item => item.label === "风险提示").value, "紧急风险");
});

test("marks a transport-bounded inquiry process without hiding its saved summary", () => {
  const inquiry = normalizeInquiryRecord({
    inquiry_id: "session-truncated",
    target_user_id: "member-1",
    target_user_name: "濡堝",
    title: "持续咳嗽",
    reasoning_summary: "建议继续观察体温和呼吸。",
    messageCount: 100,
    syncedMessageCount: 18,
    conversationTruncated: true,
  });

  assert.equal(inquiry.conversationReady, true);
  assert.equal(inquiry.messageCount, 100);
  assert.equal(inquiry.syncedMessageCount, 18);
  assert.equal(inquiry.conversationTruncated, true);
});
