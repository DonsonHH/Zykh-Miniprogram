const DEFAULT_DEVICE_ID = "zykh-qsm-001";

function todayAt(hour = "09:00:00") {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${hour}`;
}

// This is the current family's registered safety rule. Cloud events take
// priority when they are available; this rule keeps the app useful while a
// newly connected device has not uploaded its first safety event yet.
function getFixedMedicationRiskFixtures(deviceId = "") {
  const requestedDeviceId = String(deviceId || "").trim();
  if (!requestedDeviceId || requestedDeviceId !== DEFAULT_DEVICE_ID) return [];

  return [{
    type: "MEDICATION_SAFETY_EVENT",
    event_id: "local-risk-wang-ulcer-ibuprofen",
    device_id: requestedDeviceId,
    person_display_name: "王奶奶",
    medicine_name: "布洛芬缓释胶囊",
    check_status: "BLOCKED",
    dispense_status: "NOT_APPLICABLE",
    reason_codes: ["CONTRAINDICATION"],
    reason_summary: "王奶奶已登记既往胃溃疡，布洛芬可能增加胃部刺激和消化道出血风险。",
    caregiver_summary: "王奶奶有胃溃疡，不建议自行使用布洛芬缓释胶囊。",
    outcome_text: "暂不使用布洛芬缓释胶囊，请先咨询医生或药师。",
    occurred_at: todayAt(),
    read_state: "UNREAD",
    source: "family-safety-baseline",
    local_only: true,
  }];
}

module.exports = {
  DEFAULT_DEVICE_ID,
  getFixedMedicationRiskFixtures,
};
