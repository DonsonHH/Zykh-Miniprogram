function runAfterDeviceSessionReady(callback) {
  const app = typeof getApp === "function" ? getApp() : null;
  const globalData = app && app.globalData || {};
  // A known household scope is enough to render local/cache-backed pages.
  // Cloud membership resolution continues in the background and only gates
  // remote writes, never the browsing experience.
  if (String(globalData.deviceId || "").trim()) return callback();
  if (globalData.deviceSessionResolved !== true
    && app
    && typeof app.waitForDeviceSession === "function") {
    return Promise.resolve(app.waitForDeviceSession()).then(() => callback());
  }
  return callback();
}

function currentDeviceSession() {
  const app = typeof getApp === "function" ? getApp() : null;
  return app && app.globalData && app.globalData.deviceSession || {};
}

function currentConnection() {
  const session = currentDeviceSession();
  return session.connection && session.connection.state
    ? session.connection
    : null;
}

function errorCode(error) {
  return String(error && (error.code || error.message) || "").trim().toUpperCase();
}

function isPersonaMigrationError(error) {
  return errorCode(error).indexOf("PERSONA_DATA_MIGRATION_IN_PROGRESS") >= 0;
}

module.exports = {
  currentConnection,
  currentDeviceSession,
  errorCode,
  isPersonaMigrationError,
  runAfterDeviceSessionReady,
};
