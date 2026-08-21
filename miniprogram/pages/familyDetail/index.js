const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const { isDoneStatus, isPlanActionable, isPlanDueToday, planTimeValue } = require("../../utils/carePlan");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const { runAfterDeviceSessionReady } = require("../../utils/deviceSession");
const medicationSafetyEvents = require("../../modules/medicationSafetyEvents");
const vitalsAttribution = require("../../modules/vitalsAttribution");
const personaVisibility = require("../../modules/personaVisibility");
const { mergeCapabilitySnapshots } = require("../../modules/capabilitySnapshot");
const { parseTimestamp } = require("../../utils/dateTime");

const medicationSafetyEventModule = medicationSafetyEvents.createMedicationSafetyEventModule(api);

function decoded(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (error) {
    return String(value || "");
  }
}

function text(value, fallback = "") {
  const result = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
  return result || fallback;
}

function timeValue(value) {
  return parseTimestamp(value) || 0;
}

function timeLabel(value) {
  const source = text(value);
  if (!source) return "时间待同步";
  const timestamp = timeValue(source);
  if (!timestamp) return source.slice(0, 16);
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function identityMatchesScope(personId, personaGeneration, scope = {}) {
  return api.inquiryMatchesPersonScope({
    personId: text(personId),
    personaGeneration: text(personaGeneration),
    personKey: "family-detail-scope",
  }, scope, { strictGeneration: true });
}

function loadMoreContextIsCurrent(pageData = {}, deviceId = "", scope = {}) {
  return text(pageData.deviceId) === text(deviceId)
    && identityMatchesScope(scope.personId, scope.personaGeneration, pageData.personScope || {});
}

function selectedServiceUser(users = [], scope = {}) {
  return (users || []).find(user => (
    user.archived !== true
    && identityMatchesScope(user.id, user.personaGeneration, scope)
  )) || null;
}

function planStatus(plan = {}) {
  if (isPlanActionable(plan)) return { kind: "pending", label: "待处理" };
  if (isDoneStatus(plan.status)) return { kind: "normal", label: "已完成" };
  return { kind: "muted", label: "已跳过" };
}

function planDateText(plan = {}) {
  if (isPlanDueToday(plan)) return "今天";
  return text(plan.next_due_date || plan.nextDueDate || plan.date, "近期计划");
}

function projectPlans(plans = []) {
  return (plans || []).slice().sort((left, right) => {
    const todayOrder = Number(isPlanDueToday(right)) - Number(isPlanDueToday(left));
    return todayOrder || planTimeValue(left) - planTimeValue(right);
  }).map((plan, index) => ({
    key: `family-plan-${text(plan.id || plan._id, index)}`,
    symbol: "medicine",
    title: `${text(plan.time, "待定").slice(0, 5)} · ${text(plan.medicine || plan.medicine_name || plan.name, "计划用药")}`,
    supporting: [text(plan.dose), planDateText(plan)].filter(Boolean).join(" · "),
    meta: text(plan.timing_label || plan.timingLabel),
    state: planStatus(plan),
  }));
}

function inquiryState(inquiry = {}) {
  const risk = text(inquiry.riskLevel || inquiry.riskLabel).toLowerCase();
  if (["high", "emergency", "critical", "高风险", "紧急"].some(token => risk.indexOf(token) >= 0)) {
    return { kind: "risk", label: "需关注" };
  }
  if (["medium", "warn", "中风险", "注意"].some(token => risk.indexOf(token) >= 0)) {
    return { kind: "pending", label: "注意" };
  }
  return { kind: "normal", label: "已完成" };
}

function projectInquiries(inquiries = []) {
  return (inquiries || []).slice().sort((left, right) => (
    timeValue(right.updatedAt || right.createdAt) - timeValue(left.updatedAt || left.createdAt)
  )).map((inquiry, index) => ({
    key: `family-inquiry-${text(inquiry.id, index)}`,
    symbol: "conversation",
    title: text(inquiry.topic, "健康问询"),
    supporting: text(inquiry.summary, "已形成照护摘要"),
    meta: [timeLabel(inquiry.updatedAt || inquiry.createdAt), text(inquiry.riskLabel)].filter(Boolean).join(" · "),
    state: inquiryState(inquiry),
  }));
}

function vitalsState(record = {}) {
  const quality = text(record.quality).toLowerCase();
  if (["error", "failed", "failure", "sensor_error", "invalid"].includes(quality)) {
    return { kind: "risk", label: "测量异常" };
  }
  if (["partial", "poor_signal", "weak_signal", "low_signal"].includes(quality)) {
    return { kind: "pending", label: "建议复测" };
  }
  return { kind: "normal", label: "已同步" };
}

function projectVitals(vitals = []) {
  return (vitals || []).slice().sort((left, right) => (
    timeValue(right.createdAt) - timeValue(left.createdAt)
  )).map((record, index) => {
    const metrics = [
      record.bodyTemp !== undefined && record.bodyTemp !== "" ? `体温 ${record.bodyTemp}℃` : "",
      record.spo2 !== undefined && record.spo2 !== "" ? `血氧 ${record.spo2}%` : "",
      record.heartRate !== undefined && record.heartRate !== "" ? `心率 ${record.heartRate} bpm` : "",
    ].filter(Boolean);
    return {
      key: `family-vitals-${text(record.recordId, index)}`,
      symbol: "measure",
      title: metrics.join(" · ") || "健康测量",
      supporting: record.attribution && record.attribution.label || "已核对人物归属",
      meta: timeLabel(record.createdAt),
      state: vitalsState(record),
    };
  });
}

function projectSafety(events = []) {
  return medicationSafetyEventModule.projectRecords(events).map((event, index) => ({
    key: `family-safety-${text(event.id, index)}`,
    symbol: "safety",
    title: text(event.title, "用药风险记录"),
    supporting: [text(event.summary), text(event.subtitle)].filter(Boolean).join(" · "),
    meta: [timeLabel(event.occurredAt), event.readState === "UNREAD" ? "未读" : "已读"].filter(Boolean).join(" · "),
    state: event.state,
    action: text(event.id) ? {
      id: `family.person.safety.open.${text(event.id)}`,
      label: "查看用药风险详情",
      payload: { eventId: text(event.id) },
    } : null,
  }));
}

function mergeSafetyEvents(existing = [], incoming = []) {
  const byId = new Map();
  (existing || []).concat(incoming || []).forEach(event => {
    const id = text(event && event.id);
    if (id) byId.set(id, event);
  });
  return Array.from(byId.values());
}

function reconcileSafetyRefresh(previous = {}, next = {}, deviceId = "") {
  const requestDeviceId = text(deviceId);
  const availability = text(next.availability, "unknown");
  if (availability === "ready") {
    return Object.assign({}, next, {
      deviceId: requestDeviceId,
      stale: false,
      hasReadySnapshot: true,
    });
  }
  if (["forbidden", "unsupported"].includes(availability)) {
    return Object.assign({}, next, {
      deviceId: requestDeviceId,
      events: [],
      nextCursor: "",
      stale: false,
      hasReadySnapshot: false,
    });
  }
  const sameDevice = text(previous.deviceId) === requestDeviceId;
  const canPreserve = sameDevice && (previous.hasReadySnapshot === true || previous.availability === "ready");
  if (["error", "unknown"].includes(availability) && canPreserve) {
    return Object.assign({}, next, {
      deviceId: requestDeviceId,
      events: previous.events || [],
      nextCursor: previous.nextCursor || "",
      stale: true,
      hasReadySnapshot: true,
      message: `${next.message || "安全记录暂时无法刷新"}，已保留上次记录，可能不是最新`,
    });
  }
  return Object.assign({}, next, {
    deviceId: requestDeviceId,
    stale: false,
    hasReadySnapshot: false,
  });
}

function safetySupporting(state = {}, eventCount = 0, loadMoreError = "") {
  if (loadMoreError) return `${eventCount} 条安全记录 · ${loadMoreError}`;
  if (state.availability !== "ready") return state.message || "暂时无法确认安全记录是否为最新";
  if (!eventCount) return "暂无该家庭成员的用药风险记录";
  return state.nextCursor ? `已显示 ${eventCount} 条，还有更多记录` : `已显示全部 ${eventCount} 条记录`;
}

function buildPersonCarePage({ scope = {}, user = {}, device = {}, plans = [], inquiries = [], vitals = [], safetyState = {}, safetyLoadingMore = false, safetyLoadMoreError = "" } = {}) {
  const safetyRows = projectSafety(safetyState.events || []);
  const personName = text(user.name, text(scope.personName, "家人详情"));
  const profile = text(user.profile);
  const identityNote = scope.personaGeneration ? "仅显示当前身份版本的资料" : "仅显示未标注代次的历史身份资料";
  const todayPlanCount = plans.filter(isPlanDueToday).length;
  const safetyCountValue = safetyState.nextCursor
    ? `至少 ${safetyRows.length}`
    : safetyRows.length;

  return composeCarePage({
    key: "family-person-detail",
    title: "家人照护详情",
    online: device.online === true,
    focus: {
      eyebrow: "只读照护档案",
      title: personName,
      supporting: [profile, identityNote].filter(Boolean).join(" · "),
      state: { kind: "normal", label: "身份已核对" },
    },
    overview: [
      { key: "family-person-plan-count", label: "今日计划", value: todayPlanCount, state: todayPlanCount ? "pending" : "muted" },
      { key: "family-person-inquiry-count", label: "窗口内问询", value: inquiries.length, state: inquiries.length ? "actionable" : "muted" },
      { key: "family-person-safety-count", label: "用药风险", value: safetyCountValue, state: safetyRows.length ? "actionable" : "muted" },
      { key: "family-person-vitals-count", label: "窗口内测量", value: vitals.length, state: vitals.length ? "normal" : "muted" },
    ],
    sections: [
      {
        key: "family-person-plans",
        intent: "tasks",
        title: "今日与近期计划",
        supporting: "只读展示，不在家属端调整或执行计划",
        empty: "当前身份版本暂无同步计划。",
        items: projectPlans(plans),
      },
      {
        key: "family-person-inquiries",
        intent: "conversations",
        title: "已完成问询摘要",
        supporting: "当前展示全设备最近 60 条同步窗口内属于这位家人的已完成问询。",
        empty: "最近 60 条同步窗口内暂无已完成问询。",
        items: projectInquiries(inquiries),
      },
      {
        key: "family-person-safety",
        intent: "timeline",
        title: "用药风险",
        supporting: safetySupporting(safetyState, safetyRows.length, safetyLoadMoreError),
        empty: safetyState.message || "暂无该家庭成员的用药风险记录。",
        items: safetyRows,
        more: safetyState.availability === "ready" && safetyState.nextCursor ? {
          id: "family.person.safety.more",
          label: safetyLoadingMore ? "正在加载" : (safetyLoadMoreError ? "重试加载" : "加载更多"),
          disabled: safetyLoadingMore,
        } : null,
      },
      {
        key: "family-person-vitals",
        intent: "timeline",
        title: "健康测量",
        supporting: "当前展示该药箱最近 80 条体征同步窗口内、精确属于当前身份版本的记录。",
        empty: "最近 80 条体征同步窗口内暂无属于当前身份版本的健康测量。",
        items: projectVitals(vitals),
      },
    ],
  });
}

Page({
  data: {
    carePage: loadingCarePage("家人照护详情", "正在整理这位家人的照护资料…"),
    personScope: {},
    deviceId: "",
    selectedUser: {},
    device: {},
    plans: [],
    inquiries: [],
    vitals: [],
    safetyState: { availability: "unknown", message: "暂时无法确认安全记录是否为最新", events: [], nextCursor: "" },
    safetyLoadingMore: false,
    safetyLoadMoreError: "",
    hasLoaded: false,
  },

  onLoad(options = {}) {
    const app = getApp();
    const personScope = {
      personId: decoded(options.personId).trim(),
      personaGeneration: decoded(options.personaGeneration).trim(),
      personName: decoded(options.personName).trim(),
    };
    this.setData({
      personScope,
      deviceId: text(app && app.globalData && app.globalData.deviceId),
    });
    if (personScope.personName && wx && typeof wx.setNavigationBarTitle === "function") {
      wx.setNavigationBarTitle({ title: `${personScope.personName}的照护` });
    }
  },

  onShow() {
    return runAfterDeviceSessionReady(() => {
      const app = getApp();
      const activeDeviceId = text(app && app.globalData && app.globalData.deviceId);
      if (activeDeviceId !== text(this.data.deviceId)) {
        this._loadRequestId = (this._loadRequestId || 0) + 1;
        this._safetyPaginationRevision = 0;
        this.setData({
          deviceId: activeDeviceId,
          selectedUser: {},
          device: {},
          plans: [],
          inquiries: [],
          vitals: [],
          hasLoaded: false,
          safetyState: { availability: "unknown", message: "暂时无法确认安全记录是否为最新", events: [], nextCursor: "" },
          safetyLoadingMore: false,
          safetyLoadMoreError: "",
          carePage: loadingCarePage("家人照护详情", "正在整理这位家人的照护资料…"),
        });
      }
      if (!this.data.personScope.personId) {
        this.showInvalidIdentity();
        return undefined;
      }
      const loading = this.load();
      this.startRealtime();
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
      collections: ["service_users", "today_plans", "inquiries", "commands", "vitals"],
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

  showInvalidIdentity(message = "这位家人的稳定身份尚未同步，暂不能查看照护详情。") {
    this.setData({
      carePage: composeCarePage({
        key: "family-person-invalid",
        title: "家人照护详情",
        showStatus: false,
        phase: { kind: "empty", message },
      }),
    });
  },

  async load() {
    const scope = this.data.personScope || {};
    if (!scope.personId) {
      this.showInvalidIdentity();
      return;
    }
    const initialLoad = this.data.hasLoaded !== true;
    const requestDeviceId = text(this.data.deviceId);
    const loadRequestId = (this._loadRequestId || 0) + 1;
    this._loadRequestId = loadRequestId;
    if (initialLoad) {
      this.setData({ carePage: loadingCarePage("家人照护详情", "正在整理这位家人的照护资料…") });
    }
    try {
      const [snapshot, recentVitals, safetyState] = await Promise.all([
        api.getSnapshotStrict({ inquiryLimit: 60, deviceId: requestDeviceId }),
        api.getRecentVitalsStrict(80, requestDeviceId),
        medicationSafetyEventModule.list({ personId: scope.personId, limit: 50, deviceId: requestDeviceId }),
      ]);
      if (loadRequestId !== this._loadRequestId || text(this.data.deviceId) !== requestDeviceId) return;
      const users = snapshot.serviceUsers || [];
      const app = getApp();
      const deviceSessionState = app && app.globalData && app.globalData.deviceSession || {};
      const capabilitySnapshot = mergeCapabilitySnapshots(
        deviceSessionState,
        snapshot,
        safetyState.capabilitySnapshot,
      );
      const personaPolicy = personaVisibility.createPersonaVisibilityPolicy(users, {
        capabilities: capabilitySnapshot.capabilities || {},
        serviceUsersSnapshotComplete: snapshot.serviceUsersSnapshotComplete === true,
      });
      const activeUsers = personaPolicy.activeUsers();
      const user = selectedServiceUser(activeUsers, scope);
      if (!user) {
        this.showInvalidIdentity("人物资料已更新或归档，请返回家人页重新选择。");
        return;
      }
      const plans = (snapshot.plans || []).filter(plan => (
        (!personaPolicy.strict || personaPolicy.allowsPlan(plan))
        &&
        typeof api.planMatchesServiceUser === "function"
        && api.planMatchesServiceUser(plan, user, { strictGeneration: true })
      ));
      const commandInquiries = (snapshot.commands || []).map(api.inquiryFromAiCommand).filter(Boolean);
      const inquiries = api.mergeInquirySources(snapshot.inquiries || [], commandInquiries)
        .map(api.normalizeInquiryRecord)
        .filter(api.shouldShowCaregiverInquiry)
        .filter(inquiry => !personaPolicy.strict || personaPolicy.allowsInquiry(inquiry))
        .filter(inquiry => api.inquiryMatchesPersonScope(inquiry, scope, { strictGeneration: true }));
      const vitals = (recentVitals || []).map(record => {
        const attribution = vitalsAttribution.classifyVitalsAttribution(record, {
          activeUsers,
          attributionSupported: vitalsAttribution.supportsVitalsAttribution(capabilitySnapshot),
        });
        return Object.assign({}, record, { attribution });
      }).filter(record => vitalsAttribution.matchesVitalsPersonScope(record.attribution, scope));
      let scopedSafetyState = Object.assign({}, safetyState, {
        events: (safetyState.events || []).filter(event => (
          (!personaPolicy.strict || personaPolicy.allowsCurrentRecord(event))
          &&
          identityMatchesScope(event.personId, event.personaGeneration, scope)
        )),
      });
      const currentSafetyState = this.data.safetyState || {};
      if (!initialLoad
        && this._safetyPaginationRevision > 0
        && scopedSafetyState.availability === "ready"
        && (currentSafetyState.hasReadySnapshot === true || currentSafetyState.availability === "ready")
        && text(currentSafetyState.deviceId) === requestDeviceId) {
        scopedSafetyState = Object.assign({}, scopedSafetyState, {
          events: mergeSafetyEvents(currentSafetyState.events || [], scopedSafetyState.events || []),
          nextCursor: currentSafetyState.nextCursor || "",
        });
      }
      scopedSafetyState = reconcileSafetyRefresh(currentSafetyState, scopedSafetyState, requestDeviceId);
      if (["forbidden", "unsupported"].includes(scopedSafetyState.availability)) {
        this._safetyPaginationRevision = 0;
      }
      const nextData = {
        selectedUser: user,
        device: snapshot.device || {},
        plans,
        inquiries,
        vitals,
        safetyState: scopedSafetyState,
        safetyLoadingMore: false,
        safetyLoadMoreError: "",
        hasLoaded: true,
      };
      nextData.carePage = buildPersonCarePage(Object.assign({ scope, user }, nextData));
      this.setData(nextData);
    } catch (error) {
      if (loadRequestId !== this._loadRequestId || text(this.data.deviceId) !== requestDeviceId) return;
      if (!initialLoad) return;
      this.setData({
        carePage: composeCarePage({
          key: "family-person-error",
          title: "家人照护详情",
          showStatus: false,
          phase: {
            kind: "error",
            message: "这位家人的照护资料暂未同步，请稍后重试。",
            action: { id: "family.person.retry", label: "重新读取照护资料" },
          },
        }),
      });
    }
  },

  onCarePageAction(event) {
    const detail = (event && event.detail) || {};
    const id = text(detail.id);
    if (id === "family.person.retry") {
      return this.load();
    } else if (id === "family.person.safety.more") {
      this.loadMoreSafetyEvents();
    } else if (id.startsWith("family.person.safety.open.")) {
      this.openSafetyRecord(detail.payload && detail.payload.eventId);
    }
  },

  openSafetyRecord(eventId) {
    const id = text(eventId);
    if (!id) return;
    const app = getApp();
    if (!app.globalData) app.globalData = {};
    const pageDeviceId = text(this.data.deviceId);
    const activeDeviceId = text(app.globalData.deviceId);
    if (!pageDeviceId || activeDeviceId !== pageDeviceId) return;
    app.globalData.pendingCareRecord = { type: "safety", eventId: id, deviceId: pageDeviceId };
    wx.switchTab({ url: "/pages/records/index" });
  },

  updatePersonPage(next = {}) {
    const viewState = Object.assign({}, this.data, next);
    const carePage = buildPersonCarePage({
      scope: viewState.personScope,
      user: viewState.selectedUser,
      device: viewState.device,
      plans: viewState.plans,
      inquiries: viewState.inquiries,
      vitals: viewState.vitals,
      safetyState: viewState.safetyState,
      safetyLoadingMore: viewState.safetyLoadingMore,
      safetyLoadMoreError: viewState.safetyLoadMoreError,
    });
    this.setData(Object.assign({}, next, { carePage }));
  },

  async loadMoreSafetyEvents() {
    const current = this.data.safetyState || {};
    const cursor = text(current.nextCursor);
    const scope = this.data.personScope || {};
    const requestScope = {
      personId: text(scope.personId),
      personaGeneration: text(scope.personaGeneration),
    };
    const requestDeviceId = text(this.data.deviceId);
    if (this.data.safetyLoadingMore || current.availability !== "ready" || !cursor || !scope.personId) return;

    this.updatePersonPage({ safetyLoadingMore: true, safetyLoadMoreError: "" });
    try {
      const nextPage = await medicationSafetyEventModule.list({
        personId: scope.personId,
        limit: 50,
        cursor,
        deviceId: requestDeviceId,
      });
      if (!loadMoreContextIsCurrent(this.data, requestDeviceId, requestScope)) return;
      if (nextPage.availability !== "ready") {
        this.updatePersonPage({
          safetyLoadingMore: false,
          safetyLoadMoreError: nextPage.message || "更多安全记录加载失败，可重试",
        });
        return;
      }
      if (text(nextPage.nextCursor) === cursor) {
        this.updatePersonPage({
          safetyLoadingMore: false,
          safetyLoadMoreError: "更多安全记录加载未完成，请重试",
        });
        return;
      }
      const incoming = (nextPage.events || []).filter(event => (
        identityMatchesScope(event.personId, event.personaGeneration, scope)
      ));
      const nextCursor = text(nextPage.nextCursor);
      const latestState = this.data.safetyState && this.data.safetyState.availability === "ready"
        ? this.data.safetyState
        : current;
      this._safetyPaginationRevision = (this._safetyPaginationRevision || 0) + 1;
      this.updatePersonPage({
        safetyState: Object.assign({}, latestState, nextPage, {
          events: mergeSafetyEvents(latestState.events || [], incoming),
          nextCursor,
        }),
        safetyLoadingMore: false,
        safetyLoadMoreError: "",
      });
    } catch (error) {
      if (!loadMoreContextIsCurrent(this.data, requestDeviceId, requestScope)) return;
      this.updatePersonPage({
        safetyLoadingMore: false,
        safetyLoadMoreError: "更多安全记录加载失败，可重试",
      });
    }
  },
});
