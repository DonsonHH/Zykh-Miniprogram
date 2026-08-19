const api = require("../../../utils/api");
const realtime = require("../../../utils/realtime");
const { composeCarePage, loadingCarePage } = require("../../../utils/carePage");
const { createPersonaVisibilityPolicy } = require("../../../modules/personaVisibility");
const { runAfterDeviceSessionReady } = require("../../../utils/deviceSession");

function inquiryHistoryErrorCarePage(message) {
  return composeCarePage({
    key: "inquiry-history-error",
    title: "问询历史",
    showStatus: false,
    phase: {
      kind: "error",
      message,
      action: { id: "inquiry.history.retry", label: "重新读取问询历史" },
    },
  });
}

function inquiryTimeLabel(value) {
  if (!value) return "";
  const timestamp = Date.parse(String(value).replace(/-/g, "/"));
  if (!Number.isFinite(timestamp)) return String(value).slice(0, 16);
  const date = new Date(timestamp);
  const today = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  if (sameDay) return `今天 ${time}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const wasYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate();
  if (wasYesterday) return `昨天 ${time}`;
  const dateText = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === today.getFullYear() ? `${dateText} ${time}` : `${date.getFullYear()}年${dateText} ${time}`;
}

function sortByTime(a, b) {
  const ta = Date.parse(String(a.createdAt || a.updatedAt || "").replace(/-/g, "/")) || 0;
  const tb = Date.parse(String(b.createdAt || b.updatedAt || "").replace(/-/g, "/")) || 0;
  return tb - ta;
}

function personaPolicyForSnapshot(snapshot = {}) {
  const app = getApp();
  const session = app && app.globalData && app.globalData.deviceSession || {};
  return createPersonaVisibilityPolicy(snapshot.serviceUsers || [], {
    capabilities: session.capabilities || {},
    serviceUsersSnapshotComplete: snapshot.serviceUsersSnapshotComplete === true
      || snapshot.service_users_snapshot_complete === true,
  });
}

function inquiryRiskTone(item = {}) {
  const value = String(item.riskLevel || item.riskLabel || "").toLowerCase();
  if (["high", "emergency", "critical", "高风险", "紧急"].some(token => value.indexOf(token) >= 0)) return "danger";
  if (["medium", "warn", "中风险", "注意"].some(token => value.indexOf(token) >= 0)) return "warn";
  if (["low", "normal", "低风险", "正常"].some(token => value.indexOf(token) >= 0)) return "good";
  return "notice";
}

function careAction(item = {}) {
  const lines = Array.isArray(item.detailLines) ? item.detailLines : [];
  const line = lines.find(entry => entry && (entry.label === "后续建议" || entry.label === "建议就医时机"));
  return line && line.value ? String(line.value) : "";
}

function inquiryProgress(item = {}) {
  const stage = String(item.stage || "").toLowerCase();
  const nextAction = String(item.nextAction || item.next_action || "").toLowerCase();
  if (stage === "escalated" || nextAction === "escalate") return "需要优先关注";
  if (nextAction === "measure_vitals" || stage === "vitals") return "等待现场测量";
  if (stage === "clarification" || stage === "symptoms" || nextAction === "ask") return "问询进行中 · 仍需补充信息";
  if (stage === "result" || nextAction === "complete" || nextAction === "show_recommendation") return "已形成照护建议";
  return "";
}

function decorateInquiryGroups(inquiries) {
  return api.groupInquiriesByPerson(inquiries).map(group => {
    const records = (group.inquiries || []).map(item => Object.assign({}, item, {
      timeLabel: inquiryTimeLabel(item.updatedAt || item.createdAt || ""),
      riskTone: inquiryRiskTone(item),
      careAction: careAction(item),
      progressLabel: inquiryProgress(item),
    }));
    return Object.assign({}, group, {
      inquiries: records,
      countLabel: `${records.length} 条摘要`,
    });
  });
}

function decoded(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (error) {
    return String(value || "");
  }
}

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

Page({
  data: {
    carePage: loadingCarePage("问询历史", "正在整理已完成的问询摘要…"),
    pageTitle: "问询历史",
    scopeName: "",
    personScope: {},
    historyBoundaryText: "当前展示全设备最近 60 条同步窗口内的已完成问询。",
    inquiryGroups: [],
    initialLoading: true,
    hasLoaded: false,
    loadError: "",
    stale: false,
    processVisible: false,
    activeInquiry: null,
    deviceId: "",
  },

  onLoad(options = {}) {
    const personId = decoded(options.personId).trim();
    const personaGeneration = decoded(options.personaGeneration).trim();
    const personName = decoded(options.personName).trim();
    if (!personId) return;
    this.setData({
      pageTitle: personName ? `${personName}的近期问询` : "家人的近期问询",
      scopeName: personName || "这位家人",
      personScope: { personId, personaGeneration },
      historyBoundaryText: "当前展示全设备最近 60 条同步窗口内属于这位家人的已完成问询。",
    });
  },

  onShow() {
    return runAfterDeviceSessionReady(() => {
      const deviceId = activeDeviceId();
      if (String(this.data.deviceId || "").trim() !== deviceId) {
        this._loadRequestId = Number(this._loadRequestId || 0) + 1;
        this._detailRequestId = Number(this._detailRequestId || 0) + 1;
        this.setData({
          deviceId,
          inquiryGroups: [],
          initialLoading: true,
          hasLoaded: false,
          loadError: "",
          stale: false,
          processVisible: false,
          activeInquiry: null,
          carePage: loadingCarePage("问询历史", "正在整理已完成的问询摘要…"),
        });
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
      collections: ["commands", "inquiries"],
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
    const requestDeviceId = String(this.data.deviceId || activeDeviceId()).trim();
    if (String(this.data.deviceId || "").trim() !== requestDeviceId) {
      this.setData({ deviceId: requestDeviceId });
    }
    const loadRequestId = Number(this._loadRequestId || 0) + 1;
    this._loadRequestId = loadRequestId;
    const initialLoad = this.data.hasLoaded !== true;
    if (initialLoad) {
      this.setData({
        initialLoading: true,
        loadError: "",
        carePage: loadingCarePage("问询历史", "正在重新读取已完成的问询摘要…"),
      });
    }
    try {
      const snapshot = await api.getSnapshotStrict({ inquiryLimit: 60, deviceId: requestDeviceId });
      if (loadRequestId !== this._loadRequestId
        || String(this.data.deviceId || "").trim() !== requestDeviceId
        || activeDeviceId() !== requestDeviceId) return;
      const commandInquiries = (snapshot.commands || []).map(api.inquiryFromAiCommand).filter(Boolean);
      const personaPolicy = personaPolicyForSnapshot(snapshot);
      const inquiries = api.mergeInquirySources(snapshot.inquiries || [], commandInquiries)
        .filter(item => api.shouldShowInquiryForServiceUsers(item, snapshot.serviceUsers || []))
        .filter(item => personaPolicy.allowsInquiry(item))
        .filter(api.shouldShowCaregiverInquiry)
        .sort(sortByTime);
      const personScope = this.data.personScope || {};
      const scopedInquiries = personScope.personId && typeof api.inquiryMatchesPersonScope === "function"
        ? inquiries.filter(item => api.inquiryMatchesPersonScope(item, personScope))
        : inquiries;

      this.setData({
        inquiryGroups: decorateInquiryGroups(scopedInquiries),
        initialLoading: false,
        hasLoaded: true,
        loadError: "",
        stale: false,
      });
    } catch (error) {
      if (loadRequestId !== this._loadRequestId
        || String(this.data.deviceId || "").trim() !== requestDeviceId
        || activeDeviceId() !== requestDeviceId) return;
      const loadError = initialLoad ? "问询历史暂未同步，请稍后刷新。" : "";
      this.setData({
        initialLoading: false,
        loadError,
        stale: !initialLoad,
        carePage: initialLoad ? inquiryHistoryErrorCarePage(loadError) : this.data.carePage,
      });
    }
  },

  onCarePageAction(event) {
    const detail = (event && event.detail) || {};
    if (detail.id === "inquiry.history.retry") return this.load();
    return undefined;
  },

  async viewInquiryProcess(event) {
    const detailRequestId = Number(this._detailRequestId || 0) + 1;
    this._detailRequestId = detailRequestId;
    const requestDeviceId = String(this.data.deviceId || activeDeviceId()).trim();
    if (!String(this.data.deviceId || "").trim()) {
      this.setData({ deviceId: requestDeviceId });
    }
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const groupIndex = Number(dataset.groupIndex);
    const recordIndex = Number(dataset.recordIndex);
    const group = this.data.inquiryGroups[groupIndex];
    const record = group && group.inquiries && group.inquiries[recordIndex];
    if (!record) return;
    const activeInquiry = Object.assign({}, record, {
      summary: record.summary || "",
      detailLines: Array.isArray(record.detailLines) ? record.detailLines : [],
      messages: Array.isArray(record.messages) ? record.messages : [],
      detailLoading: Boolean(record.conversationReady),
      processUnavailable: false,
      processError: "",
    });
    this.setData({ activeInquiry, processVisible: true });

    if (!record.conversationReady || typeof api.getInquiryDetail !== "function") return;
    try {
      const detail = await api.getInquiryDetail(record, { deviceId: requestDeviceId });
      if (detailRequestId !== this._detailRequestId
        || String(this.data.deviceId || "").trim() !== requestDeviceId
        || activeDeviceId() !== requestDeviceId) return;
      const messages = Array.isArray(detail && detail.messages) ? detail.messages : [];
      const nextInquiry = Object.assign({}, activeInquiry, detail || {}, {
        summary: (detail && detail.summary) || activeInquiry.summary,
        detailLines: (detail && Array.isArray(detail.detailLines) && detail.detailLines.length)
          ? detail.detailLines
          : activeInquiry.detailLines,
        messages,
        timeLabel: inquiryTimeLabel((detail && (detail.updatedAt || detail.createdAt)) || record.updatedAt || record.createdAt || ""),
        riskTone: inquiryRiskTone(detail || record),
        detailLoading: false,
        conversationReady: messages.length > 0,
        processUnavailable: !messages.length,
        processError: "",
      });
      const inquiryGroups = (this.data.inquiryGroups || []).map((currentGroup, currentGroupIndex) => {
        if (currentGroupIndex !== groupIndex) return currentGroup;
        return Object.assign({}, currentGroup, {
          inquiries: (currentGroup.inquiries || []).map((currentRecord, currentRecordIndex) => (
            currentRecordIndex === recordIndex
              ? Object.assign({}, currentRecord, { conversationReady: messages.length > 0 })
              : currentRecord
          )),
        });
      });
      this.setData({ activeInquiry: nextInquiry, inquiryGroups });
    } catch (error) {
      if (detailRequestId !== this._detailRequestId
        || String(this.data.deviceId || "").trim() !== requestDeviceId
        || activeDeviceId() !== requestDeviceId) return;
      this.setData({
        activeInquiry: Object.assign({}, activeInquiry, {
          detailLoading: false,
          processUnavailable: true,
          processError: "问询过程暂未同步，已保留照护摘要。",
        }),
      });
    }
  },

  closeInquiryProcess() {
    this._detailRequestId = Number(this._detailRequestId || 0) + 1;
    this.setData({ processVisible: false, activeInquiry: null });
  },

  stopProcessTap() {},
});
