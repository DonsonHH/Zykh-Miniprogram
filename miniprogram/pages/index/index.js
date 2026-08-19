const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const { summarizeExpiry } = require("../../utils/expiry");
const { isDoneStatus, isPlanActionable, planTimeValue } = require("../../utils/carePlan");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const cabinetView = require("../../utils/cabinetView");
const deviceSession = require("../../utils/deviceSession");
const medicationSafetyEvents = require("../../modules/medicationSafetyEvents");
const personaVisibility = require("../../modules/personaVisibility");
const vitalsAttribution = require("../../modules/vitalsAttribution");
const { mergeCapabilitySnapshots } = require("../../modules/capabilitySnapshot");

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
  if (!value) return null;
  const normalized = String(value).trim().replace(/-/g, "/").replace("T", " ");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
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
  const text = String(item.rawTime || item.time || "").replace(/-/g, "/");
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : 0;
}

function recordToTimeline(record = {}) {
  const title = homeDisplayText(record.title || record.message || record.medicine_name, "用药记录");
  const desc = homeDisplayText(record.description || record.detail || record.result || record.action, "");
  const rawTime = record.createdAt || record.created_at || record.time || "";
  return {
    id: `record-${record._id || record.id || rawTime || title}`,
    title,
    desc,
    time: timelineTime(rawTime),
    rawTime,
    level: record.status === "failed" || record.result === "failed" ? "bad" : "ok",
    source: "record",
  };
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

function buildTimeline(records, inquiries, commands, vitals, safetyEvents, attributionContext = {}) {
  const seen = new Set();
  return []
    .concat((records || []).map(recordToTimeline))
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
    return {
      slot: item.slot,
      name: item.name,
      title: `${item.name} 已确认无药`,
      desc: `${item.slot}号仓 · 已在药箱取药后确认用完，补入后请更新药品资料`,
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
  const focusTodo = (state.todoItems || [])[0] || null;
  const focusState = state.heroLevel === "danger"
    ? "risk"
    : (state.heroLevel === "valid" ? "normal" : "pending");
  let focusAction = null;
  let focusActivation = "none";
  if (focusTodo && focusTodo.action === "safety" && focusTodo.eventId) {
    focusAction = {
      id: "home.focus.safety",
      label: "查看安全核查记录",
      payload: { eventId: focusTodo.eventId },
    };
    focusActivation = "surface";
  } else if (focusTodo && focusTodo.action === "medicine" && focusTodo.slot) {
    focusAction = {
      id: "home.focus.medicine",
      label: `打开 ${focusTodo.slot} 号仓维护`,
      payload: { slot: focusTodo.slot },
    };
    focusActivation = "surface";
  } else if (focusTodo && focusTodo.action === "remind" && focusTodo.planKey) {
    focusAction = {
      id: "home.focus.remind",
      label: state.reminderSubmitting ? "发送中…" : "发送用药提醒",
      payload: { planKey: focusTodo.planKey },
      disabled: Boolean(state.reminderSubmitting),
    };
    focusActivation = "button";
  } else if (!(state.device && state.device.online)) {
    focusAction = { id: "home.focus.connection", label: "打开药箱连接设置" };
    focusActivation = "surface";
  }

  return composeCarePage({
    key: "home-care",
    title: "家庭照护",
    online: Boolean(state.device && state.device.online),
    focus: {
      eyebrow: "今天需要处理",
      title: state.focusTitle,
      supporting: state.stale
        ? (String(state.focusSub || "").indexOf("可能不是最新") >= 0
          ? `刷新失败。${state.focusSub}`
          : ["刷新失败，当前照护信息可能不是最新。", state.focusSub].filter(Boolean).join(" "))
        : state.focusSub,
      state: { kind: focusState, label: state.heroBadge },
      action: focusAction,
      activation: focusActivation,
    },
    overview: [
      {
        key: "home-fact-plan",
        label: "今日计划",
        value: (state.planItems || []).length,
        state: (state.planItems || []).length ? "pending" : "muted",
      },
      {
        key: "home-fact-safety",
        label: "未读拦截",
        value: state.safetyState && state.safetyState.availability === "ready"
          ? (state.safetyState.nextCursor
            ? `至少 ${state.todaySafetyCount || 0}`
            : (state.todaySafetyCount || 0))
          : (state.safetyState && state.safetyState.availability === "unsupported"
            ? "未支持"
            : (state.safetyState && state.safetyState.availability === "forbidden" ? "无权限" : "待确认")),
        state: state.todaySafetyCount
          ? "risk"
          : (state.safetyState && ["unknown", "error", "forbidden"].includes(state.safetyState.availability) ? "pending" : "muted"),
        action: state.todaySafetyCount
          ? { id: "home.safety.records", label: "查看安全核查记录", payload: { filter: "safety" } }
          : null,
      },
      {
        key: "home-fact-medicine-risk",
        label: "药品风险",
        value: (Number(state.expiryRiskCount || 0) + Number(state.depletedCount || 0))
          || (state.inventoryUnknownCount ? `${state.inventoryUnknownCount} 待确认` : 0),
        state: state.expiredCount
          ? "risk"
          : ((state.expiryRiskCount || state.depletedCount || state.inventoryUnknownCount) ? "pending" : "muted"),
        action: (state.expiryRiskCount || state.depletedCount || state.inventoryUnknownCount)
          ? {
            id: `home.cabinet.${state.primaryMedicineFilter || "all"}`,
            label: state.inventoryUnknownCount && !(state.expiryRiskCount || state.depletedCount)
              ? "查看库存待确认药品"
              : "查看需处理药品",
            payload: { filter: state.primaryMedicineFilter || "all" },
          }
          : null,
      },
      {
        key: "home-fact-device",
        label: "药箱",
        value: state.device && state.device.online ? "在线" : "待连接",
        state: state.device && state.device.online ? "normal" : "pending",
      },
    ],
    sections: [
      {
        key: "home-today-care",
        intent: "tasks",
        title: "今日照护",
        more: (state.todoItems || []).length > 1
          ? { id: "home.today", label: `全部 ${state.todoItems.length} 项` }
          : null,
        items: [
          {
            key: "home-next-dose",
            symbol: "medicine",
            title: "下一次用药",
            supporting: state.nextDoseText,
            state: planItems.length
              ? { kind: "pending", label: "待提醒" }
              : { kind: "normal", label: "已完成" },
            action: reminderKey
              ? {
                id: `home.remind.${reminderKey}`,
                label: state.reminderSubmitting ? "发送中…" : "发送提醒",
                payload: { planKey: reminderKey },
                disabled: Boolean(state.reminderSubmitting),
              }
              : null,
          },
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
            title: "近期动态",
            supporting: state.latestCount ? `最近 ${state.latestCount} 条照护动态` : "还没有照护动态",
            state: { kind: "muted", label: state.latestCount ? `${state.latestCount} 条` : "暂无" },
            action: { id: "home.timeline", label: "查看近期动态" },
          },
        ],
      },
      {
        key: "home-navigation",
        intent: "navigation",
        title: "更多照护",
        items: [
          {
            key: "home-inquiry-navigation",
            symbol: "conversation",
            title: "问询摘要",
            supporting: state.inquiryCount ? `${state.inquiryCount} 条已完成` : "查看家人的健康结论",
            state: { kind: "actionable", label: "问询" },
            action: { id: "home.inquiry", label: "打开家庭问询" },
          },
          {
            key: "home-family-navigation",
            symbol: "person",
            title: "家人和药箱",
            supporting: state.device && state.device.online ? "药箱在线，可查看家人照护" : "查看家人资料和药箱连接状态",
            state: state.device && state.device.online
              ? { kind: "normal", label: "药箱在线" }
              : { kind: "pending", label: "待连接" },
            action: { id: "home.family", label: "查看家人和药箱" },
          },
        ],
      },
    ],
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
    focusSub: "取药、问询和药品变化会自动同步。",
    todoItems: [],
    todoPreview: [],
    planItems: [],
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
    this._stopRealtime = realtime.subscribe(() => this.load(), null, {
      collections: ["devices", "medicines", "records", "vitals", "commands", "today_plans"],
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

  async load() {
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
        timeline: [],
        timelinePreview: [],
        reminderPlan: {},
        detailVisible: false,
        stale: false,
        safetyState: { availability: "unknown", events: [], message: "暂时无法确认安全记录是否为最新" },
        safetyDeviceId: requestDeviceId,
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
      const [device, medicines, records, commands, snapshot, vitals, safetyState, inventoryPolicy] = await Promise.all([
        api.getDeviceStrict(requestDeviceId),
        api.getMedicinesStrict(requestDeviceId),
        api.getRecentRecordsStrict(20, requestDeviceId),
        api.getRecentCommandsStrict(12, requestDeviceId),
        api.getSnapshotStrict({ inquiryLimit: 12, deviceId: requestDeviceId }),
        api.getRecentVitalsStrict(20, requestDeviceId),
        medicationSafetyEventModule.list({ limit: 10, unreadOnly: true, deviceId: requestDeviceId }),
        api.getCapabilitiesStrict(requestDeviceId)
          .then(cabinetView.inventoryPolicyFor)
          .catch(error => {
            console.warn("home inventory capability read failed", error);
            return cabinetView.inventoryPolicyFor();
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
      const visibleRecords = personaPolicy.strict
        ? (records || []).filter(item => personaPolicy.allowsCurrentRecord(
          currentFactIdentity(item),
          { allowUnlinked: true },
        ))
        : (records || []);
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
      const pendingPlans = sortedPlans(plans.filter(isPlanActionable));
      const inventoryMedicines = (medicines || []).map(item => cabinetView.decorateCabinetSlot(item, inventoryPolicy));
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
          title: planTodoTitle(plan),
          desc: planTodoDesc(plan),
          level: planTodoLevel(plan),
          action: "remind",
          actionLabel: "提醒",
          heroBadge: "待提醒",
        });
      });
      risks.attention.forEach(item => {
        todoItems.push({
          id: `expiry-${item.slot}`,
          icon: "期",
          title: `${item.name} ${item.expiryText}`,
          desc: `${item.slot}号仓 · ${item.expiryHint}`,
          level: item.expiryClass === "expired" ? "bad" : "warn",
          action: "medicine",
          actionLabel: "处理",
          heroBadge: expiryTodoBadge(item.expiryClass),
          slot: item.slot,
        });
      });
      depleted.forEach(item => {
        todoItems.push({
          id: `depleted-${item.slot}`,
          icon: "补",
          title: item.title,
          desc: item.desc,
          level: "warn",
          action: "medicine",
          actionLabel: "补药",
          heroBadge: "待补药",
          slot: item.slot,
        });
      });

      const safetyProjection = medicationSafetyEvents.projectHome(visibleSafetyEvents);
      if (safetyProjection.focusBlocked) {
        const event = safetyProjection.focusBlocked;
        todoItems.push({
          id: `safety-${event.id}`,
          eventId: event.id,
          icon: "安",
          title: `${event.personName}的取药已被药箱阻止`,
          desc: [event.medicineName, event.summary || "检测到已登记信息冲突", "药箱未出药"].filter(Boolean).join(" · "),
          level: "bad",
          priority: -100,
          action: "safety",
          actionLabel: "查看",
          heroBadge: "安全拦截",
        });
      } else if (safetyProjection.focusCheckFailed && device.online === true) {
        const event = safetyProjection.focusCheckFailed;
        todoItems.push({
          id: `safety-${event.id}`,
          eventId: event.id,
          icon: "安",
          title: `${event.personName}的安全核查未完成`,
          desc: [event.medicineName, event.summary || "人物或药品资料暂不可用", "药箱未出药"].filter(Boolean).join(" · "),
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
        visibleRecords,
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
        stockCount: risks.medicines.length,
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
        nextDoseText,
        todayPlanNote: planItems.length
          ? `今日还有 ${planItems.length} 项待执行，提醒由药箱播报`
          : "今天没有待执行用药",
        timeline,
        timelinePreview: timeline.slice(0, 2),
        reminderPlan: pendingPlans[0] || {},
        reminderSubmitting: Boolean(this.data.reminderSubmitting),
        safetyState: visibleSafetyState,
        deviceId: requestDeviceId,
        safetyDeviceId: requestDeviceId,
        todaySafetyCount: safetyProjection.todayBlockedCount,
        stale: transientSafetyFailure,
      };
      nextData.carePage = homeCarePage(nextData);
      this._hasLoadedSnapshot = true;
      this.setData(nextData);
    } catch (error) {
      if (loadRequestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      console.warn("home care read failed", error);
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
    wx.switchTab({ url: "/pages/cabinet/index" });
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
      this.goAddMedicine({ currentTarget: { dataset: { slot: payload.slot } } });
    } else if (id === "home.focus.remind") {
      this.sendMedicineReminder((this._reminderPlansByKey || {})[payload.planKey]);
    } else if (id === "home.focus.connection") {
      this.goSettings();
    } else if (id === "home.focus.safety") {
      this.openSafetyRecord(payload.eventId);
    } else if (id === "home.safety.records") {
      this.openSafetyRecords();
    } else if (id.indexOf("home.cabinet.") === 0) {
      wx.navigateTo({ url: `/pages/medicineList/index?filter=${payload.filter || "all"}` });
    } else if (id.indexOf("home.remind.") === 0) {
      this.sendMedicineReminder((this._reminderPlansByKey || {})[payload.planKey]);
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
    const slot = e.currentTarget.dataset.slot || "";
    const reminderKey = e.currentTarget.dataset.planKey || "";
    this.closeDetail();
    if (action === "remind") {
      this.sendMedicineReminder((this._reminderPlansByKey || {})[reminderKey]);
    } else if (action === "medicine") {
      this.goAddMedicine({ currentTarget: { dataset: { slot } } });
    } else if (action === "safety") {
      this.openSafetyRecord(e.currentTarget.dataset.eventId);
    } else {
      this.goRecords();
    }
  },

  goAddMedicine(e) {
    const slot = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.slot : "";
    wx.navigateTo({ url: slot ? `/pages/addMedicine/index?slot=${slot}` : "/pages/addMedicine/index" });
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
    app.globalData.pendingCareRecord = { type: "safety", eventId: id, deviceId };
    wx.switchTab({ url: "/pages/records/index" });
  },

  openSafetyRecords() {
    getApp().globalData.pendingCareFilter = "safety";
    wx.switchTab({ url: "/pages/records/index" });
  },

  goVitals() {
    wx.navigateTo({ url: "/pages/vitals/index" });
  },

  goAi() {
    wx.switchTab({ url: "/pages/ai/index" });
  },

  goSettings() {
    wx.switchTab({ url: "/pages/settings/index" });
  },
});
