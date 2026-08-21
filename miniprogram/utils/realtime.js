const DEFAULT_INTERVAL_MS = 30000;
const MIN_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 120000;
const DEVTOOLS_INTERVAL_MS = 60000;
const MAX_BACKOFF_MS = 300000;

function boundedInterval(value, fallback = DEFAULT_INTERVAL_MS) {
  const number = Number(value);
  const interval = Number.isFinite(number) && number > 0 ? number : fallback;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, interval));
}

function isDevtools() {
  if (typeof wx === "undefined") return false;
  try {
    if (typeof wx.getDeviceInfo === "function") {
      return String((wx.getDeviceInfo() || {}).platform || "").toLowerCase() === "devtools";
    }
  } catch (error) {
    return false;
  }
  return false;
}

function pollingInterval(options = {}) {
  const requested = boundedInterval(options.intervalMs);
  if (!isDevtools()) return requested;
  const devtoolsFloor = boundedInterval(options.devtoolsIntervalMs, DEVTOOLS_INTERVAL_MS);
  return Math.max(requested, devtoolsFloor);
}

function subscribe(onChange, onError, options = {}) {
  let active = true;
  let refreshTimer = null;
  let running = false;
  let failureCount = 0;
  const intervalMs = pollingInterval(options);
  const maxBackoffMs = Math.max(intervalMs, Number(options.maxBackoffMs) || MAX_BACKOFF_MS);

  const schedule = delay => {
    if (!active) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      runChange();
    }, delay);
  };

  const finish = error => {
    running = false;
    if (!active) return;
    if (error) {
      failureCount += 1;
      if (onError) {
        try {
          onError(error);
        } catch (ignored) {
          // A diagnostics callback must never keep the refresh loop alive.
        }
      }
    } else {
      failureCount = 0;
    }
    const nextDelay = error
      ? Math.min(maxBackoffMs, intervalMs * (2 ** Math.min(failureCount, 4)))
      : intervalMs;
    schedule(nextDelay);
  };

  const runChange = () => {
    if (!active || running) return;
    running = true;
    Promise.resolve()
      .then(() => onChange())
      .then(() => finish(null), error => finish(error));
  };

  schedule(options.immediate === false ? intervalMs : 0);

  return () => {
    active = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  };
}

module.exports = {
  pollingInterval,
  subscribe,
};
