function statusText(status) {
  return String(status || "").trim().toLowerCase();
}

function isDoneStatus(status) {
  const text = statusText(status);
  return ["done", "completed", "complete", "已完成", "已执行", "完成"].some(item => text.indexOf(item) >= 0);
}

function isSkippedStatus(status) {
  const text = statusText(status);
  return ["skipped", "skip", "cancelled", "canceled", "ignored", "已跳过", "跳过", "已取消", "取消", "忽略"].some(item => text.indexOf(item) >= 0);
}

function isFalseFlag(value) {
  if (value === false || value === 0) return true;
  return ["false", "0", "no", "否"].includes(String(value || "").trim().toLowerCase());
}

function isPlanDueToday(plan = {}) {
  const dueToday = plan.due_today !== undefined ? plan.due_today : plan.dueToday;
  return !isFalseFlag(dueToday);
}

function isPlanActionable(plan = {}) {
  return isPlanDueToday(plan) && !isDoneStatus(plan.status) && !isSkippedStatus(plan.status);
}

function planTimeValue(plan = {}) {
  const time = String(plan.time || "").match(/(\d{1,2}):(\d{2})/);
  return time ? Number(time[1]) * 60 + Number(time[2]) : 9999;
}

module.exports = {
  isDoneStatus,
  isSkippedStatus,
  isPlanDueToday,
  isPlanActionable,
  planTimeValue,
};
