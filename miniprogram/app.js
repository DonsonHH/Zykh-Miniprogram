const api = require("./utils/api");
const { createDeviceMembershipModule } = require("./modules/deviceMemberships");
const { projectConnection } = require("./utils/connectionState");

const CLOUD_ENV = "cloud1-d6gv6t2jf3f2c541c";

function loadingDeviceSession() {
  return {
    mode: "unknown",
    availability: "loading",
    devices: [],
    selectedDeviceId: "",
    canPair: false,
    capabilities: {},
    schemaVersion: "",
    schemaRevision: "",
    compatibility: null,
    connection: projectConnection({}, { loading: true }),
    message: "正在确认当前账号可访问的药箱",
    pairing: { phase: "idle", message: "" },
  };
}

App({
  onLaunch() {
    const savedDeviceId = wx.getStorageSync("deviceId") || "";
    this.globalData = {
      env: CLOUD_ENV,
      deviceId: "",
      deviceSession: loadingDeviceSession(),
      deviceSessionResolved: false,
      deviceSessionReady: null,
    };

    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      const error = new Error("cloud runtime unavailable");
      this.globalData.deviceSession = Object.assign(loadingDeviceSession(), {
        availability: "error",
        message: "当前微信版本暂时无法连接药箱",
        error,
      });
      this.globalData.deviceSessionResolved = true;
      this.globalData.deviceSessionReady = Promise.resolve(this.globalData.deviceSession);
      return;
    }

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true,
    });

    this._deviceMemberships = createDeviceMembershipModule({
      getCapabilitiesStrict: api.getCapabilitiesStrict,
      getMyDevicesStrict: api.getMyDevicesStrict,
      redeemDevicePairingCodeStrict: api.redeemDevicePairingCodeStrict,
    });
    this.globalData.deviceSessionReady = this._deviceMemberships.resolve({ savedDeviceId })
      .then(state => this.applyDeviceSession(state));
  },

  applyDeviceSession(state = loadingDeviceSession()) {
    const requestedDeviceId = String(state.selectedDeviceId || "").trim();
    const devices = Array.isArray(state.devices) ? state.devices : [];
    const membershipSelectionIsAuthorized = state.mode === "membership"
      && state.availability === "ready"
      && devices.some(device => String(device && device.deviceId || "").trim() === requestedDeviceId);
    const selectedDeviceId = membershipSelectionIsAuthorized
      ? requestedDeviceId
      : "";
    const selectedDevice = devices.find(device => String(device && device.deviceId || "").trim() === selectedDeviceId);
    const resolvedBase = selectedDeviceId === requestedDeviceId
      ? state
      : Object.assign({}, state, { selectedDeviceId: "" });
    const resolvedState = Object.assign({}, resolvedBase, {
      connection: selectedDevice && selectedDevice.connection
        ? selectedDevice.connection
        : projectConnection({}, {
          availability: resolvedBase.availability,
          compatible: resolvedBase.compatibility
            ? resolvedBase.compatibility.compatible
            : undefined,
          reason: resolvedBase.message,
        }),
    });
    this.globalData.deviceSession = resolvedState;
    this.globalData.deviceId = selectedDeviceId;
    this.globalData.deviceSessionResolved = true;

    if (selectedDeviceId) {
      wx.setStorageSync("deviceId", selectedDeviceId);
    } else if (resolvedState.mode === "membership") {
      wx.removeStorageSync("deviceId");
    }
    return resolvedState;
  },

  waitForDeviceSession() {
    if (this.globalData && this.globalData.deviceSessionReady) {
      return this.globalData.deviceSessionReady;
    }
    return Promise.resolve(this.globalData && this.globalData.deviceSession);
  },

  refreshDeviceSession() {
    if (!this._deviceMemberships) return this.waitForDeviceSession();
    const savedDeviceId = wx.getStorageSync("deviceId") || "";
    this.globalData.deviceSessionResolved = false;
    this.globalData.deviceSession = loadingDeviceSession();
    this.globalData.deviceId = "";
    const ready = this._deviceMemberships.resolve({ savedDeviceId })
      .then(state => this.applyDeviceSession(state));
    this.globalData.deviceSessionReady = ready;
    return ready;
  },

  selectAuthorizedDevice(deviceId) {
    if (!this._deviceMemberships) {
      const error = new Error("device access has not been initialized");
      error.code = "DEVICE_SELECTION_UNAVAILABLE";
      throw error;
    }
    const state = this._deviceMemberships.select(this.globalData.deviceSession, deviceId);
    return this.applyDeviceSession(state);
  },

  async redeemDevicePairingCode(pairingCode) {
    if (!this._deviceMemberships) {
      const error = new Error("device pairing has not been initialized");
      error.code = "DEVICE_PAIRING_UNAVAILABLE";
      throw error;
    }
    const state = await this._deviceMemberships.redeem({
      pairingCode,
      previousState: this.globalData.deviceSession,
    });
    return this.applyDeviceSession(state);
  },
});
