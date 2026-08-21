const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CANONICAL_DIGEST_VERSION,
  canonicalDigest,
  canonicalize,
  canonicalSnapshotDigest,
} = require("../cloudfunctions/api/canonicalDigest");

test("canonical digest golden vector covers Chinese, emoji, numbers and nested keys", () => {
  const value = {
    z: null,
    药: "感冒😀",
    a: [3, 1.25, true, false, { b: 2, a: "x" }],
  };
  assert.equal(CANONICAL_DIGEST_VERSION, "jcs-sha256-v1");
  assert.equal(
    canonicalize(value),
    "{\"a\":[3,1.25,true,false,{\"a\":\"x\",\"b\":2}],\"z\":null,\"药\":\"感冒😀\"}",
  );
  assert.equal(
    canonicalDigest(value),
    "7e87de3fcf3010a4e2f0fe15a30ad618dfb1467900d04a7d6765a7583b364458",
  );
});

test("snapshot digest is stable across object-key and row order", () => {
  const left = [
    { medicineId: "b", name: "乙", storageBox: "CARE" },
    { storageBox: "DAILY", name: "甲", medicineId: "a" },
  ];
  const right = [
    { name: "甲", medicineId: "a", storageBox: "DAILY" },
    { storageBox: "CARE", medicineId: "b", name: "乙" },
  ];
  const digest = rows => canonicalSnapshotDigest(
    "zykh-qsm-001",
    "medicines",
    rows,
    row => row.medicineId,
  );
  assert.equal(digest(left), digest(right));
});

test("canonicalization rejects values outside the JSON/JCS domain", () => {
  assert.throws(() => canonicalize(Number.NaN), /finite numbers/);
  assert.throws(() => canonicalize({ value: undefined }), /does not support field/);
  assert.throws(() => canonicalize("\ud800"), /invalid Unicode surrogate/);
});
