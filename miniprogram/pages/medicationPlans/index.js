const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const {
  runAfterDeviceSessionReady,
} = require("../../utils/deviceSession");
const planStatus = require("../../utils/carePlan");
const { isPlanDueToday } = planStatus;
const personaVisibility = require("../../modules/personaVisibility");
const offlinePageCache = require("../../utils/offlinePageCache");

const PLANS_CACHE_KEY = "medication-plans";

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function fallbackDevice(deviceId, reason = "") {
  return {
    deviceId,
    online: false,
    connection: { state: "unavailable", online: false, reason: String(reason || "联网后自动更新") },
    connectionState: "unavailable",
  };
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
    deviceOnline: null,
    deviceConnectionState: "loading",
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
    const requestDeviceId = activeDeviceId() || "zykh-qsm-001";
    const requestId = Number(this._requestId || 0) + 1;
    this._requestId = requestId;
    if (this._cacheHydratedDeviceId !== requestDeviceId) {
      this._cacheHydratedDeviceId = requestDeviceId;
      const restored = offlinePageCache.restorePage(requestDeviceId, PLANS_CACHE_KEY);
      if (restored) this.setData(restored.data);
    }
    this.setData({
      dateText: this.data.offlineSnapshot ? this.data.dateText : todayLabel(),
      phase: this.data.offlineSnapshot ? "ready" : (this.data.plans.length ? this.data.phase : "loading"),
      phaseMessage: this.data.offlineSnapshot
        ? `当前显示上次同步数据 · ${this.data.lastSyncedAtText || "时间未知"}`
        : "正在读取今日计划…",
      headerSubtitle: this.data.offlineSnapshot ? this.data.headerSubtitle : "正在同步今日安排",
    });

    try {
      const [deviceRead, snapshotRead] = await Promise.all([
        api.getDeviceStrict(requestDeviceId).then(
          value => ({ value, error: null }),
          error => ({ value: fallbackDevice(requestDeviceId, error.message), error }),
        ),
        api.getSnapshotStrict({ inquiryLimit: 1, deviceId: requestDeviceId }).then(
          value => ({ value, error: null }),
          error => ({ value: { serviceUsers: [], plans: [], capabilities: {} }, error }),
        ),
      ]);
      if (requestId !== this._requestId || activeDeviceId() !== requestDeviceId) return;
      const device = deviceRead.value;
      const snapshot = snapshotRead.value;

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
      const stale = Boolean(deviceRead.error || snapshotRead.error);
      if (stale && this.data.offlineSnapshot === true) {
        this.setData({
          phase: "ready",
          phaseMessage: `当前显示上次同步数据 · ${this.data.lastSyncedAtText || "时间未知"}`,
          lastUpdatedText: `上次同步 · ${this.data.lastSyncedAtText || "时间未知"}`,
          deviceOnline: false,
          deviceConnectionState: "stale",
        });
        return;
      }
      const lastSyncedAtMs = Date.now();
      const nextData = {
        phase: "ready",
        phaseMessage: stale ? "联网后自动更新今日计划。" : "",
        deviceOnline: online,
        deviceConnectionState: device.connectionState || (online ? "online" : "unavailable"),
        plans: rows,
        counts,
        dateText: todayLabel(),
        headerSubtitle: counts.total ? `今日共 ${counts.total} 项计划` : "今日暂无计划",
        lastUpdatedText: stale ? "等待同步" : "刚刚同步",
        offlineSnapshot: false,
        lastSyncedAtMs,
        lastSyncedAtText: offlinePageCache.formatUpdatedAt(lastSyncedAtMs),
      };
      this.setData(nextData);
      if (!deviceRead.error || !snapshotRead.error) {
        offlinePageCache.savePage(
          requestDeviceId,
          PLANS_CACHE_KEY,
          Object.assign({}, this.data, nextData),
          { updatedAtMs: lastSyncedAtMs, quality: stale ? "partial" : "complete" },
        );
      }
    } catch (error) {
      if (requestId !== this._requestId || activeDeviceId() !== requestDeviceId) return;
      console.warn("medication plans loading failed", error);
      this.setData({
        phase: "ready",
        phaseMessage: "联网后自动更新今日计划。",
        plans: [],
        counts: { total: 0, taken: 0, remind: 0, notDue: 0 },
        headerSubtitle: "今日暂无计划",
        lastUpdatedText: "等待同步",
        deviceOnline: null,
        deviceConnectionState: "unavailable",
      });
    }
  },

  retry() {
    this.setData({ phase: "loading", phaseMessage: "正在重新读取今日计划…" });
    return this.load();
  },
});
