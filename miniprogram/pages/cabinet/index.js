const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const deviceSession = require("../../utils/deviceSession");
const cabinetView = require("../../utils/cabinetView");
const { CABINET_SLOT_COUNT, firstEmptyCabinetSlot, isCabinetSlot } = require("../../utils/cabinetSlots");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function clearedCabinetScope(deviceId) {
  return {
    carePage: loadingCarePage("家庭药箱", "正在读取当前药箱的药品状态…"),
    deviceId,
    device: {},
    slots: [],
    prioritySlots: [],
    overviewSlots: [],
    stockCount: 0,
    validExpiryCount: 0,
    expiredCount: 0,
    missingExpiryCount: 0,
    expiryRiskCount: 0,
    depletedCount: 0,
    stockedCount: 0,
    inventoryUnknownCount: 0,
    hasLoadedSnapshot: false,
    isStale: false,
    refreshError: "",
  };
}

function cabinetSlotState(slot = {}) {
  if (slot.isDepleted) return { kind: "pending", label: "待补药" };
  if (slot.isInventoryUnknown) return { kind: "muted", label: "库存待确认" };
  const kinds = {
    expired: "risk",
    urgent: "pending",
    soon: "pending",
    missing: "actionable",
    valid: "normal",
  };
  return {
    kind: kinds[slot.statusClass] || "muted",
    label: slot.statusText || slot.expiryHint || "状态待同步",
  };
}

function composeCabinetCarePage(device, summary, options = {}) {
  const stale = options.stale === true;
  const attentionCount = summary.expiredCount
    + summary.expiryRiskCount
    + summary.missingExpiryCount
    + summary.depletedCount;
  const focusState = summary.expiredCount
    ? { kind: "risk", label: "优先处理" }
    : attentionCount
      ? { kind: "pending", label: "需要维护" }
      : summary.stockCount
        ? summary.inventoryUnknownCount
          ? { kind: "muted", label: "待确认" }
          : { kind: "normal", label: "状态良好" }
        : { kind: "actionable", label: "等待登记" };
  const prioritySlot = summary.prioritySlots[0];
  const emptySlot = firstEmptyCabinetSlot(summary.slots);
  const focusAction = prioritySlot
    ? {
      id: "cabinet.focus.edit",
      label: `打开 ${prioritySlot.slot} 号仓维护`,
      payload: { slot: Number(prioritySlot.slot) },
    }
    : emptySlot
      ? {
        id: "cabinet.register",
        label: `登记 ${emptySlot} 号仓`,
        payload: { slot: emptySlot },
      }
      : {
        id: "cabinet.focus.all",
        label: "查看全部药品",
      };

  const fact = (key, label, value, tone, filter) => ({
    key,
    label,
    value,
    tone: value ? tone : "muted",
    action: value ? {
      id: `cabinet.filter.${filter}`,
      label: `查看${label}药品`,
      payload: { filter },
    } : null,
  });

  return composeCarePage({
    key: "cabinet",
    title: "家庭药箱",
    online: Boolean(device && device.online),
    focus: {
      eyebrow: stale ? "数据待刷新" : "药箱维护",
      title: attentionCount
        ? `${attentionCount} 个仓位需要维护`
        : summary.inventoryUnknownCount
          ? `${summary.inventoryUnknownCount} 个仓位库存待确认`
        : summary.stockCount
          ? "已登记药品状态良好"
          : "还没有登记药品",
      supporting: stale
        ? "显示的是上次成功读取的数据；本次刷新失败，请重新读取后再处理。"
        : `已登记 ${summary.stockCount}/${CABINET_SLOT_COUNT} 个仓位`,
      state: stale ? { kind: "pending", label: "数据待刷新" } : focusState,
      action: stale
        ? { id: "cabinet.retry", label: "重新读取药箱" }
        : focusAction,
      activation: stale ? "button" : (prioritySlot ? "surface" : "button"),
    },
    overview: [
      fact("cabinet.expired", "已过期", summary.expiredCount, "risk", "expired"),
      fact("cabinet.expiring", "临期", summary.expiryRiskCount, "pending", "expiring"),
      fact("cabinet.missing", "待补效期", summary.missingExpiryCount, "actionable", "missing"),
      fact("cabinet.depleted", "待补药", summary.depletedCount, "pending", "depleted"),
    ],
    sections: [{
      key: "cabinet.inventory",
      intent: "inventory",
      title: "药品概览",
      supporting: attentionCount ? "优先显示需要维护的仓位" : "显示最近登记的药品",
      empty: "还没有登记药品，可从上方开始登记。",
      items: summary.overviewSlots.map(slot => ({
        key: `cabinet.slot.${slot.slot}`,
        leading: String(slot.slot),
        title: slot.name,
        supporting: `${slot.spec || "规格待补充"} · ${slot.stockText}`,
        meta: slot.isDepleted ? "" : slot.expiryHint,
        state: cabinetSlotState(slot),
        action: {
          id: `cabinet.edit.${slot.slot}`,
          label: `编辑 ${slot.slot} 号仓`,
          payload: { slot: Number(slot.slot) },
        },
      })),
    }],
    detailAction: {
      id: "cabinet.all",
      label: `全部药品 · 已登记 ${summary.stockCount} 种`,
    },
  });
}

function cabinetSummaryFromData(data = {}) {
  return {
    slots: data.slots || [],
    prioritySlots: data.prioritySlots || [],
    overviewSlots: data.overviewSlots || [],
    stockCount: Number(data.stockCount || 0),
    validExpiryCount: Number(data.validExpiryCount || 0),
    expiredCount: Number(data.expiredCount || 0),
    missingExpiryCount: Number(data.missingExpiryCount || 0),
    expiryRiskCount: Number(data.expiryRiskCount || 0),
    depletedCount: Number(data.depletedCount || 0),
    stockedCount: Number(data.stockedCount || 0),
    inventoryUnknownCount: Number(data.inventoryUnknownCount || 0),
  };
}

function cabinetErrorCarePage(device = {}) {
  return composeCarePage({
    key: "cabinet-error",
    title: "家庭药箱",
    online: Boolean(device.online),
    phase: {
      kind: "error",
      message: "药品数据读取失败，当前无法判断仓位是否为空。",
      action: { id: "cabinet.retry", label: "重新读取药箱" },
    },
  });
}

Page({
  data: {
    carePage: loadingCarePage("家庭药箱", "正在整理药箱状态…"),
    deviceId: "",
    device: {},
    slots: [],
    prioritySlots: [],
    overviewSlots: [],
    stockCount: 0,
    validExpiryCount: 0,
    expiredCount: 0,
    missingExpiryCount: 0,
    expiryRiskCount: 0,
    depletedCount: 0,
    stockedCount: 0,
    inventoryUnknownCount: 0,
    hasLoadedSnapshot: false,
    isStale: false,
    refreshError: "",
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
      this.setData(clearedCabinetScope(requestDeviceId));
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
            console.warn("cabinet inventory capability read failed", error);
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
        hasLoadedSnapshot: true,
        isStale: false,
        refreshError: "",
        carePage: composeCabinetCarePage(device, summary),
      }, summary));
    } catch (error) {
      if (loadGeneration !== this._loadGeneration ||
          String(this.data.deviceId || "").trim() !== requestDeviceId ||
          activeDeviceId() !== requestDeviceId) return;
      console.warn("cabinet loading failed", error);
      if (!this._hasLoadedSnapshot) {
        this.setData({
          hasLoadedSnapshot: false,
          carePage: cabinetErrorCarePage(this.data.device),
        });
      } else {
        this.setData({
          isStale: true,
          refreshError: "上次成功读取的数据仍在显示；本次刷新失败，请重新读取后再处理。",
          carePage: composeCabinetCarePage(
            this.data.device,
            cabinetSummaryFromData(this.data),
            { stale: true },
          ),
        });
      }
    }
  },

  onCarePageAction(event) {
    const detail = event && event.detail ? event.detail : {};
    const payload = detail.payload || {};
    if (detail.id === "cabinet.retry") {
      if (!this.data.hasLoadedSnapshot) {
        this.setData({ carePage: loadingCarePage("家庭药箱", "正在重新读取药箱…") });
      }
      return this.load();
    }
    if (!this.data.hasLoadedSnapshot || activeDeviceId() !== String(this.data.deviceId || "").trim()) {
      return;
    }
    if (detail.id === "cabinet.register") {
      this.goAddMedicine(payload.slot);
      return;
    }
    if (detail.id === "cabinet.focus.edit") {
      this.editOverviewSlot({ currentTarget: { dataset: { slot: payload.slot } } });
      return;
    }
    if (detail.id === "cabinet.focus.all") {
      this.goMedicineList();
      return;
    }
    if (detail.id === "cabinet.all") {
      this.goMedicineList();
      return;
    }
    if (detail.id && detail.id.indexOf("cabinet.filter.") === 0) {
      this.goMedicineList({ currentTarget: { dataset: { filter: payload.filter } } });
      return;
    }
    if (detail.id && detail.id.indexOf("cabinet.edit.") === 0) {
      this.editOverviewSlot({ currentTarget: { dataset: { slot: payload.slot } } });
    }
  },

  goAddMedicine(slotOrEvent) {
    const eventSlot = slotOrEvent && slotOrEvent.currentTarget && slotOrEvent.currentTarget.dataset
      ? slotOrEvent.currentTarget.dataset.slot
      : slotOrEvent;
    const slot = Number(eventSlot);
    wx.navigateTo({
      url: isCabinetSlot(slot)
        ? `/pages/addMedicine/index?slot=${slot}`
        : "/pages/addMedicine/index",
    });
  },

  editOverviewSlot(e) {
    const slot = Number(e && e.currentTarget && e.currentTarget.dataset
      ? e.currentTarget.dataset.slot
      : 1);
    wx.navigateTo({ url: `/pages/addMedicine/index?slot=${slot}` });
  },

  goMedicineList(e) {
    const filter = e && e.currentTarget && e.currentTarget.dataset
      ? e.currentTarget.dataset.filter
      : "";
    const query = ["expiring", "expired", "missing", "depleted"].includes(filter)
      ? `?filter=${filter}`
      : "";
    wx.navigateTo({ url: `/pages/medicineList/index${query}` });
  },
});
