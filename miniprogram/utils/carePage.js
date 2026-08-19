const CARE_STATES = ["risk", "pending", "normal", "actionable", "muted"];
const SECTION_INTENTS = ["tasks", "inventory", "conversations", "timeline", "people", "device", "navigation"];
const SYMBOLS = {
  medicine: "药",
  measure: "测",
  conversation: "问",
  timeline: "记",
  person: "家",
  device: "箱",
  inventory: "仓",
  safety: "安",
};

const STATE_ALIASES = {
  risk: "risk",
  danger: "risk",
  bad: "risk",
  expired: "risk",
  failed: "risk",
  pending: "pending",
  warn: "pending",
  warning: "pending",
  attention: "pending",
  urgent: "pending",
  soon: "pending",
  normal: "normal",
  good: "normal",
  ok: "normal",
  valid: "normal",
  complete: "normal",
  done: "normal",
  actionable: "actionable",
  notice: "actionable",
  progress: "actionable",
  info: "actionable",
  muted: "muted",
  unknown: "muted",
  idle: "muted",
};

class CarePageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CarePageError";
  }
}

function text(value, fallback = "") {
  if (value === undefined || value === null) return String(fallback || "");
  const result = String(value).replace(/\s+/g, " ").trim();
  return result || String(fallback || "");
}

function serializablePayload(value) {
  if (value === undefined || value === null || value === "") return {};
  try {
    const clone = JSON.parse(JSON.stringify(value));
    return clone && typeof clone === "object" && !Array.isArray(clone) ? clone : {};
  } catch (error) {
    throw new CarePageError("care action payload must be serializable");
  }
}

function normalizeState(value, fallbackLabel = "", allowUnlabeled = false) {
  if (!value && !fallbackLabel) return null;
  const raw = typeof value === "string" ? { kind: value } : (value || {});
  const requested = text(raw.kind || raw.state || raw.tone, "muted").toLowerCase();
  const kind = STATE_ALIASES[requested] || "muted";
  const label = text(raw.label || raw.text, fallbackLabel);
  return label || allowUnlabeled ? { kind, label } : null;
}

function normalizeAction(value, role = "secondary") {
  if (!value) return null;
  const id = text(value.id || value.key);
  const label = text(value.label);
  if (!id || !label) throw new CarePageError("care actions require both id and label");
  return {
    id,
    label,
    role,
    disabled: value.disabled === true,
    payload: serializablePayload(value.payload),
  };
}

function normalizeFocusActivation(value, action) {
  if (!action) return "none";
  const activation = text(value, "button").toLowerCase();
  if (!["button", "surface"].includes(activation)) {
    throw new CarePageError("focus activation must be button or surface");
  }
  return activation;
}

function normalizePhase(value) {
  const raw = typeof value === "string" ? { kind: value } : (value || {});
  const kind = ["ready", "loading", "empty", "error"].includes(raw.kind) ? raw.kind : "ready";
  const defaults = {
    loading: "正在整理照护信息…",
    empty: "暂时没有可显示的内容。",
    error: "内容暂时不可用，请稍后重试。",
    ready: "",
  };
  return {
    kind,
    message: text(raw.message, defaults[kind]),
    action: normalizeAction(raw.action, "primary"),
  };
}

function normalizeFact(value = {}, index = 0) {
  const numericValue = value.value === 0 ? "0" : text(value.value, "--");
  const label = text(value.label, "未命名");
  const unit = text(value.unit);
  const action = normalizeAction(value.action);
  return {
    key: text(value.key || value.id, `fact-${index}`),
    label,
    value: numericValue,
    unit,
    state: normalizeState(value.state || value.tone, "", true),
    action,
    ariaLabel: [label, `${numericValue}${unit}`, action && action.label].filter(Boolean).join("，"),
  };
}

function normalizeItem(value = {}, sectionKey, index = 0) {
  const symbol = text(value.symbol).toLowerCase();
  const title = text(value.title, "未命名事项");
  const supporting = text(value.supporting || value.body || value.description);
  const meta = text(value.meta);
  const state = normalizeState(value.state || value.status);
  const action = normalizeAction(value.action);
  return {
    key: text(value.key || value.id, `${sectionKey}-item-${index}`),
    symbol: SYMBOLS[symbol] || text(value.leading || value.symbolText, "·"),
    title,
    supporting,
    meta,
    state,
    action,
    ariaLabel: [title, supporting, meta, state && state.label, action && action.label].filter(Boolean).join("，"),
  };
}

function normalizeFilter(value = {}, index = 0) {
  const label = text(value.label, "筛选");
  const active = value.active === true;
  const action = normalizeAction(value.action);
  return {
    key: text(value.key || value.id, `filter-${index}`),
    label,
    active,
    action,
    ariaLabel: `${label}，${active ? "已选中" : "未选中"}`,
  };
}

function normalizeSection(value = {}, index = 0) {
  const key = text(value.key, `section-${index}`);
  const intent = SECTION_INTENTS.includes(value.intent) ? value.intent : "tasks";
  return {
    key,
    intent,
    title: text(value.title),
    supporting: text(value.supporting || value.note),
    empty: text(value.empty, "暂时没有相关内容。"),
    items: (value.items || []).map((item, itemIndex) => normalizeItem(item, key, itemIndex)),
    filters: (value.filters || []).map(normalizeFilter),
    more: normalizeAction(value.more || value.detailAction),
  };
}

function assertUniqueKeys(model) {
  const keys = new Set();
  const remember = (value, label) => {
    if (!value) return;
    if (keys.has(value)) throw new CarePageError(`duplicate ${label}: ${value}`);
    keys.add(value);
  };

  remember(model.key, "page key");
  if (model.phase.action) remember(model.phase.action.id, "action id");
  if (model.focus && model.focus.action) remember(model.focus.action.id, "action id");
  model.overview.forEach(fact => {
    remember(fact.key, "fact key");
    if (fact.action) remember(fact.action.id, "action id");
  });
  model.sections.forEach(section => {
    remember(section.key, "section key");
    if (section.more) remember(section.more.id, "action id");
    section.filters.forEach(filter => {
      remember(filter.key, "filter key");
      if (filter.action) remember(filter.action.id, "action id");
    });
    section.items.forEach(item => {
      remember(item.key, "item key");
      if (item.action) remember(item.action.id, "action id");
    });
  });
  if (model.detailAction) remember(model.detailAction.id, "action id");
}

function composeCarePage(spec = {}) {
  const phase = normalizePhase(spec.phase || "ready");
  const title = text(spec.title);
  if (!title) throw new CarePageError("care page requires a title");

  const focusSource = spec.focus || {};
  if (phase.kind === "ready" && !text(focusSource.title)) {
    throw new CarePageError("a ready care page requires one focus title");
  }
  const focusAction = normalizeAction(focusSource.action, "primary");
  const focusActivation = normalizeFocusActivation(focusSource.activation, focusAction);
  const focusState = normalizeState(focusSource.state || focusSource.status);
  const focusEyebrow = text(focusSource.eyebrow || focusSource.label);
  const focusTitle = text(focusSource.title);
  const focusSupporting = text(focusSource.supporting || focusSource.body || focusSource.description);

  const overview = (spec.overview || spec.facts || []).map(normalizeFact);
  if (overview.length > 4) throw new CarePageError("care page overview supports at most four facts");

  const model = {
    key: text(spec.key, title),
    title,
    online: spec.online === true || Boolean(spec.sync && spec.sync.online),
    showStatus: spec.showStatus !== false,
    phase,
    focus: phase.kind === "ready" ? {
      eyebrow: focusEyebrow,
      title: focusTitle,
      supporting: focusSupporting,
      state: focusState,
      action: focusAction,
      activation: focusActivation,
      ariaLabel: [
        focusEyebrow,
        focusTitle,
        focusSupporting,
        focusState && focusState.label,
        focusActivation === "surface" && focusAction && focusAction.label,
      ]
        .filter(Boolean)
        .join("，"),
    } : null,
    overview,
    sections: (spec.sections || []).map(normalizeSection),
    detailAction: normalizeAction(spec.detailAction),
  };
  assertUniqueKeys(model);
  return model;
}

function loadingCarePage(title, message = "") {
  return composeCarePage({
    key: `${text(title, "care")}-loading`,
    title: text(title, "智药康护"),
    showStatus: false,
    phase: { kind: "loading", message },
  });
}

module.exports = {
  CARE_STATES,
  SECTION_INTENTS,
  CarePageError,
  composeCarePage,
  loadingCarePage,
  normalizeState,
};
