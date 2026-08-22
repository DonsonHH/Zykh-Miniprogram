const CACHE_VERSION = 1;
const CACHE_PREFIX = "zykh.offline-page.v1";
const CACHE_INDEX_KEY = "zykh.offline-page.index.v1";
const MAX_CACHE_ENTRIES = 18;
const MAX_ENTRY_BYTES = 512 * 1024;
const CACHE_QUALITY = Object.freeze({ partial: 1, complete: 2 });

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function safeToken(value, fallback = "unknown") {
  const normalized = text(value).replace(/[^A-Za-z0-9_.-]/g, "-");
  return normalized || fallback;
}

function cacheKey(deviceId, pageKey) {
  return `${CACHE_PREFIX}:${safeToken(deviceId, "unbound")}:${safeToken(pageKey, "page")}`;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function storageAvailable(method) {
  return typeof wx !== "undefined" && typeof wx[method] === "function";
}

function readStorage(key, fallback) {
  if (!storageAvailable("getStorageSync")) return fallback;
  try {
    const value = wx.getStorageSync(key);
    return value === undefined || value === null || value === "" ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

function writeStorage(key, value) {
  if (!storageAvailable("setStorageSync")) return false;
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

function entryQuality(value) {
  return text(value).toLowerCase() === "partial" ? "partial" : "complete";
}

function utf8ByteLength(value) {
  const source = String(value || "");
  let bytes = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff
      && index + 1 < source.length
      && source.charCodeAt(index + 1) >= 0xdc00
      && source.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function removeStorage(key) {
  if (!storageAvailable("removeStorageSync")) return;
  try {
    wx.removeStorageSync(key);
  } catch (error) {
    // Cache cleanup must never block the care experience.
  }
}

function formatUpdatedAt(value) {
  const epoch = Number(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return "上次同步时间未知";
  const date = new Date(epoch);
  if (Number.isNaN(date.getTime())) return "上次同步时间未知";
  const now = new Date();
  const pad = number => String(number).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return `今天 ${clock}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function normalizedIndex() {
  const index = readStorage(CACHE_INDEX_KEY, []);
  if (!Array.isArray(index)) return [];
  return index
    .filter(item => item && text(item.key) && Number.isFinite(Number(item.updatedAtMs)))
    .map(item => ({ key: text(item.key), updatedAtMs: Number(item.updatedAtMs) }));
}

function updateIndex(key, updatedAtMs) {
  const next = normalizedIndex().filter(item => item.key !== key);
  next.push({ key, updatedAtMs });
  next.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  const retained = next.slice(0, MAX_CACHE_ENTRIES);
  next.slice(MAX_CACHE_ENTRIES).forEach(item => removeStorage(item.key));
  writeStorage(CACHE_INDEX_KEY, retained);
}

function scrubTransientState(data = {}) {
  const next = clone(data) || {};
  [
    "detailVisible",
    "processVisible",
    "pairingBusy",
    "reminderSubmitting",
    "measuring",
    "commandInFlight",
  ].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = false;
  });
  if (next.safetyPaginationStatus === "loading") next.safetyPaginationStatus = "idle";
  next.initialLoading = false;
  next.loadError = "";
  return next;
}

function savePage(deviceId, pageKey, data, options = {}) {
  const normalizedDeviceId = text(deviceId);
  const normalizedPageKey = text(pageKey);
  if (!normalizedDeviceId || !normalizedPageKey || !data || typeof data !== "object") return false;
  let payload;
  try {
    payload = scrubTransientState(data);
  } catch (error) {
    return false;
  }
  const updatedAtMs = Number(options.updatedAtMs) || Date.now();
  const quality = entryQuality(options.quality);
  const key = cacheKey(normalizedDeviceId, normalizedPageKey);
  const previous = readStorage(key, null);
  if (previous
    && entryQuality(previous.quality) === "complete"
    && CACHE_QUALITY[quality] < CACHE_QUALITY.complete) {
    return false;
  }
  const entry = {
    version: CACHE_VERSION,
    deviceId: normalizedDeviceId,
    pageKey: normalizedPageKey,
    updatedAtMs,
    quality,
    data: payload,
  };
  let serialized;
  try {
    serialized = JSON.stringify(entry);
  } catch (error) {
    return false;
  }
  if (utf8ByteLength(serialized) > MAX_ENTRY_BYTES) return false;
  if (!writeStorage(key, entry)) return false;
  updateIndex(key, updatedAtMs);
  return true;
}

function loadPage(deviceId, pageKey) {
  const normalizedDeviceId = text(deviceId);
  const normalizedPageKey = text(pageKey);
  if (!normalizedDeviceId || !normalizedPageKey) return null;
  const entry = readStorage(cacheKey(normalizedDeviceId, normalizedPageKey), null);
  if (!entry
    || Number(entry.version) !== CACHE_VERSION
    || text(entry.deviceId) !== normalizedDeviceId
    || text(entry.pageKey) !== normalizedPageKey
    || !entry.data
    || typeof entry.data !== "object"
    || Array.isArray(entry.data)) return null;
  try {
    return {
      deviceId: normalizedDeviceId,
      pageKey: normalizedPageKey,
      updatedAtMs: Number(entry.updatedAtMs) || 0,
      updatedAtText: formatUpdatedAt(entry.updatedAtMs),
      quality: entryQuality(entry.quality),
      data: clone(entry.data),
    };
  } catch (error) {
    return null;
  }
}

function staleConnection(updatedAtMs) {
  return {
    state: "stale",
    online: false,
    reason: "当前显示上次同步内容",
    title: "上次同步",
    hint: formatUpdatedAt(updatedAtMs),
  };
}

function markDeviceStale(device = {}, updatedAtMs = 0) {
  return Object.assign({}, clone(device) || {}, {
    online: false,
    connection: staleConnection(updatedAtMs),
    connectionState: "stale",
  });
}

function markCarePageStale(carePage = {}, updatedAtMs = 0) {
  const next = clone(carePage) || {};
  const updatedAtText = formatUpdatedAt(updatedAtMs);
  next.online = false;
  next.connection = staleConnection(updatedAtMs);
  next.connectionState = "stale";
  next.connectionStatusText = "上次同步";
  next.connectionStatusHint = updatedAtText;
  next.showStatus = true;
  if (next.phase && next.phase.kind !== "ready") {
    next.phase = { kind: "ready", message: "", action: null };
  }
  if (next.focus && typeof next.focus === "object") {
    const current = text(next.focus.supporting)
      .replace(/^刷新失败，[^。]*。\s*/, "")
      .replace(/^当前显示上次同步数据[^。]*。\s*/, "");
    next.focus.supporting = [`当前显示上次同步数据 · ${updatedAtText}`, current]
      .filter(Boolean)
      .join("。 ");
  }
  return next;
}

function restorePage(deviceId, pageKey) {
  const entry = loadPage(deviceId, pageKey);
  if (!entry) return null;
  const data = scrubTransientState(entry.data);
  data.stale = true;
  data.offlineSnapshot = true;
  data.lastSyncedAtMs = entry.updatedAtMs;
  data.lastSyncedAtText = entry.updatedAtText;
  if (data.device && typeof data.device === "object") {
    data.device = markDeviceStale(data.device, entry.updatedAtMs);
  }
  if (data.carePage && typeof data.carePage === "object") {
    data.carePage = markCarePageStale(data.carePage, entry.updatedAtMs);
  }
  return {
    data,
    updatedAtMs: entry.updatedAtMs,
    updatedAtText: entry.updatedAtText,
    quality: entry.quality,
  };
}

function pick(data = {}, keys = []) {
  return (keys || []).reduce((result, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
    return result;
  }, {});
}

module.exports = {
  CACHE_VERSION,
  CACHE_QUALITY,
  MAX_CACHE_ENTRIES,
  MAX_ENTRY_BYTES,
  cacheKey,
  formatUpdatedAt,
  loadPage,
  markCarePageStale,
  markDeviceStale,
  pick,
  restorePage,
  savePage,
};
