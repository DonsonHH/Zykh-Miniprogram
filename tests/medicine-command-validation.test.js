const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const TEST_DEVICE_SECRET = "test-only-device-secret-at-least-32-bytes";

function loadCloudApi(rowsByCollection = {}) {
  rowsByCollection = Object.assign({
    device_memberships: [{
      _id: "membership-test-family-member",
      membershipId: "membership-test-family-member",
      openid: "family-member",
      deviceId: "station-001",
      role: "OWNER",
      status: "ACTIVE",
      permissions: [
        "READ_SAFETY",
        "READ_INQUIRY",
        "READ_PLAN",
        "READ_PROFILE",
        "READ_RECORD",
        "READ_VITALS",
        "READ_MEDICINE",
        "CREATE_COMMAND",
      ],
      service_user_scopes: [],
    }],
  }, rowsByCollection);
  process.env.DEVICE_SECRETS = JSON.stringify({
    "station-001": TEST_DEVICE_SECRET,
  });
  const writes = [];
  const documentWrites = [];
  const cloud = {
    DYNAMIC_CURRENT_ENV: "dynamic",
    init() {},
    getWXContext() {
      return { OPENID: "family-member" };
    },
    database() {
      return {
        collection(name) {
          const rows = rowsByCollection[name] || [];
          const query = {
            add: async ({ data }) => {
              writes.push({ name, data });
              return { _id: "command-1" };
            },
            where() {
              return query;
            },
            orderBy() {
              return query;
            },
            skip() {
              return query;
            },
            limit() {
              return query;
            },
            get: async () => ({ data: rows }),
            doc(id) {
              return {
                get: async () => {
                  const explicit = rowsByCollection[`${name}:${id}`];
                  const configured = explicit === undefined
                    ? rowsByCollection[name + ":document"]
                    : explicit;
                  const matched = Array.isArray(rows)
                    ? rows.find(row => String(row._id || row.id || "") === String(id))
                    : null;
                  return { data: configured === undefined ? (matched || {}) : configured };
                },
                set: async ({ data }) => {
                  documentWrites.push({ name, id, operation: "set", data });
                },
                update: async ({ data }) => {
                  documentWrites.push({ name, id, operation: "update", data });
                },
              };
            },
          };
          return query;
        },
      };
    },
  };
  const target = path.resolve(__dirname, "../cloudfunctions/api/index.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[target];
    return { api: require(target), writes, documentWrites };
  } finally {
    Module._load = originalLoad;
  }
}

function medicinePayload(patch = {}) {
  return {
    operation: "patch",
    slot: 3,
    hardware_slot: 3,
    name: "测试药品",
    expireDate: "2027-12-31",
    expire_date: "2027-12-31",
    patch: Object.assign({
      name: "测试药品",
      expireDate: "2027-12-31",
      expiryPrecision: "day",
    }, patch),
  };
}

test("cloud function accepts a valid medicine patch without changing its date precision", { concurrency: false }, async () => {
  const { api, writes } = loadCloudApi();
  const result = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload: medicinePayload(),
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.payload.expireDate, "2027-12-31");
  assert.equal(writes[0].data.payload.patch.expiryPrecision, "day");
});

test("cloud function accepts supported board metadata in a medicine patch", { concurrency: false }, async () => {
  const { api, writes } = loadCloudApi();
  const payload = medicinePayload({
    barcode: "6901234567890",
    code: "6901234567890",
    traceCode: "trace-001",
    trace_code: "trace-001",
    category: "感冒发热",
    unit: "盒",
  });
  Object.assign(payload, {
    barcode: "6901234567890",
    code: "6901234567890",
    traceCode: "trace-001",
    trace_code: "trace-001",
    category: "感冒发热",
    unit: "盒",
  });
  const result = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload,
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.payload.patch.barcode, "6901234567890");
  assert.equal(writes[0].data.payload.patch.trace_code, "trace-001");
  assert.equal(writes[0].data.payload.patch.category, "感冒发热");
  assert.equal(writes[0].data.payload.patch.unit, "盒");
});

test("cloud function rejects conflicting medicine slot aliases before writing a command", { concurrency: false }, async () => {
  const { api, writes } = loadCloudApi();
  const result = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload: medicinePayload({ hardware_slot: 23 }),
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /conflicting medicine slot fields/);
  assert.equal(writes.length, 0);
});

test("cloud function rejects impossible expiry dates before writing a command", { concurrency: false }, async () => {
  const { api, writes } = loadCloudApi();
  const payload = medicinePayload();
  payload.expireDate = "2027-02-30";
  payload.expire_date = "2027-02-30";
  payload.patch.expireDate = "2027-02-30";
  const result = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /valid medicine expiry required/);
  assert.equal(writes.length, 0);
});

test("cloud function preserves a month-only expiry and rejects a contradictory precision", { concurrency: false }, async () => {
  const { api, writes } = loadCloudApi();
  const payload = medicinePayload({
    expireDate: "2027-12",
    expire_date: "2027-12",
    expiryPrecision: "month",
  });
  payload.expireDate = "2027-12";
  payload.expire_date = "2027-12";

  const success = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload,
    },
  });

  assert.equal(success.status, "pending");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.payload.expireDate, "2027-12");

  payload.patch.expiryPrecision = "day";
  const failure = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload,
    },
  });

  assert.equal(failure.ok, false);
  assert.match(failure.error, /expiry precision does not match expiry date/);
  assert.equal(writes.length, 1);
});

test("cloud function rejects conflicting expiry aliases before writing a command", { concurrency: false }, async () => {
  const { api, writes } = loadCloudApi();
  const payload = medicinePayload();
  payload.expireDate = "2027-12";
  payload.expire_date = "2027-12-31";

  const result = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /medicine expiry aliases conflict/);
  assert.equal(writes.length, 0);
});

test("cloud function accepts zero inventory but rejects invalid numeric medicine fields", { concurrency: false }, async () => {
  const { api, writes } = loadCloudApi();
  const payload = medicinePayload({
    quantity: 0,
    stock: 0,
    lowStockLine: 0,
    low_stock_line: 0,
  });
  payload.quantity = 0;
  payload.stock = 0;
  payload.lowStockLine = 0;
  payload.low_stock_line = 0;

  const success = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload,
    },
  });

  assert.equal(success.status, "pending");
  assert.equal(writes.length, 1);

  payload.lowStockLine = "not-a-number";
  const failure = await api.main({
    action: "CREATE_COMMAND",
    data: {
      deviceId: "station-001",
      type: "UPSERT_MEDICINE",
      payload,
    },
  });

  assert.equal(failure.ok, false);
  assert.match(failure.error, /lowStockLine must be a non-negative integer/);
  assert.equal(writes.length, 1);
});

test("cloud inquiry responses preserve service-user identity for same-name family members", { concurrency: false }, async () => {
  const { api } = loadCloudApi({
    inquiries: [{
      deviceId: "station-001",
      inquiry_id: "inquiry-1",
      service_user_id: "service-alex-1",
      service_user_name: "Alex",
      topic: "question",
      updatedAt: "2026-08-01 10:00:00",
    }],
  });

  const rows = await api.main({
    action: "LIST_INQUIRIES",
    data: { deviceId: "station-001", limit: 10 },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_user_id, "service-alex-1");
  assert.equal(rows[0].service_user_id, "service-alex-1");
  assert.equal(rows[0].display_name, "Alex");
});

test("AI command acknowledgement joins its saved session and inquiry lists never expand messages", { concurrency: false }, async () => {
  const command = {
    _id: "command-ai-42",
    deviceId: "station-001",
    type: "AI_CHAT",
    status: "done",
    payload: {
      service_user_id: "member-42",
      service_user_name: "Alex",
      question: "Can I take the next dose?",
    },
    result: {
      session_id: "session-42",
      inquiry_id: "session-42",
      target_user_id: "member-resolved-42",
      service_user_id: "member-resolved-42",
      target_user_name: "Alex on Station",
      stage: "clarification",
      next_action: "ask",
      reply: "Please follow the saved care plan.",
    },
    createdAt: "2026-08-08 09:00:00",
    updatedAt: "2026-08-08 09:05:00",
  };
  const { api, documentWrites } = loadCloudApi({
    commands: [command],
    inquiries: [{
      _id: "inquiry-row-42",
      deviceId: "station-001",
      inquiry_id: "session-42",
      session_id: "session-42",
      target_user_id: "member-42",
      target_user_name: "Alex",
      messages: [
        { role: "user", content: "First saved question" },
        { role: "assistant", content: "First saved reply" },
        { role: "user", content: "Follow-up saved question" },
      ],
      updatedAt: "2026-08-08 09:10:00",
    }],
  });

  const acknowledgement = await api.main({
    action: "ACK_COMMAND",
    data: {
      deviceId: "station-001",
      deviceSecret: TEST_DEVICE_SECRET,
      commandId: "command-ai-42",
      status: "done",
      result: command.result,
    },
  });
  assert.deepEqual(acknowledgement, { commandId: "command-ai-42", status: "done" });
  const inquiryMirror = documentWrites.find(write => write.name === "inquiries" && write.operation === "set");
  assert.ok(inquiryMirror);
  assert.equal(inquiryMirror.id, "station-001-inquiry-session-42");
  assert.equal(inquiryMirror.data.session_id, "session-42");
  assert.equal(inquiryMirror.data.target_user_id, "member-resolved-42");
  assert.equal(inquiryMirror.data.target_user_name, "Alex on Station");
  assert.equal(inquiryMirror.data.stage, "clarification");
  assert.equal(inquiryMirror.data.next_action, "ask");

  const listed = await api.main({
    action: "LIST_INQUIRIES",
    data: { deviceId: "station-001", limit: 10, includeMessages: true },
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, "session-42");
  assert.equal(listed[0].messageCount, 3);
  assert.deepEqual(listed[0].messages, []);
});

test("cloud inquiry list sends a compact care summary and detail sends the saved process", { concurrency: false }, async () => {
  const { api } = loadCloudApi({
    inquiries: [{
      _id: "inquiry-doc-1",
      deviceId: "station-001",
      inquiry_id: "session-1",
      target_user_id: "member-1",
      target_user_name: "妈妈",
      title: "头痛",
      user_profile: "不应下发到家属摘要列表",
      extracted_information: {
        final_assessment: {
          summary: "先休息并补充水分。",
          next_steps: ["观察体温"],
          seek_care_if: ["头痛突然加重"],
        },
      },
      messages: [
        { role: "user", content: "今天头痛。" },
        { role: "assistant", content: "请问是否发热？" },
      ],
      updatedAt: "2026-08-08 10:00:00",
    }],
  });

  const listed = await api.main({
    action: "LIST_INQUIRIES",
    data: { deviceId: "station-001", limit: 10 },
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messageCount, 2);
  assert.deepEqual(listed[0].messages, []);
  assert.equal(listed[0].reasoning_summary, "先休息并补充水分。");
  assert.deepEqual(Array.from(listed[0].next_steps), ["观察体温"]);
  assert.equal(Object.hasOwn(listed[0], "user_profile"), false);

  const detail = await api.main({
    action: "GET_INQUIRY_DETAIL",
    data: { deviceId: "station-001", inquiryId: "session-1" },
  });
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[1].content, "请问是否发热？");
});
