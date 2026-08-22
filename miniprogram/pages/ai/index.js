const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const { createPersonaVisibilityPolicy } = require("../../modules/personaVisibility");
const { runAfterDeviceSessionReady } = require("../../utils/deviceSession");
const { parseTimestamp } = require("../../utils/dateTime");
const offlinePageCache = require("../../utils/offlinePageCache");

const INQUIRY_CACHE_KEY = "inquiries";

function inquiryTimeLabel(value) {
  if (!value) return "";
  const timestamp = parseTimestamp(value);
  if (timestamp === null) return String(value).slice(0, 16);
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
  const ta = parseTimestamp(a.updatedAt || a.createdAt || "") || 0;
  const tb = parseTimestamp(b.updatedAt || b.createdAt || "") || 0;
  return tb - ta;
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
  if (stage === "escalated" || nextAction === "escalate") {
    return "需要优先关注";
  }
  if (nextAction === "measure_vitals" || stage === "vitals") {
    return "等待现场测量";
  }
  if (stage === "clarification" || stage === "symptoms" || nextAction === "ask") {
    return "问询进行中 · 仍需补充信息";
  }
  if (stage === "result" || nextAction === "complete" || nextAction === "show_recommendation") {
    return "已形成照护建议";
  }
  return "";
}

function decorateInquiryGroups(inquiries, options = {}) {
  const maxGroups = Math.max(Number(options.maxGroups) || 0, 0);
  const maxRecords = Math.max(Number(options.maxRecords) || 0, 0);
  const maxTotalRecords = Math.max(Number(options.maxTotalRecords) || 0, 0);
  const recentInquiries = maxTotalRecords
    ? (inquiries || []).slice(0, maxTotalRecords)
    : inquiries;
  const groups = api.groupInquiriesByPerson(recentInquiries);
  const visibleGroups = maxGroups ? groups.slice(0, maxGroups) : groups;
  return visibleGroups.map(group => {
    const allRecords = group.inquiries || [];
    const sourceRecords = maxRecords ? allRecords.slice(0, maxRecords) : allRecords;
    const records = sourceRecords.map(item => Object.assign({}, item, {
      timeLabel: inquiryTimeLabel(item.updatedAt || item.createdAt || ""),
      riskTone: inquiryRiskTone(item),
      careAction: careAction(item),
      progressLabel: inquiryProgress(item),
    }));
    return Object.assign({}, group, {
      inquiries: records,
      countLabel: (maxRecords || maxTotalRecords) ? `最近 ${records.length} 条` : `${records.length} 条摘要`,
    });
  });
}

function inquiryCareState(item = {}) {
  const kindByTone = {
    danger: "risk",
    warn: "pending",
    good: "normal",
    notice: "actionable",
  };
  const tone = item.riskTone || inquiryRiskTone(item);
  return {
    kind: kindByTone[tone] || "actionable",
    label: item.riskLabel || "已形成建议",
  };
}

function loadingInquiryCarePage() {
  return Object.assign(
    {},
    loadingCarePage("家庭问询", "正在整理已完成的问询摘要…"),
    { key: "inquiry-loading", showStatus: false },
  );
}

function inquiryPhaseCarePage(kind, message) {
  const phase = { kind, message };
  if (kind === "error") {
    phase.action = {
      id: "inquiry.retry",
      label: "重新加载问询摘要",
    };
  }
  return composeCarePage({
    key: `inquiry-${kind}`,
    title: "家庭问询",
    showStatus: false,
    phase,
  });
}

function staleInquiryCarePage(carePage = {}) {
  const focus = carePage.focus;
  if (!focus) return carePage;
  const warning = "当前显示已保存的问询记录，连接后自动更新";
  const supporting = String(focus.supporting || "");
  return Object.assign({}, carePage, {
    focus: Object.assign({}, focus, {
      supporting: supporting.indexOf(warning) >= 0
        ? supporting
        : [warning, supporting].filter(Boolean).join(" · "),
    }),
  });
}

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function offlineBrowsingEnabled() {
  if (typeof getApp !== "function") return false;
  const app = getApp();
  return Boolean(app && app.globalData && app.globalData.offlineBrowsingEnabled === true);
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

function buildInquiryCarePage(inquiryGroups = []) {
  const groups = inquiryGroups || [];
  const records = groups.reduce((all, group) => all.concat(group.inquiries || []), []);
  if (!records.length) {
    if (!offlineBrowsingEnabled()) return inquiryPhaseCarePage("empty", "暂无已完成的问询摘要。");
    return composeCarePage({
      key: "inquiry-empty",
      title: "家庭问询",
      showStatus: false,
      focus: {
        eyebrow: "最近问询",
        title: "暂无已完成问询",
        supporting: "家人在药箱端完成健康问询后，摘要会自动出现在这里。",
        state: { kind: "muted", label: "暂无记录" },
        activation: "none",
      },
      overview: [
        { key: "inquiry-recent", label: "近期摘要", value: 0, state: "muted" },
        { key: "inquiry-people", label: "涉及成员", value: 0, state: "muted" },
        { key: "inquiry-attention", label: "需关注", value: 0, state: "normal" },
      ],
      sections: [{
        key: "inquiry-summaries",
        intent: "conversations",
        title: "问询摘要",
        supporting: "按家庭成员集中整理",
        empty: "暂无问询摘要，联网后会自动更新。",
        items: [],
      }],
      detailAction: {
        id: "inquiry.history",
        label: "查看全部问询历史",
      },
    });
  }

  const latestGroup = groups.find(group => (group.inquiries || []).length) || {};
  const latestGroupIndex = groups.indexOf(latestGroup);
  const latest = (latestGroup.inquiries || [])[0] || {};
  const attentionCount = records.filter(record => ["danger", "warn"].includes(record.riskTone || inquiryRiskTone(record))).length;
  const sections = groups.map((group, groupIndex) => {
    const items = (group.inquiries || [])
      .map((record, recordIndex) => ({ record, recordIndex }))
      .filter(entry => !(groupIndex === latestGroupIndex && entry.recordIndex === 0))
      .map(({ record, recordIndex }) => ({
        key: `inquiry-record-${groupIndex}-${recordIndex}-${record.id || "summary"}`,
        symbol: "conversation",
        title: record.topic || "健康问询",
        supporting: record.summary || "已同步照护摘要，打开可查看详细建议。",
        meta: record.timeLabel || "已同步",
        state: inquiryCareState(record),
        action: {
          id: `inquiry.open.${groupIndex}.${recordIndex}`,
          label: "查看详情",
          payload: { groupIndex, recordIndex },
        },
      }));
    return {
      key: `inquiry-group-${groupIndex}-${group.personKey || "record"}`,
      intent: "conversations",
      title: group.personName || "问询记录",
      supporting: groupIndex === latestGroupIndex
        ? `${group.countLabel || `${(group.inquiries || []).length} 条摘要`} · 最新一条已置顶`
        : (group.countLabel || `${(group.inquiries || []).length} 条摘要`),
      empty: "最新一条摘要已显示在页面焦点中。",
      items,
    };
  }).filter(section => section.items.length);

  return composeCarePage({
    key: "inquiry-care",
    title: "家庭问询",
    showStatus: false,
    focus: {
      eyebrow: `${latestGroup.personName || "家人"} · 最近问询`,
      title: latest.topic || "健康问询",
      supporting: latest.summary || "已同步照护摘要，打开可查看详细建议。",
      state: inquiryCareState(latest),
      action: {
        id: `inquiry.open.${latestGroupIndex}.0`,
        label: "打开问询详情",
        payload: { groupIndex: latestGroupIndex, recordIndex: 0 },
      },
      activation: "surface",
    },
    overview: [
      { key: "inquiry-recent", label: "近期摘要", value: records.length, state: "actionable" },
      { key: "inquiry-people", label: "涉及成员", value: groups.length, state: "muted" },
      { key: "inquiry-attention", label: "需关注", value: attentionCount, state: attentionCount ? "pending" : "normal" },
    ],
    sections,
    detailAction: {
      id: "inquiry.history",
      label: "查看全部问询历史",
    },
  });
}

Page({
  data: {
    carePage: loadingInquiryCarePage(),
    inquiryGroups: [],
    initialLoading: true,
    hasLoaded: false,
    loadError: "",
    stale: false,
    processVisible: false,
    activeInquiry: null,
    deviceId: "",
  },

  onShow() {
    return runAfterDeviceSessionReady(() => {
      const deviceId = activeDeviceId();
      if (String(this.data.deviceId || "").trim() !== deviceId) {
        this._loadRequestId = Number(this._loadRequestId || 0) + 1;
        this._detailRequestId = Number(this._detailRequestId || 0) + 1;
        this.setData({
          deviceId,
          carePage: loadingInquiryCarePage(),
          inquiryGroups: [],
          initialLoading: true,
          hasLoaded: false,
          loadError: "",
          stale: false,
          processVisible: false,
          activeInquiry: null,
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
    if (offlineBrowsingEnabled() && this._cacheHydratedDeviceId !== requestDeviceId) {
      this._cacheHydratedDeviceId = requestDeviceId;
      const restored = offlinePageCache.restorePage(requestDeviceId, INQUIRY_CACHE_KEY);
      if (restored) this.setData(restored.data);
    }
    const initialLoad = this.data.hasLoaded !== true;
    if (initialLoad) {
      this.setData({
        initialLoading: true,
        loadError: "",
        carePage: loadingInquiryCarePage(),
      });
    }
    try {
      const snapshot = await api.getSnapshotStrict({ inquiryLimit: 50, deviceId: requestDeviceId });
      if (loadRequestId !== this._loadRequestId
        || String(this.data.deviceId || "").trim() !== requestDeviceId
        || activeDeviceId() !== requestDeviceId) return;
      const commandInquiries = (snapshot.commands || []).map(api.inquiryFromAiCommand).filter(Boolean);
      const personaPolicy = personaPolicyForSnapshot(snapshot);
      const inquiries = api.mergeInquirySources(snapshot.inquiries || [], commandInquiries)
        .filter(item => api.shouldShowInquiryForServiceUsers(item, snapshot.serviceUsers || []))
        .filter(item => personaPolicy.allowsInquiry(item))
        .filter(api.shouldShowCaregiverInquiry)
        .sort(sortByTime)
        .slice(0, 40);

      const inquiryGroups = decorateInquiryGroups(inquiries, { maxTotalRecords: 5 });
      const lastSyncedAtMs = Date.now();
      const nextData = {
        inquiryGroups,
        initialLoading: false,
        hasLoaded: true,
        loadError: "",
        stale: false,
        offlineSnapshot: false,
        lastSyncedAtMs,
        lastSyncedAtText: offlinePageCache.formatUpdatedAt(lastSyncedAtMs),
        carePage: buildInquiryCarePage(inquiryGroups),
      };
      this.setData(nextData);
      offlinePageCache.savePage(
        requestDeviceId,
        INQUIRY_CACHE_KEY,
        Object.assign({}, this.data, nextData),
        { updatedAtMs: lastSyncedAtMs },
      );
    } catch (error) {
      if (loadRequestId !== this._loadRequestId
        || String(this.data.deviceId || "").trim() !== requestDeviceId
        || activeDeviceId() !== requestDeviceId) return;
      const nextData = {
        initialLoading: false,
        loadError: "",
        stale: true,
      };
      if (this.data.offlineSnapshot === true && this.data.hasLoaded === true) {
        nextData.carePage = offlinePageCache.markCarePageStale(
          this.data.carePage,
          this.data.lastSyncedAtMs,
        );
        this.setData(nextData);
        return;
      }
      if (initialLoad) {
        if (!offlineBrowsingEnabled()) {
          nextData.loadError = "问询摘要暂未同步，请稍后刷新。";
          nextData.stale = false;
          nextData.carePage = inquiryPhaseCarePage("error", nextData.loadError);
          this.setData(nextData);
          return;
        }
        nextData.inquiryGroups = [];
        nextData.hasLoaded = true;
        nextData.carePage = staleInquiryCarePage(buildInquiryCarePage([]));
      } else {
        nextData.carePage = staleInquiryCarePage(this.data.carePage);
      }
      this.setData(nextData);
    }
  },

  onCarePageAction(event) {
    const detail = (event && event.detail) || {};
    if (detail.id === "inquiry.retry") {
      return this.load();
    }
    if (detail.id === "inquiry.history") {
      return this.openInquiryHistory();
    }
    if (String(detail.id || "").indexOf("inquiry.open.") === 0) {
      const payload = detail.payload || {};
      return this.viewInquiryProcess({
        currentTarget: {
          dataset: {
            groupIndex: payload.groupIndex,
            recordIndex: payload.recordIndex,
          },
        },
      });
    }
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
    this.setData({
      activeInquiry,
      processVisible: true,
    });

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
    this.setData({
      processVisible: false,
      activeInquiry: null,
    });
  },

  openInquiryHistory() {
    wx.navigateTo({ url: "/pages/ai/history/index" });
  },

  stopProcessTap() {},
});
