function statusText(status) {
  return String(status || "").trim().toLowerCase();
}

function isDoneStatus(status) {
  const text = statusText(status);
  return [
    "done",
    "completed",
    "complete",
    "taken",
    "dispensed",
    "fulfilled",
    "已完成",
    "已执行",
    "已取药",
    "完成",
  ].some(item => text.indexOf(item) >= 0);
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
  return isPlanDueToday(plan) && !hasTakenEvidence(plan) && !isSkippedStatus(plan.status);
}

function planTimeValue(plan = {}) {
  const time = String(plan.time || "").match(/(\d{1,2}):(\d{2})/);
  return time ? Number(time[1]) * 60 + Number(time[2]) : 9999;
}

const PLAN_STATUS = {
  TAKEN: "taken",
  REMIND: "remind",
  NOT_DUE: "not_due",
};

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function planMedicineName(plan = {}) {
  return String(firstPresent(plan.medicine, plan.medicine_name, plan.name, "计划用药")).trim();
}

function planPersonName(plan = {}) {
  return String(firstPresent(
    plan.target_user_name,
    plan.target_user,
    plan.targetUser,
    plan.user_name,
    plan.person_name,
    "家庭成员",
  )).trim();
}

function planDoseText(plan = {}) {
  return String(firstPresent(plan.dose, plan.dosage, "")).trim();
}

function planTimeText(plan = {}) {
  const raw = String(firstPresent(plan.time, "待定")).trim();
  const match = raw.match(/^(\d{1,2}:\d{2})/);
  return match ? match[1] : raw;
}

function clockMinutes(plan = {}) {
  const match = String(plan.time || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function booleanTrue(value) {
  if (value === true || value === 1) return true;
  return ["true", "1", "yes", "y", "是", "已取药", "taken", "dispensed", "completed"]
    .includes(String(value || "").trim().toLowerCase());
}

function sameLocalDay(value, now = new Date()) {
  const match = String(value || "").match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return false;
  return Number(match[1]) === now.getFullYear()
    && Number(match[2]) === now.getMonth() + 1
    && Number(match[3]) === now.getDate();
}

function hasTakenEvidence(plan = {}, now = new Date()) {
  if (isDoneStatus(plan.status)) return true;

  const stateFields = [
    plan.execution_status,
    plan.executionStatus,
    plan.action_status,
    plan.actionStatus,
    plan.dispense_status,
    plan.dispenseStatus,
    plan.taking_status,
    plan.takingStatus,
  ];
  if (stateFields.some(value => isDoneStatus(value))) return true;

  if ([
    plan.last_action_date,
    plan.lastActionDate,
    plan.completed_at,
    plan.completedAt,
    plan.taken_at,
    plan.takenAt,
    plan.dispensed_at,
    plan.dispensedAt,
  ].some(value => sameLocalDay(value, now))) return true;

  return [
    plan.taken,
    plan.is_taken,
    plan.isTaken,
    plan.completed,
    plan.is_completed,
    plan.isCompleted,
    plan.dispensed,
    plan.is_dispensed,
    plan.isDispensed,
  ].some(booleanTrue);
}

function isPlanTimeReached(plan = {}, now = new Date()) {
  if (!isPlanDueToday(plan)) return false;
  const minutes = clockMinutes(plan);
  if (minutes === null) return true;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes >= minutes;
}

function executionStatus(plan = {}, now = new Date()) {
  if (hasTakenEvidence(plan, now)) return PLAN_STATUS.TAKEN;
  return isPlanTimeReached(plan, now) ? PLAN_STATUS.REMIND : PLAN_STATUS.NOT_DUE;
}

function statusView(kind) {
  return {
    [PLAN_STATUS.TAKEN]: {
      kind: PLAN_STATUS.TAKEN,
      label: "已取药",
      hint: "计划已完成",
      tone: "good",
    },
    [PLAN_STATUS.REMIND]: {
      kind: PLAN_STATUS.REMIND,
      label: "待提醒",
      hint: "计划时间已到，尚未完成",
      tone: "warn",
    },
    [PLAN_STATUS.NOT_DUE]: {
      kind: PLAN_STATUS.NOT_DUE,
      label: "未取药",
      hint: "尚未到计划时间",
      tone: "notice",
    },
  }[kind] || {
    kind: PLAN_STATUS.NOT_DUE,
    label: "未取药",
    hint: "尚未到计划时间",
    tone: "notice",
  };
}

function buildPlanView(plan = {}, now = new Date(), personName = "") {
  const kind = executionStatus(plan, now);
  const status = statusView(kind);
  const person = String(personName || planPersonName(plan)).trim();
  const medicine = planMedicineName(plan);
  const dose = planDoseText(plan);
  return Object.assign({}, plan, {
    planKey: String(plan.id || plan._id || `${plan.time || ""}-${person}-${medicine}`),
    timeText: planTimeText(plan),
    personName: person,
    medicineName: medicine,
    doseText: dose,
    statusKind: status.kind,
    statusLabel: status.label,
    statusHint: status.hint,
    statusTone: status.tone,
    statusOrder: kind === PLAN_STATUS.TAKEN ? 0 : (kind === PLAN_STATUS.REMIND ? 1 : 2),
  });
}

function summarizePlanViews(items = []) {
  return (items || []).reduce((summary, item) => {
    const key = item.statusKind || executionStatus(item);
    if (key === PLAN_STATUS.TAKEN) summary.taken += 1;
    else if (key === PLAN_STATUS.REMIND) summary.remind += 1;
    else summary.notDue += 1;
    summary.total += 1;
    return summary;
  }, { total: 0, taken: 0, remind: 0, notDue: 0 });
}

function sortPlanViews(items = []) {
  return (items || []).slice().sort((left, right) => (
    planTimeValue(left) - planTimeValue(right)
    || String(left.personName || "").localeCompare(String(right.personName || ""))
    || String(left.medicineName || "").localeCompare(String(right.medicineName || ""))
  ));
}

module.exports = {
  isDoneStatus,
  isSkippedStatus,
  isPlanDueToday,
  isPlanActionable,
  planTimeValue,
  PLAN_STATUS,
  planMedicineName,
  planPersonName,
  planDoseText,
  planTimeText,
  isPlanTimeReached,
  executionStatus,
  statusView,
  buildPlanView,
  summarizePlanViews,
  sortPlanViews,
};
