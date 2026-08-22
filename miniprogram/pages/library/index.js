const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const deviceSession = require("../../utils/deviceSession");
const {
  composeCarePage,
  loadingCarePage,
} = require("../../utils/carePage");
const { mergeFixedMedicineBaseline, summarizeMedicineLibrary } = require("../../utils/medicineLibrary");
const offlinePageCache = require("../../utils/offlinePageCache");

const LIBRARY_CACHE_KEY = "library";

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
      eyebrow: stale ? "已保存药品" : "家庭药库",
      title: "三类药品已整理",
      supporting: catalogOnly
          ? `共 ${summary.medicineCount || 0} 种药品，等待终端同步库存和有效期。`
          : `共 ${summary.medicineCount || 0} 种药品，库存和有效期已同步。`,
        state: { kind: stale ? "muted" : (catalogOnly ? "muted" : "normal"), label: stale ? "可浏览" : (catalogOnly ? "待同步" : "已同步") },
        action: { id: "library.all.focus", label: "查看全部药品" },
        activation: "surface",
      }
      : {
        eyebrow: stale ? "已保存药品" : "家庭药库",
        title: "暂无已入库药品",
        supporting: "仍可查看三个药柜；连接后会自动补充药品资料。",
        state: { kind: "muted", label: "可浏览" },
        action: null,
        activation: "none",
      };

  return composeCarePage({
    key: "medicine-library",
    title: "家庭药库",
    online: device.online === true,
    connection: device.connection,
    focus,
    overview: [
      { key: "library-total", label: "全部药品", value: summary.medicineCount || 0, state: summary.medicineCount ? "actionable" : "muted" },
      { key: "library-cabinet-total", label: "药柜数量", value: summary.cabinetCount || 0, state: summary.cabinetCount ? "normal" : "muted" },
      { key: "library-attention-total", label: "待处理", value: attentionCount, state: attentionCount ? "pending" : "muted" },
      { key: "library-depleted", label: "待补药", value: summary.depletedCount || 0, state: summary.depletedCount ? "pending" : "muted" },
    ],
    sections: [
      {
        key: "library-boxes",
        intent: "inventory",
        title: "三个药柜",
        supporting: "按使用场景分柜存放",
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
    const requestDeviceId = activeDeviceId() || "zykh-qsm-001";
    if (requestDeviceId !== String(this.data.deviceId || "").trim()) {
      this._hasLoadedSnapshot = false;
      this.setData(clearedLibraryScope(requestDeviceId));
    }
    const requestId = Number(this._loadRequestId || 0) + 1;
    this._loadRequestId = requestId;
    if (this._cacheHydratedDeviceId !== requestDeviceId) {
      this._cacheHydratedDeviceId = requestDeviceId;
      const restored = offlinePageCache.restorePage(requestDeviceId, LIBRARY_CACHE_KEY);
      if (restored) {
        this._hasLoadedSnapshot = true;
        this.setData(restored.data);
      }
    }
    try {
      const [deviceRead, medicineRead] = await Promise.all([
        api.getDeviceStrict(requestDeviceId).then(
          value => ({ value, error: null }),
          error => ({
            value: this.data.device && this.data.device.deviceId === requestDeviceId
              ? this.data.device
              : fallbackDevice(requestDeviceId, error.message),
            error,
          }),
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
          carePage: offlinePageCache.markCarePageStale(this.data.carePage, this.data.lastSyncedAtMs),
        });
        return;
      }
      const catalogOnly = !cloudMedicines.length;
      const summary = summarizeMedicineLibrary(medicines);
      const lastSyncedAtMs = Date.now();
      const nextData = {
        deviceId: requestDeviceId,
        device,
        summary,
        hasLoadedSnapshot: true,
        stale,
        offlineSnapshot: false,
        lastSyncedAtMs,
        lastSyncedAtText: offlinePageCache.formatUpdatedAt(lastSyncedAtMs),
        carePage: composeLibraryCarePage(device, summary, { stale, catalogOnly }),
      };
      this._hasLoadedSnapshot = true;
      this.setData(nextData);
      if (!deviceRead.error || !medicineRead.error) {
        offlinePageCache.savePage(requestDeviceId, LIBRARY_CACHE_KEY, nextData, {
          updatedAtMs: lastSyncedAtMs,
          quality: stale ? "partial" : "complete",
        });
      }
    } catch (error) {
      if (requestId !== this._loadRequestId || activeDeviceId() !== requestDeviceId) return;
      console.warn("medicine library loading failed", error);
      if (!this._hasLoadedSnapshot) {
        const device = fallbackDevice(requestDeviceId, error.message);
        const summary = summarizeMedicineLibrary(mergeFixedMedicineBaseline([]));
        this._hasLoadedSnapshot = true;
        this.setData({
          deviceId: requestDeviceId,
          device,
          summary,
          hasLoadedSnapshot: true,
          stale: true,
          carePage: composeLibraryCarePage(device, summary, { stale: true, catalogOnly: true }),
        });
      } else {
        this.setData({
          stale: true,
          carePage: this.data.offlineSnapshot
            ? offlinePageCache.markCarePageStale(this.data.carePage, this.data.lastSyncedAtMs)
            : composeLibraryCarePage(this.data.device, this.data.summary, { stale: true }),
        });
      }
    }
  },

  onCarePageAction(event) {
    const detail = event && event.detail ? event.detail : {};
    const payload = detail.payload || {};
    if (detail.id === "library.retry") {
      const app = getApp();
      if (!activeDeviceId() && app && typeof app.refreshDeviceSession === "function") {
        return Promise.resolve(app.refreshDeviceSession()).then(() => this.load());
      }
      return this.load();
    }
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
