const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../miniprogram/utils/api");

function installCloud(result) {
  const calls = [];
  const previous = {
    getApp: global.getApp,
    wx: global.wx,
  };
  global.getApp = () => ({ globalData: { deviceId: "station-001" } });
  global.wx = {
    showToast() {},
    cloud: {
      callFunction: async request => {
        calls.push(request);
        return { result: typeof result === "function" ? result(request) : result };
      },
    },
  };
  return {
    calls,
    restore() {
      global.getApp = previous.getApp;
      global.wx = previous.wx;
    },
  };
}

test("medicine submission creates one command and never needs a client database write", { concurrency: false }, async () => {
  const cloud = installCloud(request => (
    request.data.action === "LIST_MEDICINES"
      ? []
      : { _id: "command-1", status: "pending" }
  ));
  try {
    const result = await api.saveMedicine({
      slot: 2,
      name: "测试药品",
      spec: "10mg*30片",
      quantity: 4,
      expireDate: "2027-12-31",
      expiryPrecision: "day",
      lowStockLine: 2,
    }, {
      barcode: "6901234567890",
      unit: "瓶",
      category: "不应由效期页覆盖",
    });

    assert.equal(result.command._id, "command-1");
    assert.equal(cloud.calls.length, 2);
    assert.equal(cloud.calls[0].data.action, "LIST_MEDICINES");
    const request = cloud.calls[1].data;
    assert.equal(request.action, "CREATE_COMMAND");
    assert.equal(request.data.type, "UPSERT_MEDICINE");
    assert.equal(request.data.payload.operation, "patch");
    assert.equal(request.data.payload.patch.expireDate, "2027-12-31");
    assert.equal(request.data.payload.barcode, "6901234567890");
    assert.equal(request.data.payload.unit, "瓶");
    assert.equal(request.data.payload.category, "不应由效期页覆盖");
    assert.equal(Object.hasOwn(request.data.payload.patch, "unit"), false);
    assert.equal(Object.hasOwn(request.data.payload.patch, "category"), false);
  } finally {
    cloud.restore();
  }
});

test("medicine submission refreshes board-owned fields before creating its command", { concurrency: false }, async () => {
  const cloud = installCloud(request => {
    if (request.data.action === "LIST_MEDICINES") {
      return [{
        slot: 2,
        name: "board-medicine",
        barcode: "barcode-from-board",
        category: "category-from-board",
        unit: "bottle",
        quantity: 4,
        expire_date: "2027-12",
      }];
    }
    return { _id: "command-2", status: "pending" };
  });
  try {
    await api.saveMedicine({
      slot: 2,
      name: "board-medicine",
      quantity: 6,
      expireDate: "2027-12",
    });

    assert.equal(cloud.calls.length, 2);
    const payload = cloud.calls[1].data.data.payload;
    assert.equal(payload.barcode, "barcode-from-board");
    assert.equal(payload.code, "barcode-from-board");
    assert.equal(payload.category, "category-from-board");
    assert.equal(payload.unit, "bottle");
    assert.equal(payload.quantity, 6);
  } finally {
    cloud.restore();
  }
});

test("medicine submission stays on the medication box that started the save", { concurrency: false }, async () => {
  const previous = {
    getApp: global.getApp,
    wx: global.wx,
  };
  const calls = [];
  let activeDeviceId = "station-save-a";
  let releaseMedicineRead;
  const medicineReadGate = new Promise(resolve => {
    releaseMedicineRead = resolve;
  });

  global.getApp = () => ({ globalData: { deviceId: activeDeviceId } });
  global.wx = {
    cloud: {
      callFunction: async request => {
        calls.push(request);
        if (request.data.action === "LIST_MEDICINES") {
          await medicineReadGate;
          return { result: [] };
        }
        return { result: { _id: "command-fixed-scope", status: "pending" } };
      },
    },
  };

  try {
    const saving = api.saveMedicine({
      slot: 2,
      name: "测试药品",
      quantity: 3,
      expireDate: "2027-12",
      expiryPrecision: "month",
    });
    await new Promise(resolve => setImmediate(resolve));
    activeDeviceId = "station-save-b";
    releaseMedicineRead();
    await saving;

    assert.equal(calls[0].data.data.deviceId, "station-save-a");
    assert.equal(calls[1].data.action, "CREATE_COMMAND");
    assert.equal(calls[1].data.data.deviceId, "station-save-a");
  } finally {
    global.getApp = previous.getApp;
    global.wx = previous.wx;
  }
});

test("a medicine write stops before command creation when its snapshot cannot be read", { concurrency: false }, async () => {
  const cloud = installCloud({ ok: false, error: "snapshot unavailable" });
  try {
    await assert.rejects(() => api.saveMedicine({
      slot: 2,
      name: "medicine",
      quantity: 3,
      expireDate: "2027-12",
    }), /snapshot unavailable/);
    assert.equal(cloud.calls.length, 1);
    assert.equal(cloud.calls[0].data.action, "LIST_MEDICINES");
  } finally {
    cloud.restore();
  }
});

test("strict cabinet reads distinguish cloud failure from a genuinely empty cabinet", { concurrency: false }, async () => {
  const failed = installCloud({ ok: false, error: "medicine snapshot unavailable" });
  global.wx.showToast = () => {};
  try {
    await assert.rejects(() => api.getCabinetSlotsStrict(), /medicine snapshot unavailable/);
    const compatibleSlots = await api.getCabinetSlots();
    assert.equal(compatibleSlots.length, 23);
    assert.equal(compatibleSlots.every(slot => !slot.name), true);
  } finally {
    failed.restore();
  }

  const empty = installCloud([]);
  try {
    const slots = await api.getCabinetSlotsStrict();
    assert.equal(slots.length, 23);
    assert.equal(slots.every(slot => !slot.name), true);
  } finally {
    empty.restore();
  }
});

test("command submission rejects cloud errors instead of fabricating success", { concurrency: false }, async () => {
  const cloud = installCloud({ ok: false, error: "cloud unavailable" });
  try {
    await assert.rejects(() => api.addCommand("READ_VITALS_ALL"), /cloud unavailable/);
    assert.equal(cloud.calls.length, 1);
  } finally {
    cloud.restore();
  }
});

test("caregiver command submission blocks remote cabinet opening before any cloud call", { concurrency: false }, async () => {
  const cloud = installCloud({ _id: "remote-open-command", status: "pending" });
  try {
    await assert.rejects(
      () => api.addCommand("OPEN_CABINET", { remote_confirmed: true }),
      /remote cabinet opening is not available/i,
    );
    assert.equal(cloud.calls.length, 0);
  } finally {
    cloud.restore();
  }
});

test("command submission rejects an empty cloud result", { concurrency: false }, async () => {
  const cloud = installCloud(null);
  try {
    await assert.rejects(() => api.addCommand("READ_VITALS_ALL"), /command submission returned no result/);
    assert.equal(cloud.calls.length, 1);
  } finally {
    cloud.restore();
  }
});

test("command submission rejects malformed or failed command acknowledgements", { concurrency: false }, async () => {
  const malformed = installCloud({});
  try {
    await assert.rejects(() => api.addCommand("READ_VITALS_ALL"), /command submission returned no result/);
  } finally {
    malformed.restore();
  }

  const failed = installCloud({ _id: "command-failed", status: "failed", error: "board rejected it" });
  try {
    await assert.rejects(() => api.addCommand("READ_VITALS_ALL"), /board rejected it/);
  } finally {
    failed.restore();
  }
});

test("an empty read result remains a normal empty state", { concurrency: false }, async () => {
  const cloud = installCloud(null);
  try {
    assert.equal(await api.getLatestVitals(), null);
    assert.equal(cloud.calls.length, 1);
    assert.equal(cloud.calls[0].data.action, "GET_LATEST_VITALS");
  } finally {
    cloud.restore();
  }
});

test("strict vitals and records readers reject cloud failures while compatibility readers keep their fallbacks", { concurrency: false }, async () => {
  const cloud = installCloud({ ok: false, error: "care data unavailable" });
  try {
    await assert.rejects(() => api.getLatestVitalsStrict(), /care data unavailable/);
    await assert.rejects(() => api.getRecentVitalsStrict(), /care data unavailable/);
    await assert.rejects(() => api.getRecentRecordsStrict(), /care data unavailable/);

    assert.equal(await api.getLatestVitals(), null);
    assert.deepEqual(await api.getRecentVitals(), []);
    assert.deepEqual(await api.getRecentRecords(), []);
  } finally {
    cloud.restore();
  }
});

test("a remote medication reminder keeps the Station service-user identity", { concurrency: false }, async () => {
  const cloud = installCloud({ _id: "reminder-1", status: "pending" });
  try {
    await api.requestMedicationReminder({
      id: "plan-1",
      time: "09:00",
      medicine: "阿司匹林",
      service_user_id: "service-user-42",
      target_user_name: "王阿姨",
    }, { deviceId: "station-reminder" });
    const payload = cloud.calls[0].data.data.payload;
    assert.equal(payload.target_user_id, "service-user-42");
    assert.equal(payload.service_user_id, "service-user-42");
    assert.equal(cloud.calls[0].data.data.deviceId, "station-reminder");
  } finally {
    cloud.restore();
  }
});
