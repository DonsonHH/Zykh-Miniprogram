const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSlots,
  buildMedicineCommandPayload,
  normalizeMedicine,
} = require("../miniprogram/utils/api");

test("medicine records preserve the expiry precision and board metadata", () => {
  const medicine = normalizeMedicine({
    deviceId: "station-001",
    slot: 3,
    name: "测试药品",
    expireDate: "2027-12-31",
    barcode: "6901234567890",
    traceCode: "trace-001",
    unit: "瓶",
  });

  assert.equal(medicine.expireDate, "2027-12-31");
  assert.equal(medicine.barcode, "6901234567890");
  assert.equal(medicine.traceCode, "trace-001");
  assert.equal(medicine.unit, "瓶");
});

test("medicine normalization preserves explicit inventory facts from both transport aliases", () => {
  const snake = normalizeMedicine({
    deviceId: "station-001",
    slot: 13,
    name: "布洛芬",
    quantity: 0,
    inventory_state: "STOCKED",
    inventory_state_revision: "13",
    depletion_confirmed_at: "",
    depletion_confirmation_source: "POST_DISPENSE",
  });
  const camel = normalizeMedicine({
    deviceId: "station-001",
    slot: 14,
    name: "维生素",
    quantity: 8,
    inventoryState: "DEPLETED",
    inventoryStateRevision: 14,
    depletionConfirmedAt: "2026-08-10 19:00:00",
    depletionConfirmationSource: "ADMIN",
  });

  assert.deepEqual({
    state: snake.inventoryState,
    stateAlias: snake.inventory_state,
    revision: snake.inventoryStateRevision,
    revisionAlias: snake.inventory_state_revision,
    confirmedAt: snake.depletionConfirmedAt,
    confirmedAtAlias: snake.depletion_confirmed_at,
    source: snake.depletionConfirmationSource,
    sourceAlias: snake.depletion_confirmation_source,
  }, {
    state: "STOCKED",
    stateAlias: "STOCKED",
    revision: 13,
    revisionAlias: 13,
    confirmedAt: "",
    confirmedAtAlias: "",
    source: "POST_DISPENSE",
    sourceAlias: "POST_DISPENSE",
  });
  assert.equal(camel.inventory_state, "DEPLETED");
  assert.equal(camel.inventory_state_revision, 14);
  assert.equal(camel.depletion_confirmed_at, "2026-08-10 19:00:00");
  assert.equal(camel.depletion_confirmation_source, "ADMIN");
});

test("conflicting inventory aliases remain an explicit contract conflict", () => {
  const medicine = normalizeMedicine({
    deviceId: "station-001",
    slot: 15,
    name: "冲突库存",
    quantity: 8,
    inventoryState: "STOCKED",
    inventory_state: "DEPLETED",
  });

  assert.equal(medicine.inventoryState, "");
  assert.equal(medicine.inventory_state, "");
  assert.equal(medicine.inventoryStateConflict, true);
  assert.deepEqual(medicine.inventoryStateConflictValues, ["STOCKED", "DEPLETED"]);
});

test("conflicting expiry aliases are never silently reduced to one precision", () => {
  const medicine = normalizeMedicine({
    deviceId: "station-001",
    slot: 3,
    name: "medicine",
    expireDate: "2027-12",
    expire_date: "2027-12-31",
  });

  assert.equal(medicine.expiryConflict, true);
  assert.equal(medicine.expireDate, "");
  assert.throws(() => buildMedicineCommandPayload({
    deviceId: "station-001",
    slot: 3,
    name: "medicine",
    quantity: 2,
  }, medicine), /expiry aliases conflict/);
});

test("a trace code never becomes a barcode fallback", () => {
  const { payload } = buildMedicineCommandPayload({
    deviceId: "station-001",
    slot: 3,
    name: "medicine",
    quantity: 8,
    expireDate: "2027-12",
    traceCode: "trace-only-001",
  });

  assert.equal(Object.hasOwn(payload, "barcode"), false);
  assert.equal(Object.hasOwn(payload, "code"), false);
  assert.equal(payload.traceCode, "trace-only-001");
  assert.equal(payload.trace_code, "trace-only-001");
});

test("medicine normalization keeps a trace-only record out of barcode", () => {
  const medicine = normalizeMedicine({
    deviceId: "station-001",
    slot: 3,
    trace_code: "trace-only-002",
  });

  assert.equal(medicine.barcode, "");
  assert.equal(medicine.traceCode, "trace-only-002");
});

test("a medicine without an explicit board inventory state remains unknown", () => {
  const medicine = normalizeMedicine({
    deviceId: "station-001",
    slot: 3,
    name: "阿莫西林",
  });

  assert.equal(medicine.quantity, undefined);
  assert.equal(medicine.stock, undefined);
});

test("known 23-medicine rows use the current canonical box despite an old cloud box value", () => {
  const medicine = normalizeMedicine({
    deviceId: "station-001",
    name: "阿莫西林胶囊",
    storageBox: "SYMPTOM",
    inventoryState: "STOCKED",
    expireDate: "2027-12",
  });

  assert.equal(medicine.storageBox, "PRESCRIPTION");
  assert.equal(medicine.storageBoxLabel, "慢病处方储备");
  assert.equal(medicine.inventoryState, "STOCKED");
  assert.equal(medicine.expireDate, "2027-12");
});

test("a category is not silently presented or submitted as a package specification", () => {
  const medicine = normalizeMedicine({
    deviceId: "station-001",
    slot: 3,
    category: "cold-medicine",
  });
  const { payload } = buildMedicineCommandPayload({
    deviceId: "station-001",
    slot: 3,
    name: "medicine",
    quantity: 2,
    expireDate: "2027-12",
    spec: "10mg x 30",
  }, medicine);

  assert.equal(medicine.spec, "");
  assert.equal(payload.spec, "10mg x 30");
  assert.equal(Object.hasOwn(payload, "dosage"), false);
});

test("medicine commands preserve an explicit zero quantity", () => {
  const { medicine, payload } = buildMedicineCommandPayload({
    deviceId: "station-001",
    slot: 3,
    name: "medicine",
    quantity: 0,
    expireDate: "2027-12",
  });

  assert.equal(medicine.quantity, 0);
  assert.equal(payload.quantity, 0);
  assert.equal(payload.stock, 0);
  assert.equal(payload.patch.quantity, 0);
});

test("a refill command carries explicit STOCKED semantics at the root and authoritative patch", () => {
  const { payload } = buildMedicineCommandPayload({
    deviceId: "station-001",
    slot: 13,
    name: "布洛芬",
    quantity: 1,
    expireDate: "2027-12",
    inventoryState: "STOCKED",
  }, {
    deviceId: "station-001",
    slot: 13,
    name: "布洛芬",
    quantity: 0,
    expireDate: "2027-12",
    inventoryState: "DEPLETED",
    inventoryStateRevision: 12,
  });

  assert.equal(payload.inventoryState, "STOCKED");
  assert.equal(payload.inventory_state, "STOCKED");
  assert.equal(payload.patch.inventoryState, "STOCKED");
  assert.equal(payload.patch.inventory_state, "STOCKED");
});

test("normalizes station slot labels without producing NaN", () => {
  assert.equal(normalizeMedicine({ deviceId: "station-001", slot: "S03" }).slot, 3);
  assert.equal(normalizeMedicine({ deviceId: "station-001", slot: "S03", hardware_slot: 7 }).slot, 7);
});

test("places a Station slot label into its numeric cabinet position", () => {
  const previousGetApp = global.getApp;
  global.getApp = () => ({ globalData: { deviceId: "station-001" } });
  try {
    const slots = buildSlots([{
      deviceId: "station-001",
      slot: "S03",
      hardware_slot: 3,
      name: "测试药品",
      expire_date: "2027-12-31",
    }]);
    assert.equal(slots[2].name, "测试药品");
    assert.equal(slots[2].slot, 3);
  } finally {
    global.getApp = previousGetApp;
  }
});

test("medicine updates use a narrow patch while retaining legacy command compatibility", () => {
  const { medicine, payload } = buildMedicineCommandPayload({
    deviceId: "station-001",
    slot: 3,
    name: "测试药品",
    spec: "10mg*30片",
    quantity: 8,
    expireDate: "2027-12-31",
    lowStockLine: 2,
  }, {
    deviceId: "station-001",
    hardware_slot: 3,
    barcode: "6901234567890",
    unit: "瓶",
    category: "不应由效期页覆盖",
  });

  assert.equal(medicine.expireDate, "2027-12-31");
  assert.equal(payload.operation, "patch");
  assert.equal(payload.hardware_slot, 3);
  assert.equal(payload.barcode, "6901234567890");
  assert.equal(payload.unit, "瓶");
  assert.equal(payload.category, "不应由效期页覆盖");
  assert.equal(payload.patch.expireDate, "2027-12-31");
  assert.equal(payload.patch.lowStockLine, 2);
  assert.equal(Object.hasOwn(payload.patch, "unit"), false);
  assert.equal(Object.hasOwn(payload.patch, "category"), false);
});

test("medicine precision patches use the field accepted by every v2 cloud revision", () => {
  const { payload } = buildMedicineCommandPayload({
    deviceId: "station-001",
    slot: 3,
    name: "测试药品",
    quantity: 8,
    expireDate: "2028-01",
    expiryPrecision: "month",
  }, {
    deviceId: "station-001",
    hardware_slot: 3,
    name: "测试药品",
    quantity: 8,
    expireDate: "2027-12-31",
    expiryPrecision: "day",
  });

  assert.equal(payload.patch.expiryPrecision, "month");
  assert.equal(Object.hasOwn(payload.patch, "expiry_precision"), false);
  assert.equal(payload.expiry_precision, "month");
});

test("medicine patch omits unchanged board-owned fields", () => {
  const base = {
    deviceId: "station-001",
    hardware_slot: 3,
    name: "测试药品",
    spec: "10mg*30片",
    quantity: 8,
    expireDate: "2027-12-31",
    expiryPrecision: "day",
    lowStockLine: 2,
    barcode: "6901234567890",
    unit: "瓶",
    category: "家庭常用",
  };
  const { payload } = buildMedicineCommandPayload(Object.assign({}, base, { slot: 3 }), base);

  assert.deepEqual(payload.patch, {});
  assert.equal(payload.barcode, "6901234567890");
  assert.equal(payload.unit, "瓶");
  assert.equal(payload.category, "家庭常用");
});

test("medicine patch carries changed board-owned metadata in the authoritative nested patch", () => {
  const base = {
    deviceId: "station-001",
    hardware_slot: 3,
    name: "测试药品",
    spec: "10mg*30片",
    quantity: 8,
    expireDate: "2027-12-31",
    expiryPrecision: "day",
    barcode: "6901234567890",
    traceCode: "trace-old",
    unit: "瓶",
    category: "家庭常用",
  };
  const { payload } = buildMedicineCommandPayload(Object.assign({}, base, {
    slot: 3,
    barcode: "6900000000001",
    traceCode: "trace-new",
    unit: "盒",
    category: "感冒发热",
  }), base);

  assert.equal(payload.barcode, "6900000000001");
  assert.equal(payload.code, "6900000000001");
  assert.equal(payload.traceCode, "trace-new");
  assert.equal(payload.trace_code, "trace-new");
  assert.equal(payload.category, "感冒发热");
  assert.equal(payload.unit, "盒");
  assert.equal(payload.patch.barcode, "6900000000001");
  assert.equal(payload.patch.code, "6900000000001");
  assert.equal(payload.patch.traceCode, "trace-new");
  assert.equal(payload.patch.trace_code, "trace-new");
  assert.equal(payload.patch.category, "感冒发热");
  assert.equal(payload.patch.unit, "盒");
});
