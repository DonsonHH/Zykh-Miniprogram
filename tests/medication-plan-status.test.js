const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PLAN_STATUS,
  executionStatus,
  buildPlanView,
  summarizePlanViews,
} = require("../miniprogram/utils/carePlan");

const at = (hour, minute) => new Date(2026, 7, 20, hour, minute, 0, 0);

test("plan status treats an explicit completion as 已取药", () => {
  assert.equal(executionStatus({ status: "done", time: "23:00" }, at(8, 0)), PLAN_STATUS.TAKEN);
  assert.equal(executionStatus({ status: "已取药", time: "23:00" }, at(8, 0)), PLAN_STATUS.TAKEN);
  assert.equal(executionStatus({ status: "pending", last_action_date: "2026-08-20 07:50" }, at(8, 0)), PLAN_STATUS.TAKEN);
});

test("plan status distinguishes an overdue plan from a future plan", () => {
  assert.equal(executionStatus({ status: "pending", due_today: true, time: "07:59" }, at(8, 0)), PLAN_STATUS.REMIND);
  assert.equal(executionStatus({ status: "pending", due_today: true, time: "08:01" }, at(8, 0)), PLAN_STATUS.NOT_DUE);
  assert.equal(executionStatus({ status: "pending", due_today: false, time: "08:01" }, at(8, 0)), PLAN_STATUS.NOT_DUE);
});

test("plan view exposes the three user-facing labels and stable counts", () => {
  const views = [
    buildPlanView({ id: "taken", status: "done", time: "07:00", medicine: "药甲" }, at(8, 0)),
    buildPlanView({ id: "remind", status: "pending", due_today: true, time: "07:30", medicine: "药乙" }, at(8, 0)),
    buildPlanView({ id: "future", status: "pending", due_today: true, time: "20:00", medicine: "药丙" }, at(8, 0)),
  ];
  assert.deepEqual(views.map(item => item.statusLabel), ["已取药", "待提醒", "未取药"]);
  assert.deepEqual(summarizePlanViews(views), { total: 3, taken: 1, remind: 1, notDue: 1 });
});
