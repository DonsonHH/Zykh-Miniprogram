const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const { runAfterDeviceSessionReady } = require("../../utils/deviceSession");
const vitalsAttribution = require("../../modules/vitalsAttribution");

const CARE_STATE_BY_MEASUREMENT = {
  danger: "risk",
  warn: "pending",
  good: "normal",
  muted: "muted",
};

function displayValue(value) {
  return value === undefined || value === null || value === "" ? "--" : String(value);
}

function vitalTimestamp(vitals = {}) {
  const fields = ["createdAt", "created_at", "measuredAt", "measured_at", "time", "updatedAt", "updated_at"];
  for (let i = 0; i < fields.length; i += 1) {
    const value = vitals[fields[i]];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function contextualDateTime(value, emptyLabel = "暂无测量数据") {
  if (value === undefined || value === null || value === "") return emptyLabel;
  const source = String(value).trim();
  if (!source) return emptyLabel;
  const dateSource = source.indexOf("T") >= 0 ? source : source.replace(/-/g, "/");
  const timestamp = Date.parse(dateSource);
  if (!Number.isFinite(timestamp)) return source.slice(0, 16);

  const date = new Date(timestamp);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (isToday) return `今天 ${time}`;

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${time}`;

  const dateLabel = `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  return date.getFullYear() === now.getFullYear() ? dateLabel : `${date.getFullYear()}年${dateLabel}`;
}

function statusView(status) {
  const map = {
    pending: { text: "等待药箱", cls: "warn" },
    running: { text: "测量中", cls: "warn" },
    done: { text: "已完成", cls: "ok" },
    failed: { text: "失败", cls: "bad" },
  };
  return map[status] || { text: status || "暂无", cls: "idle" };
}

function vitalValueAvailable(value) {
  return value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
}

function measurementView(vitals) {
  if (!vitals) {
    return {
      label: "暂无数据",
      cls: "muted",
      hint: "等待药箱上传测量结果",
      showValues: false,
    };
  }

  const quality = String(vitals.quality || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const availableValues = [vitals.heartRate, vitals.spo2, vitals.bodyTemp].filter(vitalValueAvailable).length;
  const failedQualities = ["error", "failed", "failure", "unavailable", "no_finger", "sensor_error", "invalid"];
  const partialQualities = ["partial", "poor_signal", "weak_signal", "low_signal"];

  if (failedQualities.indexOf(quality) >= 0) {
    return {
      label: "测量异常",
      cls: "danger",
      hint: quality === "no_finger" ? "未检测到手指，请重新测量" : "传感器未就绪或测量失败",
      showValues: false,
    };
  }
  if (partialQualities.indexOf(quality) >= 0 || availableValues < 3) {
    if (!availableValues) {
      return {
        label: "测量异常",
        cls: "danger",
        hint: "测量数据不可用，请重新测量",
        showValues: false,
      };
    }
    const poorSignal = quality.indexOf("signal") >= 0;
    return {
      label: poorSignal ? "信号不稳" : "部分数据",
      cls: "warn",
      hint: poorSignal ? "测量信号不稳，建议重新测量" : "仅同步部分测量数据，建议重新测量",
      showValues: true,
    };
  }
  return {
    label: "已同步",
    cls: "good",
    hint: "最近一次有效测量",
    showValues: true,
  };
}

function compactMeasurementTarget(user = {}) {
  const personId = String(user.id || user.personId || user.person_id || "").trim();
  const personaGeneration = String(
    user.personaGeneration || user.persona_generation || "",
  ).trim();
  if (!personId || !personaGeneration || user.archived === true) return null;
  return {
    personId,
    name: String(user.name || user.personName || user.person_name || "已登记人员").trim(),
    personaGeneration,
  };
}

function measurementTargetContext(app, deviceId, serviceUsers = [], previousTarget = null) {
  const globalData = app && app.globalData || {};
  const session = globalData.deviceSession || {};
  const membershipDevice = session.mode === "membership" && session.availability === "ready"
    ? (session.devices || []).find(item => (
      String(item && (item.deviceId || item.device_id) || "").trim() === String(deviceId || "").trim()
    ))
    : null;
  const scopes = membershipDevice
    ? (membershipDevice.serviceUserScopes || membershipDevice.service_user_scopes || [])
      .map(value => String(value || "").trim())
      .filter(Boolean)
    : [];
  const required = scopes.length > 0;
  if (!required) return { required: false, targets: [], selected: null };
  const allowed = new Set(scopes);
  const targets = serviceUsers
    .map(compactMeasurementTarget)
    .filter(target => target && allowed.has(target.personId));
  const previous = previousTarget || {};
  const selected = targets.find(target => (
    target.personId === String(previous.personId || "").trim()
    && target.personaGeneration === String(previous.personaGeneration || "").trim()
  )) || (targets.length === 1 ? targets[0] : null);
  return { required: true, targets, selected };
}

function composeVitalsCarePage(
  device,
  vitals,
  vitalsView,
  measuring = false,
  stale = false,
  commandStatusKnown = true,
  commandInFlight = false,
  measurementTargets = [],
  selectedMeasurementTarget = null,
  measurementTargetRequired = false,
) {
  const stateKind = CARE_STATE_BY_MEASUREMENT[vitalsView.measurementStatusClass] || "muted";
  const available = value => value !== "--";
  const fact = (key, label, value, unit) => ({
    key,
    label,
    value,
    unit,
    state: available(value) ? stateKind : "muted",
  });

  let focusTitle = "还没有测量记录";
  let actionLabel = "请求测量";
  if (vitals && stateKind === "risk") {
    focusTitle = "最近测量需要重新确认";
    actionLabel = "重新测量";
  } else if (vitals && stateKind === "pending") {
    focusTitle = "最近测量建议重新测量";
    actionLabel = "重新测量";
  } else if (vitals) {
    focusTitle = "最近测量已同步";
    actionLabel = "再次测量";
  }

  const focusSupporting = [
    stale ? "刷新失败，当前结果可能不是最新" : "",
    vitalsView.timeLabel,
    vitals ? `测量对象：${vitalsView.personName}` : "",
    measurementTargetRequired
      ? (selectedMeasurementTarget
        ? `本次将归入：${selectedMeasurementTarget.name}`
        : "请先选择本次测量对象")
      : "",
    vitalsView.sensorHint,
  ].filter(Boolean).join(" · ");

  const requestBlocked = measuring
    || !commandStatusKnown
    || commandInFlight
    || (measurementTargetRequired && !selectedMeasurementTarget);
  const requestLabel = measuring
    ? "请求中…"
    : (!commandStatusKnown
      ? "状态暂不可用"
      : (commandInFlight
        ? "请求处理中…"
        : (measurementTargetRequired && !selectedMeasurementTarget ? "先选择测量对象" : actionLabel)));

  const sections = [];
  if (measurementTargetRequired) {
    sections.push({
      key: "vitals-target",
      intent: "people",
      title: "本次测量对象",
      supporting: measurementTargets.length
        ? "测量结果只会归入所选家人，点击一行即可选择。"
        : "当前人物资料暂不可用，暂不能发起远程测量。",
      items: measurementTargets.map((target, index) => {
        const selected = selectedMeasurementTarget
          && selectedMeasurementTarget.personId === target.personId
          && selectedMeasurementTarget.personaGeneration === target.personaGeneration;
        return {
          key: `vitals-target-${target.personId}-${target.personaGeneration}`,
          symbol: "person",
          title: target.name,
          supporting: selected ? "本次测量结果将归入这位家人" : "点击选择为本次测量对象",
          state: {
            kind: selected ? "normal" : "muted",
            label: selected ? "已选择" : "选择",
          },
          action: {
            id: `vitals.target.${index}`,
            label: `选择${target.name}作为测量对象`,
            payload: target,
          },
        };
      }),
    });
  }
  sections.push({
    key: "vitals-device-state",
    intent: "device",
    title: "测量状态",
    supporting: vitalsView.actionFootnote,
    items: [{
      key: "vitals-device-detail",
      symbol: "device",
      title: vitalsView.deviceStatusLabel,
      supporting: `最近请求：${vitalsView.commandStatusLabel}`,
      meta: vitals ? `${vitalsView.timeLabel} · ${vitalsView.personName}` : "等待首次测量",
      state: {
        kind: device && device.online ? "normal" : "pending",
        label: device && device.online ? "在线" : "离线",
      },
      action: {
        id: "vitals.details",
        label: "查看测量与设备详情",
      },
    }],
  });

  return composeCarePage({
    key: "vitals",
    title: "健康测量",
    online: Boolean(device && device.online),
    focus: {
      eyebrow: "最近一次测量",
      title: focusTitle,
      supporting: focusSupporting,
      state: {
        kind: stateKind,
        label: vitalsView.measurementStatusLabel,
      },
      action: {
        id: "vitals.measure",
        label: requestLabel,
        disabled: requestBlocked,
      },
    },
    overview: [
      fact("vitals-heart-rate", "心率", vitalsView.heartRate, "bpm"),
      fact("vitals-oxygen", "血氧", vitalsView.spo2, "%"),
      fact("vitals-temperature", "体温", vitalsView.bodyTemp, "℃"),
    ],
    sections,
  });
}

function vitalsErrorCarePage(device) {
  return composeCarePage({
    key: "vitals-error",
    title: "健康测量",
    online: Boolean(device && device.online),
    phase: {
      kind: "error",
      message: "测量数据读取失败，请检查网络后重新加载。",
      action: {
        id: "vitals.retry",
        label: "重新加载测量数据",
      },
    },
  });
}

function measurementDetailRows(device, vitals, command, attribution = {}, capabilitySnapshot = {}) {
  const rows = [
    { key: "time", label: "测量时间", value: contextualDateTime(vitalTimestamp(vitals), "暂无") },
    { key: "person", label: "测量对象", value: attribution.label || "未登记人员（旧记录）" },
    { key: "quality", label: "测量质量", value: vitals.quality || "未上报" },
    { key: "command", label: "请求状态", value: command.statusText || "暂无" },
    {
      key: "updated",
      label: "更新时间",
      value: contextualDateTime(
        command.updatedAt || command.updated_at || command.createdAt || command.created_at,
        "暂无",
      ),
    },
    { key: "device", label: "药箱状态", value: device && device.online ? "在线" : "离线" },
  ];
  if (attribution.kind === "BROKEN_INQUIRY") {
    const capabilities = capabilitySnapshot.capabilities || {};
    rows.push(
      { key: "record-id", label: "记录编号", value: attribution.recordId || "未同步" },
      { key: "inquiry-session", label: "问询会话", value: attribution.inquirySessionId || "未同步" },
      { key: "attribution-source", label: "归属来源", value: attribution.attributionSource || "未同步" },
      { key: "attribution-capability", label: "归属能力", value: capabilities.vitalsAttribution || capabilities.vitals_attribution || "未声明" },
      { key: "schema-revision", label: "云端版本", value: capabilitySnapshot.schemaRevision || capabilitySnapshot.schema_revision || "未同步" },
    );
  }
  return rows;
}

function emptyVitalsView() {
  return {
    heartRate: "--",
    spo2: "--",
    bodyTemp: "--",
    quality: "unknown",
    timeLabel: "暂无测量数据",
    personName: "未登记人员",
    attributionKind: "",
    sensorHint: "等待上传",
    deviceStatusLabel: "等待药箱连接",
    commandStatusLabel: "暂无测量指令",
    measurementStatusLabel: "暂无数据",
    measurementStatusClass: "muted",
    actionFootnote: "用于家庭记录；持续异常请咨询专业医生。",
  };
}

Page({
  data: {
    carePage: loadingCarePage("健康测量", "正在读取最近测量…"),
    deviceId: "",
    device: {},
    vitals: null,
    vitalsAttribution: null,
    capabilitySnapshot: {},
    vitalsView: emptyVitalsView(),
    latestCommand: {},
    commands: [],
    commandStatusKnown: false,
    commandInFlight: false,
    measurementTargets: [],
    selectedMeasurementTarget: null,
    measurementTargetRequired: false,
    measuring: false,
    stale: false,
    detailVisible: false,
    detailRows: [],
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
      collections: ["devices", "vitals", "commands"],
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
    const app = getApp();
    const requestDeviceId = String((app && app.globalData && app.globalData.deviceId) || "").trim();
    const loadRequestId = Number(this._loadRequestId || 0) + 1;
    this._loadRequestId = loadRequestId;
    if (String(this.data.deviceId || "").trim() !== requestDeviceId) {
      this._hasLoadedVitals = false;
      this._measureRequestId = Number(this._measureRequestId || 0) + 1;
      this.setData({
        carePage: loadingCarePage("健康测量", "正在读取当前药箱的最近测量…"),
        deviceId: requestDeviceId,
        device: {},
        vitals: null,
        vitalsAttribution: null,
        capabilitySnapshot: {},
        vitalsView: emptyVitalsView(),
        latestCommand: {},
        commands: [],
        commandStatusKnown: false,
        commandInFlight: false,
        measurementTargets: [],
        selectedMeasurementTarget: null,
        measurementTargetRequired: false,
        measuring: false,
        stale: false,
        detailVisible: false,
        detailRows: [],
      });
    }
    try {
      const [device, vitals, commandRead, snapshotRead, capabilityRead] = await Promise.all([
        api.getDevice(requestDeviceId),
        api.getLatestVitalsStrict(requestDeviceId),
        api.getRecentCommandsStrict(12, requestDeviceId).then(
          commands => ({ commands, known: true }),
          error => ({ commands: [], known: false, error }),
        ),
        api.getSnapshotStrict({ inquiryLimit: 1, deviceId: requestDeviceId }).then(
          snapshot => ({ snapshot }),
          error => ({ snapshot: { serviceUsers: [] }, error }),
        ),
        api.getCapabilitiesStrict(requestDeviceId).then(
          capabilitySnapshot => ({ capabilitySnapshot }),
          error => ({ capabilitySnapshot: {}, error }),
        ),
      ]);
      if (loadRequestId !== this._loadRequestId || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      if (commandRead.error) console.warn("vitals command status read failed", commandRead.error);
      const measureCommands = commandRead.commands
        .filter(item => item.type === "READ_VITALS_ALL")
        .map(item => {
          const status = statusView(item.status);
          return Object.assign({}, item, {
            userText: "远程测量体征",
            statusText: status.text,
            statusClass: status.cls,
          });
        });
      const latestCommand = commandRead.known
        ? (measureCommands[0] || {})
        : { statusText: "请求状态暂不可用", statusClass: "idle" };
      const commandInFlight = commandRead.known
        && ["pending", "running"].indexOf(String(latestCommand.status || "").toLowerCase()) >= 0;
      const targetContext = measurementTargetContext(
        app,
        requestDeviceId,
        snapshotRead.snapshot.serviceUsers || [],
        this.data.selectedMeasurementTarget,
      );
      const measurement = measurementView(vitals);
      const attribution = vitals
        ? vitalsAttribution.classifyVitalsAttribution(vitals, {
          activeUsers: snapshotRead.snapshot.serviceUsers || [],
          attributionSupported: vitalsAttribution.supportsVitalsAttribution(
            capabilityRead.capabilitySnapshot,
          ),
        })
        : null;
      const measuredAt = vitalTimestamp(vitals || {});
      const vitalsView = {
        heartRate: vitals && measurement.showValues ? displayValue(vitals.heartRate) : "--",
        spo2: vitals && measurement.showValues ? displayValue(vitals.spo2) : "--",
        bodyTemp: vitals && measurement.showValues ? displayValue(vitals.bodyTemp) : "--",
        quality: vitals ? displayValue(vitals.quality) : "unknown",
        timeLabel: vitals ? contextualDateTime(measuredAt, "测量时间未记录") : "暂无测量数据",
        personName: attribution ? attribution.label : "未登记人员",
        attributionKind: attribution ? attribution.kind : "",
        sensorHint: measurement.hint,
        deviceStatusLabel: device && device.online ? "药箱在线" : "药箱离线",
        commandStatusLabel: commandRead.known
          ? (latestCommand.statusText || (vitals ? "暂无测量指令" : "等待测量"))
          : "请求状态暂不可用",
        measurementStatusLabel: measurement.label,
        measurementStatusClass: measurement.cls,
        actionFootnote: device && device.online
          ? "用于家庭记录；持续异常请咨询专业医生。"
          : "药箱上线后执行；持续异常请咨询专业医生。",
      };
      this.setData({
        deviceId: requestDeviceId,
        device,
        vitals,
        vitalsAttribution: attribution,
        capabilitySnapshot: capabilityRead.capabilitySnapshot,
        vitalsView,
        stale: false,
        carePage: composeVitalsCarePage(
          device,
          vitals,
          vitalsView,
          this.data.measuring,
          false,
          commandRead.known,
          commandInFlight,
          targetContext.targets,
          targetContext.selected,
          targetContext.required,
        ),
        latestCommand,
        commands: measureCommands.slice(0, 6),
        commandStatusKnown: commandRead.known,
        commandInFlight,
        measurementTargets: targetContext.targets,
        selectedMeasurementTarget: targetContext.selected,
        measurementTargetRequired: targetContext.required,
        detailRows: this.data.detailVisible
          ? measurementDetailRows(
            device,
            vitals || {},
            latestCommand,
            attribution || {},
            capabilityRead.capabilitySnapshot,
          )
          : this.data.detailRows,
      });
      this._hasLoadedVitals = true;
    } catch (error) {
      if (loadRequestId !== this._loadRequestId || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      console.warn("vitals read failed", error);
      if (this._hasLoadedVitals && String(this.data.deviceId || "").trim() === requestDeviceId) {
        this.setData({
          stale: true,
          carePage: composeVitalsCarePage(
            this.data.device,
            this.data.vitals,
            this.data.vitalsView,
            this.data.measuring,
            true,
            this.data.commandStatusKnown,
            this.data.commandInFlight,
            this.data.measurementTargets,
            this.data.selectedMeasurementTarget,
            this.data.measurementTargetRequired,
          ),
        });
      } else {
        this.setData({ carePage: vitalsErrorCarePage(this.data.device) });
      }
    }
  },

  retryLoad() {
    this.setData({
      carePage: loadingCarePage("健康测量", "正在重新读取最近测量…"),
    });
    return this.load();
  },

  isDeviceScopeCurrent(deviceId) {
    const scopeDeviceId = String(deviceId || "").trim();
    const app = getApp();
    const activeDeviceId = String((app && app.globalData && app.globalData.deviceId) || "").trim();
    return Boolean(scopeDeviceId)
      && scopeDeviceId === String(this.data.deviceId || "").trim()
      && scopeDeviceId === activeDeviceId;
  },

  async readAll() {
    if (this.data.measuring) return;
    const requestDeviceId = String(this.data.deviceId || "").trim();
    if (!this.isDeviceScopeCurrent(requestDeviceId)) {
      wx.showToast({ title: "药箱已切换，请重新打开测量", icon: "none" });
      return;
    }
    if (!this.data.commandStatusKnown) {
      wx.showToast({ title: "请求状态暂不可用，请稍后重试", icon: "none" });
      return;
    }
    if (this.data.commandInFlight) {
      wx.showToast({ title: "测量请求正在处理中", icon: "none" });
      return;
    }
    const selectedTarget = this.data.selectedMeasurementTarget;
    if (this.data.measurementTargetRequired && !selectedTarget) {
      wx.showToast({ title: "请先选择测量对象", icon: "none" });
      return;
    }
    const measureRequestId = Number(this._measureRequestId || 0) + 1;
    this._measureRequestId = measureRequestId;
    this.setData({
      measuring: true,
      carePage: composeVitalsCarePage(
        this.data.device,
        this.data.vitals,
        this.data.vitalsView,
        true,
        this.data.stale,
        this.data.commandStatusKnown,
        this.data.commandInFlight,
        this.data.measurementTargets,
        selectedTarget,
        this.data.measurementTargetRequired,
      ),
    });
    try {
      const payload = selectedTarget ? {
        service_user_id: selectedTarget.personId,
        serviceUserId: selectedTarget.personId,
        service_user_name_snapshot: selectedTarget.name,
        serviceUserNameSnapshot: selectedTarget.name,
        persona_generation: selectedTarget.personaGeneration,
        personaGeneration: selectedTarget.personaGeneration,
        attribution_source: "REMOTE_COMMAND",
        attributionSource: "REMOTE_COMMAND",
      } : {
        attribution_source: "STANDALONE",
        attributionSource: "STANDALONE",
      };
      await api.addCommand("READ_VITALS_ALL", payload, { deviceId: requestDeviceId });
      if (measureRequestId !== this._measureRequestId || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      wx.showToast({ title: "测量请求已提交" });
      await this.load();
    } catch (error) {
      if (measureRequestId !== this._measureRequestId || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      console.warn("vitals command submission failed", error);
      wx.showToast({ title: "提交失败，请重试", icon: "none" });
    } finally {
      if (measureRequestId !== this._measureRequestId || !this.isDeviceScopeCurrent(requestDeviceId)) return;
      this.setData({
        measuring: false,
        carePage: composeVitalsCarePage(
          this.data.device,
          this.data.vitals,
          this.data.vitalsView,
          false,
          this.data.stale,
          this.data.commandStatusKnown,
          this.data.commandInFlight,
          this.data.measurementTargets,
          this.data.selectedMeasurementTarget,
          this.data.measurementTargetRequired,
        ),
      });
    }
  },

  onCarePageAction(event) {
    const detail = event && event.detail ? event.detail : {};
    if (detail.id === "vitals.retry") {
      return this.retryLoad();
    } else if (detail.id === "vitals.measure") {
      return this.readAll();
    } else if (String(detail.id || "").indexOf("vitals.target.") === 0) {
      this.selectMeasurementTarget(detail.payload || {});
    } else if (detail.id === "vitals.details") {
      this.showMeasureDetails();
    }
  },

  selectMeasurementTarget(target = {}) {
    const personId = String(target.personId || "").trim();
    const personaGeneration = String(target.personaGeneration || "").trim();
    const selected = (this.data.measurementTargets || []).find(item => (
      item.personId === personId && item.personaGeneration === personaGeneration
    ));
    if (!selected) return;
    this.setData({
      selectedMeasurementTarget: selected,
      carePage: composeVitalsCarePage(
        this.data.device,
        this.data.vitals,
        this.data.vitalsView,
        this.data.measuring,
        this.data.stale,
        this.data.commandStatusKnown,
        this.data.commandInFlight,
        this.data.measurementTargets,
        selected,
        this.data.measurementTargetRequired,
      ),
    });
  },

  showMeasureDetails() {
    const vitals = this.data.vitals || {};
    const command = this.data.latestCommand || {};
    this.setData({
      detailVisible: true,
      detailRows: measurementDetailRows(
        this.data.device,
        vitals,
        command,
        this.data.vitalsAttribution || {},
        this.data.capabilitySnapshot || {},
      ),
    });
  },

  closeMeasureDetails() {
    this.setData({ detailVisible: false });
  },

  noop() {},
});
