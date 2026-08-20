const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const deviceSession = require("../../utils/deviceSession");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const medicationSafetyEvents = require("../../modules/medicationSafetyEvents");

const riskGateway = medicationSafetyEvents.createMedicationSafetyEventModule(api);

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function reasonText(event = {}) {
  const labels = {
    ALLERGY: "存在已登记过敏信息",
    CONTRAINDICATION: "与已登记健康情况存在禁忌",
    DUPLICATE_INGREDIENT: "可能与现有药品成分重复",
    DRUG_INTERACTION: "可能与长期用药发生相互作用",
    AGE_RESTRICTION: "年龄信息需要进一步核对",
    PROFILE_INCOMPLETE: "个人健康资料不足",
    MEDICINE_DATA_INCOMPLETE: "药品资料不足",
    EXPIRED: "药品已超过有效期",
  };
  const reasons = (event.reasonCodes || []).map(code => labels[code] || code).filter(Boolean);
  return reasons.join("；") || event.summary || "风险依据等待终端同步";
}

function riskState(event = {}) {
  if (event.checkStatus === "BLOCKED") return { kind: "risk", label: "明确风险" };
  if (event.checkStatus === "CHECK_FAILED") return { kind: "pending", label: "需要复核" };
  return { kind: "normal", label: "已核验" };
}

function decorateRisk(event = {}) {
  return Object.assign({}, event, {
    reasonText: reasonText(event),
    riskState: riskState(event),
  });
}

function composeRiskCarePage(device = {}, state = {}, options = {}) {
  const risks = (state.events || []).map(decorateRisk);
  const registry = medicationSafetyEvents.projectRiskRegistry(risks);
  const blocked = registry.blocked.map(decorateRisk);
  const review = registry.review.map(decorateRisk);
  const unread = registry.all.filter(event => event.readState === "UNREAD");
  const primary = unread.find(event => event.checkStatus === "BLOCKED")
    || blocked[0]
    || unread[0]
    || review[0]
    || risks[0]
    || null;
  const unavailable = state.availability !== "ready";

  return composeCarePage({
    key: "medication-risks",
    title: "用药风险",
    online: device.online === true,
    focus: primary ? {
      eyebrow: primary.checkStatus === "BLOCKED" ? "需要重点关注" : "最近风险核验",
      title: `${primary.personName} · ${primary.medicineName}`,
      supporting: primary.summary || primary.reasonText,
      state: primary.riskState,
      action: { id: "risks.open", label: "查看风险详情", payload: { eventId: primary.id } },
      activation: "surface",
    } : {
      eyebrow: "家庭用药安全",
      title: unavailable ? "暂时无法确认风险记录" : "暂无已记录用药风险",
      supporting: unavailable ? (state.message || "请稍后重新读取。") : "新的风险核验结果会集中显示在这里。",
      state: { kind: unavailable ? "pending" : "normal", label: unavailable ? "待确认" : "暂无风险" },
      action: unavailable ? { id: "risks.retry", label: "重新读取风险记录" } : null,
      activation: unavailable ? "button" : "none",
    },
    overview: [
      { key: "risks-blocked", label: "明确风险", value: blocked.length, state: blocked.length ? "risk" : "muted" },
      { key: "risks-review", label: "需要复核", value: review.length, state: review.length ? "pending" : "muted" },
      { key: "risks-unread", label: "未查看", value: unread.length, state: unread.length ? "actionable" : "muted" },
    ],
    sections: [{
      key: "risks-blocked-list",
      intent: "tasks",
      title: "明确用药风险",
      supporting: options.stale ? "刷新失败，当前显示的是上次同步结果。" : "",
      empty: unavailable ? (state.message || "风险资料暂不可用。") : "暂无明确用药风险。",
      items: blocked.map(event => ({
        key: `risk-registry-${event.registryKey}`,
        symbol: "safety",
        title: `${event.personName} · ${event.medicineName}`,
        supporting: event.reasonText,
        meta: [event.occurredAt, event.occurrenceCount > 1 ? `${event.occurrenceCount} 次核验` : ""].filter(Boolean).join(" · "),
        state: event.riskState,
        action: { id: "risks.open", label: "查看风险详情", payload: { eventId: event.eventId || event.id } },
      })),
    }, {
      key: "risks-review-list",
      intent: "tasks",
      title: "需要复核",
      empty: "暂无待复核项目。",
      items: review.map(event => ({
        key: `risk-review-${event.registryKey}`,
        symbol: "safety",
        title: `${event.personName} · ${event.medicineName}`,
        supporting: event.reasonText,
        meta: event.occurredAt,
        state: event.riskState,
        action: { id: "risks.open", label: "查看核验详情", payload: { eventId: event.eventId || event.id } },
      })),
    }],
  });
}

Page({
  data: {
    deviceId: "",
    device: {},
    riskState: { availability: "unknown", message: "正在确认风险记录", events: [] },
    carePage: loadingCarePage("用药风险", "正在整理家庭用药风险…"),
    detailVisible: false,
    selectedRisk: {},
    hasLoadedSnapshot: false,
  },

  onShow() {
    return deviceSession.runAfterDeviceSessionReady(() => {
      const loading = this.load();
      this.startRealtime();
      return loading;
    });
  },

  onHide() { this.stopRealtime(); },
  onUnload() { this.stopRealtime(); },

  startRealtime() {
    this.stopRealtime();
    this._stopRealtime = realtime.subscribe(() => this.load(), null, {
      collections: ["medication_safety_events"],
      intervalMs: 20000,
      immediate: false,
    });
  },

  stopRealtime() {
    if (this._stopRealtime) this._stopRealtime();
    this._stopRealtime = null;
  },

  async load() {
    const requestDeviceId = activeDeviceId();
    if (requestDeviceId !== String(this.data.deviceId || "").trim()) {
      this._hasLoadedSnapshot = false;
      this.setData({
        deviceId: requestDeviceId,
        device: {},
        riskState: { availability: "unknown", message: "正在确认风险记录", events: [] },
        carePage: loadingCarePage("用药风险", "正在整理家庭用药风险…"),
        detailVisible: false,
      });
    }
    const requestId = Number(this._loadRequestId || 0) + 1;
    this._loadRequestId = requestId;
    try {
      const [device, riskState] = await Promise.all([
        api.getDevice(requestDeviceId),
        riskGateway.list({ deviceId: requestDeviceId, limit: 100 }),
      ]);
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      this._hasLoadedSnapshot = riskState.availability === "ready";
      this.setData({
        deviceId: requestDeviceId,
        device,
        riskState,
        hasLoadedSnapshot: this._hasLoadedSnapshot,
        carePage: composeRiskCarePage(device, riskState),
      });
      this.consumePendingRisk();
    } catch (error) {
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      console.warn("medication risks loading failed", error);
      if (this._hasLoadedSnapshot) {
        this.setData({ carePage: composeRiskCarePage(this.data.device, this.data.riskState, { stale: true }) });
      } else {
        const riskState = { availability: "error", message: "风险记录读取失败，请稍后重试。", events: [] };
        this.setData({ riskState, carePage: composeRiskCarePage(this.data.device, riskState) });
      }
    }
  },

  onCarePageAction(event) {
    const detail = event && event.detail ? event.detail : {};
    if (detail.id === "risks.retry") return this.load();
    if (detail.id === "risks.open") return this.openRisk(detail.payload && detail.payload.eventId);
    return undefined;
  },

  consumePendingRisk() {
    const app = getApp();
    const pending = app && app.globalData && app.globalData.pendingMedicationRisk;
    if (!pending || pending.deviceId !== this.data.deviceId) return;
    app.globalData.pendingMedicationRisk = null;
    this.openRisk(pending.eventId);
  },

  async openRisk(eventId) {
    const event = (this.data.riskState.events || []).find(item => item.id === eventId);
    if (!event) return;
    const selectedRisk = decorateRisk(Object.assign({}, event, medicationSafetyEvents.eventPresentation(event)));
    this.setData({ selectedRisk, detailVisible: true });
    if (event.readState !== "UNREAD") return;
    try {
      await riskGateway.markRead(event.id, {
        deviceId: this.data.deviceId,
        personId: event.personId,
        personaGeneration: event.personaGeneration,
      });
      const events = (this.data.riskState.events || []).map(item => (
        item.id === event.id ? Object.assign({}, item, { readState: "READ" }) : item
      ));
      const riskState = Object.assign({}, this.data.riskState, { events });
      this.setData({ riskState, carePage: composeRiskCarePage(this.data.device, riskState) });
    } catch (error) {
      console.warn("medication risk read receipt failed", error);
    }
  },

  closeDetail() { this.setData({ detailVisible: false }); },
  noop() {},
});
