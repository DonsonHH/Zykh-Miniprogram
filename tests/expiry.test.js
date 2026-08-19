const test = require("node:test");
const assert = require("node:assert/strict");
const {
  daysUntil,
  expiryView,
  formatExpiryMonth,
  normalizeExpiryDate,
  parseDateOnly,
  summarizeExpiry,
} = require("../miniprogram/utils/expiry");

const now = new Date(2026, 6, 16, 18, 30);

test("parses only real YYYY-MM-DD dates", () => {
  assert.equal(parseDateOnly("2026-07-16").getDate(), 16);
  assert.equal(parseDateOnly("2026-02-30"), null);
  assert.equal(parseDateOnly("2026/07/16"), null);
});

test("preserves the precision shown on the medicine label", () => {
  assert.equal(normalizeExpiryDate("2026-07"), "2026-07");
  assert.equal(normalizeExpiryDate("2026-7"), "2026-07");
  assert.equal(normalizeExpiryDate("2026-07-31"), "2026-07-31");
  assert.equal(normalizeExpiryDate("2026-13"), "");
  assert.equal(normalizeExpiryDate(""), "");
  assert.equal(formatExpiryMonth("2026-07-31"), "2026-07");
  assert.equal(expiryView({ name: "A", expireDate: "2026-07-31" }).expiryLabel, "2026-07-31");
});

test("keeps a month-only expiry usable through the last day of that month", () => {
  const onLastDay = expiryView({ name: "A", expireDate: "2026-08" }, new Date(2026, 7, 31));
  const afterMonth = expiryView({ name: "A", expireDate: "2026-08" }, new Date(2026, 8, 1));

  assert.equal(onLastDay.expiryClass, "urgent");
  assert.equal(afterMonth.expiryClass, "expired");
});

test("calculates whole local calendar days from the proper expiry boundary", () => {
  assert.equal(daysUntil("2026-07", now), 15);
  assert.equal(daysUntil("2026-07-31", now), 15);
  assert.equal(daysUntil("2026-08", now), 46);
  assert.equal(daysUntil("2026-07-15", now), -1);
});

test("classifies expiry attention levels", () => {
  assert.equal(expiryView({ name: "A", expireDate: "2026-06-30" }, now).expiryClass, "expired");
  assert.equal(expiryView({ name: "A", expireDate: "2026-07" }, now).expiryClass, "urgent");
  assert.equal(expiryView({ name: "A", expireDate: "2026-08" }, now).expiryClass, "soon");
  assert.equal(expiryView({ name: "A", expireDate: "2026-11" }, now).expiryClass, "valid");
  assert.equal(expiryView({ name: "A", expireDate: "" }, now).expiryClass, "missing");
  assert.equal(expiryView({ name: "", expireDate: "" }, now).expiryClass, "empty");
});

test("summarizes and sorts expiry attention by urgency without changing precision", () => {
  const summary = summarizeExpiry([
    { name: "Missing", expireDate: "" },
    { name: "Soon", expireDate: "2026-08" },
    { name: "Expired", expireDate: "2026-06-30" },
    { name: "Urgent", expireDate: "2026-07" },
    { name: "Valid", expireDate: "2027-07" },
  ], now);

  assert.equal(summary.expiredCount, 1);
  assert.equal(summary.expiringCount, 2);
  assert.equal(summary.missingCount, 1);
  assert.equal(summary.validCount, 1);
  assert.deepEqual(summary.attention.map(item => item.name), ["Expired", "Urgent", "Soon", "Missing"]);
  assert.equal(summary.medicines.find(item => item.name === "Expired").expireDate, "2026-06-30");
  assert.equal(summary.medicines.find(item => item.name === "Expired").expiryMonth, "2026-06");
});
