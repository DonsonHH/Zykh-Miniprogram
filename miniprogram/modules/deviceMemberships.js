const {
  evaluateCompatibility,
  projectConnection,
} = require("../utils/connectionState");

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function supportsV1(value) {
  if (value === true || value === 1) return true;
  const version = text(value).toLowerCase();
  return version === "v1" || version === "1" || version.indexOf("v1.") === 0;
}

function stateFor(values = {}) {
  return Object.assign({
    mode: "unknown",
    availability: "error",
    devices: [],
    selectedDeviceId: "",
    canPair: false,
    capabilities: {},
    schemaVersion: "",
    schemaRevision: "",
    compatibility: null,
    message: "",
    error: null,
    pairing: { phase: "idle", message: "" },
  }, values);
}

function textList(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(text).filter(Boolean)))
    : [];
}

function normalizeDevice(value = {}, compatibility = { compatible: true }) {
  const deviceId = text(value.deviceId || value.device_id || value._id);
  if (!deviceId) return null;
  const connection = projectConnection(value, {
    compatible: compatibility.compatible,
    reason: compatibility.compatible === false ? compatibility.reason : "",
  });
  return {
    deviceId,
    name: text(value.name || value.displayName) || "家庭药箱",
    online: connection.online,
    connection,
    connectionState: connection.state,
    lastSeenAt: text(value.lastSeenAt || value.last_seen_at || value.updatedAt),
    lastSeenAtEpochMs: Number(value.lastSeenAtEpochMs || value.last_seen_at_epoch_ms) || 0,
    heartbeatAgeMs: connection.heartbeatAgeMs,
    role: (text(value.role) || "VIEWER").toUpperCase(),
    permissions: textList(value.permissions),
    serviceUserScopes: textList(value.serviceUserScopes || value.service_user_scopes),
    serviceUserGenerations: Object.assign(
      {},
      value.serviceUserGenerations || value.service_user_generations || {},
    ),
  };
}

function authorizedDevicesFrom(response, compatibility = { compatible: true }) {
  const rows = Array.isArray(response)
    ? response
    : (response && Object.prototype.hasOwnProperty.call(response, "items") ? response.items : null);
  if (!Array.isArray(rows)) {
    const error = new Error("authorized device list format is invalid");
    error.code = "DEVICE_LIST_INVALID";
    throw error;
  }
  const devices = rows.map(value => normalizeDevice(value, compatibility));
  if (devices.some(device => !device)) {
    const error = new Error("authorized device row is missing deviceId");
    error.code = "DEVICE_LIST_INVALID";
    throw error;
  }
  const seen = new Set();
  return devices.filter(device => {
    if (seen.has(device.deviceId)) return false;
    seen.add(device.deviceId);
    return true;
  });
}

function createDeviceMembershipModule(gateway = {}) {
  return {
    async resolve(options = {}) {
      let capabilitySnapshot;
      try {
        capabilitySnapshot = await gateway.getCapabilitiesStrict();
      } catch (error) {
        return stateFor({
          mode: "unknown",
          availability: "error",
          message: "暂时无法确认账号可访问的药箱",
          error,
        });
      }
      const capabilities = capabilitySnapshot && capabilitySnapshot.capabilities || {};
      const compatibility = capabilitySnapshot.compatibility || evaluateCompatibility(capabilitySnapshot);
      const schemaVersion = capabilitySnapshot.schemaVersion || capabilitySnapshot.schema_version || "";
      const schemaRevision = capabilitySnapshot.schemaRevision || capabilitySnapshot.schema_revision || "";
      if (!compatibility.compatible) {
        return stateFor({
          mode: "membership",
          availability: "incompatible",
          capabilities,
          schemaVersion,
          schemaRevision,
          compatibility,
          message: compatibility.reason || "云端版本待升级",
        });
      }
      const canPair = supportsV1(capabilities.devicePairing || capabilities.device_pairing);
      let response;
      try {
        response = await gateway.getMyDevicesStrict();
      } catch (error) {
        const code = text(error && error.code).toUpperCase();
        if (code === "CAREGIVER_MEMBERSHIP_REQUIRED") {
          return stateFor({
            mode: "membership",
            availability: canPair ? "unpaired" : "pairing-unavailable",
            canPair,
            capabilities,
            schemaVersion,
            schemaRevision,
            compatibility,
            message: canPair
              ? "当前微信账号尚未配对药箱，请输入一次性配对码"
              : "当前账号尚未获得药箱权限，请联系管理员",
            error,
          });
        }
        if ([
          "CAREGIVER_PERMISSION_DENIED",
          "FORBIDDEN",
          "UNAUTHORIZED",
          "PERMISSION_DENIED",
        ].includes(code)) {
          return stateFor({
            mode: "membership",
            availability: "forbidden",
            canPair,
            capabilities,
            schemaVersion,
            schemaRevision,
            compatibility,
            message: "当前微信账号无权查看已选药箱，可重新配对或联系管理员",
            error,
          });
        }
        return stateFor({
          mode: "membership",
          availability: "error",
          canPair,
          capabilities,
          schemaVersion,
          schemaRevision,
          compatibility,
          message: "授权药箱列表读取失败，请稍后重试",
          error,
        });
      }
      let devices;
      try {
        devices = authorizedDevicesFrom(response, compatibility);
      } catch (error) {
        return stateFor({
          mode: "membership",
          availability: "error",
          canPair,
          capabilities,
          schemaVersion,
          schemaRevision,
          compatibility,
          message: "授权药箱列表格式异常，请稍后重试",
          error,
        });
      }
      const savedDeviceId = text(options.savedDeviceId);
      const selected = devices.find(device => device.deviceId === savedDeviceId) || devices[0];
      return stateFor({
        mode: "membership",
        availability: devices.length ? "ready" : (canPair ? "unpaired" : "pairing-unavailable"),
        devices,
        selectedDeviceId: selected ? selected.deviceId : "",
        canPair,
        capabilities,
        schemaVersion,
        schemaRevision,
        compatibility,
        message: devices.length
          ? ""
          : (canPair ? "当前微信账号尚未配对药箱" : "当前云端未开放自助配对，请联系管理员"),
      });
    },

    async redeem(input = {}) {
      const previousState = input.previousState || {};
      const pairingCode = text(input.pairingCode);
      if (!pairingCode) {
        const error = new Error("pairing code is required");
        error.code = "PAIRING_CODE_REQUIRED";
        return stateFor(Object.assign({}, previousState, {
          error,
          pairing: { phase: "error", message: "请输入一次性配对码" },
        }));
      }
      let result;
      try {
        result = await gateway.redeemDevicePairingCodeStrict(pairingCode);
      } catch (error) {
        const invalidCode = text(error && (error.code || error.message)) === "PAIRING_CODE_INVALID";
        return stateFor(Object.assign({}, previousState, {
          error,
          pairing: {
            phase: "error",
            message: invalidCode ? "配对码无效或已失效，请重新获取" : "配对失败，请稍后重试",
          },
        }));
      }
      const redeemedDeviceId = text(result && (result.deviceId || result.device_id));
      let devices;
      try {
        devices = authorizedDevicesFrom(
          await gateway.getMyDevicesStrict(),
          previousState.compatibility || { compatible: true },
        );
      } catch (error) {
        return stateFor({
          mode: "membership",
          availability: "error",
          devices: [],
          selectedDeviceId: "",
          canPair: previousState.canPair === true,
          capabilities: previousState.capabilities || {},
          schemaVersion: previousState.schemaVersion || "",
          schemaRevision: previousState.schemaRevision || "",
          compatibility: previousState.compatibility || null,
          error,
          message: "配对已提交，但授权药箱列表暂时无法确认",
          pairing: { phase: "error", message: "请重试读取授权药箱" },
        });
      }
      const selected = devices.find(device => device.deviceId === redeemedDeviceId);
      return stateFor({
        mode: "membership",
        availability: selected ? "ready" : "error",
        devices,
        selectedDeviceId: selected ? selected.deviceId : "",
        canPair: previousState.canPair === true,
        capabilities: previousState.capabilities || {},
        schemaVersion: previousState.schemaVersion || "",
        schemaRevision: previousState.schemaRevision || "",
        compatibility: previousState.compatibility || null,
        message: selected ? "" : "配对结果尚未出现在授权药箱列表中",
      });
    },

    select(state = {}, deviceId = "") {
      const requestedDeviceId = text(deviceId);
      const devices = Array.isArray(state.devices) ? state.devices : [];
      const selectableMembership = state.mode === "membership" && state.availability === "ready";
      if (!selectableMembership) {
        const error = new Error("device selection is unavailable until cloud access is resolved");
        error.code = "DEVICE_SELECTION_UNAVAILABLE";
        throw error;
      }
      if (!requestedDeviceId) {
        const error = new Error("device id is required");
        error.code = "DEVICE_ID_REQUIRED";
        throw error;
      }
      if (state.mode === "membership" && !devices.some(device => text(device.deviceId) === requestedDeviceId)) {
        const error = new Error("device is not authorized for the current account");
        error.code = "DEVICE_NOT_AUTHORIZED";
        throw error;
      }
      return Object.assign({}, state, { selectedDeviceId: requestedDeviceId });
    },
  };
}

module.exports = { createDeviceMembershipModule };
