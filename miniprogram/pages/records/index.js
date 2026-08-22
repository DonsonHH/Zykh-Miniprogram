const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const { runAfterDeviceSessionReady } = require("../../utils/deviceSession");
const medicationSafetyEvents = require("../../modules/medicationSafetyEvents");
const vitalsAttribution = require("../../modules/vitalsAttribution");
const personaVisibility = require("../../modules/personaVisibility");
const { mergeCapabilitySnapshots } = require("../../modules/capabilitySnapshot");
const { parseTimestamp } = require("../../utils/dateTime");
const offlinePageCache = require("../../utils/offlinePageCache");

const RECORD_PREVIEW_LIMIT = 4;
const medicationSafetyEventModule = medicationSafetyEvents.createMedicationSafetyEventModule(api);
const RECORDS_CACHE_KEY = "care-records";

function displayDeviceId(value) {
  return String(value || "").trim() || "zykh-qsm-001";
}

function offlineBrowsingEnabled() {
  if (typeof getApp !== "function") return false;
  const app = getApp();
  return Boolean(app && app.globalData && app.globalData.offlineBrowsingEnabled === true);
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
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== undefined && values[i] !== null && values[i] !== "") return values[i];
  }
  return "";
}

function parseTime(value) {
  return parseTimestamp(value) || 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(value) {
  const time = parseTime(value);
  if (!time) return { date: "时间未记录", time: "", full: "时间未记录" };
  const date = new Date(time);
  return {
    date: `${date.getMonth() + 1}月${date.getDate()}日`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    full: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function displayValue(value, unit) {
  if (value === undefined || value === null || value === "") return "--";
  return `${value}${unit || ""}`;
}

function normalizeVitalsRecord(record = {}, context = {}) {
  const vitals = api.normalizeVitals(record) || {};
  const rawTime = firstPresent(vitals.createdAt, vitals.created_at, vitals.time, vitals.deviceTime, vitals.device_time);
  const formatted = formatDateTime(rawTime);
  const attribution = vitalsAttribution.classifyVitalsAttribution(vitals, {
    activeUsers: context.activeUsers || [],
    attributionSupported: context.vitalsAttributionSupported === true,
  });
  const person = attribution.label;
  const heartRate = displayValue(vitals.heartRate, " bpm");
  const spo2 = displayValue(vitals.spo2, "%");
  const bodyTemp = displayValue(vitals.bodyTemp, "℃");
  return {
    id: `vitals-${vitals.recordId || record._id || record.id || rawTime}`,
    type: "vitals",
    typeLabel: "体征",
    rawTime,
    sortTime: parseTime(rawTime),
    date: formatted.date,
    time: formatted.time,
    fullTime: formatted.full,
    person,
    title: `${person} 完成健康测量`,
    subtitle: [bodyTemp, spo2, heartRate].filter(value => value !== "--").join(" · ") || "测量结果未完整同步",
    heartRate,
    spo2,
    bodyTemp,
    quality: firstPresent(vitals.quality, record.quality, record.status, "未记录"),
    attributionKind: attribution.kind,
    canAttach: attribution.canAttach,
    recordId: attribution.recordId,
    inquirySessionId: attribution.inquirySessionId,
    attributionSource: attribution.attributionSource,
    attributionCapability: firstPresent(
      context.capabilitySnapshot && context.capabilitySnapshot.capabilities && context.capabilitySnapshot.capabilities.vitalsAttribution,
      context.capabilitySnapshot && context.capabilitySnapshot.capabilities && context.capabilitySnapshot.capabilities.vitals_attribution,
      "",
    ),
    schemaRevision: firstPresent(
      context.capabilitySnapshot && context.capabilitySnapshot.schemaRevision,
      context.capabilitySnapshot && context.capabilitySnapshot.schema_revision,
      "",
    ),
  };
}

function buildVitalsRecords(vitals = [], context = {}) {
  return vitals.map(record => normalizeVitalsRecord(record, context)).sort((a, b) => b.sortTime - a.sortTime);
}

function safetyCheckText(status) {
  return {
    BLOCKED: "存在明确用药风险",
    CHECK_FAILED: "用药风险需要复核",
    PASSED: "已完成用药风险核验",
  }[status] || "风险状态未知";
}

function safetyReadText(state) {
  return { READ: "已查看", UNREAD: "未读", UNKNOWN: "读取状态未知" }[state] || "读取状态未知";
}

function buildSafetyRecords(events = [], policy = null) {
  return medicationSafetyEvents.projectRecords(events).map(record => {
    const formatted = formatDateTime(record.occurredAt);
    const evidence = [
      record.profileRevision !== "" ? `档案版本 ${record.profileRevision}` : "",
      record.rulesetVersion ? `规则 ${record.rulesetVersion}` : "",
      record.medicineReviewFingerprint ? `药品资料 ${record.medicineReviewFingerprint.slice(0, 12)}` : "",
    ].filter(Boolean).join(" · ");
    return Object.assign({}, record, {
      date: formatted.date,
      time: formatted.time,
      fullTime: formatted.full,
      checkStatusText: safetyCheckText(record.checkStatus),
      readText: safetyReadText(record.readState),
      detailSummary: record.summary || (record.checkStatus === "CHECK_FAILED"
        ? "人物或药品资料暂不足以完成可靠核验。"
        : "本次用药风险核验已由终端记录。"),
      evidenceText: evidence || "版本证据暂未同步",
    });
  }).filter(record => !policy || policy.allowsCurrentRecord(record, { allowUnlinked: true }))
    .sort(compareRecordOrder);
}

function compareRecordOrder(left = {}, right = {}) {
  return (Number(right.sortTime) || 0) - (Number(left.sortTime) || 0) ||
    String(left.id || "").localeCompare(String(right.id || ""));
}

function mergeSafetyRecords(current = [], incoming = []) {
  const byId = Object.create(null);
  (current || []).concat(incoming || []).forEach(record => {
    const eventId = String(record && record.id || "").trim();
    if (eventId) byId[eventId] = record;
  });
  return Object.keys(byId).map(eventId => byId[eventId]).sort(compareRecordOrder);
}

function safetyRecordMatchesDevice(record = {}, deviceId = "") {
  const recordDeviceId = String(record.deviceId || record.device_id || "").trim();
  return !recordDeviceId || recordDeviceId === String(deviceId || "").trim();
}

function buildFeed(vitalsRecords, safetyRecords) {
  return []
    .concat(vitalsRecords || [])
    .concat(safetyRecords || [])
    .sort(compareRecordOrder);
}

function todayCount(records, type) {
  const now = new Date();
  return records.filter(item => {
    const date = new Date(item.sortTime);
    return (!type || item.type === type) && item.sortTime &&
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
  }).length;
}

function filterTitle(filter) {
  return { all: "全部照护记录", safety: "用药风险", vitals: "健康测量" }[filter] || "照护记录";
}

function safetyAvailabilityText(safetyState = {}) {
  if (safetyState.availability === "unsupported") return "当前云端版本尚未支持安全记录。";
  if (safetyState.availability === "forbidden") return "当前微信账号无权查看该药箱。";
  if (safetyState.availability === "unknown") return "暂时无法确认安全记录是否为最新。";
  if (safetyState.availability === "error") return "安全记录读取失败，请稍后重试。";
  return "暂无用药风险记录。";
}

function emptyTextFor(filter, safetyState = {}) {
  return {
    all: "暂时没有同步到照护记录。",
    safety: safetyAvailabilityText(safetyState),
    vitals: "暂无健康测量记录。",
  }[filter] || "暂时没有同步到照护记录。";
}

function careStateForRecord(record) {
  if (!record) return { kind: "muted", label: "暂无记录" };
  if (record.type === "safety") return record.state || { kind: "pending", label: "用药风险" };
  return { kind: "normal", label: "健康测量" };
}

function safetyPaginationView(state = {}) {
  const status = state.safetyPaginationStatus || "idle";
  const recordFilter = state.recordFilter || "all";
  const canContainSafety = recordFilter === "all" || recordFilter === "safety";
  const hasCursor = Boolean(String(state.safetyNextCursor || "").trim());
  const availability = state.safetyState && state.safetyState.availability;
  const visible = Boolean(
    state.detailVisible &&
    state.detailMode === "list" &&
    canContainSafety &&
    availability === "ready" &&
    (hasCursor || status === "loading" || status === "error")
  );
  const label = status === "loading"
    ? "正在加载安全记录…"
    : (status === "error" ? "加载失败，点击重试" : "加载更多安全记录");
  const hint = status === "error"
    ? (state.safetyPaginationError || "本页读取失败，已有记录仍可查看。")
    : (status === "loading" ? "请稍候" : "继续查看更早的用药风险");
  return {
    safetyPaginationVisible: visible,
    safetyPaginationLabel: label,
    safetyPaginationHint: hint,
  };
}

function buildRecordsCarePage(state = {}) {
  const visibleFeed = Array.isArray(state.visibleFeed) ? state.visibleFeed : [];
  const previewFeed = Array.isArray(state.previewFeed) ? state.previewFeed : [];
  const pendingSafetyDetailRetry = state.pendingSafetyDetailRetry || null;
  const pendingSafetyDetailLoading = pendingSafetyDetailRetry && pendingSafetyDetailRetry.status === "loading";
  const focusRecord = visibleFeed[0];
  const recordFilter = ["all", "safety", "vitals"].includes(state.recordFilter) ? state.recordFilter : "all";
  const focusTitle = focusRecord
    ? ([focusRecord.title, focusRecord.time || focusRecord.date].filter(Boolean).join(" · ") || "照护记录")
    : emptyTextFor(recordFilter, state.safetyState);

  return composeCarePage({
    key: "records-page",
    title: "照护记录",
    online: Boolean(state.device && state.device.online),
    connection: state.device && state.device.connection,
    focus: {
      eyebrow: "最近一次照护",
      title: focusTitle,
      supporting: state.stale
        ? `当前显示已保存记录 · ${state.lastSyncedAtText || "连接后自动更新"}`
        : "",
      state: careStateForRecord(focusRecord),
      action: focusRecord ? {
        id: "records-action-open-latest",
        label: "打开最近记录",
        payload: { recordId: focusRecord.id },
      } : null,
      activation: focusRecord ? "surface" : "none",
    },
    overview: [
      {
        key: "records-today-safety",
        label: "今日风险",
        value: state.safetyState && state.safetyState.availability === "ready"
          ? (Number(state.todaySafetyCount) || 0)
          : (state.safetyState && state.safetyState.availability === "unsupported"
            ? "未支持"
            : (state.safetyState && state.safetyState.availability === "forbidden" ? "无权限" : "待确认")),
        tone: state.todaySafetyCount
          ? "risk"
          : (state.safetyState && ["unknown", "error", "forbidden"].includes(state.safetyState.availability) ? "warn" : "muted"),
        action: state.safetyState && state.safetyState.availability === "ready" && state.todaySafetyCount ? {
          id: "records-action-filter-safety-overview",
          label: "筛选用药风险记录",
          payload: { filter: "safety" },
        } : null,
      },
      {
        key: "records-today-vitals",
        label: "今日测量",
        value: Number(state.todayVitalsCount) || 0,
        tone: "normal",
        action: {
          id: "records-action-filter-vitals-overview",
          label: "筛选健康测量",
          payload: { filter: "vitals" },
        },
      },
    ],
    sections: (pendingSafetyDetailRetry ? [
      {
        key: "records-pending-safety-detail",
        intent: "navigation",
        title: "用药风险详情未打开",
        supporting: pendingSafetyDetailRetry.message || "详情读取失败，请检查网络后重试。",
        items: [
          {
            key: "records-pending-safety-detail-retry",
            symbol: "safety",
            title: pendingSafetyDetailLoading ? "正在重新读取用药风险" : "重试打开用药风险",
            supporting: pendingSafetyDetailLoading
              ? "正在读取原安全事件，请稍候。"
              : "仅在点击后重新读取，不会随页面刷新重复请求。",
            state: { kind: "pending", label: pendingSafetyDetailLoading ? "读取中" : "可重试" },
            action: pendingSafetyDetailLoading ? null : {
              id: "records-action-retry-pending-safety",
              label: "重试打开用药风险",
            },
          },
        ],
      },
    ] : []).concat([
      {
        key: "records-timeline",
        intent: "timeline",
        title: "近期动态",
        supporting: state.safetyState && state.safetyState.availability !== "ready"
          ? safetyAvailabilityText(state.safetyState)
          : "",
        empty: state.emptyText || emptyTextFor(recordFilter, state.safetyState),
        more: {
          id: "records-action-open-all",
          label: "全部记录",
        },
        filters: [
          {
            key: "records-filter-all",
            label: "全部",
            active: recordFilter === "all",
            action: {
              id: "records-action-filter-all",
              label: "筛选全部记录",
              payload: { filter: "all" },
            },
          },
          {
            key: "records-filter-safety",
            label: "用药风险",
            active: recordFilter === "safety",
            action: {
              id: "records-action-filter-safety",
              label: "筛选用药风险记录",
              payload: { filter: "safety" },
            },
          },
          {
            key: "records-filter-vitals",
            label: "测量",
            active: recordFilter === "vitals",
            action: {
              id: "records-action-filter-vitals",
              label: "筛选健康测量",
              payload: { filter: "vitals" },
            },
          },
        ],
        items: previewFeed.map((record, index) => ({
          key: `records-item-${record.id || index}`,
          symbol: record.type === "vitals" ? "measure" : "safety",
          title: record.title,
          supporting: record.subtitle,
          meta: [record.time, record.date].filter(Boolean).join(" · "),
          state: careStateForRecord(record),
          action: {
            id: `records-action-open-${index}`,
            label: "查看记录详情",
            payload: { recordId: record.id },
          },
        })),
      },
    ]),
  });
}

function recordsErrorCarePage(device) {
  return composeCarePage({
    key: "records-error",
    title: "照护记录",
    online: Boolean(device && device.online),
    connection: device && device.connection,
    phase: {
      kind: "error",
      message: "照护记录读取失败，请检查网络后重新加载。",
      action: { id: "records.retry", label: "重新加载照护记录" },
    },
  });
}

function clearedRecordsScope(deviceId, recordFilter = "all") {
  const safetyState = {
    availability: "unknown",
    events: [],
    message: "暂时无法确认安全记录是否为最新",
  };
  return {
    carePage: loadingCarePage("照护记录", "正在同步当前药箱的照护记录…"),
    device: {},
    vitalsRecords: [],
    safetyRecords: [],
    feed: [],
    visibleFeed: [],
    previewFeed: [],
    todaySafetyCount: 0,
    todayVitalsCount: 0,
    safetyState,
    safetyDeviceId: String(deviceId || "").trim(),
    safetyLoadedPageCount: 0,
    safetyNextCursor: "",
    safetyPaginationStatus: "idle",
    safetyPaginationError: "",
    safetyPaginationVisible: false,
    safetyPaginationLabel: "加载更多安全记录",
    safetyPaginationHint: "继续查看更早的用药风险",
    pendingSafetyDetailRetry: null,
    emptyText: emptyTextFor(recordFilter, safetyState),
    stale: false,
    detailVisible: false,
    detailMode: "record",
    detailTitle: "照护记录",
    detailList: [],
  };
}

Page({
  data: {
    carePage: loadingCarePage("照护记录", "正在同步最近的照护记录…"),
    device: {},
    vitalsRecords: [],
    safetyRecords: [],
    feed: [],
    visibleFeed: [],
    previewFeed: [],
    recordFilter: "all",
    todaySafetyCount: 0,
    todayVitalsCount: 0,
    safetyState: { availability: "unknown", events: [], message: "暂时无法确认安全记录是否为最新" },
    safetyDeviceId: "",
    safetyLoadedPageCount: 0,
    safetyNextCursor: "",
    safetyPaginationStatus: "idle",
    safetyPaginationError: "",
    safetyPaginationVisible: false,
    safetyPaginationLabel: "加载更多安全记录",
    safetyPaginationHint: "继续查看更早的用药风险",
    pendingSafetyDetailRetry: null,
    emptyText: "暂时没有同步到照护记录。",
    stale: false,
    detailVisible: false,
    detailMode: "record",
    detailTitle: "照护记录",
    detailList: [],
  },

  onShow() {
    return runAfterDeviceSessionReady(() => {
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
      collections: ["devices", "vitals"],
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

  prepareDeviceScope(requestDeviceId) {
    const nextDeviceId = String(requestDeviceId || "").trim();
    const previousDeviceId = String(this.data.safetyDeviceId || "").trim();
    const deviceChanged = previousDeviceId !== nextDeviceId && (
      Boolean(previousDeviceId) || this._hasLoadedRecords === true
    );
    if (deviceChanged) {
      this._hasLoadedRecords = false;
      this._safetyDetailRequestId = Number(this._safetyDetailRequestId || 0) + 1;
      this._safetyPaginationRequestId = Number(this._safetyPaginationRequestId || 0) + 1;
      this.setData(clearedRecordsScope(nextDeviceId, this.data.recordFilter));
    } else if (previousDeviceId !== nextDeviceId) {
      this.setData({ safetyDeviceId: nextDeviceId });
    }
    return deviceChanged;
  },

  isDeviceScopeCurrent(requestDeviceId) {
    const expectedDeviceId = String(requestDeviceId || "").trim();
    const app = getApp();
    const activeDeviceId = String((app && app.globalData && app.globalData.deviceId) || "").trim();
    return String(this.data.safetyDeviceId || "").trim() === expectedDeviceId &&
      activeDeviceId === expectedDeviceId;
  },

  async load() {
    const app = getApp();
    const rawDeviceId = String(app && app.globalData && app.globalData.deviceId || "").trim();
    const allowOfflineBrowsing = offlineBrowsingEnabled();
    const requestDeviceId = allowOfflineBrowsing ? displayDeviceId(rawDeviceId) : rawDeviceId;
    this.prepareDeviceScope(requestDeviceId);
    const loadGeneration = Number(this._loadGeneration || 0) + 1;
    this._loadGeneration = loadGeneration;
    if (allowOfflineBrowsing && this._cacheHydratedDeviceId !== requestDeviceId) {
      this._cacheHydratedDeviceId = requestDeviceId;
      const restored = offlinePageCache.restorePage(requestDeviceId, RECORDS_CACHE_KEY);
      if (restored) {
        this._hasLoadedRecords = true;
        this.setData(restored.data);
      }
    }
    try {
      const [deviceRead, vitalsRead, safetyRead, snapshotRead] = await Promise.all([
        api.getDevice(requestDeviceId).then(
          value => ({ value, error: null }),
          error => ({ value: fallbackDevice(requestDeviceId, error.message), error }),
        ),
        api.getRecentVitalsStrict(80, requestDeviceId).then(
          value => ({ value, error: null }),
          error => ({ value: [], error }),
        ),
        medicationSafetyEventModule.list({
          limit: 50,
          deviceId: requestDeviceId,
          includeLocalFixtures: true,
          allowUnavailableLocalFallback: allowOfflineBrowsing,
        }).then(
          value => ({ value, error: null }),
          error => ({
            value: medicationSafetyEvents.mergeLocalMedicationSafetyFixtures(
              { availability: "error", events: [], message: "联网后自动更新风险记录" },
              requestDeviceId,
              { includeLocalFixtures: true, allowUnavailableLocalFallback: allowOfflineBrowsing },
            ),
            error,
          }),
        ),
        api.getSnapshotStrict({ inquiryLimit: 1, deviceId: requestDeviceId }).then(
          value => ({ value, error: null }),
          error => ({ value: { serviceUsers: [], capabilities: {} }, error }),
        ),
      ]);
      if (loadGeneration !== this._loadGeneration || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      const device = deviceRead.value;
      const vitals = vitalsRead.value;
      const safetyState = safetyRead.value;
      const snapshot = snapshotRead.value || {};
      const sourceStale = [deviceRead.error, vitalsRead.error, safetyRead.error, snapshotRead.error]
        .some(Boolean);
      const strictReadError = [deviceRead.error, vitalsRead.error, safetyRead.error, snapshotRead.error]
        .find(Boolean);
      if (!allowOfflineBrowsing && strictReadError) throw strictReadError;
      if (sourceStale && this.data.offlineSnapshot === true && this._hasLoadedRecords) {
        this.setData({
          stale: true,
          carePage: offlinePageCache.markCarePageStale(this.data.carePage, this.data.lastSyncedAtMs),
        });
        return;
      }
      const deviceSessionState = app && app.globalData && app.globalData.deviceSession || {};
      const capabilitySnapshot = mergeCapabilitySnapshots(
        deviceSessionState,
        snapshot,
        safetyState.capabilitySnapshot,
      );
      const personaPolicy = personaVisibility.createPersonaVisibilityPolicy(snapshot.serviceUsers || [], {
        capabilities: capabilitySnapshot.capabilities,
        serviceUsersSnapshotComplete: snapshot.serviceUsersSnapshotComplete === true,
      });
      this._personaPolicy = personaPolicy;
      const vitalsRecords = buildVitalsRecords(vitals, {
        activeUsers: personaPolicy.activeUsers(),
        capabilitySnapshot,
        vitalsAttributionSupported: vitalsAttribution.supportsVitalsAttribution(capabilitySnapshot),
      });
      const sameDeviceScope = this._hasLoadedRecords === true
        && String(this.data.safetyDeviceId || "") === requestDeviceId;
      const transientSafetyFailure = sameDeviceScope
        && ["error", "unknown"].includes(String(safetyState.availability || ""));
      const effectiveSafetyState = transientSafetyFailure
        ? Object.assign({}, safetyState, { events: (this.data.safetyState && this.data.safetyState.events) || [] })
        : safetyState;
      const firstPageSafetyRecords = buildSafetyRecords(effectiveSafetyState.events || [], personaPolicy);
      const preserveLoadedPages = sameDeviceScope && (
        transientSafetyFailure || Number(this.data.safetyLoadedPageCount || 0) > 1
      );
      const safetyRecords = preserveLoadedPages
        ? mergeSafetyRecords(this.data.safetyRecords || [], firstPageSafetyRecords)
        : mergeSafetyRecords([], firstPageSafetyRecords);
      const firstPageCursor = String(effectiveSafetyState.nextCursor || "");
      const safetyNextCursor = preserveLoadedPages
        ? String(this.data.safetyNextCursor || "")
        : firstPageCursor;
      const safetyLoadedPageCount = preserveLoadedPages
        ? Number(this.data.safetyLoadedPageCount || 1)
        : 1;
      const safetyPaginationStatus = preserveLoadedPages && this.data.safetyPaginationStatus === "loading"
        ? "loading"
        : (safetyNextCursor ? "idle" : "done");
      const feed = buildFeed(vitalsRecords, safetyRecords);
      const lastSyncedAtMs = Date.now();
      this.applyRecordFilter(this.data.recordFilter, feed, {
        device,
        vitalsRecords,
        safetyRecords,
        safetyState: effectiveSafetyState,
        safetyDeviceId: requestDeviceId,
        safetyLoadedPageCount,
        safetyNextCursor,
        safetyPaginationStatus,
        safetyPaginationError: "",
        feed,
        stale: sourceStale || transientSafetyFailure,
        offlineSnapshot: false,
        lastSyncedAtMs,
        lastSyncedAtText: offlinePageCache.formatUpdatedAt(lastSyncedAtMs),
        persistOfflineSnapshot: [deviceRead.error, vitalsRead.error, safetyRead.error, snapshotRead.error]
          .some(error => !error),
        offlineSnapshotQuality: sourceStale || transientSafetyFailure ? "partial" : "complete",
        todaySafetyCount: todayCount(
          safetyRecords.filter(item => item.checkStatus === "BLOCKED"),
          "safety",
        ),
        todayVitalsCount: todayCount(feed, "vitals"),
      });
      this._hasLoadedRecords = true;
      await this.consumePendingCareRoute(requestDeviceId);
    } catch (error) {
      if (loadGeneration !== this._loadGeneration || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      console.warn("care records read failed", error);
      if (this._hasLoadedRecords) {
        const stale = true;
        this.setData({
          stale,
          carePage: this.data.offlineSnapshot
            ? offlinePageCache.markCarePageStale(this.data.carePage, this.data.lastSyncedAtMs)
            : buildRecordsCarePage(Object.assign({}, this.data, { stale })),
        });
      } else {
        if (!allowOfflineBrowsing) {
          this.setData({ carePage: recordsErrorCarePage(this.data.device) });
          return;
        }
        const device = fallbackDevice(requestDeviceId, error.message);
        const safetyState = medicationSafetyEvents.mergeLocalMedicationSafetyFixtures(
          { availability: "error", events: [], message: "联网后自动更新风险记录" },
          requestDeviceId,
          { includeLocalFixtures: true, allowUnavailableLocalFallback: true },
        );
        const safetyRecords = buildSafetyRecords(safetyState.events || [], null);
        const feed = buildFeed([], safetyRecords);
        this._hasLoadedRecords = true;
        this.applyRecordFilter(this.data.recordFilter, feed, {
          device,
          vitalsRecords: [],
          safetyRecords,
          safetyState,
          safetyDeviceId: requestDeviceId,
          safetyLoadedPageCount: 1,
          safetyNextCursor: "",
          safetyPaginationStatus: "done",
          safetyPaginationError: "",
          feed,
          stale: true,
          todaySafetyCount: todayCount(
            safetyRecords.filter(item => item.checkStatus === "BLOCKED"),
            "safety",
          ),
          todayVitalsCount: 0,
        });
      }
    }
  },

  retryLoad() {
    this.setData({
      carePage: loadingCarePage("照护记录", "正在重新读取照护记录…"),
    });
    return this.load();
  },

  applyRecordFilter(filter, source, patch = {}) {
    const persistOfflineSnapshot = patch.persistOfflineSnapshot === true;
    const offlineSnapshotQuality = patch.offlineSnapshotQuality === "partial" ? "partial" : "complete";
    const nextFilter = ["all", "safety", "vitals"].includes(filter) ? filter : "all";
    const feed = Array.isArray(source) ? source : (patch.feed || this.data.feed || []);
    const visibleFeed = nextFilter === "all" ? feed : feed.filter(item => item.type === nextFilter);
    const nextData = Object.assign({}, patch, {
      recordFilter: nextFilter,
      feed,
      visibleFeed,
      previewFeed: visibleFeed.slice(0, RECORD_PREVIEW_LIMIT),
      emptyText: emptyTextFor(nextFilter, patch.safetyState || this.data.safetyState),
    });
    delete nextData.persistOfflineSnapshot;
    delete nextData.offlineSnapshotQuality;
    if (this.data.detailVisible && this.data.detailMode === "list") {
      nextData.detailList = visibleFeed;
    }
    Object.assign(nextData, safetyPaginationView(Object.assign({}, this.data, nextData)));
    nextData.carePage = buildRecordsCarePage(Object.assign({}, this.data, nextData));
    this.setData(nextData);
    if (persistOfflineSnapshot) {
      const deviceId = String(nextData.safetyDeviceId || this.data.safetyDeviceId || "").trim();
      offlinePageCache.savePage(
        deviceId,
        RECORDS_CACHE_KEY,
        Object.assign({}, this.data, nextData),
        { updatedAtMs: nextData.lastSyncedAtMs, quality: offlineSnapshotQuality },
      );
    }
  },

  setRecordFilter(e) {
    this.applyRecordFilter(e.currentTarget.dataset.filter);
  },

  showAllRecords() {
    const nextData = {
      detailVisible: true,
      detailMode: "list",
      detailTitle: filterTitle(this.data.recordFilter),
      detailList: this.data.visibleFeed,
    };
    Object.assign(nextData, safetyPaginationView(Object.assign({}, this.data, nextData)));
    this.setData(nextData);
  },

  async loadMoreSafetyRecords() {
    const cursor = String(this.data.safetyNextCursor || "").trim();
    const requestDeviceId = String(this.data.safetyDeviceId || "").trim();
    const canContainSafety = this.data.recordFilter === "all" || this.data.recordFilter === "safety";
    if (!cursor || !canContainSafety || !this.data.detailVisible || this.data.detailMode !== "list" || this.data.safetyPaginationStatus === "loading") {
      return;
    }
    const paginationRequestId = Number(this._safetyPaginationRequestId || 0) + 1;
    this._safetyPaginationRequestId = paginationRequestId;

    const loadingPatch = {
      safetyPaginationStatus: "loading",
      safetyPaginationError: "",
    };
    Object.assign(loadingPatch, safetyPaginationView(Object.assign({}, this.data, loadingPatch)));
    this.setData(loadingPatch);

    let pageState;
    try {
      pageState = await medicationSafetyEventModule.list({ limit: 50, cursor, deviceId: requestDeviceId });
    } catch (error) {
      pageState = { availability: "error", error };
    }

    if (paginationRequestId !== this._safetyPaginationRequestId ||
      !this.isDeviceScopeCurrent(requestDeviceId) ||
      String(this.data.safetyNextCursor || "").trim() !== cursor) {
      return;
    }

    if (!pageState || pageState.availability !== "ready") {
      const errorPatch = {
        safetyPaginationStatus: "error",
        safetyPaginationError: safetyAvailabilityText(pageState || { availability: "error" }),
      };
      Object.assign(errorPatch, safetyPaginationView(Object.assign({}, this.data, errorPatch)));
      this.setData(errorPatch);
      return;
    }

    const nextCursor = String(pageState.nextCursor || "");
    if (nextCursor === cursor) {
      const errorPatch = {
        safetyPaginationStatus: "error",
        safetyPaginationError: "分页位置没有前进，请点击重试。",
      };
      Object.assign(errorPatch, safetyPaginationView(Object.assign({}, this.data, errorPatch)));
      this.setData(errorPatch);
      return;
    }

    const incoming = buildSafetyRecords(pageState.events || [], this._personaPolicy);
    const safetyRecords = mergeSafetyRecords(this.data.safetyRecords || [], incoming);
    const feed = buildFeed(this.data.vitalsRecords || [], safetyRecords);
    const safetyNextCursor = nextCursor;
    this.applyRecordFilter(this.data.recordFilter, feed, {
      safetyRecords,
      feed,
      safetyLoadedPageCount: Number(this.data.safetyLoadedPageCount || 1) + 1,
      safetyNextCursor,
      safetyPaginationStatus: safetyNextCursor ? "idle" : "done",
      safetyPaginationError: "",
      todaySafetyCount: todayCount(
        safetyRecords.filter(item => item.checkStatus === "BLOCKED"),
        "safety",
      ),
    });
  },

  showRecordDetails(e) {
    const index = Number(e.currentTarget.dataset.recordIndex);
    const record = (this.data.visibleFeed || [])[index];
    this.openRecord(record);
  },

  openRecord(record) {
    if (!record) return;
    this.setData({
      detailVisible: true,
      detailMode: "record",
      detailTitle: record.type === "safety" ? "用药风险" : "健康测量",
      detailList: [record],
    });
    if (record.type === "safety") {
      return this.syncSafetyRecord(record, String(this.data.safetyDeviceId || "").trim());
    }
  },

  openDetailRecord(event) {
    if (this.data.detailMode !== "list") return;
    const recordId = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.recordId;
    const record = (this.data.feed || []).find(item => item.id === recordId);
    return this.openRecord(record);
  },

  async syncSafetyRecord(record, requestDeviceId = this.data.safetyDeviceId) {
    const scopeDeviceId = String(requestDeviceId || "").trim();
    const detailRequestId = Number(this._safetyDetailRequestId || 0) + 1;
    this._safetyDetailRequestId = detailRequestId;
    if (!this.isDeviceScopeCurrent(scopeDeviceId) || !safetyRecordMatchesDevice(record, scopeDeviceId) ||
      (this._personaPolicy && !this._personaPolicy.allowsCurrentRecord(record, { allowUnlinked: true }))) {
      return record;
    }
    let nextRecord;
    try {
      const detail = await medicationSafetyEventModule.getDetail(record.id, { deviceId: scopeDeviceId });
      if (detailRequestId !== this._safetyDetailRequestId ||
        !this.isDeviceScopeCurrent(scopeDeviceId) ||
        !safetyRecordMatchesDevice(detail, scopeDeviceId) ||
        (this._personaPolicy && !this._personaPolicy.allowsCurrentRecord(detail, { allowUnlinked: true }))) {
        return record;
      }
      nextRecord = buildSafetyRecords([detail], this._personaPolicy)[0] || record;
    } catch (error) {
      console.warn("medication safety detail read failed", error);
      return record;
    }

    return this.markSafetyRecordRead(nextRecord, scopeDeviceId, detailRequestId);
  },

  async markSafetyRecordRead(
    nextRecord,
    requestDeviceId = this.data.safetyDeviceId,
    detailRequestId = this._safetyDetailRequestId,
  ) {
    const scopeDeviceId = String(requestDeviceId || "").trim();
    if (detailRequestId !== this._safetyDetailRequestId ||
      !this.isDeviceScopeCurrent(scopeDeviceId) ||
      !safetyRecordMatchesDevice(nextRecord, scopeDeviceId)) {
      return nextRecord;
    }
    if (nextRecord && nextRecord.localOnly === true) {
      nextRecord = Object.assign({}, nextRecord, {
        readState: "READ",
        readText: "已查看",
      });
      if (detailRequestId === this._safetyDetailRequestId && this.isDeviceScopeCurrent(scopeDeviceId)) {
        this.replaceSafetyRecord(nextRecord, scopeDeviceId);
      }
      return nextRecord;
    }
    try {
      await medicationSafetyEventModule.markRead(nextRecord.id, { deviceId: scopeDeviceId });
      if (detailRequestId !== this._safetyDetailRequestId || !this.isDeviceScopeCurrent(scopeDeviceId)) {
        return nextRecord;
      }
      nextRecord = Object.assign({}, nextRecord, {
        readState: "READ",
        readText: "已查看",
      });
    } catch (error) {
      console.warn("medication safety read receipt failed", error);
    }

    if (detailRequestId === this._safetyDetailRequestId && this.isDeviceScopeCurrent(scopeDeviceId)) {
      this.replaceSafetyRecord(nextRecord, scopeDeviceId);
    }
    return nextRecord;
  },

  replaceSafetyRecord(record, requestDeviceId = this.data.safetyDeviceId) {
    if (!this.isDeviceScopeCurrent(requestDeviceId) || !safetyRecordMatchesDevice(record, requestDeviceId)) return;
    const safetyRecords = (this.data.safetyRecords || []).map(item => item.id === record.id ? record : item);
    const feed = buildFeed(this.data.vitalsRecords || [], safetyRecords);
    const recordFilter = this.data.recordFilter || "all";
    const visibleFeed = recordFilter === "all" ? feed : feed.filter(item => item.type === recordFilter);
    const detailList = (this.data.detailList || []).map(item => item.id === record.id ? record : item);
    const nextData = {
      safetyRecords,
      feed,
      visibleFeed,
      previewFeed: visibleFeed.slice(0, RECORD_PREVIEW_LIMIT),
      detailList,
    };
    nextData.carePage = buildRecordsCarePage(Object.assign({}, this.data, nextData));
    this.setData(nextData);
  },

  setPendingSafetyDetailRetry(value) {
    const nextData = { pendingSafetyDetailRetry: value || null };
    nextData.carePage = buildRecordsCarePage(Object.assign({}, this.data, nextData));
    this.setData(nextData);
  },

  async retryPendingSafetyDetail() {
    const pending = this.data.pendingSafetyDetailRetry;
    const eventId = String(pending && pending.eventId || "").trim();
    const scopeDeviceId = String(pending && pending.deviceId || "").trim();
    if (!eventId || !scopeDeviceId || !this.isDeviceScopeCurrent(scopeDeviceId)) {
      if (pending) this.setPendingSafetyDetailRetry(null);
      return;
    }

    const detailRequestId = Number(this._safetyDetailRequestId || 0) + 1;
    this._safetyDetailRequestId = detailRequestId;
    this.setPendingSafetyDetailRetry({
      eventId,
      deviceId: scopeDeviceId,
      status: "loading",
      message: "正在重新读取用药风险详情…",
    });

    let record;
    try {
      const detail = await medicationSafetyEventModule.getDetail(eventId, { deviceId: scopeDeviceId });
      if (detailRequestId !== this._safetyDetailRequestId ||
        !this.isDeviceScopeCurrent(scopeDeviceId)) {
        return;
      }
      record = buildSafetyRecords([detail], this._personaPolicy)[0];
      if (!record || record.id !== eventId || !safetyRecordMatchesDevice(record, scopeDeviceId) ||
        (this._personaPolicy && !this._personaPolicy.allowsCurrentRecord(detail, { allowUnlinked: true }))) {
        this.setPendingSafetyDetailRetry(null);
        return;
      }
    } catch (error) {
      console.warn("pending medication safety detail retry failed", error);
      const current = this.data.pendingSafetyDetailRetry || {};
      if (detailRequestId === this._safetyDetailRequestId &&
        this.isDeviceScopeCurrent(scopeDeviceId) &&
        current.eventId === eventId && current.deviceId === scopeDeviceId) {
        this.setPendingSafetyDetailRetry({
          eventId,
          deviceId: scopeDeviceId,
          status: "error",
          message: "仍未能读取用药风险详情，请检查网络后再次重试。",
        });
      }
      return;
    }

    const safetyRecords = mergeSafetyRecords(this.data.safetyRecords || [], [record]);
    const feed = buildFeed(this.data.vitalsRecords || [], safetyRecords);
    this.applyRecordFilter("safety", feed, {
      safetyRecords,
      feed,
      pendingSafetyDetailRetry: null,
    });
    this.setData({
      detailVisible: true,
      detailMode: "record",
      detailTitle: "用药风险",
      detailList: [record],
    });
    return this.markSafetyRecordRead(record, scopeDeviceId, detailRequestId);
  },

  async consumePendingCareRoute(requestDeviceId = this.data.safetyDeviceId) {
    const app = getApp();
    const globalData = (app && app.globalData) || {};
    const scopeDeviceId = String(requestDeviceId || "").trim();
    const requestedFilter = globalData.pendingCareFilter;
    if (requestedFilter === "safety") {
      delete globalData.pendingCareFilter;
      this.applyRecordFilter("safety");
    }

    const pending = globalData.pendingCareRecord;
    if (!pending || pending.type !== "safety" || !pending.eventId) return;
    const pendingDeviceId = String(pending.deviceId || pending.device_id || "").trim();
    if (!pendingDeviceId || pendingDeviceId !== scopeDeviceId || !this.isDeviceScopeCurrent(scopeDeviceId)) {
      delete globalData.pendingCareRecord;
      return;
    }
    delete globalData.pendingCareRecord;
    let record = (this.data.feed || []).find(item => item.type === "safety" && item.id === pending.eventId);
    if (!record) {
      if (!this.data.safetyState || this.data.safetyState.availability !== "ready") return;
      const detailRequestId = Number(this._safetyDetailRequestId || 0) + 1;
      this._safetyDetailRequestId = detailRequestId;
      try {
        const detail = await medicationSafetyEventModule.getDetail(pending.eventId, { deviceId: scopeDeviceId });
        if (detailRequestId !== this._safetyDetailRequestId ||
          globalData.pendingCareRecord ||
          !this.isDeviceScopeCurrent(scopeDeviceId) ||
          !safetyRecordMatchesDevice(detail, scopeDeviceId) ||
          (this._personaPolicy && !this._personaPolicy.allowsCurrentRecord(detail, { allowUnlinked: true }))) {
          return;
        }
        record = buildSafetyRecords([detail], this._personaPolicy)[0];
      } catch (error) {
        console.warn("pending medication safety detail read failed", error);
        if (detailRequestId !== this._safetyDetailRequestId ||
          globalData.pendingCareRecord ||
          !this.isDeviceScopeCurrent(scopeDeviceId)) {
          return;
        }
        this.setPendingSafetyDetailRetry({
          eventId: String(pending.eventId || "").trim(),
          deviceId: scopeDeviceId,
          status: "error",
          message: "用药风险详情读取失败，请检查网络后重试。",
        });
        return;
      }
      if (!record) return;
      const safetyRecords = mergeSafetyRecords(this.data.safetyRecords || [], [record]);
      const feed = buildFeed(this.data.vitalsRecords || [], safetyRecords);
      this.applyRecordFilter("safety", feed, { safetyRecords, feed });
      this.setData({
        detailVisible: true,
        detailMode: "record",
        detailTitle: "用药风险",
        detailList: [record],
      });
      return this.markSafetyRecordRead(record, scopeDeviceId, detailRequestId);
    }
    this.applyRecordFilter("safety");
    return this.openRecord(record);
  },

  onCarePageAction(event) {
    const detail = (event && event.detail) || {};
    const payload = detail.payload || {};
    const actionId = String(detail.id || "");

    if (actionId === "records.retry") {
      return this.retryLoad();
    }

    if (actionId === "records-action-open-all") {
      this.showAllRecords();
      return;
    }

    if (actionId === "records-action-retry-pending-safety") {
      return this.retryPendingSafetyDetail();
    }

    if (actionId.indexOf("records-action-filter-") === 0) {
      this.applyRecordFilter(payload.filter);
      return;
    }

    if (actionId.indexOf("records-action-open-") === 0) {
      const record = (this.data.feed || []).find(item => item.id === payload.recordId);
      return this.openRecord(record);
    }
  },

  showVitalsDetails() {
    this.applyRecordFilter("vitals");
    this.showAllRecords();
  },

  closeDetail() {
    this.setData({ detailVisible: false });
  },

  noop() {},
});
