const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../miniprogram/utils/api");

test("the strict medicine reader used by the dashboard is part of the public API", () => {
  assert.equal(typeof api.getMedicinesStrict, "function");
});

test("service-user normalization keeps persona and safety-profile identity without hard-coded people", () => {
  assert.equal(typeof api.compactServiceUser, "function");
  const member = api.compactServiceUser({
    service_user_id: "person-stable-001",
    display_name: "任意家人",
    age: 72,
    persona_generation: "senior-demo-v1",
    safety_profile_revision: 3,
    safety_profile_updated_at: "2026-08-10 09:30:00",
    archived: true,
  });

  assert.equal(member.id, "person-stable-001");
  assert.equal(member.name, "任意家人");
  assert.equal(member.personaGeneration, "senior-demo-v1");
  assert.equal(member.safetyProfileRevision, 3);
  assert.equal(member.safetyProfileUpdatedAt, "2026-08-10 09:30:00");
  assert.equal(member.archived, true);
});

test("every api method referenced by a page is exported by the public adapter", () => {
  const pagesRoot = path.join(__dirname, "../miniprogram/pages");
  const filesBelow = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(file);
    return file.endsWith(".js") ? [file] : [];
  });
  const references = new Set();
  filesBelow(pagesRoot).forEach(file => {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\b/g)) references.add(match[1]);
  });
  const missing = Array.from(references).filter(method => typeof api[method] !== "function").sort();
  assert.deepEqual(missing, []);
});

function installCloud(handler, initialDeviceId = "station-strict") {
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  const state = { deviceId: initialDeviceId };
  global.getApp = () => ({ globalData: { deviceId: state.deviceId } });
  global.wx = {
    cloud: {
      callFunction: ({ data }) => handler(data, state),
    },
  };
  return () => {
    global.getApp = previousGetApp;
    global.wx = previousWx;
  };
}

test("both device readers reject GET_DEVICE failures instead of inventing an offline row", async () => {
  const restore = installCloud(async ({ action }) => {
    assert.equal(action, "GET_DEVICE");
    throw new Error("device transport failed");
  });

  try {
    await assert.rejects(api.getDeviceStrict(), /device transport failed/);
    await assert.rejects(api.getDevice(), /device transport failed/);
  } finally {
    restore();
  }
});

test("a successful null GET_DEVICE response is still invalid", async () => {
  const restore = installCloud(async ({ action, data }) => {
    assert.equal(action, "GET_DEVICE");
    assert.equal(data.deviceId, "station-null");
    return { result: null };
  });

  try {
    await assert.rejects(
      api.getDeviceStrict("station-null"),
      error => error.code === "DEVICE_SNAPSHOT_INVALID",
    );
  } finally {
    restore();
  }
});

test("strict command reads expose LIST_COMMANDS failures while the compatibility reader returns no rows", async () => {
  const restore = installCloud(async ({ action }) => {
    assert.equal(action, "LIST_COMMANDS");
    throw new Error("commands transport failed");
  });

  try {
    await assert.rejects(api.getRecentCommandsStrict(7), /commands transport failed/);
    assert.deepEqual(await api.getRecentCommands(7), []);
  } finally {
    restore();
  }
});

test("strict command reads reject a non-array LIST_COMMANDS payload", async () => {
  const restore = installCloud(async () => ({ result: { rows: [] } }));

  try {
    await assert.rejects(api.getRecentCommandsStrict(), /commands snapshot unavailable/);
  } finally {
    restore();
  }
});

test("strict inquiry reads expose LIST_INQUIRIES failures without running compatibility fallbacks", async () => {
  const actions = [];
  const restore = installCloud(async ({ action }) => {
    actions.push(action);
    if (action === "LIST_INQUIRIES") throw new Error("inquiries transport failed");
    throw new Error(`unexpected compatibility action: ${action}`);
  });

  try {
    await assert.rejects(api.getRecentInquiriesStrict(4), /inquiries transport failed/);
    assert.deepEqual(actions, ["LIST_INQUIRIES"]);
  } finally {
    restore();
  }
});

test("strict inquiry reads keep the compact-and-merge contract for full 2.4 rows", async () => {
  const restore = installCloud(async ({ action, data }) => {
    assert.equal(action, "LIST_INQUIRIES");
    assert.equal(data.includeMessages, true);
    return {
      result: [
        {
          inquiry_id: "shared-session",
          session_id: "shared-session",
          target_user_name: "妈妈",
          status: "result",
          messages: [{ role: "user", content: "older process" }],
          updatedAt: "2026-08-09 09:00:00",
        },
        {
          inquiry_id: "shared-session",
          session_id: "shared-session",
          target_user_name: "妈妈",
          status: "result",
          messages: [
            { role: "user", content: "new question" },
            { role: "assistant", content: "new answer" },
          ],
          updatedAt: "2026-08-09 10:00:00",
        },
      ],
    };
  });

  try {
    const inquiries = await api.getRecentInquiriesStrict(5, { includeMessages: true });
    assert.equal(inquiries.length, 1);
    assert.equal(inquiries[0].sessionId, "shared-session");
    assert.equal(inquiries[0].messageCount, 2);
    assert.deepEqual(inquiries[0].messages, []);
  } finally {
    restore();
  }
});

test("strict snapshots freeze their starting device and compact inquiry data across cloud revisions", async () => {
  const calls = [];
  const restore = installCloud(async ({ action, data }, state) => {
    calls.push({ action, deviceId: data.deviceId });
    if (action === "GET_SNAPSHOT") {
      state.deviceId = "station-switched";
      return {
        result: {
          serviceUsers: [{ id: "member-1", name: "妈妈" }],
          plans: [{ id: "plan-1" }],
          inquiries: [{
            inquiry_id: "session-24",
            session_id: "session-24",
            target_user_name: "妈妈",
            status: "result",
            messages: [{ role: "user", content: "2.4 snapshot process" }],
            updatedAt: "2026-08-09 12:00:00",
          }],
        },
      };
    }
    if (action === "LIST_INQUIRIES") {
      return {
        result: [{
          inquiry_id: "session-22",
          session_id: "session-22",
          target_user_name: "爸爸",
          status: "result",
          messageCount: 2,
          updatedAt: "2026-08-09 13:00:00",
        }],
      };
    }
    if (action === "LIST_COMMANDS") {
      return { result: [{ _id: "command-1", type: "AUDIO_SPEAK" }] };
    }
    throw new Error(`unexpected action: ${action}`);
  }, "station-start");

  try {
    const snapshot = await api.getSnapshotStrict({ inquiryLimit: 12 });

    assert.deepEqual(calls, [
      { action: "GET_SNAPSHOT", deviceId: "station-start" },
      { action: "LIST_INQUIRIES", deviceId: "station-start" },
      { action: "LIST_COMMANDS", deviceId: "station-start" },
    ]);
    assert.deepEqual(snapshot.serviceUsers, [{
      id: "member-1",
      name: "妈妈",
      age: "",
      profile: "",
      status: "",
      personaGeneration: "",
      safetyProfileRevision: "",
      safetyProfileUpdatedAt: "",
      archived: false,
    }]);
    assert.deepEqual(snapshot.commands, [{ _id: "command-1", type: "AUDIO_SPEAK" }]);
    assert.deepEqual(snapshot.inquiries.map(item => item.inquiryId), ["session-22", "session-24"]);
    assert.ok(snapshot.inquiries.every(item => item.messages.length === 0));
  } finally {
    restore();
  }
});

test("strict snapshots reject a successful GET_SNAPSHOT response that is not an object", async () => {
  const actions = [];
  const restore = installCloud(async ({ action }) => {
    actions.push(action);
    return { result: null };
  });

  try {
    await assert.rejects(api.getSnapshotStrict(), /care snapshot unavailable/);
    assert.deepEqual(actions, ["GET_SNAPSHOT"]);
  } finally {
    restore();
  }
});

test("strict snapshots expose inquiry-list failures instead of assembling partial data", async () => {
  const actions = [];
  const restore = installCloud(async ({ action }) => {
    actions.push(action);
    if (action === "GET_SNAPSHOT") return { result: { serviceUsers: [], plans: [] } };
    if (action === "LIST_INQUIRIES") throw new Error("snapshot inquiry read failed");
    if (action === "LIST_COMMANDS") return { result: [] };
    throw new Error(`unexpected fallback action: ${action}`);
  });

  try {
    await assert.rejects(api.getSnapshotStrict(), /snapshot inquiry read failed/);
    assert.deepEqual(actions, ["GET_SNAPSHOT", "LIST_INQUIRIES", "LIST_COMMANDS"]);
  } finally {
    restore();
  }
});

test("strict snapshots expose command-list failures instead of replacing them with an empty list", async () => {
  const restore = installCloud(async ({ action }) => {
    if (action === "GET_SNAPSHOT") return { result: { serviceUsers: [], plans: [] } };
    if (action === "LIST_INQUIRIES") return { result: [] };
    if (action === "LIST_COMMANDS") throw new Error("snapshot command read failed");
    throw new Error(`unexpected fallback action: ${action}`);
  });

  try {
    await assert.rejects(api.getSnapshotStrict(), /snapshot command read failed/);
  } finally {
    restore();
  }
});

test("safety event readers negotiate capabilities and keep list failures strict", async () => {
  const actions = [];
  const restore = installCloud(async ({ action, data }) => {
    actions.push(action);
    if (action === "PING") {
      return {
        result: {
          ok: true,
          schemaVersion: 2,
          schemaRevision: "2.5-caregiver-safety-events",
          capabilities: { medicationSafetyEvents: "v1" },
        },
      };
    }
    if (action === "LIST_MEDICATION_SAFETY_EVENTS") {
      assert.equal(data.deviceId, "safety-station");
      assert.equal(data.personId, "wang-nainai");
      assert.equal(data.unreadOnly, true);
      assert.equal(data.limit, 10);
      return {
        result: {
          items: [{ event_id: "safety-1", check_status: "BLOCKED" }],
          next_cursor: "cursor-2",
        },
      };
    }
    throw new Error(`unexpected action ${action}`);
  }, "safety-station");

  try {
    const capability = await api.getCapabilitiesStrict();
    assert.equal(capability.schemaRevision, "2.5-caregiver-safety-events");
    assert.equal(capability.capabilities.medicationSafetyEvents, "v1");

    const result = await api.getMedicationSafetyEventsStrict({
      personId: "wang-nainai",
      unreadOnly: true,
      limit: 10,
    });
    assert.equal(result.items[0].event_id, "safety-1");
    assert.equal(result.nextCursor, "cursor-2");
    assert.deepEqual(actions, ["PING", "LIST_MEDICATION_SAFETY_EVENTS"]);
  } finally {
    restore();
  }
});

test("safety detail and read-receipt calls stay read-only and preserve the requested device scope", async () => {
  const calls = [];
  const restore = installCloud(async ({ action, data }) => {
    calls.push({ action, data });
    if (action === "GET_MEDICATION_SAFETY_EVENT") {
      return { result: { event_id: data.eventId, check_status: "BLOCKED" } };
    }
    if (action === "MARK_MEDICATION_SAFETY_EVENT_READ") {
      return { result: { ok: true, eventId: data.eventId, state: "READ" } };
    }
    throw new Error(`unexpected action ${action}`);
  }, "station-active");

  try {
    const detail = await api.getMedicationSafetyEventDetail("safety-detail-1", {
      deviceId: "station-captured",
    });
    const receipt = await api.markMedicationSafetyEventRead("safety-detail-1", {
      deviceId: "station-captured",
    });

    assert.equal(detail.event_id, "safety-detail-1");
    assert.equal(receipt.state, "READ");
    assert.deepEqual(calls.map(call => ({
      action: call.action,
      deviceId: call.data.deviceId,
      eventId: call.data.eventId,
    })), [
      {
        action: "GET_MEDICATION_SAFETY_EVENT",
        deviceId: "station-captured",
        eventId: "safety-detail-1",
      },
      {
        action: "MARK_MEDICATION_SAFETY_EVENT_READ",
        deviceId: "station-captured",
        eventId: "safety-detail-1",
      },
    ]);
    assert.deepEqual(calls.map(call => call.action), [
      "GET_MEDICATION_SAFETY_EVENT",
      "MARK_MEDICATION_SAFETY_EVENT_READ",
    ]);
  } finally {
    restore();
  }
});

test("the read-receipt adapter rejects empty, mismatched and explicitly unread acknowledgements", async () => {
  const restore = installCloud(async ({ action, data }) => {
    assert.equal(action, "MARK_MEDICATION_SAFETY_EVENT_READ");
    if (data.eventId === "empty-receipt") return { result: {} };
    if (data.eventId === "mismatched-receipt") {
      return { result: { eventId: "different-event", state: "READ" } };
    }
    return { result: { eventId: data.eventId, state: "UNREAD", ok: true } };
  });

  try {
    await assert.rejects(api.markMedicationSafetyEventRead("empty-receipt"), /read receipt/);
    await assert.rejects(api.markMedicationSafetyEventRead("mismatched-receipt"), /identity mismatch/);
    await assert.rejects(api.markMedicationSafetyEventRead("unread-receipt"), /confirm READ/);
  } finally {
    restore();
  }
});

test("cloud adapter preserves permission metadata for caregiver-safe error states", async () => {
  const restore = installCloud(async ({ action }) => ({
    result: {
      ok: false,
      error: "membership required",
      code: "FORBIDDEN",
      action,
      details: { reason: "NOT_A_DEVICE_MEMBER" },
    },
  }));

  try {
    await assert.rejects(api.getMedicationSafetyEventsStrict(), error => {
      assert.equal(error.message, "membership required");
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.action, "LIST_MEDICATION_SAFETY_EVENTS");
      assert.deepEqual(error.details, { reason: "NOT_A_DEVICE_MEMBER" });
      return true;
    });
  } finally {
    restore();
  }
});

test("the snapshot adapter has no legacy person-data fallback", async () => {
  const scopes = [];
  const restore = installCloud(async ({ action, data }, state) => {
    scopes.push({ action, deviceId: data.deviceId });
    if (action === "GET_SNAPSHOT") {
      state.deviceId = "station-after-failure";
      throw new Error("legacy snapshot action unavailable");
    }
    if (action === "GET_DEVICE") {
      return {
        result: {
          deviceId: data.deviceId,
          syncSummary: { serviceUsers: [{ id: "member-legacy" }], plans: [], recentInquiries: [] },
        },
      };
    }
    if (action === "GET_LATEST_VITALS") return { result: null };
    if (["LIST_MEDICINES", "LIST_RECORDS", "LIST_COMMANDS", "LIST_INQUIRIES"].includes(action)) {
      return { result: [] };
    }
    throw new Error(`unexpected action: ${action}`);
  }, "station-before-failure");

  try {
    await assert.rejects(api.getSnapshot({ inquiryLimit: 8 }), /legacy snapshot action unavailable/);
    assert.equal(scopes.length, 1);
    assert.ok(scopes.every(call => call.deviceId === "station-before-failure"));
  } finally {
    restore();
  }
});
