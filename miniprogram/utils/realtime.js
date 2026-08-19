function subscribe(onChange, onError, options = {}) {
  let active = true;
  let refreshTimer = null;
  let fallbackTimer = null;
  let running = false;
  let pending = false;
  const requestedIntervalMs = Number(options.intervalMs);
  const intervalMs = Math.max(5000, Math.min(10000, requestedIntervalMs > 0 ? requestedIntervalMs : 10000));

  const runChange = () => {
    if (!active) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    Promise.resolve()
      .then(() => onChange())
      .catch(error => {
        if (active && onError) onError(error);
      })
      .then(() => {
        running = false;
        if (active && pending) {
          pending = false;
          queueChange(200);
        }
      });
  };

  const queueChange = (delay = 120) => {
    if (!active) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      runChange();
    }, delay);
  };

  if (options.immediate !== false) queueChange(0);
  fallbackTimer = setInterval(() => queueChange(0), intervalMs);

  return () => {
    active = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (fallbackTimer) clearInterval(fallbackTimer);
  };
}

module.exports = {
  subscribe,
};
