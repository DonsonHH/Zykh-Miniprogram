const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const deviceSession = require("../../utils/deviceSession");
const { expiryView, formatExpiryMonth, normalizeExpiryDate } = require("../../utils/expiry");
const { CABINET_SLOT_COUNT, clampCabinetSlot } = require("../../utils/cabinetSlots");
const cabinetView = require("../../utils/cabinetView");

function activeDeviceId() {
  const app = getApp();
  return String((app && app.globalData && app.globalData.deviceId) || "").trim();
}

function emptyForm() {
  return {
    name: "",
    spec: "",
    // 当前只登记该药品是否仍有库存，库存状态由药箱现场确认后同步。
    quantity: "1",
    expireDate: "",
    expiryPrecision: "month",
  };
}

function inventoryStateFor(medicine = {}, policy = {}) {
  return cabinetView.stockView(medicine, policy);
}

function expiryPrecisionFor(value, explicit) {
  if (explicit === "day" || explicit === "month") return explicit;
  return /^\d{4}-\d{2}-\d{2}$/.test(normalizeExpiryDate(value)) ? "day" : "month";
}

function buildExpiryPreview(value) {
  return Object.assign(
    { expiryMonth: formatExpiryMonth(value) },
    expiryView({ name: "药品", expireDate: value }),
  );
}

function formFromMedicine(current = {}, expiryConflict = false) {
  const expireDate = expiryConflict ? "" : normalizeExpiryDate(current.expireDate || "");
  const expiryPrecision = expiryPrecisionFor(expireDate, current.expiryPrecision || current.expiry_precision);
  return {
    name: current.name || "",
    spec: current.spec || "",
    quantity: current.quantity === 0 ? "0" : current.quantity ? String(current.quantity) : "1",
    expireDate,
    expiryPrecision,
  };
}

function clearedEditorScope(deviceId, slotIndex) {
  const form = emptyForm();
  return {
    deviceId,
    device: {},
    slotIndex,
    currentStep: 1,
    form,
    expiryPickerFields: "month",
    expiryPreview: buildExpiryPreview(""),
    expiryConflict: false,
    baseMedicine: {},
    inventoryPolicy: cabinetView.inventoryPolicyFor(),
    inventoryState: inventoryStateFor(),
    inventoryIntent: "",
    inventoryUpdateStatus: "idle",
    hasLoadedSlot: false,
    initialLoading: true,
    loadError: "",
    isStale: false,
    refreshError: "",
    saving: false,
  };
}

Page({
  data: {
    deviceId: "",
    device: {},
    slots: Array.from({ length: CABINET_SLOT_COUNT }, (_, i) => `${i + 1}号仓`),
    slotIndex: 0,
    currentStep: 1,
    form: emptyForm(),
    expiryPickerFields: "month",
    expiryPreview: buildExpiryPreview(""),
    expiryConflict: false,
    baseMedicine: {},
    inventoryPolicy: cabinetView.inventoryPolicyFor(),
    inventoryState: inventoryStateFor(),
    inventoryIntent: "",
    inventoryUpdateStatus: "idle",
    hasLoadedSlot: false,
    initialLoading: true,
    loadError: "",
    isStale: false,
    refreshError: "",
    saving: false,
  },

  onLoad(options) {
    const slot = clampCabinetSlot(options.slot || 1);
    this._slotLoadGeneration = 0;
    this._slotLoadRequestId = 0;
    this._submitRevision = 0;
    this.setData({
      deviceId: activeDeviceId(),
      slotIndex: slot - 1,
    });
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
      collections: ["medicines"],
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
    if (String(this.data.deviceId || "").trim() === nextDeviceId) return false;
    this._slotLoadGeneration = Number(this._slotLoadGeneration || 0) + 1;
    this._slotLoadRequestId = Number(this._slotLoadRequestId || 0) + 1;
    this._submitRevision = Number(this._submitRevision || 0) + 1;
    this.setData(clearedEditorScope(nextDeviceId, Number(this.data.slotIndex || 0)));
    return true;
  },

  isDeviceScopeCurrent(requestDeviceId) {
    const expectedDeviceId = String(requestDeviceId || "").trim();
    return String(this.data.deviceId || "").trim() === expectedDeviceId &&
      activeDeviceId() === expectedDeviceId;
  },

  isEditorReady() {
    return this.data.hasLoadedSlot === true &&
      this.data.initialLoading !== true &&
      !this.data.loadError &&
      this.isDeviceScopeCurrent(this.data.deviceId);
  },

  async load() {
    const requestDeviceId = activeDeviceId();
    this.prepareDeviceScope(requestDeviceId);
    const slotIndex = this.data.slotIndex;
    const generation = Number(this._slotLoadGeneration || 0);
    const loadRequestId = Number(this._slotLoadRequestId || 0) + 1;
    this._slotLoadRequestId = loadRequestId;
    const needsInitialSnapshot = !this.data.hasLoadedSlot;
    if (needsInitialSnapshot && !this.data.initialLoading) this.setData({ initialLoading: true });
    try {
      const [device, cabinetSlots, inventoryPolicy] = await Promise.all([
        api.getDevice(requestDeviceId),
        api.getCabinetSlotsStrict(requestDeviceId),
        api.getCapabilitiesStrict(requestDeviceId)
          .then(cabinetView.inventoryPolicyFor)
          .catch(error => {
            console.warn("medicine editor inventory capability read failed", error);
            return cabinetView.inventoryPolicyFor();
          }),
      ]);
      if (loadRequestId !== this._slotLoadRequestId ||
          slotIndex !== this.data.slotIndex ||
          generation !== Number(this._slotLoadGeneration || 0) ||
          !this.isDeviceScopeCurrent(requestDeviceId)) return;
      const current = cabinetSlots[slotIndex] || {};
      const shouldFill = !this.data.hasLoadedSlot && current.name;
      const expiryConflict = shouldFill ? Boolean(current.expiryConflict) : this.data.expiryConflict;
      const nextForm = shouldFill ? formFromMedicine(current, expiryConflict) : this.data.form;
      const expiryPrecision = nextForm.expiryPrecision;
      const nextInventoryState = inventoryStateFor(current, inventoryPolicy);
      const refillConfirmed = this.data.inventoryIntent === "STOCKED"
        && nextInventoryState.inventoryState === "STOCKED";
      this.setData({
        deviceId: requestDeviceId,
        device,
        form: nextForm,
        expiryPickerFields: expiryPrecision === "day" ? "day" : "month",
        expiryPreview: buildExpiryPreview(nextForm.expireDate),
        expiryConflict,
        baseMedicine: shouldFill ? current : this.data.baseMedicine,
        inventoryPolicy,
        inventoryState: nextInventoryState,
        inventoryIntent: refillConfirmed ? "" : this.data.inventoryIntent,
        inventoryUpdateStatus: refillConfirmed ? "succeeded" : this.data.inventoryUpdateStatus,
        hasLoadedSlot: true,
        loadError: "",
        isStale: false,
        refreshError: "",
      });
    } catch (error) {
      if (loadRequestId !== this._slotLoadRequestId ||
          slotIndex !== this.data.slotIndex ||
          generation !== Number(this._slotLoadGeneration || 0) ||
          !this.isDeviceScopeCurrent(requestDeviceId)) return;
      console.warn("medicine slot loading failed", error);
      if (needsInitialSnapshot && !this.data.hasLoadedSlot) {
        this.setData({
          loadError: "仓位数据读取失败，当前无法判断这里是否已有药品。",
        });
      } else if (this.data.hasLoadedSlot) {
        this.setData({
          isStale: true,
          refreshError: "显示的是上次成功读取的仓位数据；本次刷新失败，请重新读取后再提交。",
          loadError: "",
        });
      }
    } finally {
      if (needsInitialSnapshot &&
          loadRequestId === this._slotLoadRequestId &&
          slotIndex === this.data.slotIndex &&
          generation === Number(this._slotLoadGeneration || 0) &&
          this.isDeviceScopeCurrent(requestDeviceId)) {
        this.setData({ initialLoading: false });
      }
    }
  },

  retryLoad() {
    if (this.data.initialLoading) return;
    if (!this.data.hasLoadedSlot) {
      this.setData({ initialLoading: true, loadError: "" });
    } else {
      this.setData({
        isStale: true,
        refreshError: "正在重新读取仓位数据…",
      });
    }
    return this.load();
  },

  onInput(e) {
    if (!this.isEditorReady()) return;
    const key = e.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: e.detail.value });
  },

  nextStep() {
    if (!this.isEditorReady()) return;
    const currentStep = Number(this.data.currentStep) || 1;
    const form = this.data.form || {};
    if (currentStep === 1 && !String(form.name || "").trim()) {
      wx.showToast({ title: "请输入药名", icon: "none" });
      return;
    }
    if (currentStep === 2 && !normalizeExpiryDate(form.expireDate)) {
      wx.showToast({ title: "请选择有效期", icon: "none" });
      return;
    }
    this.setData({ currentStep: Math.min(3, currentStep + 1) });
  },

  previousStep() {
    if (!this.isEditorReady()) return;
    const currentStep = Number(this.data.currentStep) || 1;
    this.setData({ currentStep: Math.max(1, currentStep - 1) });
  },

  onSlotChange(e) {
    this._slotLoadGeneration = (this._slotLoadGeneration || 0) + 1;
    this._slotLoadRequestId = (this._slotLoadRequestId || 0) + 1;
    this._submitRevision = (this._submitRevision || 0) + 1;
    this.setData({
      slotIndex: Number(e.detail.value),
      currentStep: 1,
      form: emptyForm(),
      expiryPickerFields: "month",
      expiryPreview: buildExpiryPreview(""),
      expiryConflict: false,
      baseMedicine: {},
      inventoryState: inventoryStateFor(),
      inventoryIntent: "",
      inventoryUpdateStatus: "idle",
      hasLoadedSlot: false,
      initialLoading: true,
      loadError: "",
      isStale: false,
      refreshError: "",
    });
    this.load();
  },

  onExpiryPrecisionChange(e) {
    if (!this.isEditorReady()) return;
    const expiryPrecision = e.currentTarget.dataset.precision === "day" ? "day" : "month";
    if (expiryPrecision === this.data.form.expiryPrecision) return;
    const current = normalizeExpiryDate(this.data.form.expireDate);
    if (expiryPrecision === "month" && /^\d{4}-\d{2}-\d{2}$/.test(current)) {
      const requestDeviceId = String(this.data.deviceId || "").trim();
      const slotIndex = this.data.slotIndex;
      const generation = Number(this._slotLoadGeneration || 0);
      wx.showModal({
        title: "切换为按月份",
        content: "该操作会把精确日期改为月份。请确认包装只标注到月份。",
        confirmText: "确认切换",
        success: result => {
          if (result.confirm &&
              slotIndex === this.data.slotIndex &&
              generation === Number(this._slotLoadGeneration || 0) &&
              this.isDeviceScopeCurrent(requestDeviceId)) {
            this.applyExpiryPrecision(expiryPrecision, current);
          }
        },
      });
      return;
    }
    this.applyExpiryPrecision(expiryPrecision, current);
  },

  applyExpiryPrecision(expiryPrecision, current = normalizeExpiryDate(this.data.form.expireDate)) {
    if (!this.isEditorReady()) return;
    const expireDate = expiryPrecision === "month"
      ? formatExpiryMonth(current)
      : /^\d{4}-\d{2}$/.test(current) ? "" : current;
    this.setData({
      "form.expiryPrecision": expiryPrecision,
      "form.expireDate": expireDate,
      expiryPickerFields: expiryPrecision === "day" ? "day" : "month",
      expiryPreview: buildExpiryPreview(expireDate),
      expiryConflict: false,
    });
  },

  onDateChange(e) {
    if (!this.isEditorReady()) return;
    const expireDate = normalizeExpiryDate(e.detail.value);
    this.setData({
      "form.expireDate": expireDate,
      expiryPreview: buildExpiryPreview(expireDate),
      expiryConflict: false,
    });
  },

  clearForm() {
    if (!this.isEditorReady()) return;
    const requestDeviceId = String(this.data.deviceId || "").trim();
    const slotIndex = this.data.slotIndex;
    const generation = Number(this._slotLoadGeneration || 0);
    const canApplyReset = () => slotIndex === this.data.slotIndex &&
      generation === Number(this._slotLoadGeneration || 0) &&
      this.isEditorReady() &&
      this.isDeviceScopeCurrent(requestDeviceId);
    const baseMedicine = this.data.baseMedicine || {};
    const hasSyncedMedicine = Boolean(baseMedicine.name);
    const restoredConflict = hasSyncedMedicine && Boolean(baseMedicine.expiryConflict);
    const restoredForm = hasSyncedMedicine ? formFromMedicine(baseMedicine, restoredConflict) : emptyForm();
    const reset = () => {
      if (!canApplyReset()) return;
      this.setData({
        form: restoredForm,
        expiryPickerFields: restoredForm.expiryPrecision === "day" ? "day" : "month",
        expiryPreview: buildExpiryPreview(restoredForm.expireDate),
        expiryConflict: restoredConflict,
        baseMedicine: hasSyncedMedicine ? baseMedicine : {},
        inventoryState: inventoryStateFor(baseMedicine, this.data.inventoryPolicy),
        inventoryIntent: "",
        inventoryUpdateStatus: "idle",
      });
    };
    const form = this.data.form || {};
    const initial = hasSyncedMedicine ? formFromMedicine(baseMedicine, restoredConflict) : emptyForm();
    const hasDraft = Object.keys(form).some(key => String(form[key] || "").trim() !== String(initial[key] || "").trim());
    if (!hasDraft) {
      reset();
      return;
    }
    wx.showModal({
      title: "重置未保存修改",
      content: "这会恢复进入页面时的内容，不会改变药箱中已同步的药品。",
      confirmText: "重置",
      success: result => {
        if (result.confirm) reset();
      },
    });
  },

  markRefilled() {
    if (!this.isEditorReady() || this.data.saving) return;
    this.setData({
      "form.quantity": "1",
      inventoryIntent: "STOCKED",
      inventoryUpdateStatus: "draft",
    });
  },

  async submit() {
    const requestDeviceId = activeDeviceId();
    if (String(this.data.deviceId || "").trim() !== requestDeviceId) {
      this.prepareDeviceScope(requestDeviceId);
      this.load();
      wx.showToast({ title: "药箱已切换，正在重新读取", icon: "none" });
      return;
    }
    if (this.data.isStale) {
      wx.showToast({ title: "数据待刷新，请重新读取后再提交", icon: "none" });
      return;
    }
    if (!this.isEditorReady() || this.data.saving) return;
    const form = this.data.form;
    if (!form.name.trim()) {
      this.setData({ currentStep: 1 });
      wx.showToast({ title: "请输入药名", icon: "none" });
      return;
    }
    const expireDate = normalizeExpiryDate(form.expireDate);
    if (!expireDate) {
      this.setData({ currentStep: 2 });
      wx.showToast({ title: "请选择有效期", icon: "none" });
      return;
    }
    const quantityText = String(form.quantity === 0 ? "0" : form.quantity || "").trim();
    const quantity = Number(quantityText);
    if (!quantityText || !Number.isInteger(quantity) || quantity < 0) {
      wx.showToast({ title: "库存请填写不小于 0 的整数", icon: "none" });
      return;
    }
    const slot = this.data.slotIndex + 1;
    const submitRevision = Number(this._submitRevision || 0) + 1;
    this._submitRevision = submitRevision;
    this.setData({ saving: true });
    wx.showLoading({ title: "正在提交", mask: true });
    try {
      const inventoryIntent = String(this.data.inventoryIntent || "").trim().toUpperCase();
      const submittedForm = {
        slot,
        name: form.name.trim(),
        spec: form.spec.trim(),
        quantity,
        expireDate,
        expiryPrecision: form.expiryPrecision,
      };
      if (inventoryIntent && this.data.inventoryPolicy.explicitInventoryStateSupported === true) {
        submittedForm.inventoryState = inventoryIntent;
      }
      await api.saveMedicine(submittedForm, this.data.baseMedicine);
      wx.hideLoading();
      if (submitRevision !== this._submitRevision || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      if (inventoryIntent) {
        this.setData({ inventoryUpdateStatus: "pending" });
        wx.showToast({
          title: "已提交，等待药箱确认",
          icon: "none",
        });
        return;
      }
      wx.showToast({ title: "已提交，等待药箱同步", icon: "success" });
      setTimeout(() => wx.switchTab({ url: "/pages/cabinet/index" }), 900);
    } catch (error) {
      wx.hideLoading();
      if (submitRevision !== this._submitRevision || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      console.warn("medicine command submission failed", error);
      if (this.data.inventoryIntent) this.setData({ inventoryUpdateStatus: "failed" });
      wx.showToast({ title: "提交失败，请重试", icon: "none" });
    } finally {
      if (submitRevision === this._submitRevision && this.isDeviceScopeCurrent(requestDeviceId)) {
        this.setData({ saving: false });
      }
    }
  },
});
