const { expiryView, formatExpiryLabel } = require("./expiry");

const OVERVIEW_SLOT_LIMIT = 4;

function inventoryPolicyFor(capabilitySnapshot) {
  if (!capabilitySnapshot || typeof capabilitySnapshot !== "object" || Array.isArray(capabilitySnapshot)) {
    return { explicitInventoryStateSupported: false, legacyMode: false };
  }
  const capabilities = capabilitySnapshot.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return { explicitInventoryStateSupported: false, legacyMode: false };
  }
  const rawCapability = capabilities.explicitInventoryState !== undefined
    ? capabilities.explicitInventoryState
    : capabilities.explicit_inventory_state;
  const version = String(rawCapability === undefined || rawCapability === null ? "" : rawCapability).trim().toLowerCase();
  const explicitInventoryStateSupported = rawCapability === true
    || rawCapability === 1
    || version === "v1"
    || version === "1"
    || version.indexOf("v1.") === 0;
  return {
    explicitInventoryStateSupported,
    legacyMode: !explicitInventoryStateSupported,
  };
}

function unknownStockView(contractIssue = "") {
  const view = {
    inventoryState: "UNKNOWN",
    isStocked: false,
    isDepleted: false,
    isInventoryUnknown: true,
    stockText: "库存状态待药箱确认",
    title: "库存状态待确认",
    hint: "当前不会生成待补药提醒，请等待药箱同步确认。",
  };
  if (contractIssue) view.contractIssue = contractIssue;
  return view;
}

function stockView(slot = {}, policy = {}) {
  if (!String(slot.name || "").trim()) {
    return {
      inventoryState: "UNKNOWN",
      isStocked: false,
      isDepleted: false,
      isInventoryUnknown: true,
      stockText: "仓位尚未登记药品",
      title: "等待药品登记",
      hint: "登记后由药箱同步并确认库存状态。",
    };
  }
  const camelState = String(slot.inventoryState || "").trim().toUpperCase();
  const snakeState = String(slot.inventory_state || "").trim().toUpperCase();
  const stateConflict = slot.inventoryStateConflict === true
    || Boolean(camelState && snakeState && camelState !== snakeState);
  if (stateConflict) return unknownStockView("explicit_inventory_state_conflict");
  const explicitState = camelState || snakeState;
  if (explicitState === "STOCKED") {
    return {
      inventoryState: "STOCKED",
      isStocked: true,
      isDepleted: false,
      isInventoryUnknown: false,
      stockText: "药箱显示有药",
      title: "药箱确认仓内有药",
      hint: "是否待补药以药箱最近一次现场确认为准。",
    };
  }
  if (explicitState === "DEPLETED") {
    return {
      inventoryState: "DEPLETED",
      isStocked: false,
      isDepleted: true,
      isInventoryUnknown: false,
      stockText: "药箱已确认无药 · 待补药",
      title: "药箱已确认无药",
      hint: "补入药品后提交更新，等待药箱确认新的库存状态。",
    };
  }
  if (explicitState === "UNKNOWN") {
    return unknownStockView();
  }
  if (explicitState) return unknownStockView("explicit_inventory_state_invalid");
  if (policy.explicitInventoryStateSupported === true) {
    return unknownStockView("explicit_inventory_state_missing");
  }
  const rawQuantity = slot.quantity !== undefined && slot.quantity !== null && slot.quantity !== ""
    ? slot.quantity
    : slot.stock;
  const parsedQuantity = Number(rawQuantity);
  const hasQuantity = rawQuantity !== undefined && rawQuantity !== null && rawQuantity !== "" && Number.isFinite(parsedQuantity);
  const quantity = hasQuantity ? parsedQuantity : undefined;
  const isLegacyStocked = Boolean(
    policy.legacyMode === true
    && slot.name
    && hasQuantity
    && quantity > 0
  );
  if (isLegacyStocked) {
    return {
      inventoryState: "STOCKED",
      isStocked: true,
      isDepleted: false,
      isInventoryUnknown: false,
      stockText: "药箱显示有药",
      title: "药箱确认仓内有药",
      hint: "是否待补药以药箱最近一次现场确认为准。",
    };
  }
  return unknownStockView();
}

function decorateCabinetSlot(slot = {}, policy = {}) {
  const expiry = expiryView(slot);
  return Object.assign({}, slot, stockView(slot, policy), {
    statusText: expiry.expiryText,
    statusClass: expiry.expiryClass,
    expiryText: expiry.expiryText,
    expiryHint: expiry.expiryHint,
    expiryLabel: formatExpiryLabel(slot.expireDate || slot.expire_date),
    expiry,
  });
}

function maintenanceRank(slot = {}) {
  if (slot.isDepleted) return 1;
  if (slot.statusClass === "expired") return 0;
  if (slot.statusClass === "urgent") return 2;
  if (slot.statusClass === "soon") return 3;
  if (slot.statusClass === "missing") return 4;
  return 5;
}

function sortCabinetSlots(slots = []) {
  return (slots || []).slice().sort((a, b) => {
    const leftExpiry = a.expiry || {};
    const rightExpiry = b.expiry || {};
    if (leftExpiry.expiryRank !== rightExpiry.expiryRank) {
      return Number(leftExpiry.expiryRank || 0) - Number(rightExpiry.expiryRank || 0);
    }
    if (leftExpiry.expiryDays === null) return 1;
    if (rightExpiry.expiryDays === null) return -1;
    const dayDiff = Number(leftExpiry.expiryDays || 0) - Number(rightExpiry.expiryDays || 0);
    if (dayDiff) return dayDiff;
    return Number(a.slot || 0) - Number(b.slot || 0);
  });
}

function priorityMaintenanceSlots(slots = []) {
  return (slots || [])
    .filter(slot => slot && slot.name && maintenanceRank(slot) < 5)
    .slice()
    .sort((left, right) => {
      const rankDiff = maintenanceRank(left) - maintenanceRank(right);
      if (rankDiff) return rankDiff;
      return Number(left.slot || 0) - Number(right.slot || 0);
    })
    .slice(0, OVERVIEW_SLOT_LIMIT);
}

function overviewCabinetSlots(slots = []) {
  const prioritySlots = priorityMaintenanceSlots(slots);
  if (prioritySlots.length >= OVERVIEW_SLOT_LIMIT) return prioritySlots;

  const prioritySet = new Set(prioritySlots);
  const regularSlots = sortCabinetSlots(
    (slots || []).filter(slot => (
      slot
      && slot.name
      && maintenanceRank(slot) >= 5
      && !prioritySet.has(slot)
    )),
  );

  return prioritySlots.concat(
    regularSlots.slice(0, OVERVIEW_SLOT_LIMIT - prioritySlots.length),
  );
}

function summarizeCabinetSlots(rawSlots = [], policy = {}) {
  const slots = (rawSlots || []).map(slot => decorateCabinetSlot(slot, policy));
  const stockSlots = slots.filter(item => item.name);
  const availableSlots = stockSlots.filter(item => !item.isDepleted);
  const expiryRisk = availableSlots.filter(item => ["urgent", "soon"].includes(item.statusClass));
  const expired = availableSlots.filter(item => item.statusClass === "expired");
  const missing = availableSlots.filter(item => item.statusClass === "missing");
  const valid = availableSlots.filter(item => item.statusClass === "valid");
  const depleted = stockSlots.filter(item => item.isDepleted);
  const stocked = stockSlots.filter(item => item.isStocked);
  const inventoryUnknown = stockSlots.filter(item => item.isInventoryUnknown);
  return {
    slots,
    stockCount: stockSlots.length,
    stockedCount: stocked.length,
    inventoryUnknownCount: inventoryUnknown.length,
    validExpiryCount: valid.length,
    expiredCount: expired.length,
    missingExpiryCount: missing.length,
    expiryRiskCount: expiryRisk.length,
    depletedCount: depleted.length,
    prioritySlots: priorityMaintenanceSlots(slots),
    overviewSlots: overviewCabinetSlots(slots),
  };
}

function filterCabinetSlots(slots = [], filter = "all", keyword = "") {
  const normalizedFilter = ["all", "expiring", "expired", "missing", "depleted"].includes(filter) ? filter : "all";
  const query = String(keyword || "").trim().toLowerCase();
  let viewSlots = (slots || []).filter(item => item && item.name);

  if (normalizedFilter === "expiring") {
    viewSlots = viewSlots.filter(item => !item.isDepleted && ["urgent", "soon"].includes(item.statusClass));
  } else if (normalizedFilter === "expired") {
    viewSlots = viewSlots.filter(item => !item.isDepleted && item.statusClass === "expired");
  } else if (normalizedFilter === "missing") {
    viewSlots = viewSlots.filter(item => !item.isDepleted && item.statusClass === "missing");
  } else if (normalizedFilter === "depleted") {
    viewSlots = viewSlots.filter(item => item.isDepleted);
  }

  if (query) {
    viewSlots = viewSlots.filter(item => {
      const haystack = `${item.slot} ${item.name || ""} ${item.spec || ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  return sortCabinetSlots(viewSlots);
}

module.exports = {
  decorateCabinetSlot,
  filterCabinetSlots,
  inventoryPolicyFor,
  priorityMaintenanceSlots,
  sortCabinetSlots,
  stockView,
  summarizeCabinetSlots,
};
