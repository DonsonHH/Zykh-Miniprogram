const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../miniprogram/utils/api");

test("a 2.4 inquiry list stays summary-only and supplies the process when detail is unavailable", async () => {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  const calls = [];

  global.getApp = () => ({ globalData: { deviceId: "station-001" } });
  global.wx = {
    cloud: {
      callFunction: async ({ data }) => {
        calls.push(data.action);
        if (data.action === "LIST_INQUIRIES") {
          return {
            result: [{
              inquiry_id: "inquiry-24",
              session_id: "session-24",
              target_user_id: "member-1",
              target_user_name: "妈妈",
              title: "最近头晕",
              reasoning_summary: "建议休息并复测血压。",
              status: "result",
              messages: [
                { id: "turn-1", role: "user", content: "今天有点头晕。" },
                { id: "turn-2", role: "assistant", content: "先坐下休息并复测血压。" },
              ],
            }],
          };
        }
        if (data.action === "GET_INQUIRY_DETAIL") {
          return { result: { ok: false, error: "unknown action: GET_INQUIRY_DETAIL" } };
        }
        throw new Error(`unexpected action: ${data.action}`);
      },
    },
  };

  try {
    const summaries = await api.getRecentInquiries(5);

    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0].messages, []);
    assert.equal(summaries[0].conversationReady, true);

    const detail = await api.getInquiryDetail(summaries[0]);

    assert.deepEqual(detail.messages.map(message => message.content), [
      "今天有点头晕。",
      "先坐下休息并复测血压。",
    ]);
    assert.deepEqual(calls, ["LIST_INQUIRIES", "GET_INQUIRY_DETAIL"]);
  } finally {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
});

test("a long inquiry process reports that the mobile view is truncated", () => {
  const record = api.normalizeInquiryRecord({
    inquiry_id: "long-inquiry",
    target_user_name: "妈妈",
    title: "持续咳嗽",
    messages: Array.from({ length: 65 }, (_, index) => ({
      id: `turn-${index + 1}`,
      role: index % 2 ? "assistant" : "user",
      content: `第 ${index + 1} 条记录`,
    })),
  });

  assert.equal(record.messages.length, 60);
  assert.equal(record.conversationTruncated, true);
});

test("a cached 2.4 inquiry process never crosses medication-box boundaries", async () => {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  let deviceId = "station-cache-a";

  global.getApp = () => ({ globalData: { deviceId } });
  global.wx = {
    cloud: {
      callFunction: async ({ data }) => {
        if (data.action === "LIST_INQUIRIES") {
          return {
            result: [{
              inquiry_id: "shared-inquiry-id",
              session_id: "shared-session-id",
              target_user_name: "妈妈",
              status: "result",
              messages: [{ role: "user", content: "只属于 A 药箱的过程" }],
            }],
          };
        }
        if (data.action === "GET_INQUIRY_DETAIL") {
          return { result: { ok: false, error: "unknown action: GET_INQUIRY_DETAIL" } };
        }
        throw new Error(`unexpected action: ${data.action}`);
      },
    },
  };

  try {
    await api.getRecentInquiries(1);
    deviceId = "station-cache-b";

    await assert.rejects(
      api.getInquiryDetail({ id: "shared-inquiry-id", inquiryId: "shared-inquiry-id" }),
      /unknown action: GET_INQUIRY_DETAIL/,
    );
  } finally {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
});

test("device-summary fallback inquiries use the same compact process adapter", async () => {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;

  global.getApp = () => ({ globalData: { deviceId: "station-summary-fallback" } });
  global.wx = {
    cloud: {
      callFunction: async ({ data }) => {
        if (data.action === "LIST_INQUIRIES") throw new Error("temporary list outage");
        if (data.action === "GET_DEVICE") {
          return {
            result: {
              syncSummary: {
                recentInquiries: [{
                  inquiry_id: "fallback-inquiry",
                  status: "result",
                  target_user_name: "爸爸",
                  messages: [{ role: "assistant", content: "仅在详情里显示" }],
                }],
              },
            },
          };
        }
        if (data.action === "LIST_COMMANDS") return { result: [] };
        if (data.action === "GET_INQUIRY_DETAIL") {
          return { result: { ok: false, error: "unknown action: GET_INQUIRY_DETAIL" } };
        }
        throw new Error(`unexpected action: ${data.action}`);
      },
    },
  };

  try {
    const summaries = await api.getRecentInquiries(5);
    assert.deepEqual(summaries[0].messages, []);

    const detail = await api.getInquiryDetail(summaries[0]);
    assert.equal(detail.messages[0].content, "仅在详情里显示");
  } finally {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
});

test("an inquiry response keeps the medication-box scope captured when its request began", async () => {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  let deviceId = "station-request-a";
  let releaseList;

  global.getApp = () => ({ globalData: { deviceId } });
  global.wx = {
    cloud: {
      callFunction: ({ data }) => {
        if (data.action === "LIST_INQUIRIES") {
          return new Promise(resolve => { releaseList = resolve; });
        }
        if (data.action === "GET_INQUIRY_DETAIL") {
          return Promise.resolve({ result: { ok: false, error: "unknown action: GET_INQUIRY_DETAIL" } });
        }
        throw new Error(`unexpected action: ${data.action}`);
      },
    },
  };

  try {
    const pending = api.getRecentInquiries(1);
    deviceId = "station-request-b";
    releaseList({
      result: [{
        inquiry_id: "request-race-inquiry",
        status: "result",
        messages: [{ role: "user", content: "A 药箱请求返回的过程" }],
      }],
    });
    await pending;

    await assert.rejects(
      api.getInquiryDetail({ id: "request-race-inquiry", inquiryId: "request-race-inquiry" }),
      /unknown action: GET_INQUIRY_DETAIL/,
    );

    deviceId = "station-request-a";
    const detail = await api.getInquiryDetail({ id: "request-race-inquiry", inquiryId: "request-race-inquiry" });
    assert.equal(detail.messages[0].content, "A 药箱请求返回的过程");
  } finally {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
});

test("an inquiry-list failure keeps fallback reads on the medication box that started the request", async () => {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  let deviceId = "station-fallback-a";
  let rejectList;
  const fallbackScopes = [];

  global.getApp = () => ({ globalData: { deviceId } });
  global.wx = {
    cloud: {
      callFunction: ({ data }) => {
        if (data.action === "LIST_INQUIRIES") {
          return new Promise((resolve, reject) => { rejectList = reject; });
        }
        if (data.action === "GET_DEVICE") {
          fallbackScopes.push(data.data.deviceId);
          return Promise.resolve({ result: { deviceId: data.data.deviceId, syncSummary: {} } });
        }
        if (data.action === "LIST_COMMANDS") {
          fallbackScopes.push(data.data.deviceId);
          return Promise.resolve({ result: [] });
        }
        throw new Error(`unexpected action: ${data.action}`);
      },
    },
  };

  try {
    const pending = api.getRecentInquiries(1);
    deviceId = "station-fallback-b";
    rejectList(new Error("list failed after switching boxes"));
    await pending;

    assert.deepEqual(fallbackScopes, ["station-fallback-a", "station-fallback-a"]);
  } finally {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  }
});
