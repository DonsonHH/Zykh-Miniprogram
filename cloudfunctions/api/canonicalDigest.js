const crypto = require("crypto");

const CANONICAL_DIGEST_VERSION = "jcs-sha256-v1";

function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("canonical JSON contains an invalid Unicode surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("canonical JSON contains an invalid Unicode surrogate");
    }
  }
}

function canonicalize(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON only supports finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        throw new Error("canonical JSON does not support undefined array values");
      }
      return canonicalize(item);
    }).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        throw new Error(`canonical JSON does not support field: ${key}`);
      }
      assertValidUnicode(key);
      return `${JSON.stringify(key)}:${canonicalize(item)}`;
    }).join(",")}}`;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalDigest(value) {
  return sha256Hex(canonicalize(value));
}

function canonicalSnapshotDigest(deviceId, kind, rows, rowIdFor) {
  if (typeof rowIdFor !== "function") throw new Error("rowIdFor is required");
  const sortedRows = (rows || []).slice().sort((left, right) => (
    String(rowIdFor(left)) < String(rowIdFor(right))
      ? -1
      : (String(rowIdFor(left)) > String(rowIdFor(right)) ? 1 : 0)
  ));
  return canonicalDigest({ deviceId, kind, rows: sortedRows });
}

module.exports = {
  CANONICAL_DIGEST_VERSION,
  canonicalDigest,
  canonicalize,
  canonicalSnapshotDigest,
  sha256Hex,
};
