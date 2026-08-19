const test = require("node:test");
const assert = require("node:assert/strict");

const safetyEvents = require("../miniprogram/modules/medicationSafetyEvents");

test("a blocked safety event with a medicine name is never presented as taken medicine", () => {
  const event = safetyEvents.normalizeMedicationSafetyEvent({
    type: "MEDICATION_SAFETY_CHECK",
    event_id: "safety-wang-001",
    service_user_id: "wang-nainai",
    person_display_name: "王奶奶",
    medicine: {
      id: "slot-13-ibuprofen",
      name: "布洛芬缓释胶囊",
      slot: 13,
    },
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
    caregiver_summary: "检测到已登记的既往胃溃疡与该药禁忌冲突。",
    occurred_at: "2026-08-10 14:30:00",
    read_state: "UNREAD",
    internal_rule_trace: "must-not-cross-the-caregiver-adapter",
  });

  assert.equal(event.id, "safety-wang-001");
  assert.equal(event.personId, "wang-nainai");
  assert.equal(event.medicineName, "布洛芬缓释胶囊");
  assert.equal(event.checkStatus, "BLOCKED");
  assert.equal(event.dispenseStatus, "BLOCKED");
  assert.equal(event.readState, "UNREAD");
  assert.equal(event.raw, undefined);
  assert.equal(event.internal_rule_trace, undefined);
  assert.equal(safetyEvents.isCompletedPhysicalDispense(event), false);

  const record = safetyEvents.projectRecords([event])[0];
  assert.equal(record.type, "safety");
  assert.equal(record.title, "王奶奶 · 已阻止取药");
  assert.match(record.subtitle, /布洛芬缓释胶囊/);
  assert.match(record.subtitle, /药箱未出药/);
  assert.doesNotMatch(record.title, /已取药/);
});

test("unknown safety states fail closed and physical dispense requires positive evidence", () => {
  const unknown = safetyEvents.normalizeMedicationSafetyEvent({
    event_id: "safety-unknown",
    check_status: "MAYBE",
    dispense_status: "MAYBE",
  });
  assert.equal(unknown.checkStatus, "CHECK_FAILED");
  assert.equal(unknown.dispenseStatus, "NOT_STARTED");
  assert.equal(safetyEvents.isCompletedPhysicalDispense(unknown), false);

  const hardwareFailed = safetyEvents.normalizeMedicationSafetyEvent({
    event_id: "safety-hardware-failed",
    check_status: "PASSED",
    dispense_status: "HARDWARE_FAILED",
    medicine_name: "任意药品",
  });
  assert.equal(safetyEvents.isCompletedPhysicalDispense(hardwareFailed), false);
  assert.match(safetyEvents.eventPresentation(hardwareFailed).title, /开柜失败/);
  assert.doesNotMatch(safetyEvents.eventPresentation(hardwareFailed).title, /已取药/);

  assert.equal(safetyEvents.isCompletedPhysicalDispense({
    checkStatus: "PASSED",
    dispenseStatus: "DISPENSED",
  }), true);
  assert.equal(safetyEvents.isCompletedPhysicalDispense({
    checkStatus: "PASSED",
    dispenseStatus: "NOT_STARTED",
    qsmOk: true,
    dryRun: false,
  }), true);
  assert.equal(safetyEvents.isCompletedPhysicalDispense({
    checkStatus: "PASSED",
    dispenseStatus: "NOT_STARTED",
    qsmOk: true,
    dryRun: null,
  }), false);
  assert.equal(safetyEvents.isCompletedPhysicalDispense({
    checkStatus: "BLOCKED",
    dispenseStatus: "DISPENSED",
    qsmOk: true,
    dryRun: false,
  }), false, "a contradictory block can never become a completed dispense");
});

test("an old cloud revision is reported as unsupported without calling an unknown safety action", async () => {
  let listCalls = 0;
  const module = safetyEvents.createMedicationSafetyEventModule({
    getCapabilitiesStrict: async () => ({
      schemaVersion: 2,
      schemaRevision: "2.2-miniprogram",
      capabilities: {},
    }),
    getMedicationSafetyEventsStrict: async () => {
      listCalls += 1;
      return { items: [] };
    },
  });

  const result = await module.list({ limit: 10, unreadOnly: true });

  assert.equal(result.availability, "unsupported");
  assert.equal(result.message, "当前云端版本尚未支持安全记录");
  assert.deepEqual(result.events, []);
  assert.equal(listCalls, 0);
});

test("capability and event read failures stay distinguishable from a real empty safety history", async () => {
  const capabilityFailure = safetyEvents.createMedicationSafetyEventModule({
    getCapabilitiesStrict: async () => {
      throw new Error("PING unavailable");
    },
  });
  const unknown = await capabilityFailure.list();
  assert.equal(unknown.availability, "unknown");
  assert.match(unknown.message, /无法确认/);

  const listFailure = safetyEvents.createMedicationSafetyEventModule({
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => {
      throw new Error("list unavailable");
    },
  });
  const failed = await listFailure.list();
  assert.equal(failed.availability, "error");
  assert.match(failed.message, /读取失败/);

  const emptyHistory = safetyEvents.createMedicationSafetyEventModule({
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [] }),
  });
  const empty = await emptyHistory.list();
  assert.equal(empty.availability, "ready");
  assert.equal(empty.message, "暂无安全核查记录");
});

test("malformed list and detail responses fail closed instead of becoming caregiver facts", async () => {
  const malformedList = safetyEvents.createMedicationSafetyEventModule({
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({
      items: [{ medicine_name: "缺少事件身份与核查状态" }],
    }),
  });
  const listResult = await malformedList.list();
  assert.equal(listResult.availability, "error");
  assert.deepEqual(listResult.events, []);

  const malformedDetail = safetyEvents.createMedicationSafetyEventModule({
    getMedicationSafetyEventDetail: async () => ({ medicine_name: "不是安全事件" }),
  });
  await assert.rejects(malformedDetail.getDetail("expected-event"), /detail unavailable|identity mismatch/);

  const mismatchedDetail = safetyEvents.createMedicationSafetyEventModule({
    getMedicationSafetyEventDetail: async () => ({
      type: "MEDICATION_SAFETY_EVENT",
      event_id: "different-event",
      check_status: "BLOCKED",
    }),
  });
  await assert.rejects(mismatchedDetail.getDetail("expected-event"), /identity mismatch/);
});

test("canonical event_id wins over the cloud document id for detail and read routes", async () => {
  const row = {
    _id: "station-1-safety-canonical-event",
    event_id: "canonical-event",
    type: "MEDICATION_SAFETY_EVENT",
    check_status: "BLOCKED",
  };
  assert.equal(safetyEvents.normalizeMedicationSafetyEvent(row).id, "canonical-event");

  const module = safetyEvents.createMedicationSafetyEventModule({
    getMedicationSafetyEventDetail: async eventId => {
      assert.equal(eventId, "canonical-event");
      return row;
    },
  });
  const detail = await module.getDetail("canonical-event");
  assert.equal(detail.id, "canonical-event");
});

test("conflicting safety-event identities across top-level and payload fail closed", async () => {
  const module = safetyEvents.createMedicationSafetyEventModule({
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({
      items: [{
        event_id: "safety-consistent-event",
        device_id: "box-a",
        person_id: "person-a",
        persona_generation: "generation-a",
        check_status: "BLOCKED",
        payload: {
          eventId: "safety-consistent-event",
          deviceId: "box-b",
          personId: "person-a",
          personaGeneration: "generation-b",
        },
      }],
    }),
    getMedicationSafetyEventDetail: async () => ({
      eventId: "safety-consistent-event",
      deviceId: "box-a",
      personId: "person-a",
      personaGeneration: "generation-a",
      checkStatus: "BLOCKED",
      payload: { person_id: "person-b" },
    }),
  });

  const list = await module.list({ deviceId: "box-a" });
  assert.equal(list.availability, "error");
  assert.deepEqual(list.events, []);
  await assert.rejects(module.getDetail("safety-consistent-event", { deviceId: "box-a" }), /identity mismatch/);
});

test("snake and camel identity aliases remain compatible when every supplied value agrees", async () => {
  const module = safetyEvents.createMedicationSafetyEventModule({
    getMedicationSafetyEventDetail: async () => ({
      event_id: "safety-alias-event",
      deviceId: "box-a",
      person_id: "person-a",
      personaGeneration: "generation-a",
      check_status: "BLOCKED",
      payload: {
        eventId: "safety-alias-event",
        device_id: "box-a",
        serviceUserId: "person-a",
        persona_generation: "generation-a",
      },
    }),
  });

  const detail = await module.getDetail("safety-alias-event", { deviceId: "box-a" });
  assert.equal(detail.id, "safety-alias-event");
  assert.equal(detail.deviceId, "box-a");
  assert.equal(detail.personId, "person-a");
  assert.equal(detail.personaGeneration, "generation-a");
});

test("list and detail reject an event that explicitly belongs to another medication box", async () => {
  const foreign = {
    event_id: "foreign-safety-event",
    device_id: "box-b",
    person_id: "person-a",
    persona_generation: "generation-a",
    check_status: "BLOCKED",
    dispense_status: "BLOCKED",
  };
  const module = safetyEvents.createMedicationSafetyEventModule({
    getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
    getMedicationSafetyEventsStrict: async () => ({ items: [foreign], nextCursor: "" }),
    getMedicationSafetyEventDetail: async () => foreign,
  });

  const list = await module.list({ deviceId: "box-a" });
  assert.equal(list.availability, "error");
  assert.deepEqual(list.events, []);
  await assert.rejects(
    module.getDetail("foreign-safety-event", { deviceId: "box-a" }),
    /device scope mismatch/,
  );
});

test("read receipts fail closed unless the canonical event id and read success are explicit", async () => {
  const receipts = [
    {},
    { eventId: "different-event", state: "READ" },
    { eventId: "canonical-event", ok: true },
    { eventId: "canonical-event", state: "UNREAD", ok: true },
    { eventId: "canonical-event", state: "READ", ok: false },
  ];

  for (const receipt of receipts) {
    const module = safetyEvents.createMedicationSafetyEventModule({
      markMedicationSafetyEventRead: async () => receipt,
    });
    await assert.rejects(module.markRead("canonical-event"), /read receipt/);
  }

  const module = safetyEvents.createMedicationSafetyEventModule({
    markMedicationSafetyEventRead: async () => ({
      event_id: "canonical-event",
      read_state: "READ",
    }),
  });
  const receipt = await module.markRead("canonical-event");
  assert.equal(receipt.read_state, "READ");
});

test("read receipts reject every top-level, payload, or nested identity contradiction", async () => {
  const contradictoryReceipts = [
    {
      eventId: "safety-read-identity",
      deviceId: "box-a",
      state: "READ",
      receipt: { event_id: "another-event", device_id: "box-a", state: "READ" },
    },
    {
      eventId: "safety-read-identity",
      deviceId: "box-a",
      state: "READ",
      receipt: { event_id: "safety-read-identity", device_id: "box-b", state: "READ" },
    },
    {
      eventId: "safety-read-identity",
      deviceId: "box-a",
      personId: "person-a",
      state: "READ",
      payload: { person_id: "person-b" },
    },
  ];

  for (const receipt of contradictoryReceipts) {
    const module = safetyEvents.createMedicationSafetyEventModule({
      markMedicationSafetyEventRead: async () => receipt,
    });
    await assert.rejects(
      module.markRead("safety-read-identity", { deviceId: "box-a", personId: "person-a" }),
      /identity mismatch/,
    );
  }

  const accepted = safetyEvents.createMedicationSafetyEventModule({
    markMedicationSafetyEventRead: async () => ({
      event_id: "safety-read-identity",
      deviceId: "box-a",
      read_state: "READ",
      receipt: { eventId: "safety-read-identity", device_id: "box-a", state: "READ" },
    }),
  });
  await assert.doesNotReject(
    accepted.markRead("safety-read-identity", { deviceId: "box-a" }),
  );
});

test("membership and permission rejections become an explicit forbidden state", async () => {
  for (const code of [
    "FORBIDDEN",
    "CAREGIVER_MEMBERSHIP_REQUIRED",
    "CAREGIVER_PERMISSION_DENIED",
  ]) {
    const module = safetyEvents.createMedicationSafetyEventModule({
      getCapabilitiesStrict: async () => ({ capabilities: { medicationSafetyEvents: "v1" } }),
      getMedicationSafetyEventsStrict: async () => {
        const error = new Error("membership required");
        error.code = code;
        throw error;
      },
    });

    const result = await module.list();
    assert.equal(result.availability, "forbidden", code);
    assert.equal(result.message, "当前微信账号无权查看该药箱", code);
    assert.deepEqual(result.events, [], code);
  }
});

test("home projection promotes the newest explicitly unread block without inventing unread state", () => {
  const projection = safetyEvents.projectHome([
    {
      event_id: "unknown-newer",
      check_status: "BLOCKED",
      dispense_status: "BLOCKED",
      occurred_at: "2026-08-10 11:00:00",
    },
    {
      event_id: "failed-newest",
      check_status: "CHECK_FAILED",
      occurred_at: "2026-08-10 10:30:00",
      read_state: "UNREAD",
    },
    {
      event_id: "blocked-newest",
      check_status: "BLOCKED",
      dispense_status: "BLOCKED",
      occurred_at: "2026-08-10 10:00:00",
      read_state: "UNREAD",
    },
    {
      event_id: "blocked-older",
      check_status: "BLOCKED",
      dispense_status: "BLOCKED",
      occurred_at: "2026-08-10 09:00:00",
      read_state: "UNREAD",
    },
  ], { now: new Date("2026-08-10T12:00:00+08:00") });

  assert.equal(projection.focusBlocked.id, "blocked-newest");
  assert.equal(projection.focusCheckFailed.id, "failed-newest");
  assert.equal(projection.unreadBlockedCount, 2);
  assert.equal(projection.todayBlockedCount, 3);
  assert.deepEqual(projection.unread.map(event => event.id), [
    "failed-newest",
    "blocked-newest",
    "blocked-older",
  ]);
});
