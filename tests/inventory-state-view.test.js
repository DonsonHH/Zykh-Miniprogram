const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inventoryPolicyFor,
  summarizeCabinetSlots,
  stockView,
} = require("../miniprogram/utils/cabinetView");

const explicitPolicy = {
  explicitInventoryStateSupported: true,
  legacyMode: false,
};

test("inventory capability negotiation distinguishes supported, legacy and unknown reads", () => {
  assert.deepEqual(inventoryPolicyFor({
    capabilities: { explicitInventoryState: "v1" },
  }), {
    explicitInventoryStateSupported: true,
    legacyMode: false,
  });
  assert.deepEqual(inventoryPolicyFor({ capabilities: {} }), {
    explicitInventoryStateSupported: false,
    legacyMode: true,
  });
  assert.deepEqual(inventoryPolicyFor(), {
    explicitInventoryStateSupported: false,
    legacyMode: false,
  });
});

test("an explicit STOCKED fact wins over a temporary zero quantity", () => {
  const view = stockView({
    name: "布洛芬",
    quantity: 0,
    inventoryState: "STOCKED",
  }, explicitPolicy);

  assert.equal(view.inventoryState, "STOCKED");
  assert.equal(view.isStocked, true);
  assert.equal(view.isDepleted, false);
  assert.equal(view.isInventoryUnknown, false);
  assert.equal(view.stockText, "药箱显示有药");
});

test("an explicit DEPLETED fact wins over a stale positive quantity", () => {
  const view = stockView({
    name: "维生素",
    quantity: 8,
    inventory_state: "DEPLETED",
  }, explicitPolicy);

  assert.equal(view.inventoryState, "DEPLETED");
  assert.equal(view.isStocked, false);
  assert.equal(view.isDepleted, true);
  assert.equal(view.isInventoryUnknown, false);
  assert.match(view.stockText, /待补药/);
});

test("an explicit UNKNOWN fact stays visible without becoming a refill alert", () => {
  const view = stockView({
    name: "阿莫西林",
    quantity: 0,
    inventoryState: "UNKNOWN",
  }, explicitPolicy);

  assert.equal(view.inventoryState, "UNKNOWN");
  assert.equal(view.isStocked, false);
  assert.equal(view.isDepleted, false);
  assert.equal(view.isInventoryUnknown, true);
  assert.equal(view.stockText, "库存状态待药箱确认");
});

test("a capability contract with a missing state fails closed as UNKNOWN", () => {
  const view = stockView({
    name: "缺失显式状态的药品",
    quantity: 0,
  }, explicitPolicy);

  assert.equal(view.inventoryState, "UNKNOWN");
  assert.equal(view.isDepleted, false);
  assert.equal(view.isInventoryUnknown, true);
  assert.equal(view.contractIssue, "explicit_inventory_state_missing");
});

test("conflicting or invalid explicit inventory facts never fall back to quantity", () => {
  const conflict = stockView({
    name: "冲突库存",
    quantity: 9,
    inventoryState: "STOCKED",
    inventory_state: "DEPLETED",
  }, { explicitInventoryStateSupported: false, legacyMode: true });
  const invalid = stockView({
    name: "非法库存",
    quantity: 9,
    inventoryState: "MAYBE",
  }, { explicitInventoryStateSupported: false, legacyMode: true });

  assert.equal(conflict.inventoryState, "UNKNOWN");
  assert.equal(conflict.isStocked, false);
  assert.equal(conflict.contractIssue, "explicit_inventory_state_conflict");
  assert.equal(invalid.inventoryState, "UNKNOWN");
  assert.equal(invalid.isStocked, false);
  assert.equal(invalid.contractIssue, "explicit_inventory_state_invalid");
});

test("legacy inventory only treats a positive quantity as confirmed STOCKED", () => {
  const policy = { explicitInventoryStateSupported: false, legacyMode: true };
  const positive = stockView({ name: "仍有药", quantity: 1 }, policy);
  const zero = stockView({ name: "预扣为零", quantity: 0 }, policy);
  const negative = stockView({ name: "异常负数", quantity: -1 }, policy);
  const missing = stockView({ name: "未上报数量" }, policy);

  assert.equal(positive.inventoryState, "STOCKED");
  assert.equal(positive.isStocked, true);
  [zero, negative, missing].forEach(view => {
    assert.equal(view.inventoryState, "UNKNOWN");
    assert.equal(view.isDepleted, false);
    assert.equal(view.isInventoryUnknown, true);
  });
});

test("an unregistered cabinet slot never becomes a replenishment fact", () => {
  const view = stockView({
    name: "",
    quantity: 0,
    inventoryState: "DEPLETED",
  }, explicitPolicy);

  assert.equal(view.inventoryState, "UNKNOWN");
  assert.equal(view.isDepleted, false);
  assert.equal(view.isInventoryUnknown, true);
  assert.equal(view.stockText, "仓位尚未登记药品");
});

test("cabinet summaries count only explicit DEPLETED facts as refill work", () => {
  const summary = summarizeCabinetSlots([{
    slot: 1,
    name: "布洛芬",
    quantity: 0,
    inventoryState: "STOCKED",
    expireDate: "2099-01",
  }, {
    slot: 2,
    name: "维生素",
    quantity: 8,
    inventoryState: "DEPLETED",
    expireDate: "2099-01",
  }, {
    slot: 3,
    name: "阿莫西林",
    quantity: 0,
    inventoryState: "UNKNOWN",
    expireDate: "2099-01",
  }], explicitPolicy);

  assert.equal(summary.stockedCount, 1);
  assert.equal(summary.depletedCount, 1);
  assert.equal(summary.inventoryUnknownCount, 1);
  assert.deepEqual(summary.slots.map(item => item.inventoryState), ["STOCKED", "DEPLETED", "UNKNOWN"]);
});

test("inventory projections expose honest maintenance copy for every state", () => {
  const stocked = stockView({ name: "有药", inventoryState: "STOCKED" }, explicitPolicy);
  const depleted = stockView({ name: "用完", inventoryState: "DEPLETED" }, explicitPolicy);
  const unknown = stockView({ name: "待确认", inventoryState: "UNKNOWN" }, explicitPolicy);

  assert.match(stocked.title, /仓内有药/);
  assert.match(depleted.title, /确认无药/);
  assert.match(depleted.hint, /补入药品/);
  assert.match(unknown.title, /待确认/);
  assert.match(unknown.hint, /不会生成待补药/);
});
