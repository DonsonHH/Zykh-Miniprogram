function runAfterDeviceSessionReady(callback) {
  const app = typeof getApp === "function" ? getApp() : null;
  const globalData = app && app.globalData || {};
  if (globalData.deviceSessionResolved !== true
    && app
    && typeof app.waitForDeviceSession === "function") {
    return Promise.resolve(app.waitForDeviceSession()).then(() => callback());
  }
  return callback();
}

module.exports = {
  runAfterDeviceSessionReady,
};
