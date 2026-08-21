function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function timestampFromObject(value) {
  if (!value || typeof value !== "object") return null;
  if (value instanceof Date) return finiteTimestamp(value.getTime());

  if (typeof value.toDate === "function") {
    try {
      const date = value.toDate();
      if (date instanceof Date) return finiteTimestamp(date.getTime());
    } catch (error) {
      return null;
    }
  }

  const seconds = value.seconds !== undefined ? value.seconds : value._seconds;
  if (Number.isFinite(Number(seconds))) {
    const nanoseconds = value.nanoseconds !== undefined ? value.nanoseconds : value._nanoseconds;
    return Number(seconds) * 1000 + Math.floor((Number(nanoseconds) || 0) / 1000000);
  }
  return null;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return finiteTimestamp(value);
  if (typeof value === "object") return timestampFromObject(value);

  const text = String(value).trim();
  if (!text) return null;
  if (/^-?\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return text.replace(/^-/, "").length === 10 ? numeric * 1000 : numeric;
  }

  const match = text.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:\s*(Z|([+-])(\d{2}):?(\d{2})))?$/i,
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const millisecond = Number(String(match[7] || "0").padEnd(3, "0").slice(0, 3));
  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || hour < 0 || hour > 23
    || minute < 0 || minute > 59
    || second < 0 || second > 59
  ) return null;

  const timezone = String(match[8] || "").toUpperCase();
  if (timezone) {
    const utc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    const check = new Date(utc);
    if (
      check.getUTCFullYear() !== year
      || check.getUTCMonth() !== month - 1
      || check.getUTCDate() !== day
    ) return null;
    if (timezone === "Z") return utc;

    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    const direction = match[9] === "+" ? 1 : -1;
    return utc - direction * (offsetHour * 60 + offsetMinute) * 60 * 1000;
  }

  const local = new Date(year, month - 1, day, hour, minute, second, millisecond);
  if (
    local.getFullYear() !== year
    || local.getMonth() !== month - 1
    || local.getDate() !== day
    || local.getHours() !== hour
    || local.getMinutes() !== minute
    || local.getSeconds() !== second
  ) return null;
  return local.getTime();
}

function parseDate(value) {
  const timestamp = parseTimestamp(value);
  return timestamp === null ? null : new Date(timestamp);
}

module.exports = {
  parseDate,
  parseTimestamp,
};
