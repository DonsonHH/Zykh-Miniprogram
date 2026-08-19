const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compactPlan,
  planMatchesServiceUser,
  shouldShowPlanForServiceUsers,
} = require("../miniprogram/utils/api");

test("plan normalization keeps persona generation from snake and camel transports", () => {
  assert.equal(compactPlan({ persona_generation: "generation-v1" }).personaGeneration, "generation-v1");
  assert.equal(compactPlan({ personaGeneration: "generation-v2" }).personaGeneration, "generation-v2");
});

test("a plan matches only the active service-user identity tuple by default", () => {
  const plan = {
    service_user_id: "member-rebuilt",
    persona_generation: "generation-v2",
    target_user_name: "同名家人",
  };

  assert.equal(planMatchesServiceUser(plan, {
    id: "member-rebuilt",
    personaGeneration: "generation-v2",
    archived: false,
  }), true);
  assert.equal(planMatchesServiceUser(plan, {
    id: "member-rebuilt",
    personaGeneration: "generation-v1",
    archived: false,
  }), false);
  assert.equal(planMatchesServiceUser(plan, {
    id: "member-rebuilt",
    personaGeneration: "generation-v2",
    archived: true,
  }), false);
  assert.equal(planMatchesServiceUser({
    service_user_id: "member-rebuilt",
  }, {
    id: "member-rebuilt",
    personaGeneration: "generation-v2",
  }, { strictGeneration: true }), false);
  assert.equal(planMatchesServiceUser({
    service_user_id: "legacy-member",
  }, {
    id: "legacy-member",
  }, { strictGeneration: true }), true);
});

test("plan matching never downgrades a stable or generated identity to a same-name guess", () => {
  assert.equal(planMatchesServiceUser({
    service_user_id: "member-old",
    target_user_name: "同名家人",
  }, {
    id: "member-new",
    name: "同名家人",
  }), false);
  assert.equal(planMatchesServiceUser({
    target_user_name: "同名家人",
    persona_generation: "generation-v1",
  }, {
    name: "同名家人",
    personaGeneration: "generation-v1",
  }), false);
  assert.equal(planMatchesServiceUser({ target_user_name: "旧版家人" }, { name: "旧版家人" }), true);
});

test("plan visibility keeps only the current active generation for known service users", () => {
  const serviceUsers = [
    { id: "member-rebuilt", personaGeneration: "generation-v1", archived: true },
    { id: "member-rebuilt", personaGeneration: "generation-v2", archived: false },
    { id: "member-archived", personaGeneration: "legacy-v1", archived: true },
  ];

  assert.equal(shouldShowPlanForServiceUsers({
    service_user_id: "member-rebuilt",
    persona_generation: "generation-v1",
  }, serviceUsers), false);
  assert.equal(shouldShowPlanForServiceUsers({
    service_user_id: "member-rebuilt",
    personaGeneration: "generation-v2",
  }, serviceUsers), true);
  assert.equal(shouldShowPlanForServiceUsers({
    service_user_id: "member-rebuilt",
  }, serviceUsers), false);
  assert.equal(shouldShowPlanForServiceUsers({
    service_user_id: "member-archived",
    persona_generation: "legacy-v1",
  }, serviceUsers), false);
});

test("plan visibility does not guess between same-name legacy active and archived users", () => {
  assert.equal(shouldShowPlanForServiceUsers({
    target_user_name: "同名家人",
  }, [
    { name: "同名家人", archived: true },
    { name: "同名家人", archived: false },
  ]), false);
});
