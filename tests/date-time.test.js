const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDate, parseTimestamp } = require("../miniprogram/utils/dateTime");

test("cloud timestamps with slash dates and compact offsets parse without native string parsing", () => {
  assert.equal(
    parseTimestamp("2026/08/11 03:06:23+0000"),
    Date.UTC(2026, 7, 11, 3, 6, 23),
  );
  assert.equal(
    parseTimestamp("2026-08-11T11:06:23+08:00"),
    Date.UTC(2026, 7, 11, 3, 6, 23),
  );
});

test("local cloud timestamps preserve calendar fields", () => {
  const date = parseDate("2026-08-11 03:06:23");
  assert.ok(date);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 7);
  assert.equal(date.getDate(), 11);
  assert.equal(date.getHours(), 3);
  assert.equal(date.getMinutes(), 6);
  assert.equal(date.getSeconds(), 23);
});

test("timestamp objects and numeric epoch strings remain compatible", () => {
  assert.equal(parseTimestamp({ seconds: 100, nanoseconds: 500000000 }), 100500);
  assert.equal(parseTimestamp("1723354800"), 1723354800000);
  assert.equal(parseTimestamp(1723354800000), 1723354800000);
});

test("invalid calendar and unsupported strings fail closed", () => {
  assert.equal(parseTimestamp("2026-02-30 09:00:00"), null);
  assert.equal(parseTimestamp("August 11, 2026"), null);
  assert.equal(parseTimestamp(""), null);
});
