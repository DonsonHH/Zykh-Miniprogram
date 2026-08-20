const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const deviceSession = require("../../utils/deviceSession");
const {
  STORAGE_BOXES,
  filterMedicines,
  summarizeMedicineLibrary,
} = require("../../utils/medicineLibrary");

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
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
    const requestDeviceId = activeDeviceId();
    if (requestDeviceId !== String(this.data.deviceId || "").trim()) {
      const preserved = { box: this.data.box, filter: this.data.filter };
      this._hasLoadedSnapshot = false;
      this.setData(Object.assign(clearedScope(requestDeviceId), preserved));
    }
    const requestId = Number(this._loadRequestId || 0) + 1;
    this._loadRequestId = requestId;
    try {
      const [device, medicines] = await Promise.all([
        api.getDevice(requestDeviceId),
        api.getMedicinesStrict(requestDeviceId),
      ]);
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      const summary = summarizeMedicineLibrary(medicines);
      this._hasLoadedSnapshot = true;
      this.setData({
        deviceId: requestDeviceId,
        device,
        medicines: summary.medicines,
        initialLoading: false,
        loadError: "",
        hasLoadedSnapshot: true,
        stale: false,
        refreshError: "",
      });
      this.applyFilter();
    } catch (error) {
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      console.warn("medicine list loading failed", error);
      if (!this._hasLoadedSnapshot) {
        this.setData({
          initialLoading: false,
          loadError: "药品资料读取失败，请稍后重试。",
        });
      } else {
        this.setData({
          stale: true,
          refreshError: "本次刷新失败，当前显示的是上次同步结果。",
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
