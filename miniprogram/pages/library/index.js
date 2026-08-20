const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const deviceSession = require("../../utils/deviceSession");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const { summarizeMedicineLibrary } = require("../../utils/medicineLibrary");
const { FIXED_MEDICINES } = require("../../data/fixedMedicineCatalog");

function medicinesForDisplay(medicines = []) {
  if (Array.isArray(medicines) && medicines.length) return medicines;
  return FIXED_MEDICINES.map(item => Object.assign({}, item, { hasCloudRecord: false }));
}

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function clearedLibraryScope(deviceId = "") {
  return {
    deviceId,
    device: {},
    summary: summarizeMedicineLibrary([]),
    hasLoadedSnapshot: false,
    stale: false,
    carePage: loadingCarePage("家庭药库", "正在整理家庭药品…"),
  };
}

function medicineState(medicine = {}) {
  if (medicine.statusClass === "expired") return { kind: "risk", label: "已过期" };
  if (medicine.isDepleted) return { kind: "pending", label: "待补药" };
  if (["urgent", "soon"].includes(medicine.statusClass)) return { kind: "pending", label: "临期" };
  if (medicine.statusClass === "missing") return { kind: "actionable", label: "效期待补" };
  if (medicine.isInventoryUnknown) return { kind: "muted", label: "余量待确认" };
  return { kind: "normal", label: "状态正常" };
}

function boxState(box = {}) {
  if (box.attentionCount) return { kind: "pending", label: `${box.attentionCount} 项关注` };
  if (box.count) return { kind: "normal", label: `${box.count} 种` };
  return { kind: "muted", label: "暂无药品" };
}

function composeLibraryCarePage(device = {}, summary = {}, options = {}) {
  const attentionCount = (summary.attentionMedicines || []).length;
  const stale = options.stale === true;
  const catalogOnly = options.catalogOnly === true;
  const primary = (summary.attentionMedicines || [])[0] || null;
  const focus = primary
    ? {
      eyebrow: stale ? "数据待刷新" : "药品需要关注",
      title: primary.statusClass === "expired"
        ? `${primary.name} 已过期`
        : (primary.isDepleted ? `${primary.name} 需要补充` : `${primary.name} 状态待处理`),
      supporting: `${primary.storageBoxLabel} · ${primary.isDepleted ? primary.stockHint : primary.expiryHint}`,
      state: medicineState(primary),
      action: { id: "library.attention", label: "查看需要关注的药品", payload: { filter: "attention" } },
      activation: "surface",
    }
    : summary.medicineCount
      ? {
        eyebrow: stale ? "数据待刷新" : "家庭药库",
        title: "三类药品已整理",
        supporting: catalogOnly
          ? `共 ${summary.medicineCount} 种药品，库存和有效期将在连接药箱后更新。`
          : `共 ${summary.medicineCount} 种药品，按综合内服、感冒呼吸和外用护理分类查看。`,
        state: { kind: stale ? "pending" : (catalogOnly ? "muted" : "normal"), label: stale ? "待刷新" : (catalogOnly ? "待同步" : "已同步") },
        action: { id: "library.all.focus", label: "查看全部药品" },
        activation: "surface",
      }
      : {
        eyebrow: stale ? "数据待刷新" : "家庭药库",
        title: "暂无已入库药品",
        supporting: "药品资料等待终端同步。",
        state: { kind: "muted", label: "等待同步" },
        action: null,
        activation: "none",
      };

  return composeCarePage({
    key: "medicine-library",
    title: "家庭药库",
    online: device.online === true,
    focus,
    overview: [
      { key: "library-total", label: "全部药品", value: summary.medicineCount || 0, state: summary.medicineCount ? "actionable" : "muted" },
      { key: "library-expiring", label: "临期", value: summary.expiringCount || 0, state: summary.expiringCount ? "pending" : "muted" },
      { key: "library-expired", label: "已过期", value: summary.expiredCount || 0, state: summary.expiredCount ? "risk" : "muted" },
      { key: "library-depleted", label: "待补药", value: summary.depletedCount || 0, state: summary.depletedCount ? "pending" : "muted" },
    ],
    sections: [
      {
        key: "library-boxes",
        intent: "inventory",
        title: "三个药盒",
        supporting: "",
        items: (summary.boxes || []).map(box => ({
          key: `library-box-${box.id}`,
          symbolText: box.symbol,
          title: box.label,
          supporting: box.previewNames || box.description,
          meta: `${box.count} 种药品`,
          state: boxState(box),
          action: {
            id: `library.box.${box.id}`,
            label: `查看${box.label}`,
            payload: { box: box.id },
          },
        })),
      },
      {
        key: "library-attention",
        intent: "tasks",
        title: "药品维护",
        supporting: attentionCount ? `共 ${attentionCount} 项需要关注` : "当前没有临期、过期或缺药提醒",
        empty: "当前没有需要处理的药品。",
        items: (summary.attentionMedicines || []).slice(0, 4).map((medicine, itemIndex) => ({
          key: `library-medicine-${medicine.medicineId || medicine._id}`,
          symbolText: medicine.storageBoxSymbol,
          title: medicine.name,
          supporting: `${medicine.storageBoxLabel} · ${medicine.isDepleted ? medicine.stockHint : medicine.expiryHint}`,
          meta: medicine.expiryLabel || "效期待补",
          state: medicineState(medicine),
          action: {
            id: `library.attention.item.${itemIndex}`,
            label: "查看药品清单",
            payload: { filter: "attention", box: medicine.storageBox },
          },
        })),
        more: attentionCount > 4 ? { id: "library.attention.more", label: `全部 ${attentionCount} 项` } : null,
      },
    ],
    detailAction: summary.medicineCount ? {
      id: "library.all",
      label: `全部药品 · ${summary.medicineCount} 种`,
    } : null,
  });
}

function libraryErrorCarePage(device = {}) {
  return composeCarePage({
    key: "medicine-library-error",
    title: "家庭药库",
    online: device.online === true,
    phase: {
      kind: "error",
      message: "药品资料读取失败，当前无法确认家庭药库状态。",
      action: { id: "library.retry", label: "重新读取药品资料" },
    },
  });
}

Page({
  data: clearedLibraryScope(""),

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
    const requestDeviceId = activeDeviceId();
    if (requestDeviceId !== String(this.data.deviceId || "").trim()) {
      this._hasLoadedSnapshot = false;
      this.setData(clearedLibraryScope(requestDeviceId));
    }
    const requestId = Number(this._loadRequestId || 0) + 1;
    this._loadRequestId = requestId;
    try {
      const [device, medicines] = requestDeviceId
        ? await Promise.all([
          api.getDevice(requestDeviceId),
          api.getMedicinesStrict(requestDeviceId),
        ])
        : [{}, []];
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      const hasLiveMedicines = Array.isArray(medicines) && medicines.length > 0;
      const summary = summarizeMedicineLibrary(medicinesForDisplay(medicines), {
        includeFixedBaseline: hasLiveMedicines,
      });
      this._hasLoadedSnapshot = true;
      this.setData({
        deviceId: requestDeviceId,
        device,
        summary,
        hasLoadedSnapshot: true,
        stale: false,
        carePage: composeLibraryCarePage(device, summary, { catalogOnly: !requestDeviceId }),
      });
    } catch (error) {
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      console.warn("medicine library loading failed", error);
      if (!this._hasLoadedSnapshot) {
        this.setData({ carePage: libraryErrorCarePage(this.data.device) });
      } else {
        this.setData({
          stale: true,
          carePage: composeLibraryCarePage(this.data.device, this.data.summary, { stale: true }),
        });
      }
    }
  },

  onCarePageAction(event) {
    const detail = event && event.detail ? event.detail : {};
    const payload = detail.payload || {};
    if (detail.id === "library.retry") return this.load();
    if (detail.id === "library.all" || detail.id === "library.all.focus") return this.openList();
    if (detail.id === "library.attention"
      || detail.id === "library.attention.more"
      || String(detail.id || "").indexOf("library.attention.item.") === 0) return this.openList(payload);
    if (String(detail.id || "").indexOf("library.box.") === 0) return this.openList(payload);
    return undefined;
  },

  openList(options = {}) {
    const query = [];
    if (options.box) query.push(`box=${encodeURIComponent(options.box)}`);
    if (options.filter) query.push(`filter=${encodeURIComponent(options.filter)}`);
    wx.navigateTo({ url: `/pages/libraryList/index${query.length ? `?${query.join("&")}` : ""}` });
  },
});
