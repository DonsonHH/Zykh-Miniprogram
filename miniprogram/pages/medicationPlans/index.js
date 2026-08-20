const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const { runAfterDeviceSessionReady } = require("../../utils/deviceSession");
const planStatus = require("../../utils/carePlan");
const { isPlanDueToday } = planStatus;
const personaVisibility = require("../../modules/personaVisibility");

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function memberNameForPlan(plan = {}, users = []) {
  const member = (users || []).find(user => (
    api.planMatchesServiceUser(plan, user, { strictGeneration: true })
  ));
  return String(firstPresent(
    member && firstPresent(member.name, member.user_name, member.display_name),
    plan.target_user_name,
    plan.target_user,
    plan.user_name,
    plan.person_name,
    "家庭成员",
  )).trim();
}

function todayLabel() {
  const now = new Date();
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
}

function buildPlanRows(plans = [], users = [], now = new Date()) {
  const visiblePlans = (plans || [])
    .filter(isPlanDueToday)
    .map(plan => planStatus.buildPlanView(plan, now, memberNameForPlan(plan, users)));
  return planStatus.sortPlanViews(visiblePlans);
}

Page({
  data: {
    phase: "loading",
    phaseMessage: "正在读取今日计划…",
    deviceOnline: false,
    dateText: todayLabel(),
    headerSubtitle: "正在同步今日安排",
    plans: [],
    counts: { total: 0, taken: 0, remind: 0, notDue: 0 },
    lastUpdatedText: "",
  },

  onShow() {
    return runAfterDeviceSessionReady(() => {
      const loading = this.load();
      if (activeDeviceId()) this.startRealtime();
      else this.stopRealtime();
      return loading;
    });
  },

  onHide() {
    this.stopRealtime();
  },

  onUnload() {
    this.stopRealtime();
  },

  onPullDownRefresh() {
    return Promise.resolve(this.load()).finally(() => wx.stopPullDownRefresh());
  },

  startRealtime() {
    this.stopRealtime();
    this._stopRealtime = realtime.subscribe(() => this.load(), null, {
      collections: ["devices", "today_plans"],
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
    const requestDeviceId = activeDeviceId();
    const requestId = Number(this._requestId || 0) + 1;
    this._requestId = requestId;
    this.setData({
      dateText: todayLabel(),
      phase: this.data.plans.length ? this.data.phase : "loading",
      phaseMessage: "正在读取今日计划…",
      headerSubtitle: "正在同步今日安排",
    });

    if (!requestDeviceId) {
      this.stopRealtime();
      this.setData({
        phase: "empty",
        phaseMessage: "请先在“家人”页面确认已配对的药箱。",
        plans: [],
        counts: { total: 0, taken: 0, remind: 0, notDue: 0 },
        headerSubtitle: "尚未连接药箱",
        deviceOnline: false,
      });
      return;
    }

    try {
      const [snapshot, device] = await Promise.all([
        api.getSnapshotStrict({ inquiryLimit: 1, deviceId: requestDeviceId }),
        api.getDeviceStrict(requestDeviceId),
      ]);
      if (requestId !== this._requestId || activeDeviceId() !== requestDeviceId) return;

      const serviceUsers = snapshot.serviceUsers || [];
      const policy = personaVisibility.createPersonaVisibilityPolicy(serviceUsers, {
        capabilities: snapshot.capabilities || {},
        serviceUsersSnapshotComplete: snapshot.serviceUsersSnapshotComplete === true,
      });
      const visiblePlans = (snapshot.plans || []).filter(plan => policy.strict
        ? policy.allowsPlan(plan)
        : api.shouldShowPlanForServiceUsers(plan, serviceUsers));
      const rows = buildPlanRows(visiblePlans, serviceUsers, new Date());
      const counts = planStatus.summarizePlanViews(rows);
      const online = api.isDeviceOnline(device);
      this.setData({
        phase: "ready",
        phaseMessage: "",
        deviceOnline: online,
        plans: rows,
        counts,
        dateText: todayLabel(),
        headerSubtitle: counts.total ? `今日共 ${counts.total} 项计划` : "今日暂无计划",
        lastUpdatedText: "刚刚同步",
      });
    } catch (error) {
      if (requestId !== this._requestId || activeDeviceId() !== requestDeviceId) return;
      console.warn("medication plans loading failed", error);
      this.setData({
        phase: "error",
        phaseMessage: "计划暂时无法读取，请检查网络后重试。",
        headerSubtitle: "同步失败",
      });
    }
  },

  retry() {
    this.setData({ phase: "loading", phaseMessage: "正在重新读取今日计划…" });
    return this.load();
  },
});
