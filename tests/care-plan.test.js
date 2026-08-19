const test = require("node:test");
const assert = require("node:assert/strict");
const { isPlanActionable } = require("../miniprogram/utils/carePlan");

test("only an unfinished plan that is due today is actionable", () => {
  assert.equal(isPlanActionable({ status: "pending", due_today: true }), true);
  assert.equal(isPlanActionable({ status: "pending" }), true);
  assert.equal(isPlanActionable({ status: "pending", due_today: false }), false);
  assert.equal(isPlanActionable({ status: "pending", dueToday: "false" }), false);
  assert.equal(isPlanActionable({ status: "skipped", due_today: true }), false);
  assert.equal(isPlanActionable({ status: "已跳过", due_today: true }), false);
  assert.equal(isPlanActionable({ status: "done", due_today: true }), false);
});
