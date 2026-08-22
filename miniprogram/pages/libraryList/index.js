const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const deviceSession = require("../../utils/deviceSession");
const {
  STORAGE_BOXES,
  filterMedicines,
  mergeFixedMedicineBaseline,
  summarizeMedicineLibrary,
} = require("../../utils/medicineLibrary");
const offlinePageCache = require("../../utils/offlinePageCache");

const LIBRARY_LIST_CACHE_KEY = "library-list";

function medicinesForDisplay(medicines = []) {
  return Array.isArray(medicines) ? medicines : [];
}

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

function emptyTextFor(medicines = [], filter = "all", keyword = "") {
  if (!medicines.length) return "暂无已入库药品。";
  if (String(keyword || "").trim()) return "没有找到匹配的药品。";
  if (filter === "attention") return "当前没有需要关注的药品。";
  if (filter === "depleted") return "当前没有已确认缺药的药品。";
  return "当前分类暂无药品。";
}

function clearedScope(deviceId = "") {
  return {
    deviceId,
    device: {},
    medicines: [],
    viewMedicines: [],
    boxes: [{ id: "ALL", shortLabel: "全部" }].concat(STORAGE_BOXES),
    box: "ALL",
    filter: "all",
    keyword: "",
    emptyText: "暂无已入库药品。",
    initialLoading: true,
    loadError: "",
    hasLoadedSnapshot: false,
    stale: false,
    refreshError: "",
    detailVisible: false,
    selectedMedicine: {},
  };
}

Page({
  data: clearedScope(""),

  onLoad(options = {}) {
    const box = STORAGE_BOXES.some(item => item.id === options.box) ? options.box : "ALL";
    const filter = ["all", "attention", "expiring", "expired", "depleted", "unknown"].includes(options.filter)
      ? options.filter
      : "all";
    this.setData({ box, filter });
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
    if (!activeDeviceId()) return;
    this._stopRealtime = realtime.subscribe(() => this.load(), null, {
      collections: ["devices", "medicines"],
      intervalMs: 20000,
      immediate: false,
    });
  },

  stopRealtime() {
    if (this._stopRealtime) this._stopRealtime();
    this._stopRealtime = null;
  },

  async load() {
    const requestDeviceId = activeDeviceId() || "zykh-qsm-001";
    if (requestDeviceId !== String(this.data.deviceId || "").trim()) {
      const preserved = { box: this.data.box, filter: this.data.filter };
      this._hasLoadedSnapshot = false;
      this.setData(Object.assign(clearedScope(requestDeviceId), preserved));
    }
    const requestId = Number(this._loadRequestId || 0) + 1;
    this._loadRequestId = requestId;
    if (this._cacheHydratedDeviceId !== requestDeviceId) {
      this._cacheHydratedDeviceId = requestDeviceId;
      const restored = offlinePageCache.restorePage(requestDeviceId, LIBRARY_LIST_CACHE_KEY);
      if (restored) {
        const restoredData = Object.assign({}, restored.data, {
          box: this.data.box,
          filter: this.data.filter,
          keyword: this.data.keyword,
          refreshError: `当前显示上次同步数据 · ${restored.updatedAtText}`,
        });
        restoredData.viewMedicines = filterMedicines(restoredData.medicines || [], restoredData);
        restoredData.emptyText = emptyTextFor(
          restoredData.medicines || [],
          restoredData.filter,
          restoredData.keyword,
        );
        this._hasLoadedSnapshot = true;
        this.setData(restoredData);
      }
    }
    try {
      const [deviceRead, medicineRead] = await Promise.all([
        api.getDeviceStrict(requestDeviceId).then(
          value => ({ value, error: null }),
          error => ({ value: this.data.device && this.data.device.deviceId === requestDeviceId ? this.data.device : fallbackDevice(requestDeviceId, error.message), error }),
        ),
        api.getMedicinesStrict(requestDeviceId).then(
          value => ({ value, error: null }),
          error => ({ value: [], error }),
        ),
      ]);
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      const cloudMedicines = medicinesForDisplay(medicineRead.value);
      const medicines = cloudMedicines.length ? cloudMedicines : mergeFixedMedicineBaseline([]);
      const device = deviceRead.value;
      const stale = Boolean(deviceRead.error || medicineRead.error);
      if (stale && this.data.offlineSnapshot === true && this._hasLoadedSnapshot) {
        this.setData({
          stale: true,
          refreshError: `当前显示上次同步数据 · ${this.data.lastSyncedAtText || "时间未知"}`,
        });
        return;
      }
      const summary = summarizeMedicineLibrary(medicines);
      const lastSyncedAtMs = Date.now();
      const viewMedicines = filterMedicines(summary.medicines, {
        box: this.data.box,
        filter: this.data.filter,
        keyword: this.data.keyword,
      });
      const nextData = {
        deviceId: requestDeviceId,
        device,
        medicines: summary.medicines,
        viewMedicines,
        emptyText: emptyTextFor(summary.medicines, this.data.filter, this.data.keyword),
        initialLoading: false,
        loadError: "",
        hasLoadedSnapshot: true,
        stale,
        refreshError: stale ? "当前显示家庭药品目录，联网后自动更新库存和有效期。" : "",
        offlineSnapshot: false,
        lastSyncedAtMs,
        lastSyncedAtText: offlinePageCache.formatUpdatedAt(lastSyncedAtMs),
      };
      this._hasLoadedSnapshot = true;
      this.setData(nextData);
      if (!deviceRead.error || !medicineRead.error) {
        offlinePageCache.savePage(
          requestDeviceId,
          LIBRARY_LIST_CACHE_KEY,
          Object.assign({}, this.data, nextData),
          { updatedAtMs: lastSyncedAtMs, quality: stale ? "partial" : "complete" },
        );
      }
    } catch (error) {
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      console.warn("medicine list loading failed", error);
      if (!this._hasLoadedSnapshot) {
        const summary = summarizeMedicineLibrary(mergeFixedMedicineBaseline([]));
        this._hasLoadedSnapshot = true;
        this.setData({
          deviceId: requestDeviceId,
          device: fallbackDevice(requestDeviceId, error.message),
          medicines: summary.medicines,
          initialLoading: false,
          loadError: "",
          hasLoadedSnapshot: true,
          stale: true,
          refreshError: "当前显示家庭药品目录，联网后自动更新库存和有效期。",
        });
        this.applyFilter();
      } else {
        this.setData({
          stale: true,
          refreshError: this.data.offlineSnapshot
            ? `当前显示上次同步数据 · ${this.data.lastSyncedAtText || "时间未知"}`
            : "当前显示已保存的药品资料，连接后自动更新。",
        });
      }
    }
  },

  retryLoad() {
    if (!this.data.hasLoadedSnapshot) this.setData({ initialLoading: true, loadError: "" });
    return this.load();
  },

  applyFilter() {
    const viewMedicines = filterMedicines(this.data.medicines, {
      box: this.data.box,
      filter: this.data.filter,
      keyword: this.data.keyword,
    });
    this.setData({
      viewMedicines,
      emptyText: emptyTextFor(this.data.medicines, this.data.filter, this.data.keyword),
    });
  },

  onSearch(event) {
    this.setData({ keyword: event.detail.value });
    this.applyFilter();
  },

  setBox(event) {
    this.setData({ box: event.currentTarget.dataset.box || "ALL" });
    this.applyFilter();
  },

  setFilter(event) {
    this.setData({ filter: event.currentTarget.dataset.filter || "all" });
    this.applyFilter();
  },

  showMedicine(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const selectedMedicine = (this.data.viewMedicines || []).find(item => (
      String(item.medicineId || item._id) === id
    ));
    if (!selectedMedicine) return;
    this.setData({ detailVisible: true, selectedMedicine });
  },

  closeDetail() { this.setData({ detailVisible: false }); },
  noop() {},
});
