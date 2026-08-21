const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const { summarizeExpiry } = require("../../utils/expiry");
const planStatus = require("../../utils/carePlan");
const {
  isDoneStatus,
  isSkippedStatus,
  isPlanDueToday,
  isPlanActionable,
  planTimeValue,
} = planStatus;
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const medicineLibrary = require("../../utils/medicineLibrary");
const deviceSession = require("../../utils/deviceSession");
const medicationSafetyEvents = require("../../modules/medicationSafetyEvents");
const personaVisibility = require("../../modules/personaVisibility");
const vitalsAttribution = require("../../modules/vitalsAttribution");
const { mergeCapabilitySnapshots } = require("../../modules/capabilitySnapshot");
const { parseDate, parseTimestamp } = require("../../utils/dateTime");

const medicationSafetyEventModule = medicationSafetyEvents.createMedicationSafetyEventModule(api);

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function currentFactIdentity(value = {}) {
  const payload = value && value.payload && typeof value.payload === "object"
    ? value.payload
    : {};
  return Object.assign({}, payload, value);
}

function commandStatus(command = {}) {
  const status = command.status || "pending";
  const map = {
    pending: { text: "等待药箱", cls: "warn" },
    running: { text: "提醒中", cls: "warn" },
    done: { text: "已完成", cls: "ok" },
    failed: { text: "失败", cls: "bad" },
  };
  return map[status] || { text: status, cls: "idle" };
}

function planTitle(plan = {}) {
  const user = planUserName(plan);
  const medicine = plan.medicine || plan.medicine_name || plan.name || "计划用药";
  const time = plan.time || "--:--";
  return `${time} ${user} ${medicine}`;
}

function planUserName(plan = {}) {
  return plan.target_user_name || plan.target_user || plan.targetUser || plan.user_name || plan.person_name || "老人";
}

function planKey(plan = {}) {
  return String(plan.id || plan._id || `${plan.time || ""}-${planUserName(plan)}-${plan.medicine || plan.medicine_name || plan.name || ""}`);
}

function sortedPlans(plans = []) {
  return plans.slice().sort((a, b) => planTimeValue(a) - planTimeValue(b));
}

function planTodoLevel(plan = {}) {
  if (isDoneStatus(plan.status)) return "ok";
  return "warn";
}

function planTodoTitle(plan = {}) {
  const status = plan.status || (isDoneStatus(plan.status) ? "已完成" : "待执行");
  return `${String(plan.time || "--:--").slice(0, 5)} ${status}`;
}

function planTodoDesc(plan = {}) {
  const user = planUserName(plan);
  const medicine = plan.medicine || plan.medicine_name || plan.name || "计划用药";
  const dose = plan.dose || plan.dosage || "";
  return [user, medicine, dose].filter(Boolean).join(" · ");
}

function clockTime(value) {
  const match = String(value || "").match(/(\d{2}:\d{2})(?::\d{2})?/);
  return match ? match[1] : "";
}

function localDate(value) {
  return parseDate(value);
}

function isSameCalendarDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function timelineTime(value) {
  const fallback = clockTime(value) || String(value || "").slice(0, 16);
  const date = localDate(value);
  if (!date) return fallback;

  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (isSameCalendarDay(date, now)) return `今天 ${time}`;

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return `昨天 ${time}`;

  const dayLabel = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear()
    ? `${dayLabel} ${time}`
    : `${date.getFullYear()}年${dayLabel}`;
}

function compactText(value, fallback = "") {
  return String(value || fallback || "").replace(/\s+/g, " ").trim();
}

function homeDisplayText(value, fallback = "") {
  return compactText(value, fallback).replace(/问诊/g, "问询");
}

function sortValue(item) {
  return parseTimestamp(item.rawTime || item.time || "") || 0;
}

function vitalsToTimeline(record = {}, attributionContext = {}) {
  const vitals = api.normalizeVitals(record) || record;
  const rawTime = vitals.createdAt || vitals.created_at || vitals.time || vitals.deviceTime || vitals.device_time || "";
  const attribution = vitalsAttribution.classifyVitalsAttribution(vitals, attributionContext);
  const person = attribution.label;
  const metrics = [
    vitals.bodyTemp !== undefined && vitals.bodyTemp !== null && vitals.bodyTemp !== "" ? `体温 ${vitals.bodyTemp}℃` : "",
    vitals.spo2 !== undefined && vitals.spo2 !== null && vitals.spo2 !== "" ? `血氧 ${vitals.spo2}%` : "",
    vitals.heartRate !== undefined && vitals.heartRate !== null && vitals.heartRate !== "" ? `心率 ${vitals.heartRate} bpm` : "",
  ].filter(Boolean);
  return {
    id: `vitals-${record._id || record.id || rawTime}`,
    title: `${person} 完成健康测量`,
    desc: metrics.join(" · ") || "测量结果未完整同步",
    time: timelineTime(rawTime),
    rawTime,
    level: vitals.quality === "error" ? "bad" : "ok",
    source: "vitals",
  };
}

function latestVitalsSummary(record, attributionContext = {}) {
  if (!record) return "暂无测量结果";
  return vitalsToTimeline(record, attributionContext).desc;
}

function timelineKey(item) {
  const title = compactText(item.title).toLowerCase().replace(/\s+/g, "");
  const moment = String(item.rawTime || item.time || "");
  if (title.indexOf("ai问诊") >= 0 || title.indexOf("ai问询") >= 0) {
    return `${moment}|ai-inquiry`;
  }
  return [
    moment,
    title,
    compactText(item.desc).slice(0, 18),
  ].join("|");
}

function inquiryToTimeline(inquiry = {}) {
  const rawTime = inquiry.updatedAt || inquiry.updated_at || inquiry.createdAt || inquiry.created_at || "";
  const risk = inquiry.risk_label || inquiry.risk_level || "";
  const person = inquiry.target_user_name || inquiry.patient_name || inquiry.person_name || inquiry.user_name || "";
  const topic = homeDisplayText(inquiry.title || inquiry.topic || inquiry.symptoms_summary, "AI 问询");
  const summary = homeDisplayText(inquiry.reasoning_summary || inquiry.reply || inquiry.symptoms_summary || "", "");
  return {
    id: `inquiry-${inquiry._id || inquiry.inquiry_id || inquiry.session_id || rawTime}`,
    title: compactText(person ? `${person} · ${topic}` : topic, "AI 问询"),
    desc: risk ? compactText(`${risk} · ${summary}`) : summary,
    time: timelineTime(rawTime),
    rawTime,
    level: ["high", "emergency", "高风险", "紧急"].some(key => String(risk).indexOf(key) >= 0) ? "bad" : "notice",
    source: "inquiry",
  };
}

function commandToTimeline(command = {}) {
  const status = commandStatus(command);
  const rawTime = command.updatedAt || command.createdAt || "";
  const payload = command.payload || {};
  const labels = {
    AUDIO_BEEP: payload.reminder_kind === "missed_medication" ? "远程用药提醒" : "提示音提醒",
    AUDIO_SPEAK: "远程用药提醒",
    READ_VITALS_ALL: "远程测量",
    AI_CHAT: "AI 问询提交",
    UPSERT_MEDICINE: "药品信息同步",
  };
  return {
    id: `command-${command._id || rawTime}`,
    title: labels[command.type] || "远程协同",
    desc: `${status.text}${payload.medicine_name ? ` · ${payload.medicine_name}` : ""}`,
    time: timelineTime(rawTime),
    rawTime,
    level: status.cls,
    source: "command",
  };
}

function safetyToTimeline(event = {}) {
  const presentation = medicationSafetyEvents.eventPresentation(event);
  return {
    id: `safety-${event.id}`,
    title: presentation.title,
    desc: [event.medicineName, presentation.outcomeText].filter(Boolean).join(" · "),
    time: timelineTime(event.occurredAt),
    rawTime: event.occurredAt,
    level: presentation.state.kind === "risk" ? "bad" : "notice",
    source: "safety",
    eventId: event.id,
  };
}

function buildTimeline(inquiries, commands, vitals, safetyEvents, attributionContext = {}) {
  const seen = new Set();
  return []
    .concat((safetyEvents || []).map(safetyToTimeline))
    .concat((vitals || []).map(record => vitalsToTimeline(record, attributionContext)))
    .concat((inquiries || []).map(inquiryToTimeline))
    .concat((commands || [])
      .filter(command => command.type !== "AI_CHAT" && command.type !== "UPSERT_MEDICINE")
      .slice(0, 6)
      .map(commandToTimeline))
    .sort((a, b) => sortValue(b) - sortValue(a))
    .filter(item => {
      const key = timelineKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function medicineRiskItems(medicines) {
  return summarizeExpiry(medicines);
}

function depletedMedicineItems(medicines = []) {
  return (medicines || []).filter(item => item.name && item.isDepleted).map(item => {
    const box = medicineLibrary.storageBoxFor(item);
    return {
      medicineId: medicineLibrary.medicineIdentity(item),
      storageBox: item.storageBox || box.id,
      name: item.name,
      title: `${item.name} 已确认无药`,
      desc: `${item.storageBoxLabel || box.label} · 最近一次现场确认已经用完`,
    };
  });
}

function todoPriority(item = {}) {
  if (Number.isFinite(Number(item.priority))) return Number(item.priority);
  const levelRank = { bad: 0, warn: 1, notice: 2, ok: 3 };
  return levelRank[item.level] === undefined ? 4 : levelRank[item.level];
}

function heroStateForTodo(todo, device = {}) {
  if (!todo) {
    if (device.online !== true) {
      return {
        heroBadge: "等待药箱连接",
        heroLevel: "attention",
        focusTitle: "药箱暂未连接",
        focusSub: "当前照护信息可能不是最新，连接后会自动刷新。",
      };
    }
    return {
      heroBadge: "今日无待办",
      heroLevel: "valid",
      focusTitle: "今天暂无需要处理",
      focusSub: "需要提醒或补药时，这里会直接显示。",
    };
  }

  return {
    heroBadge: todo.heroBadge || "待处理",
    heroLevel: todo.level === "bad" ? "danger" : "attention",
    focusTitle: todo.title,
    focusSub: todo.desc,
  };
}

function expiryTodoBadge(expiryClass) {
  const badgeByClass = {
    expired: "优先处理",
    urgent: "尽快处理",
    soon: "近期处理",
    missing: "待补效期",
  };
  return badgeByClass[expiryClass] || "待处理";
}

function homeCarePage(state = {}) {
  const planItems = state.planItems || [];
  const reminder = planItems[0] || null;
  const reminderKey = reminder && reminder.planKey ? reminder.planKey : "";
  const reminderPlan = state.reminderPlan || {};
  const todayPlanTotal = Number(state.todayPlanTotal || 0);
  const todayPlanCompleted = Number(state.todayPlanCompleted || 0);
  const reminderPerson = planUserName(reminderPlan);
  const reminderMedicine = reminderPlan.medicine
    || reminderPlan.medicine_name
    || reminderPlan.name
    || "计划用药";
  const reminderDose = reminderPlan.dose || reminderPlan.dosage || "";
  const reminderTime = String(reminderPlan.time || "--:--").slice(0, 5);
  const deviceOnline = Boolean(state.device && state.device.online);

  let focusTitle = "今天暂无用药计划";
  let focusSupporting = "有新的计划或照护记录时会自动更新。";
  let focusState = { kind: "normal", label: "无需提醒" };
  let focusAction = null;
  let focusActivation = "none";
  if (reminder && reminderKey) {
    focusTitle = `${reminderTime} · ${reminderPerson}`;
    focusSupporting = [reminderMedicine, reminderDose].filter(Boolean).join(" · ");
    focusState = { kind: "pending", label: "待提醒" };
    focusAction = {
      id: "home.focus.plans",
      label: "查看计划用药",
    };
    focusActivation = "surface";
  } else if (todayPlanTotal > 0) {
    focusTitle = "今天的用药计划已完成";
    focusSupporting = `${todayPlanTotal} 次计划均已确认。`;
    focusState = { kind: "normal", label: "已完成" };
    focusAction = {
      id: "home.focus.plans",
      label: "查看计划用药",
    };
    focusActivation = "surface";
  } else if (!deviceOnline) {
    focusTitle = "照护信息等待更新";
    focusSupporting = "家庭药箱重新连接后，今日计划会自动同步。";
    focusState = { kind: "pending", label: "待连接" };
    focusAction = { id: "home.focus.connection", label: "打开药箱连接设置" };
    focusActivation = "surface";
  }

  if (state.stale) {
    focusSupporting = ["刷新失败，当前照护信息可能不是最新。", focusSupporting]
      .filter(Boolean)
      .join(" ");
  }

  const attentionItems = [];
  if (Number(state.riskCount || 0) > 0) {
    const unreadRiskCount = Number(state.unreadRiskCount || 0);
    attentionItems.push({
      key: "home-attention-safety",
      symbol: "safety",
      title: `${state.riskCount} 条用药风险`,
      supporting: [
        unreadRiskCount ? `${unreadRiskCount} 条待查看` : "均已查看",
        "查看涉及的家人、药品和风险依据",
      ].join(" · "),
      state: { kind: "risk", label: "需确认" },
      action: { id: "home.risks", label: "查看用药风险" },
    });
  }

  const medicineAttentionCount = Number(state.expiryRiskCount || 0)
    + Number(state.depletedCount || 0)
    + Number(state.inventoryUnknownCount || 0);
  if (medicineAttentionCount > 0) {
    const medicineAttentionCopy = [
      state.expiredCount ? `过期 ${state.expiredCount}` : "",
      state.expiringCount ? `临期 ${state.expiringCount}` : "",
      state.missingExpiryCount ? `有效期待补 ${state.missingExpiryCount}` : "",
      state.depletedCount ? `无药 ${state.depletedCount}` : "",
      state.inventoryUnknownCount ? `余量待确认 ${state.inventoryUnknownCount}` : "",
    ].filter(Boolean).join(" · ");
    attentionItems.push({
      key: "home-attention-medicine",
      symbol: "inventory",
      title: `${medicineAttentionCount} 项药品需要维护`,
      supporting: medicineAttentionCopy,
      state: {
        kind: state.expiredCount ? "risk" : "pending",
        label: state.expiredCount ? "优先处理" : "待处理",
      },
      action: {
        id: `home.cabinet.${state.primaryMedicineFilter || "all"}`,
        label: "查看需维护药品",
        payload: { filter: state.primaryMedicineFilter || "all" },
      },
    });
  }

  const sections = [];
  if (attentionItems.length) {
    sections.push({
      key: "home-attention",
      intent: "tasks",
      title: "需要关注",
      items: attentionItems,
    });
  }
  sections.push({
    key: "home-care-activity",
    intent: "timeline",
    title: "照护动态",
    items: [
      {
        key: "home-health-measurement",
        symbol: "measure",
        title: "健康测量",
        supporting: state.latestVitalsText,
        state: { kind: "actionable", label: "查看" },
        action: { id: "home.vitals", label: "查看健康测量" },
      },
      {
        key: "home-recent-activity",
        symbol: "timeline",
        title: "近期记录",
        supporting: state.latestCount ? `最近同步 ${state.latestCount} 条照护记录` : "还没有照护记录",
        state: { kind: "muted", label: state.latestCount ? `${state.latestCount} 条` : "暂无" },
        action: { id: "home.timeline", label: "查看近期记录" },
      },
    ],
  });
  sections.push({
    key: "home-navigation",
    intent: "navigation",
    title: "家庭服务",
    items: [
      {
        key: "home-inquiry-navigation",
        symbol: "conversation",
        title: "问询摘要",
        supporting: state.inquiryCount ? `${state.inquiryCount} 条问询结论可查看` : "查看家人的健康问询结论",
        state: { kind: "actionable", label: "查看" },
        action: { id: "home.inquiry", label: "打开家庭问询" },
      },
      {
        key: "home-family-navigation",
        symbol: "person",
        title: "家人资料",
        supporting: "查看家庭成员与照护设置",
        state: { kind: "normal", label: "管理" },
        action: { id: "home.family", label: "查看家人资料" },
      },
    ],
  });

  return composeCarePage({
    key: "home-care",
    title: "家庭照护",
    online: deviceOnline,
    focus: {
      eyebrow: "今日照护进度",
      title: focusTitle,
      supporting: focusSupporting,
      progress: todayPlanTotal
        ? { current: todayPlanCompleted, total: todayPlanTotal, label: "今日已完成" }
        : null,
      state: focusState,
      action: focusAction,
      activation: focusActivation,
    },
    overview: [],
    sections,
  });
}

function homeErrorCarePage(device = {}) {
  return composeCarePage({
    key: "home-error",
    title: "家庭照护",
    online: Boolean(device.online),
    phase: {
      kind: "error",
      message: "家庭照护信息读取失败，请检查网络后重新加载。",
      action: { id: "home.retry", label: "重新加载家庭照护" },
    },
  });
}

function homeDeviceAccessCarePage(session = {}) {
  const availability = String(session.availability || "").trim();
  const copy = {
    unpaired: {
      title: "请先配对药箱",
      supporting: session.message || "当前微信账号尚未配对药箱，请在家人页输入一次性配对码。",
      state: "待配对",
    },
    "pairing-unavailable": {
      title: "请先开通药箱权限",
      supporting: session.message || "当前账号尚未获得药箱权限，请联系管理员。",
      state: "待授权",
    },
    forbidden: {
      title: "当前账号无权查看药箱",
      supporting: session.message || "请重新配对药箱，或联系管理员确认照护权限。",
      state: "无权限",
    },
  }[availability] || {
    title: "请确认药箱权限",
    supporting: session.message || "请在家人页确认当前账号可访问的药箱。",
    state: "待确认",
  };
  return composeCarePage({
    key: "home-device-access",
    title: "家庭照护",
    showStatus: false,
    focus: {
      eyebrow: "药箱连接",
      title: copy.title,
      supporting: copy.supporting,
      state: { kind: "pending", label: copy.state },
      activation: "surface",
      action: { id: "home.focus.connection", label: "打开家人和药箱设置" },
    },
  });
}

Page({
  data: {
    carePage: loadingCarePage("家庭照护", "正在整理今日照护…"),
    device: {},
    heroBadge: "今日无待办",
    heroLevel: "valid",
    todoCount: 0,
    expiryRiskCount: 0,
    stockCount: 0,
    validExpiryCount: 0,
    expiringCount: 0,
    expiredCount: 0,
    missingExpiryCount: 0,
    depletedCount: 0,
    inventoryUnknownCount: 0,
    expiryAttention: [],
    nextExpiry: null,
    latestVitalsText: "暂无测量结果",
    latestCount: 0,
    inquiryCount: 0,
    focusTitle: "今天暂无需要处理",
    focusSub: "问询、测量和药品变化会自动同步。",
    todoItems: [],
    todoPreview: [],
    planItems: [],
    todayPlanViews: [],
    planStatusCounts: { total: 0, taken: 0, remind: 0, notDue: 0 },
    todayPlanTotal: 0,
    todayPlanCompleted: 0,
    todayPlanPendingCount: 0,
    nextDoseText: "今天无需提醒用药",
    todayPlanNote: "今天没有待执行用药",
    timeline: [],
    timelinePreview: [],
    detailVisible: false,
    detailMode: "todo",
    detailTitle: "今日详情",
    reminderPlan: {},
    reminderSubmitting: false,
    stale: false,
    safetyState: { availability: "unknown", events: [], message: "暂时无法确认安全记录是否为最新" },
    deviceId: "",
    safetyDeviceId: "",
    riskCount: 0,
    todaySafetyCount: 0,
    primaryMedicineFilter: "all",
  },

  onShow() {
    return deviceSession.runAfterDeviceSessionReady(() => {
      const loading = this.load();
      if (activeDeviceId()) {
        this.startRealtime();
      } else {
        this.stopRealtime();
      }
      return loading;
    });
  },

  onHide() {
    this.stopRealtime();
  },

  onUnload() {
    this.stopRealtime();
  },

  startRealtime() {
    this.stopRealtime();
    this._stopRealtime = realtime.subscribe(() => this.load({ background: true }), null, {
      collections: ["devices", "medicines", "vitals", "commands", "today_plans"],
      intervalMs: 20000,
      immediate: false,
    });
  },

  stopRealtime() {
    if (this._stopRealtime) {
      this._stopRealtime();
      this._stopRealtime = null;
    }
  },

  async load(options = {}) {
    const app = getApp();
    const requestDeviceId = String((app && app.globalData && app.globalData.deviceId) || "").trim();
    const deviceSessionState = app && app.globalData && app.globalData.deviceSession || {};
    const loadRequestId = Number(this._loadRequestId || 0) + 1;
    this._loadRequestId = loadRequestId;
    const displayedDeviceId = String(this.data.deviceId || "").trim();
    if (displayedDeviceId !== requestDeviceId) {
      this._hasLoadedSnapshot = false;
      this._reminderPlansByKey = {};
      this.setData({
        carePage: loadingCarePage("家庭照护", "正在读取当前药箱的照护信息…"),
        deviceId: requestDeviceId,
        device: {},
        todoCount: 0,
        expiryRiskCount: 0,
        stockCount: 0,
        validExpiryCount: 0,
        expiringCount: 0,
        expiredCount: 0,
        missingExpiryCount: 0,
        depletedCount: 0,
        inventoryUnknownCount: 0,
        expiryAttention: [],
        nextExpiry: null,
        latestCount: 0,
        inquiryCount: 0,
        todoItems: [],
        todoPreview: [],
        planItems: [],
        todayPlanViews: [],
        planStatusCounts: { total: 0, taken: 0, remind: 0, notDue: 0 },
        todayPlanTotal: 0,
        todayPlanCompleted: 0,
        todayPlanPendingCount: 0,
        timeline: [],
        timelinePreview: [],
        reminderPlan: {},
        detailVisible: false,
        stale: false,
        safetyState: { availability: "unknown", events: [], message: "暂时无法确认安全记录是否为最新" },
        safetyDeviceId: requestDeviceId,
        riskCount: 0,
        todaySafetyCount: 0,
      });
    }
    if (!requestDeviceId) {
      this._hasLoadedSnapshot = false;
      this._reminderPlansByKey = {};
      this.setData({ carePage: homeDeviceAccessCarePage(deviceSessionState) });
      return;
    }
    try {
      const [device, medicines, commands, snapshot, vitals, safetyState] = await Promise.all([
        api.getDeviceStrict(requestDeviceId),
        api.getMedicinesStrict(requestDeviceId),
        api.getRecentCommandsStrict(12, requestDeviceId),
        api.getSnapshotStrict({ inquiryLimit: 12, deviceId: requestDeviceId }),
        api.getRecentVitalsStrict(20, requestDeviceId),
        medicationSafetyEventModule.list({
          limit: 100,
          unreadOnly: false,
          deviceId: requestDeviceId,
          includeLocalFixtures: true,
        }),
      ]);
      if (loadRequestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;

      const sameDeviceScope = this._hasLoadedSnapshot === true
        && String(this.data.safetyDeviceId || "") === requestDeviceId;
      const transientSafetyFailure = sameDeviceScope
        && ["error", "unknown"].includes(String(safetyState.availability || ""));
      const effectiveSafetyState = transientSafetyFailure
        ? Object.assign({}, safetyState, {
          events: (this.data.safetyState && this.data.safetyState.events) || [],
          nextCursor: (this.data.safetyState && this.data.safetyState.nextCursor) || "",
        })
        : safetyState;

      const serviceUsers = snapshot.serviceUsers || [];
      const capabilitySnapshot = mergeCapabilitySnapshots(
        deviceSessionState,
        snapshot,
        safetyState.capabilitySnapshot,
      );
      const personaPolicy = personaVisibility.createPersonaVisibilityPolicy(serviceUsers, {
        capabilities: capabilitySnapshot.capabilities,
        serviceUsersSnapshotComplete: snapshot.serviceUsersSnapshotComplete === true,
      });
      const vitalsAttributionContext = {
        activeUsers: personaPolicy.activeUsers(),
        attributionSupported: vitalsAttribution.supportsVitalsAttribution(capabilitySnapshot),
      };
      const plans = (snapshot.plans || [])
        .filter(plan => personaPolicy.strict
          ? personaPolicy.allowsPlan(plan)
          : api.shouldShowPlanForServiceUsers(plan, serviceUsers));
      const inquiries = snapshot.inquiries || [];
      const visibleCommands = personaPolicy.strict
        ? (commands || []).filter(item => personaPolicy.allowsCurrentRecord(
          currentFactIdentity(item),
          { allowUnlinked: true },
        ))
        : (commands || []);
      const visibleVitals = personaPolicy.strict
        ? (vitals || []).filter(item => personaPolicy.allowsCurrentRecord(
          currentFactIdentity(api.normalizeVitals(item) || item),
          { allowUnlinked: true },
        ))
        : (vitals || []);
      const visibleSafetyEvents = personaPolicy.strict
        ? (effectiveSafetyState.events || []).filter(item => (
          personaPolicy.allowsCurrentRecord(currentFactIdentity(item), { allowUnlinked: true })
        ))
        : (effectiveSafetyState.events || []);
      const visibleSafetyState = Object.assign({}, effectiveSafetyState, {
        events: visibleSafetyEvents,
      });
      const todayPlans = sortedPlans(plans.filter(plan => (
        isPlanDueToday(plan) && !isSkippedStatus(plan.status)
      )));
      const todayPlanViews = todayPlans.map(plan => planStatus.buildPlanView(plan));
      const planStatusCounts = planStatus.summarizePlanViews(todayPlanViews);
      const pendingPlans = todayPlans.filter(isPlanActionable);
      const completedPlans = todayPlans.filter(plan => (
        planStatus.executionStatus(plan) === planStatus.PLAN_STATUS.TAKEN
      ));
      const hasFixedCatalogSnapshot = Array.isArray(medicines)
        && medicines.some(item => item && item.fixedCatalogMatch === true);
      const medicineSummary = medicineLibrary.summarizeMedicineLibrary(medicines || [], {
        includeFixedBaseline: hasFixedCatalogSnapshot,
      });
      const inventoryMedicines = medicineSummary.medicines;
      const risks = medicineRiskItems(inventoryMedicines.filter(item => !item.isDepleted));
      const depleted = depletedMedicineItems(inventoryMedicines);
      const inventoryUnknownCount = inventoryMedicines.filter(item => item.isInventoryUnknown).length;
      this._reminderPlansByKey = {};
      pendingPlans.forEach(plan => {
        this._reminderPlansByKey[planKey(plan)] = plan;
      });

      const todoItems = [];
      pendingPlans.forEach(plan => {
        todoItems.push({
          id: `plan-${plan.id || plan._id || plan.time}`,
          planKey: planKey(plan),
          icon: "药",
          title: `${String(plan.time || "--:--").slice(0, 5)} ${planStatus.statusView(planStatus.executionStatus(plan)).label}`,
          desc: planTodoDesc(plan),
          level: planTodoLevel(plan),
          action: "remind",
          actionLabel: "查看计划",
          heroBadge: "待提醒",
        });
      });
      risks.attention.forEach(item => {
        const box = medicineLibrary.storageBoxFor(item);
        todoItems.push({
          id: `expiry-${medicineLibrary.medicineIdentity(item)}`,
          icon: "期",
          title: `${item.name} ${item.expiryText}`,
          desc: `${item.storageBoxLabel || box.label} · ${item.expiryHint}`,
          level: item.expiryClass === "expired" ? "bad" : "warn",
          action: "medicine",
          actionLabel: "处理",
          heroBadge: expiryTodoBadge(item.expiryClass),
          filter: "attention",
          storageBox: item.storageBox || box.id,
        });
      });
      depleted.forEach(item => {
        todoItems.push({
          id: `depleted-${item.medicineId}`,
          icon: "补",
          title: item.title,
          desc: item.desc,
          level: "warn",
          action: "medicine",
          actionLabel: "补药",
          heroBadge: "待补药",
          filter: "depleted",
          storageBox: item.storageBox,
        });
      });

      const safetyProjection = medicationSafetyEvents.projectHome(visibleSafetyEvents);
      // CloudBase has already applied the caregiver/device permission check.
      // Use the complete authorized safety list for the home count so it
      // matches the risk registry page; persona filtering remains for the
      // mixed care timeline below.
      const safetyOverviewProjection = medicationSafetyEvents.projectHome(effectiveSafetyState.events || []);
      const safetyOverviewRegistry = medicationSafetyEvents.projectRiskRegistry(effectiveSafetyState.events || []);
      const riskCount = safetyOverviewRegistry.all.length;
      if (safetyProjection.focusBlocked) {
        const event = safetyProjection.focusBlocked;
        todoItems.push({
          id: `safety-${event.id}`,
          eventId: event.id,
          icon: "安",
          title: `${event.personName}存在明确用药风险`,
          desc: [event.medicineName, event.summary || "与已登记健康资料存在冲突"].filter(Boolean).join(" · "),
          level: "bad",
          priority: -100,
          action: "safety",
          actionLabel: "查看",
          heroBadge: "用药风险",
        });
      } else if (safetyProjection.focusCheckFailed && device.online === true) {
        const event = safetyProjection.focusCheckFailed;
        todoItems.push({
          id: `safety-${event.id}`,
          eventId: event.id,
          icon: "安",
          title: `${event.personName}的用药风险需要复核`,
          desc: [event.medicineName, event.summary || "人物或药品资料暂不完整"].filter(Boolean).join(" · "),
          level: "warn",
          priority: -50,
          action: "safety",
          actionLabel: "查看",
          heroBadge: "核查未完成",
        });
      }

      todoItems.sort((a, b) => todoPriority(a) - todoPriority(b));

      const todoCount = todoItems.length;
      const heroState = heroStateForTodo(todoItems[0], device);

      const planItems = todoItems.filter(item => item.action === "remind");
      const nextPlan = pendingPlans[0] || null;
      const nextDoseText = nextPlan
        ? [
          String(nextPlan.time || "").slice(0, 5),
          planUserName(nextPlan),
          nextPlan.medicine || nextPlan.medicine_name || nextPlan.name || "计划用药",
          nextPlan.dose || nextPlan.dosage || "",
        ].filter(Boolean).join(" · ")
        : "今天无需提醒用药";
      const visibleInquiries = inquiries
        .filter(item => personaPolicy.strict
          ? personaPolicy.allowsInquiry(item)
          : api.shouldShowInquiryForServiceUsers(item, serviceUsers))
        .filter(api.shouldShowCaregiverInquiry);
      const timeline = buildTimeline(
        visibleInquiries,
        visibleCommands,
        visibleVitals,
        safetyProjection.events,
        vitalsAttributionContext,
      );
      const primaryMedicineFilter = risks.expiredCount
        ? "expired"
        : (risks.expiringCount ? "expiring" : (risks.missingCount ? "missing" : (depleted.length ? "depleted" : "all")));
      const nextData = {
        device,
        heroBadge: heroState.heroBadge,
        heroLevel: heroState.heroLevel,
        todoCount,
        expiryRiskCount: risks.attention.length,
        stockCount: medicineSummary.medicineCount,
        validExpiryCount: risks.validCount,
        expiringCount: risks.expiringCount,
        expiredCount: risks.expiredCount,
        missingExpiryCount: risks.missingCount,
        depletedCount: depleted.length,
        inventoryUnknownCount,
        primaryMedicineFilter,
        expiryAttention: risks.attention.slice(0, 3),
        nextExpiry: risks.nextAttention,
        latestVitalsText: latestVitalsSummary(visibleVitals[0], vitalsAttributionContext),
        latestCount: timeline.length,
        inquiryCount: visibleInquiries.length,
        focusTitle: heroState.focusTitle,
        focusSub: heroState.focusSub,
        todoItems,
        todoPreview: todoItems.slice(0, 2),
        planItems,
        todayPlanTotal: todayPlans.length,
        todayPlanCompleted: completedPlans.length,
        todayPlanPendingCount: pendingPlans.length,
        todayPlanViews,
        planStatusCounts,
        nextDoseText,
        todayPlanNote: planStatusCounts.remind
          ? `今日有 ${planStatusCounts.remind} 项计划待提醒`
          : (planStatusCounts.notDue ? `还有 ${planStatusCounts.notDue} 项未到时间` : "今日计划已完成"),
        timeline,
        timelinePreview: timeline.slice(0, 2),
        reminderPlan: pendingPlans[0] || {},
        reminderSubmitting: Boolean(this.data.reminderSubmitting),
        safetyState: visibleSafetyState,
        deviceId: requestDeviceId,
        safetyDeviceId: requestDeviceId,
        todaySafetyCount: safetyProjection.todayBlockedCount,
        unreadRiskCount: safetyOverviewProjection.unreadBlockedCount + safetyOverviewProjection.unreadCheckFailedCount,
        riskCount,
        stale: transientSafetyFailure,
      };
      nextData.carePage = homeCarePage(nextData);
      this._hasLoadedSnapshot = true;
      this.setData(nextData);
    } catch (error) {
      if (loadRequestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      if (options.background !== true) {
        console.warn("home care read failed", error);
      }
      const sameDeviceSnapshot = this._hasLoadedSnapshot
        && String(this.data.deviceId || "").trim() === requestDeviceId;
      if (!sameDeviceSnapshot) {
        this._reminderPlansByKey = {};
        this.setData({ carePage: homeErrorCarePage(this.data.device) });
      } else {
        const stale = true;
        this.setData({
          stale,
          carePage: homeCarePage(Object.assign({}, this.data, { stale })),
        });
      }
      if (options.background === true) throw error;
    }
  },

  async retryLoad() {
    const app = getApp();
    if (!activeDeviceId() && app && typeof app.refreshDeviceSession === "function") {
      this.setData({
        carePage: loadingCarePage("家庭照护", "正在重新确认账号可访问的药箱…"),
      });
      let session;
      try {
        session = await app.refreshDeviceSession();
      } catch (error) {
        console.warn("home device session refresh failed", error);
        session = {
          mode: "unknown",
          availability: "error",
          message: "暂时无法确认账号可访问的药箱，请稍后重试",
        };
      }
      if (!activeDeviceId()) {
        this.stopRealtime();
        this.setData({
          carePage: homeDeviceAccessCarePage(
            session || (app.globalData && app.globalData.deviceSession) || {},
          ),
        });
        return undefined;
      }
      const loading = this.load();
      this.startRealtime();
      return loading;
    }
    this.setData({
      carePage: loadingCarePage("家庭照护", "正在重新读取家庭照护信息…"),
    });
    return this.load();
  },

  setReminderSubmitting(reminderSubmitting) {
    const nextSubmitting = Boolean(reminderSubmitting);
    const nextData = { reminderSubmitting: nextSubmitting };
    if (this.data.carePage && this.data.carePage.phase && this.data.carePage.phase.kind === "ready") {
      nextData.carePage = homeCarePage(Object.assign({}, this.data, {
        reminderSubmitting: nextSubmitting,
      }));
    }
    this.setData(nextData);
  },

  async sendMedicineReminder(planOverride, deviceIdOverride = "") {
    const plan = planOverride || this.data.reminderPlan || {};
    const requestDeviceId = String(deviceIdOverride || this.data.deviceId || "").trim();
    const activeDeviceId = String((getApp().globalData && getApp().globalData.deviceId) || "").trim();
    if (!requestDeviceId || activeDeviceId !== requestDeviceId) {
      wx.showToast({ title: "药箱已切换，请重新选择", icon: "none" });
      return;
    }
    if (this._reminderSubmissionInFlight) return;
    this._reminderSubmissionInFlight = true;
    this.setReminderSubmitting(true);
    try {
      const confirmed = await new Promise(resolve => {
        wx.showModal({
          title: "提醒老人用药",
          content: plan.time ? `将向药箱发送提醒：${planTitle(plan)}` : "将向家庭药箱发送一次用药提醒。",
          confirmText: "发送提醒",
          cancelText: "取消",
          success: res => resolve(Boolean(res.confirm)),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      const confirmedDeviceId = String((getApp().globalData && getApp().globalData.deviceId) || "").trim();
      if (confirmedDeviceId !== requestDeviceId) {
        wx.showToast({ title: "药箱已切换，请重新选择", icon: "none" });
        return;
      }
      await api.requestMedicationReminder(plan, { deviceId: requestDeviceId });
      wx.showToast({ title: "提醒已提交" });
      this.load();
    } catch (error) {
      console.warn("medication reminder submission failed", error);
      wx.showToast({ title: "提交失败，请重试", icon: "none" });
    } finally {
      this._reminderSubmissionInFlight = false;
      this.setReminderSubmitting(false);
    }
  },

  goCabinet() {
    wx.switchTab({ url: "/pages/library/index" });
  },

  showTodoDetails() {
    this.setData({
      detailVisible: true,
      detailMode: "todo",
      detailTitle: "今日详情",
    });
  },

  showLatestDetails() {
    this.setData({
      detailVisible: true,
      detailMode: "timeline",
      detailTitle: "近期记录",
    });
  },

  closeDetail() {
    this.setData({ detailVisible: false });
  },

  noop() {},

  onCarePageAction(event) {
    const detail = event && event.detail ? event.detail : {};
    const id = detail.id || "";
    const payload = detail.payload || {};
    if (id === "home.retry") {
      return this.retryLoad();
    } else if (id === "home.today") {
      this.showTodoDetails();
    } else if (id === "home.focus.medicine") {
      this.openMedicineList(payload);
    } else if (id === "home.focus.plans" || id === "home.focus.remind") {
      this.openMedicationPlans();
    } else if (id === "home.focus.connection") {
      this.goSettings();
    } else if (id === "home.focus.safety") {
      this.openSafetyRecord(payload.eventId);
    } else if (id === "home.safety.records") {
      this.openMedicationRisks();
    } else if (id === "home.risks") {
      this.openMedicationRisks();
    } else if (id.indexOf("home.cabinet.") === 0) {
      this.openMedicineList({ filter: payload.filter || "all" });
    } else if (id.indexOf("home.remind.") === 0) {
      this.openMedicationPlans();
    } else if (id === "home.vitals") {
      this.goVitals();
    } else if (id === "home.timeline") {
      this.showLatestDetails();
    } else if (id === "home.inquiry") {
      this.goAi();
    } else if (id === "home.family") {
      this.goSettings();
    }
  },

  handleDetailItem(e) {
    const action = e.currentTarget.dataset.action || "";
    const box = e.currentTarget.dataset.box || "";
    const filter = e.currentTarget.dataset.filter || "";
    const reminderKey = e.currentTarget.dataset.planKey || "";
    this.closeDetail();
    if (action === "remind") {
      this.openMedicationPlans();
    } else if (action === "medicine") {
      this.openMedicineList({ box, filter: filter || "attention" });
    } else if (action === "safety") {
      this.openSafetyRecord(e.currentTarget.dataset.eventId);
    } else {
      this.goRecords();
    }
  },

  openMedicineList(options = {}) {
    const query = [];
    if (options.box) query.push(`box=${encodeURIComponent(options.box)}`);
    if (options.filter) query.push(`filter=${encodeURIComponent(options.filter)}`);
    wx.navigateTo({ url: `/pages/libraryList/index${query.length ? `?${query.join("&")}` : ""}` });
  },

  goRecords() {
    wx.switchTab({ url: "/pages/records/index" });
  },

  openSafetyRecord(eventId) {
    const id = String(eventId || "").trim();
    const app = getApp();
    const deviceId = String(this.data.deviceId || "").trim();
    const activeDeviceId = String((app.globalData && app.globalData.deviceId) || "").trim();
    if (!id || !deviceId || activeDeviceId !== deviceId) return;
    app.globalData.pendingMedicationRisk = { eventId: id, deviceId };
    wx.navigateTo({ url: "/pages/medicationRisks/index" });
  },

  openSafetyRecords() {
    this.openMedicationRisks();
  },

  openMedicationRisks() {
    wx.navigateTo({ url: "/pages/medicationRisks/index" });
  },

  goVitals() {
    wx.navigateTo({ url: "/pages/vitals/index" });
  },

  openMedicationPlans() {
    wx.navigateTo({ url: "/pages/medicationPlans/index" });
  },

  goAi() {
    wx.switchTab({ url: "/pages/ai/index" });
  },

  goSettings() {
    wx.switchTab({ url: "/pages/settings/index" });
  },
});
