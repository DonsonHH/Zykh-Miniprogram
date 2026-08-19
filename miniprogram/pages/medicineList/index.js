const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const deviceSession = require("../../utils/deviceSession");
const cabinetView = require("../../utils/cabinetView");
const { firstEmptyCabinetSlot, isCabinetSlot } = require("../../utils/cabinetSlots");

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function clearedMedicineListScope(deviceId) {
  return {
    deviceId,
    device: {},
    slots: [],
    viewSlots: [],
    emptyText: "还没有登记药品。",
    primarySlot: 0,
    stockedCount: 0,
    depletedCount: 0,
    inventoryUnknownCount: 0,
    initialLoading: true,
    loadError: "",
    hasLoadedSnapshot: false,
    isStale: false,
    refreshError: "",
  };
}

function emptyTextFor(slots = [], filter = "all", keyword = "") {
  const hasRegisteredMedicine = (slots || []).some(item => item && item.name);
  if (!hasRegisteredMedicine) return "还没有登记药品，先从一个仓位开始。";
  if (String(keyword || "").trim()) return "没有找到匹配的药品。";
  if (filter === "depleted") return "没有已由药箱确认用完、等待补药的药品。";
  return "没有符合当前筛选条件的药品。";
}

Page({
  data: {
    deviceId: "",
    device: {},
    slots: [],
    viewSlots: [],
    filter: "all",
    keyword: "",
    emptyText: "还没有登记药品。",
    primarySlot: 0,
    stockedCount: 0,
    depletedCount: 0,
    inventoryUnknownCount: 0,
    initialLoading: true,
    loadError: "",
    hasLoadedSnapshot: false,
    isStale: false,
    refreshError: "",
  },

  onLoad(options = {}) {
    const filter = options.filter;
    if (["all", "expiring", "expired", "missing", "depleted"].includes(filter)) {
      this.setData({ filter });
    }
  },

  onShow() {
    return deviceSession.runAfterDeviceSessionReady(() => {
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
      collections: ["devices", "medicines"],
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
    if (String(this.data.deviceId || "").trim() !== requestDeviceId) {
      this._hasLoadedSnapshot = false;
      this._loadGeneration = Number(this._loadGeneration || 0) + 1;
      this.setData(clearedMedicineListScope(requestDeviceId));
    }
    const loadGeneration = Number(this._loadGeneration || 0) + 1;
    this._loadGeneration = loadGeneration;
    try {
      const [device, rawSlots, inventoryPolicy] = await Promise.all([
        api.getDevice(requestDeviceId),
        api.getCabinetSlotsStrict(requestDeviceId),
        api.getCapabilitiesStrict(requestDeviceId)
          .then(cabinetView.inventoryPolicyFor)
          .catch(error => {
            console.warn("medicine list inventory capability read failed", error);
            return cabinetView.inventoryPolicyFor();
          }),
      ]);
      if (loadGeneration !== this._loadGeneration ||
          String(this.data.deviceId || "").trim() !== requestDeviceId ||
          activeDeviceId() !== requestDeviceId) return;
      const summary = cabinetView.summarizeCabinetSlots(rawSlots, inventoryPolicy);
      this._hasLoadedSnapshot = true;
      this.setData(Object.assign({
        device,
        deviceId: requestDeviceId,
        primarySlot: firstEmptyCabinetSlot(summary.slots),
        loadError: "",
        hasLoadedSnapshot: true,
        isStale: false,
        refreshError: "",
      }, summary));
      this.applyFilter();
    } catch (error) {
      if (loadGeneration !== this._loadGeneration ||
          String(this.data.deviceId || "").trim() !== requestDeviceId ||
          activeDeviceId() !== requestDeviceId) return;
      console.warn("medicine list loading failed", error);
      if (!this._hasLoadedSnapshot) {
        this.setData({
          loadError: "药品数据读取失败，当前无法判断药箱是否为空。",
          primarySlot: 0,
          hasLoadedSnapshot: false,
        });
      } else {
        this.setData({
          isStale: true,
          refreshError: "上次成功读取的数据仍在显示；本次刷新失败，请重新读取后再处理。",
          loadError: "",
        });
      }
    } finally {
      if (loadGeneration === this._loadGeneration &&
          String(this.data.deviceId || "").trim() === requestDeviceId &&
          activeDeviceId() === requestDeviceId &&
          this.data.initialLoading) {
        this.setData({ initialLoading: false });
      }
    }
  },

  retryLoad() {
    if (this.data.initialLoading) return;
    if (!this.data.hasLoadedSnapshot) {
      this.setData({ initialLoading: true, loadError: "" });
    } else {
      this.setData({
        isStale: true,
        refreshError: "正在重新读取药品数据…",
      });
    }
    return this.load();
  },

  applyFilter() {
    const viewSlots = cabinetView.filterCabinetSlots(
      this.data.slots,
      this.data.filter,
      this.data.keyword,
    );
    this.setData({
      viewSlots,
      emptyText: emptyTextFor(this.data.slots, this.data.filter, this.data.keyword),
    });
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter || "all" });
    this.applyFilter();
  },

  selectSlot(e) {
    if (!this.data.hasLoadedSnapshot || activeDeviceId() !== String(this.data.deviceId || "").trim()) return;
    const slot = Number(e.currentTarget.dataset.slot || 1);
    wx.navigateTo({ url: `/pages/addMedicine/index?slot=${slot}` });
  },

  goAddMedicine() {
    if (!this.data.hasLoadedSnapshot || activeDeviceId() !== String(this.data.deviceId || "").trim()) return;
    const slot = Number(this.data.primarySlot);
    if (!isCabinetSlot(slot)) return;
    wx.navigateTo({ url: `/pages/addMedicine/index?slot=${slot}` });
  },
});
