const api = require("../../utils/api");
const realtime = require("../../utils/realtime");
const { isDoneStatus, isPlanActionable, isPlanDueToday, planTimeValue } = require("../../utils/carePlan");
const { composeCarePage, loadingCarePage } = require("../../utils/carePage");
const medicationSafetyEvents = require("../../modules/medicationSafetyEvents");
const personaVisibility = require("../../modules/personaVisibility");
const { parseTimestamp } = require("../../utils/dateTime");
const { connectionCopy } = require("../../utils/connectionState");

const medicationSafetyEventModule = medicationSafetyEvents.createMedicationSafetyEventModule(api);

function reconcileSafetyRefresh(previous = {}, next = {}, deviceId = "") {
  const requestDeviceId = String(deviceId || "").trim();
  const availability = String(next.availability || "unknown");
  if (availability === "ready") {
    return Object.assign({}, next, {
      deviceId: requestDeviceId,
      stale: false,
      hasReadySnapshot: true,
    });
  }
  if (["forbidden", "unsupported"].includes(availability)) {
    return Object.assign({}, next, {
      deviceId: requestDeviceId,
      events: [],
      nextCursor: "",
      stale: false,
      hasReadySnapshot: false,
    });
  }
  const sameDevice = String(previous.deviceId || "").trim() === requestDeviceId;
  const canPreserve = sameDevice && (previous.hasReadySnapshot === true || previous.availability === "ready");
  if (["error", "unknown"].includes(availability) && canPreserve) {
    return Object.assign({}, next, {
      deviceId: requestDeviceId,
      events: previous.events || [],
      nextCursor: previous.nextCursor || "",
      stale: true,
      hasReadySnapshot: true,
      message: `${next.message || "安全记录暂时无法刷新"}，已保留上次记录，可能不是最新`,
    });
  }
  return Object.assign({}, next, {
    deviceId: requestDeviceId,
    stale: false,
    hasReadySnapshot: false,
  });
}

function clearedDeviceView(deviceId = "") {
  const id = String(deviceId || "").trim();
  return {
    carePage: loadingCarePage("家人和药箱", "正在整理家人和今日照护…"),
    stale: false,
    deviceId: id,
    pairingCode: "",
    pairingBusy: false,
    device: {},
    familyMembers: [],
    familyPreview: [],
    safetyState: {
      availability: "unknown",
      message: "暂时无法确认安全记录是否为最新",
      events: [],
      nextCursor: "",
      deviceId: id,
    },
    todayCare: {
      totalCount: 0,
      pendingCount: 0,
      doneCount: 0,
      statusText: "暂无待办",
      statusClass: "good",
      nextText: "暂未安排今日照护",
    },
    todayCareLines: [],
    commands: [],
    detailVisible: false,
    detailMode: "lines",
    detailTitle: "药箱详情",
    detailLines: [],
    detailMembers: [],
  };
}

function firstPresent(...values) {
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== undefined && values[i] !== null && values[i] !== "") return values[i];
  }
  return "";
}

function isPersonaMigrationError(error) {
  return String(error && (error.code || error.message) || "")
    .toUpperCase()
    .includes("PERSONA_DATA_MIGRATION_IN_PROGRESS");
}

function memberMatchesPlan(member = {}, plan = {}) {
  return api.planMatchesServiceUser(plan, member, { strictGeneration: true });
}

function familyAgeText(value) {
  const compact = String(value === undefined || value === null ? "" : value).trim().replace(/\s+/g, "");
  if (!compact) return "";
  const age = compact.replace(/岁$/, "");
  return age ? `${age} 岁` : "";
}

function familyProfileText(value, age) {
  const profile = String(value === undefined || value === null ? "" : value).trim();
  const ageValue = String(age === undefined || age === null ? "" : age).trim().replace(/\s*岁\s*$/, "");
  if (!profile || !ageValue) return profile;
  const escapedAge = ageValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return profile.replace(new RegExp(`^${escapedAge}\\s*岁\\s*[·•，,、:：-]?\\s*`), "").trim();
}

function isArchivedUser(user = {}) {
  const value = firstPresent(user.archived, user.isArchived, user.is_archived, false);
  if (value === true || value === 1) return true;
  return ["true", "1", "yes", "是"].includes(String(value || "").trim().toLowerCase());
}

function safetyProfileText(value) {
  const date = String(value || "").trim().slice(0, 10);
  return date ? `健康资料更新 ${date}` : "";
}

function familyMemberViewKey(personId, personaGeneration, fallbackId) {
  return encodeURIComponent(JSON.stringify([
    String(personId || fallbackId || "unbound"),
    String(personaGeneration || ""),
  ]));
}

function safetyEventMatchesMember(member = {}, event = {}) {
  const memberId = firstPresent(member.id, member.service_user_id, member.user_id, member._id);
  const eventPersonId = firstPresent(event.personId, event.person_id, event.serviceUserId, event.service_user_id);
  if (!memberId || !eventPersonId || String(memberId) !== String(eventPersonId)) return false;
  const memberGeneration = firstPresent(member.personaGeneration, member.persona_generation);
  const eventGeneration = firstPresent(event.personaGeneration, event.persona_generation);
  if (!memberGeneration || !eventGeneration) return !memberGeneration && !eventGeneration;
  return String(memberGeneration) === String(eventGeneration);
}

function safetyEventTime(event = {}) {
  const value = firstPresent(event.occurredAt, event.occurred_at, event.createdAt, event.created_at);
  return parseTimestamp(value) || 0;
}

function safetyOutcomeText(event = {}) {
  if (event.checkStatus === "BLOCKED") return "存在明确用药风险";
  if (event.checkStatus === "CHECK_FAILED") return "风险资料需要复核";
  return "用药风险核验已记录";
}

function memberSafetySummary(member = {}, events = []) {
  const relatedEvents = (events || [])
    .filter(event => safetyEventMatchesMember(member, event))
    .sort((left, right) => safetyEventTime(right) - safetyEventTime(left));
  const unreadEvents = relatedEvents.filter(event => event.readState === "UNREAD");
  const blocked = unreadEvents.find(event => event.checkStatus === "BLOCKED");
  const checkFailed = unreadEvents.find(event => event.checkStatus === "CHECK_FAILED");
  const attentionEvent = blocked || checkFailed || null;
  const latestEvent = relatedEvents[0] || null;
  return {
    unreadCount: unreadEvents.length,
    attentionEvent,
    latestText: latestEvent
      ? [latestEvent.medicineName, latestEvent.summary || safetyOutcomeText(latestEvent)].filter(Boolean).join(" · ")
      : "",
  };
}

function buildFamilyMembers(users = [], plans = [], safetyEvents = [], options = {}) {
  return (users || []).filter(user => !isArchivedUser(user)).map((user, index) => {
    const name = firstPresent(user.name, user.user_name, user.display_name, "家庭成员");
    const relatedPlans = (plans || []).filter(plan => memberMatchesPlan(user, plan));
    const pendingPlans = relatedPlans.filter(isPlanActionable).sort((a, b) => planTimeValue(a) - planTimeValue(b));
    const nextPlan = pendingPlans[0];
    const age = firstPresent(user.age, "");
    const profile = firstPresent(user.profile, user.disease, user.note, "");
    const personId = firstPresent(user.id, user.service_user_id, user.user_id, user._id, "");
    const personaGeneration = firstPresent(user.personaGeneration, user.persona_generation, "");
    const fallbackId = `family-${index}`;
    const safety = personId ? memberSafetySummary(user, safetyEvents) : memberSafetySummary({}, []);
    const unreadSafetyQualifier = options.safetyHasMore ? "至少 " : " ";
    const hasUnreadSafetyAttention = Boolean(safety.attentionEvent);
    const safetyKind = safety.attentionEvent && safety.attentionEvent.checkStatus === "BLOCKED"
      ? "risk"
      : (hasUnreadSafetyAttention ? "pending" : "");
    return {
      id: personId || fallbackId,
      viewKey: familyMemberViewKey(personId, personaGeneration, fallbackId),
      personId,
      personaGeneration,
      name,
      initial: String(name).slice(0, 1),
      profileText: [familyAgeText(age), familyProfileText(profile, age)].filter(Boolean).join(" · "),
      pendingCount: pendingPlans.length,
      unreadSafetyCount: safety.unreadCount,
      unreadSafetyText: safety.unreadCount ? `未读安全${unreadSafetyQualifier}${safety.unreadCount} 条` : "",
      latestSafetyText: safety.latestText,
      careStatusText: hasUnreadSafetyAttention
        ? `未读安全提醒${unreadSafetyQualifier}${safety.unreadCount} 条`
        : (pendingPlans.length ? `待办 ${pendingPlans.length} 项` : "暂无待办"),
      careTone: safetyKind === "risk" ? "danger" : ((safetyKind || pendingPlans.length) ? "warn" : "good"),
      careStateKind: safetyKind || (pendingPlans.length ? "pending" : "normal"),
      nextCareText: nextPlan ? `${String(nextPlan.time || "待定").slice(0, 5)} · ${nextPlan.medicine || nextPlan.medicine_name || nextPlan.name || "计划用药"}` : "暂无待办",
      safetyProfileText: safetyProfileText(firstPresent(user.safetyProfileUpdatedAt, user.safety_profile_updated_at, "")),
    };
  });
}

function withoutArchivedPlans(users = [], plans = []) {
  const activeUsers = (users || []).filter(user => !isArchivedUser(user));
  return (plans || [])
    .filter(plan => api.shouldShowPlanForServiceUsers(plan, users || []))
    .filter(plan => activeUsers.some(user => api.planMatchesServiceUser(plan, user, { strictGeneration: true })));
}

function memberNameForPlan(plan = {}, users = []) {
  const member = (users || []).find(user => memberMatchesPlan(user, plan));
  return firstPresent(
    member && firstPresent(member.name, member.user_name, member.display_name),
    plan.target_user_name,
    plan.target_user,
    plan.user_name,
    plan.person_name,
    "家人"
  );
}

function planMedicineText(plan = {}) {
  return firstPresent(plan.medicine, plan.medicine_name, plan.name, "用药计划");
}

function planTimeText(plan = {}) {
  const value = String(plan.time || "待定");
  return value.match(/^\d{1,2}:\d{2}/) ? value.slice(0, 5) : value;
}

function buildTodayCareOverview(plans = [], users = []) {
  const todayPlans = (plans || [])
    .filter(isPlanDueToday)
    .sort((a, b) => planTimeValue(a) - planTimeValue(b));
  const pendingPlans = todayPlans.filter(isPlanActionable);
  const nextPlan = pendingPlans[0];
  const totalCount = todayPlans.length;
  const pendingCount = pendingPlans.length;
  const doneCount = todayPlans.filter(plan => isDoneStatus(plan.status)).length;

  return {
    totalCount,
    pendingCount,
    doneCount,
    statusText: pendingCount ? `待办 ${pendingCount} 项` : (totalCount ? "今日已处理" : "暂无待办"),
    statusClass: pendingCount ? "warn" : "good",
    nextText: nextPlan
      ? `${planTimeText(nextPlan)} · ${memberNameForPlan(nextPlan, users)} · ${planMedicineText(nextPlan)}`
      : (totalCount ? "今日计划已处理" : "暂未安排今日照护"),
    lines: todayPlans.map(plan => ({
      label: planTimeText(plan),
      value: `${memberNameForPlan(plan, users)} · ${planMedicineText(plan)} · ${isPlanActionable(plan) ? "待处理" : (isDoneStatus(plan.status) ? "已完成" : "已跳过")}`,
    })),
  };
}

function statusView(status) {
  const map = {
    pending: { text: "等待药箱", cls: "warn" },
    running: { text: "执行中", cls: "warn" },
    done: { text: "已完成", cls: "good" },
    failed: { text: "失败", cls: "danger" },
  };
  return map[status] || { text: status || "等待同步", cls: "muted" };
}

function commandLabel(type) {
  const map = {
    READ_VITALS_ALL: "远程测量体征",
    AUDIO_BEEP: "提示音提醒",
    AUDIO_SPEAK: "语音提醒",
    AI_CHAT: "AI 问询",
  };
  return map[type] || "家庭药箱协同";
}

function commandTime(command = {}) {
  const value = firstPresent(command.updatedAt, command.updated_at, command.createdAt, command.created_at);
  const match = String(value || "").match(/(\d{2}:\d{2})(?::\d{2})?/);
  return match ? match[1] : (value ? String(value).slice(5, 16) : "刚刚");
}

function buildFamilyCarePage({ device = {}, deviceId = "", familyMembers = [], familyPreview = [], todayCare = {}, safetyState = {}, stale = false } = {}) {
  const totalCount = Number(todayCare.totalCount) || 0;
  const pendingCount = Number(todayCare.pendingCount) || 0;
  const doneCount = Number(todayCare.doneCount) || 0;
  const hasPending = pendingCount > 0;
  const hasTodayCare = totalCount > 0;
  const focusTitle = hasPending
    ? (todayCare.nextText || "查看下一项照护安排")
    : (hasTodayCare ? "今天的照护已处理" : "今天暂无照护安排");
  const currentFocusSupporting = hasPending
    ? `今天还有 ${pendingCount} 项待处理，打开可查看完整安排。`
    : (hasTodayCare ? "今天的计划均已处理，可随时回顾照护明细。" : "药箱同步新的计划后，会优先显示在这里。");
  const focusSupporting = stale
    ? `刷新失败，当前家人与照护信息可能不是最新。${currentFocusSupporting}`
    : currentFocusSupporting;
  const safetySupporting = safetyState.stale ? safetyState.message : ({
    unsupported: "当前云端版本尚未支持安全记录",
    forbidden: "当前微信账号无权查看该药箱",
    unknown: "暂时无法确认安全记录是否为最新",
    error: "安全记录读取失败，请稍后重试",
  }[safetyState.availability] || "");
  const familySupporting = familyMembers.length
    ? [`已同步 ${familyMembers.length} 位家人`, safetySupporting].filter(Boolean).join(" · ")
    : (safetySupporting || "等待药箱同步家人信息");
  const deviceStatus = connectionCopy(device.connection || { state: "unavailable" });

  return composeCarePage({
    key: "family-care",
    title: "家人和药箱",
    online: device.online === true,
    connection: device.connection,
    focus: {
      eyebrow: hasPending ? "今日照护 · 下一项" : "今日照护",
      title: focusTitle,
      supporting: focusSupporting,
      state: {
        kind: hasPending ? "pending" : "normal",
        label: todayCare.statusText || (hasPending ? `待办 ${pendingCount} 项` : "暂无待办"),
      },
      action: hasTodayCare ? {
        id: "family.today",
        label: hasPending ? "打开今日照护" : "回顾今日照护",
      } : (familyMembers.length ? {
        id: "family.focus.people",
        label: "查看家人照护",
      } : {
        id: "family.focus.device",
        label: "查看药箱状态",
      }),
      activation: "surface",
    },
    overview: [
      { key: "family-pending", label: "待办", value: pendingCount, state: hasPending ? "pending" : "normal" },
      { key: "family-done", label: "已完成", value: doneCount, state: "normal" },
      {
        key: "family-total",
        label: "今日计划",
        value: totalCount,
        state: totalCount ? "actionable" : "muted",
      },
    ],
    sections: [
      {
        key: "family-people",
        intent: "people",
        title: "家人",
        supporting: familySupporting,
        empty: "药箱尚未同步家人信息，连接后会在这里显示。",
        items: familyPreview.map(member => ({
          key: `family-member-${member.viewKey}`,
          symbolText: member.initial,
          title: member.name,
          supporting: [
            member.profileText,
            member.latestSafetyText ? `最近安全：${member.latestSafetyText}` : "",
            member.pendingCount ? `下一项：${member.nextCareText}` : "",
          ].filter(Boolean).join(" · "),
          meta: [member.unreadSafetyText, member.safetyProfileText].filter(Boolean).join(" · "),
          state: {
            kind: member.careStateKind,
            label: member.careStatusText,
          },
          action: member.personId ? {
            id: `family.person.detail.${member.viewKey}`,
            label: `查看${member.name}的照护详情`,
            payload: {
              personId: member.personId,
              personaGeneration: member.personaGeneration,
              personName: member.name,
            },
          } : null,
        })),
        more: familyMembers.length > familyPreview.length ? {
          id: "family.all",
          label: "全部家人",
        } : null,
      },
      {
        key: "family-device-section",
        intent: "device",
        title: "我的药箱",
        supporting: "绑定、语音测试与协同日志集中在药箱管理中",
        items: [{
          key: "family-device-item",
          symbol: "device",
          title: deviceStatus.title,
          supporting: device.lastSeenAt ? `最近同步 · ${device.lastSeenAt}` : deviceStatus.hint,
          meta: deviceId ? `药箱编号 ${deviceId}` : "尚未设置药箱编号",
          state: {
            kind: device.connection && device.connection.state === "online" ? "normal" : "pending",
            label: deviceStatus.hint,
          },
          action: {
            id: "family.device",
            label: "管理我的药箱",
          },
        }],
      },
    ],
  });
}

function deviceSessionViewData(session = {}) {
  const mode = String(session.mode || "unknown");
  const availability = String(session.availability || "error");
  const requestedDeviceId = String(session.selectedDeviceId || "").trim();
  const devices = Array.isArray(session.devices)
    ? session.devices.map(device => {
      const connection = device && device.connection || { state: "unavailable" };
      const status = connectionCopy(connection);
      const lastSeenAt = String(device && device.lastSeenAt || "").trim();
      return Object.assign({}, device, {
        deviceId: String(device && device.deviceId || "").trim(),
        name: String(device && device.name || "").trim() || "家庭药箱",
        statusText: status.title,
        statusHint: lastSeenAt ? `最近同步 ${lastSeenAt}` : status.hint,
        connectionState: connection.state || "unavailable",
      });
    }).filter(device => device.deviceId)
    : [];
  const authorizedSelection = mode === "membership"
    && availability === "ready"
    && devices.some(device => device.deviceId === requestedDeviceId);
  const deviceAccessReady = authorizedSelection;
  const selectedDeviceId = deviceAccessReady ? requestedDeviceId : "";
  const invalidMembershipSelection = mode === "membership"
    && availability === "ready"
    && !authorizedSelection;
  return {
    deviceSessionMode: mode,
    deviceSessionAvailability: invalidMembershipSelection ? "error" : availability,
    authorizedDevices: devices.map(device => Object.assign({}, device, {
      selected: device.deviceId === selectedDeviceId,
    })),
    selectedDeviceId,
    canPair: mode === "membership" && session.canPair === true,
    deviceSessionMessage: invalidMembershipSelection
      ? "当前药箱不在账号授权列表中，请重新读取授权药箱"
      : String(session.message || ""),
    pairingPhase: String(session.pairing && session.pairing.phase || "idle"),
    pairingMessage: String(session.pairing && session.pairing.message || ""),
    deviceAccessReady,
  };
}

function settingsDeviceScopeIsCurrent(page, requestDeviceId, loadRequestId) {
  if (loadRequestId !== undefined && loadRequestId !== page._loadRequestId) return false;
  const normalizedDeviceId = String(requestDeviceId || "").trim();
  const pageDeviceId = String(page.data && page.data.deviceId || "").trim();
  if (pageDeviceId !== normalizedDeviceId) return false;
  if (page.data && page.data.deviceSessionMode === "membership") {
    if (page.data.deviceSessionAvailability !== "ready") return false;
    if (!(page.data.authorizedDevices || []).some(device => device.deviceId === normalizedDeviceId)) return false;
  }
  if (typeof getApp === "function") {
    const app = getApp();
    const globalData = app && app.globalData;
    if (globalData && Object.prototype.hasOwnProperty.call(globalData, "deviceId")) {
      if (String(globalData.deviceId || "").trim() !== normalizedDeviceId) return false;
    }
  }
  return true;
}

function deviceRecoveryCarePage(sessionView = {}) {
  const availability = sessionView.deviceSessionAvailability;
  if (availability === "loading") {
    return loadingCarePage("家人和药箱", "正在确认当前账号可访问的药箱…");
  }
  return composeCarePage({
    key: "family-device-access",
    title: "家人和药箱",
    showStatus: false,
    phase: {
      kind: ["error", "unknown", "forbidden"].includes(availability) ? "error" : "empty",
      message: sessionView.deviceSessionMessage || "请先在“我的药箱”中完成药箱授权。",
      action: { id: "family.device", label: "管理我的药箱" },
    },
  });
}

function familyMigrationCarePage(device = {}, deviceId = "") {
  const status = connectionCopy(device.connection || { state: "unavailable" });
  return composeCarePage({
    key: "family-persona-migration",
    title: "家人和药箱",
    connection: device.connection,
    focus: {
      eyebrow: "家人照护",
      title: "家人资料正在安全更新",
      supporting: "用药计划、问询和健康记录完成迁移后会自动恢复。",
      state: { kind: "muted", label: "更新中" },
      action: { id: "family.focus.device", label: "查看药箱状态" },
      activation: "surface",
    },
    sections: [{
      key: "family-device-section",
      intent: "device",
      title: "我的药箱",
      items: [{
        key: "family-device-item",
        symbol: "device",
        title: status.title,
        supporting: device.lastSeenAt ? `最近同步 · ${device.lastSeenAt}` : status.hint,
        meta: deviceId ? `药箱编号 ${deviceId}` : "",
        state: {
          kind: device.connection && device.connection.state === "online" ? "normal" : "pending",
          label: status.hint,
        },
        action: { id: "family.device", label: "管理我的药箱" },
      }],
    }],
  });
}

Page({
  data: {
    carePage: loadingCarePage("家人和药箱", "正在整理家人和今日照护…"),
    stale: false,
    env: "",
    deviceId: "",
    device: {},
    familyMembers: [],
    familyPreview: [],
    safetyState: { availability: "unknown", events: [], message: "暂时无法确认安全记录是否为最新" },
    todayCare: {
      totalCount: 0,
      pendingCount: 0,
      doneCount: 0,
      statusText: "暂无待办",
      statusClass: "good",
      nextText: "暂未安排今日照护",
    },
    todayCareLines: [],
    commands: [],
    pairingCode: "",
    pairingBusy: false,
    deviceSessionMode: "unknown",
    deviceSessionAvailability: "loading",
    authorizedDevices: [],
    selectedDeviceId: "",
    canPair: false,
    deviceSessionMessage: "正在确认当前账号可访问的药箱",
    pairingPhase: "idle",
    pairingMessage: "",
    deviceAccessReady: false,
    detailVisible: false,
    detailMode: "lines",
    detailTitle: "药箱详情",
    detailLines: [],
    detailMembers: [],
  },

  onShow() {
    const app = getApp();
    const showRequestId = (this._showRequestId || 0) + 1;
    this._showRequestId = showRequestId;
    const session = app.globalData && app.globalData.deviceSession || {};
    const sessionPending = (app.globalData && app.globalData.deviceSessionResolved === false)
      || session.availability === "loading";
    if (sessionPending && typeof app.waitForDeviceSession === "function") {
      this._hasLoadedSnapshot = false;
      this._loadedDeviceId = "";
      const loadingView = deviceSessionViewData(Object.assign({}, session, {
        mode: "unknown",
        availability: "loading",
        selectedDeviceId: "",
      }));
      this.setData(Object.assign(clearedDeviceView(""), loadingView));
      this.stopRealtime();
      return Promise.resolve(app.waitForDeviceSession()).then(resolvedSession => {
        if (showRequestId !== this._showRequestId) return undefined;
        return this.activateDeviceSession(resolvedSession || {});
      }).catch(error => {
        if (showRequestId !== this._showRequestId) return undefined;
        console.warn("device session loading failed", error);
        return this.activateDeviceSession({
          mode: "unknown",
          availability: "error",
          devices: [],
          selectedDeviceId: "",
          canPair: false,
          message: "暂时无法确认账号可访问的药箱",
        });
      });
    }
    return this.activateDeviceSession(session);
  },

  activateDeviceSession(session = {}) {
    const app = getApp();
    const sessionView = deviceSessionViewData(session);
    const deviceId = sessionView.selectedDeviceId;
    const sameDevice = deviceId === String(this.data.deviceId || "").trim();
    if (!sameDevice || !sessionView.deviceAccessReady) {
      this._loadRequestId = (this._loadRequestId || 0) + 1;
      this._hasLoadedSnapshot = false;
      this._loadedDeviceId = "";
    }
    const nextData = sameDevice
      ? Object.assign({ env: app.globalData.env, deviceId }, sessionView)
      : Object.assign({ env: app.globalData.env }, clearedDeviceView(deviceId), sessionView);
    if (!sessionView.deviceAccessReady) {
      nextData.carePage = deviceRecoveryCarePage(sessionView);
    }
    this.setData(nextData);
    if (!sessionView.deviceAccessReady) {
      this._hasLoadedSnapshot = false;
      this._loadedDeviceId = "";
      this.stopRealtime();
      return undefined;
    }
    const loading = this.load();
    this.startRealtime();
    return loading;
  },

  onHide() {
    this._showRequestId = (this._showRequestId || 0) + 1;
    this.stopRealtime();
  },

  onUnload() {
    this._showRequestId = (this._showRequestId || 0) + 1;
    this.stopRealtime();
  },

  startRealtime() {
    this.stopRealtime();
    this._stopRealtime = realtime.subscribe(() => this.load(), null, {
      collections: ["devices", "commands", "service_users", "today_plans"],
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
    const requestDeviceId = String(this.data.deviceId || "").trim();
    const membershipRequestAuthorized = this.data.deviceSessionMode === "membership"
      && this.data.deviceSessionAvailability === "ready"
      && (this.data.authorizedDevices || []).some(device => device.deviceId === requestDeviceId);
    if (this.data.deviceSessionMode === "membership" && !membershipRequestAuthorized) {
      this._loadRequestId = (this._loadRequestId || 0) + 1;
      this._hasLoadedSnapshot = false;
      this._loadedDeviceId = "";
      const sessionView = deviceSessionViewData({
        mode: "membership",
        availability: "error",
        devices: this.data.authorizedDevices || [],
        selectedDeviceId: "",
        canPair: this.data.canPair === true,
        message: "当前药箱不在账号授权列表中，请重新读取授权药箱",
        pairing: {
          phase: this.data.pairingPhase || "idle",
          message: this.data.pairingMessage || "",
        },
      });
      const nextData = Object.assign(clearedDeviceView(""), sessionView);
      nextData.carePage = deviceRecoveryCarePage(sessionView);
      this.setData(nextData);
      this.stopRealtime();
      return;
    }
    const loadRequestId = (this._loadRequestId || 0) + 1;
    this._loadRequestId = loadRequestId;
    try {
      const latestDevice = await api.getDeviceStrict(requestDeviceId);
      const [snapshotRead, commandRead, safetyRead] = await Promise.all([
        api.getSnapshotStrict({ inquiryLimit: 10, deviceId: requestDeviceId })
          .then(value => ({ value }), error => ({ error })),
        api.getRecentCommandsStrict(6, requestDeviceId)
          .then(value => ({ value }), error => ({ error })),
        medicationSafetyEventModule.list({ limit: 50, deviceId: requestDeviceId })
          .then(value => ({ value }), error => ({ error })),
      ]);
      if (!settingsDeviceScopeIsCurrent(this, requestDeviceId, loadRequestId)) return;
      const migrationError = [snapshotRead.error, commandRead.error, safetyRead.error]
        .filter(Boolean)
        .find(isPersonaMigrationError);
      if (migrationError) {
        this.setData({
          device: latestDevice,
          deviceId: requestDeviceId,
          familyMembers: [],
          familyPreview: [],
          todayCare: {
            totalCount: 0,
            pendingCount: 0,
            doneCount: 0,
            statusText: "更新中",
            statusClass: "idle",
            nextText: "家人资料正在安全更新",
          },
          todayCareLines: [],
          commands: [],
          stale: false,
          carePage: familyMigrationCarePage(latestDevice, requestDeviceId),
        });
        this._hasLoadedSnapshot = true;
        this._loadedDeviceId = requestDeviceId;
        return;
      }
      const readError = [snapshotRead.error, commandRead.error, safetyRead.error].filter(Boolean)[0];
      if (readError) throw readError;
      const snapshot = snapshotRead.value;
      const commands = commandRead.value;
      const safetyState = safetyRead.value;
      const returnedDevice = latestDevice || {};
      const returnedDeviceId = String(returnedDevice.deviceId || "").trim();
      if (this.data.deviceSessionMode === "membership"
        && returnedDeviceId
        && returnedDeviceId !== requestDeviceId) {
        const error = new Error("membership snapshot device does not match the authorized request");
        error.code = "DEVICE_NOT_AUTHORIZED";
        throw error;
      }
      const reconciledSafetyState = reconcileSafetyRefresh(this.data.safetyState || {}, safetyState, requestDeviceId);
      const device = returnedDevice;
      const serviceUsers = snapshot.serviceUsers || [];
      const personaPolicy = personaVisibility.createPersonaVisibilityPolicy(serviceUsers, {
        capabilities: (safetyState.capabilitySnapshot && safetyState.capabilitySnapshot.capabilities) || {},
        serviceUsersSnapshotComplete: snapshot.serviceUsersSnapshotComplete === true,
      });
      const activeUsers = personaPolicy.strict
        ? personaPolicy.activeUsers()
        : serviceUsers.filter(user => !isArchivedUser(user));
      const activePlans = personaPolicy.strict
        ? (snapshot.plans || []).filter(plan => personaPolicy.allowsPlan(plan))
        : withoutArchivedPlans(serviceUsers, snapshot.plans || []);
      const familyMembers = buildFamilyMembers(activeUsers, activePlans, reconciledSafetyState.events || [], {
        safetyHasMore: Boolean(reconciledSafetyState.nextCursor),
      });
      const familyPreview = familyMembers.slice(0, 3);
      const todayCare = buildTodayCareOverview(activePlans, activeUsers);
      const deviceId = device.deviceId || this.data.deviceId;
      const currentDeviceId = String(this.data.deviceId || "").trim();
      const refreshedDeviceId = String(deviceId || "").trim();
      const isSameDeviceRefresh = requestDeviceId === currentDeviceId
        && requestDeviceId === refreshedDeviceId;
      const nextData = {
        device,
        deviceId,
        familyMembers,
        familyPreview,
        safetyState: reconciledSafetyState,
        stale: false,
        todayCare,
        todayCareLines: todayCare.lines,
        commands: (commands || []).map(item => {
          const status = statusView(item.status);
          return Object.assign({}, item, {
            userText: commandLabel(item.type),
            statusText: status.text,
            statusClass: status.cls,
            timeText: commandTime(item),
          });
        }),
        detailVisible: isSameDeviceRefresh ? this.data.detailVisible : false,
        detailMode: isSameDeviceRefresh ? this.data.detailMode : "lines",
        detailTitle: isSameDeviceRefresh ? this.data.detailTitle : "药箱详情",
        detailLines: isSameDeviceRefresh ? this.data.detailLines : [],
        detailMembers: isSameDeviceRefresh ? this.data.detailMembers : [],
      };
      nextData.carePage = buildFamilyCarePage(nextData);
      this.setData(nextData);
      this._hasLoadedSnapshot = true;
      this._loadedDeviceId = requestDeviceId;
    } catch (error) {
      if (!settingsDeviceScopeIsCurrent(this, requestDeviceId, loadRequestId)) return;
      console.warn("family care loading failed", error);
      const currentDeviceId = String(this.data.deviceId || "").trim();
      const canPreserveLoadedView = this._hasLoadedSnapshot === true
        && String(this._loadedDeviceId || "").trim() === requestDeviceId
        && currentDeviceId === requestDeviceId;
      if (canPreserveLoadedView) {
        const stale = true;
        this.setData({
          stale,
          carePage: buildFamilyCarePage(Object.assign({}, this.data, { stale })),
        });
        return;
      }
      this._hasLoadedSnapshot = false;
      this._loadedDeviceId = "";
      this.setData({
        stale: false,
        carePage: composeCarePage({
          key: "family-care-error",
          title: "家人和药箱",
          online: Boolean(this.data.device && this.data.device.online),
          connection: this.data.device && this.data.device.connection,
          phase: {
            kind: "error",
            message: "家人与药箱信息暂未同步，请稍后刷新。",
            action: { id: "family.retry", label: "重新读取家人与药箱" },
          },
        }),
      });
    }
  },

  retryLoad() {
    this.setData({ carePage: loadingCarePage("家人和药箱", "正在重新读取家人与药箱…") });
    return this.load();
  },

  onCarePageAction(event) {
    const id = event && event.detail && event.detail.id;
    if (id === "family.retry") {
      return this.retryLoad();
    } else if (id === "family.today") {
      this.showTodayCareDetails();
    } else if (id === "family.all" || id === "family.focus.people") {
      this.showFamilyDetails();
    } else if (id === "family.device" || id === "family.focus.device") {
      this.showDeviceDetails();
    } else if (String(id || "").indexOf("family.person.detail.") === 0) {
      this.goMemberDetail(event.detail.payload || {});
    }
  },

  goMemberDetail(member = {}) {
    const personId = String(member.personId || "").trim();
    if (!personId) return;
    const query = [
      `personId=${encodeURIComponent(personId)}`,
      member.personaGeneration ? `personaGeneration=${encodeURIComponent(member.personaGeneration)}` : "",
      member.personName ? `personName=${encodeURIComponent(member.personName)}` : "",
    ].filter(Boolean).join("&");
    wx.navigateTo({ url: `/pages/familyDetail/index?${query}` });
  },

  openMemberDetail(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    this.goMemberDetail({
      personId: dataset.personId,
      personaGeneration: dataset.personaGeneration,
      personName: dataset.personName,
    });
  },

  onPairingCodeInput(event) {
    this.setData({ pairingCode: event && event.detail ? event.detail.value : "" });
  },

  async redeemDevicePairingCode() {
    if (this.data.pairingBusy === true) return;
    if (this.data.deviceSessionMode !== "membership" || this.data.canPair !== true) {
      wx.showToast({ title: "当前云端未开放自助配对", icon: "none" });
      return;
    }
    const pairingCode = String(this.data.pairingCode || "").trim();
    if (!pairingCode) {
      this.setData({
        pairingPhase: "error",
        pairingMessage: "请输入一次性配对码",
      });
      return;
    }
    this.setData({ pairingBusy: true, pairingPhase: "submitting", pairingMessage: "正在配对药箱…" });
    try {
      const app = getApp();
      const session = await app.redeemDevicePairingCode(pairingCode);
      const resolvedSession = session || app.globalData.deviceSession || {};
      const sessionView = deviceSessionViewData(resolvedSession);
      const paired = sessionView.deviceSessionMode === "membership"
        && sessionView.deviceSessionAvailability === "ready"
        && sessionView.pairingPhase === "idle"
        && sessionView.deviceAccessReady
        && (sessionView.authorizedDevices || []).some(device => (
          device.deviceId === sessionView.selectedDeviceId
        ));
      if (!paired) {
        this.setData(Object.assign({}, sessionView, {
          pairingBusy: false,
          pairingPhase: sessionView.pairingPhase === "idle" ? "error" : sessionView.pairingPhase,
          pairingMessage: sessionView.pairingMessage
            || sessionView.deviceSessionMessage
            || "配对结果未通过授权校验，请重试",
        }));
        return;
      }
      this.setData({ pairingCode: "", pairingBusy: false });
      await Promise.resolve(this.activateDeviceSession(resolvedSession));
      wx.showToast({ title: "药箱配对成功" });
    } catch (error) {
      console.warn("device pairing failed", error);
      this.setData({
        pairingBusy: false,
        pairingPhase: "error",
        pairingMessage: "配对失败，请稍后重试",
      });
    }
  },

  async refreshDeviceSession() {
    const loadingSession = {
      mode: "unknown",
      availability: "loading",
      devices: [],
      selectedDeviceId: "",
      canPair: false,
      message: "正在重新读取账号授权的药箱",
      pairing: { phase: "idle", message: "" },
    };
    this.activateDeviceSession(loadingSession);
    try {
      const app = getApp();
      const session = await app.refreshDeviceSession();
      return await Promise.resolve(this.activateDeviceSession(session || app.globalData.deviceSession || {}));
    } catch (error) {
      console.warn("device session refresh failed", error);
      this.activateDeviceSession({
        mode: "unknown",
        availability: "error",
        devices: [],
        selectedDeviceId: "",
        canPair: false,
        message: "暂时无法确认账号可访问的药箱，请稍后重试",
      });
      wx.showToast({ title: "授权药箱读取失败", icon: "none" });
      return undefined;
    }
  },

  selectAuthorizedDevice(event) {
    const deviceId = String(event && event.currentTarget && event.currentTarget.dataset
      && event.currentTarget.dataset.deviceId || "").trim();
    const authorized = this.data.deviceSessionMode === "membership"
      && this.data.deviceSessionAvailability === "ready"
      && (this.data.authorizedDevices || []).some(device => device.deviceId === deviceId);
    if (!authorized) {
      wx.showToast({ title: "当前账号未获该药箱授权", icon: "none" });
      return undefined;
    }
    try {
      const app = getApp();
      const session = app.selectAuthorizedDevice(deviceId);
      const sessionView = deviceSessionViewData(session || app.globalData.deviceSession || {});
      if (sessionView.deviceSessionMode !== "membership"
        || !sessionView.deviceAccessReady
        || sessionView.selectedDeviceId !== deviceId) {
        wx.showToast({ title: "药箱授权校验失败", icon: "none" });
        return undefined;
      }
      const loading = this.activateDeviceSession(session || app.globalData.deviceSession || {});
      wx.showToast({ title: "已切换药箱" });
      return loading;
    } catch (error) {
      console.warn("authorized device selection failed", error);
      wx.showToast({ title: "当前账号未获该药箱授权", icon: "none" });
      return undefined;
    }
  },

  showFamilyDetails() {
    this.setData({
      detailVisible: true,
      detailMode: "family",
      detailTitle: "全部家人",
      detailLines: [],
      detailMembers: this.data.familyMembers || [],
    });
  },

  showTodayCareDetails() {
    this.setData({
      detailVisible: true,
      detailMode: "todayCare",
      detailTitle: "今日照护",
      detailLines: this.data.todayCareLines || [],
      detailMembers: [],
    });
  },

  showDeviceDetails() {
    const device = this.data.device || {};
    const showDeviceFacts = this.data.deviceAccessReady === true
      || (this.data.deviceAccessReady === undefined && Boolean(this.data.deviceId));
    this.setData({
      detailVisible: true,
      detailMode: "device",
      detailTitle: "我的药箱",
      detailLines: showDeviceFacts ? [
        { label: "药箱编号", value: this.data.deviceId || "未设置" },
        { label: "最近在线", value: device.lastSeenAt || "暂无" },
        { label: "网络", value: [device.network || "未上报", device.signal || ""].filter(Boolean).join(" · ") },
        { label: "同步程序", value: device.cloudAgent || "未上报" },
        { label: "云环境", value: this.data.env || "未设置" },
      ] : [],
      detailMembers: [],
    });
  },

  showCommandDetails() {
    const commands = this.data.commands || [];
    this.setData({
      detailVisible: true,
      detailMode: "commands",
      detailTitle: "最近协同",
      detailLines: commands.length
        ? commands.map(item => ({ label: item.timeText, value: `${item.userText} · ${item.statusText}` }))
        : [{ label: "状态", value: "暂无最近协同操作" }],
      detailMembers: [],
    });
  },

  closeDetail() {
    this.setData({ detailVisible: false });
  },

  noop() {},

  async testVoiceReminder() {
    const requestId = `test-speak-${Date.now()}`;
    const requestDeviceId = String(this.data.deviceId || "").trim();
    if (!requestDeviceId || !settingsDeviceScopeIsCurrent(this, requestDeviceId)) {
      wx.showToast({ title: "药箱授权已变化，请重新选择", icon: "none" });
      return;
    }
    try {
      await api.addCommand("AUDIO_SPEAK", {
        request_id: requestId,
        text: "智药康护提醒测试。",
        message: "智药康护提醒测试。",
        target_user_name: "家庭成员",
        volume: 230,
        tts_mode: "auto",
      }, { requestId, deviceId: requestDeviceId });
      if (!settingsDeviceScopeIsCurrent(this, requestDeviceId)) return;
      wx.showToast({ title: "提醒已提交" });
      this.load();
    } catch (error) {
      console.warn("voice reminder submission failed", error);
      wx.showToast({ title: "提交失败，请重试", icon: "none" });
    }
  },
});
