const test = require("node:test");
const assert = require("node:assert/strict");

const realtime = require("../miniprogram/utils/realtime");

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test("a scoped refresh subscription performs its authenticated read immediately", async () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  global.getApp = () => ({ globalData: { deviceId: "box-1" } });
  global.wx = {
    getStorageSync: () => "box-1",
    getSystemInfoSync: () => ({ platform: "devtools" }),
    cloud: {
      callFunction: async () => ({ result: { schemaVersion: 2 } }),
    },
  };
  let refreshCount = 0;
  let stop;

  try {
    stop = realtime.subscribe(() => {
      refreshCount += 1;
    }, null, { pollOnly: true, intervalMs: 60000 });
    await nextTurn();

    assert.equal(refreshCount, 1);
  } finally {
    if (stop) stop();
    global.wx = previousWx;
    global.getApp = previousGetApp;
  }
});

test("pages that already loaded onShow can disable the duplicate immediate refresh", async () => {
  let refreshCount = 0;
  const stop = realtime.subscribe(() => {
    refreshCount += 1;
  }, null, { immediate: false, intervalMs: 10000 });

  try {
    await nextTurn();
    assert.equal(refreshCount, 0);
  } finally {
    stop();
  }
});

test("a scoped refresh never opens a direct database watch for requested collections", async () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  let databaseOpenCount = 0;
  let watchCount = 0;
  const query = {
    where() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    watch() {
      watchCount += 1;
      return { close() {} };
    },
  };
  global.getApp = () => ({ globalData: { deviceId: "box-1" } });
  global.wx = {
    getStorageSync: () => "box-1",
    getSystemInfoSync: () => ({ platform: "ios" }),
    cloud: {
      callFunction: async () => ({ result: { schemaVersion: 2 } }),
      database() {
        databaseOpenCount += 1;
        return { collection: () => query };
      },
    },
  };
  let stop;

  try {
    stop = realtime.subscribe(() => {}, null, {
      collections: ["devices", "vitals", "records"],
      intervalMs: 60000,
    });
    await nextTurn();
    await nextTurn();

    assert.equal(databaseOpenCount, 0);
    assert.equal(watchCount, 0);
  } finally {
    if (stop) stop();
    global.wx = previousWx;
    global.getApp = previousGetApp;
  }
});

test("stopping a scoped refresh cancels its one-shot timer and makes late callbacks inert", async () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const timeouts = new Map();
  let nextTimerId = 1;
  global.setTimeout = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timeouts.set(id, { callback, delay });
    return id;
  };
  global.clearTimeout = id => timeouts.delete(id);
  let refreshCount = 0;

  try {
    const stop = realtime.subscribe(() => {
      refreshCount += 1;
    }, null, { intervalMs: 20000 });
    const immediateEntry = Array.from(timeouts.entries()).find(([, timer]) => timer.delay === 0);
    assert.ok(immediateEntry);
    timeouts.delete(immediateEntry[0]);
    immediateEntry[1].callback();
    await nextTurn();
    assert.equal(refreshCount, 1);

    const poll = Array.from(timeouts.values()).find(timer => timer.delay === 20000);
    assert.ok(poll);

    stop();
    assert.equal(timeouts.size, 0);

    poll.callback();
    await nextTurn();
    assert.equal(refreshCount, 1);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test("polling waits for a slow refresh to settle before scheduling the next read", async () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const timeouts = new Map();
  let nextTimerId = 1;
  global.setTimeout = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timeouts.set(id, { callback, delay });
    return id;
  };
  global.clearTimeout = id => timeouts.delete(id);
  let finishRefresh;
  const refresh = new Promise(resolve => { finishRefresh = resolve; });

  try {
    const stop = realtime.subscribe(() => refresh, null, { intervalMs: 20000 });
    const immediateEntry = Array.from(timeouts.entries()).find(([, timer]) => timer.delay === 0);
    assert.ok(immediateEntry);
    timeouts.delete(immediateEntry[0]);
    immediateEntry[1].callback();
    await nextTurn();
    assert.equal(timeouts.size, 0);

    finishRefresh();
    await nextTurn();
    assert.equal(Array.from(timeouts.values()).filter(timer => timer.delay === 20000).length, 1);
    stop();
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test("the simulator polls less often while real devices retain the requested interval", () => {
  const previousWx = global.wx;
  try {
    global.wx = { getDeviceInfo: () => ({ platform: "devtools" }) };
    assert.equal(realtime.pollingInterval({ intervalMs: 20000 }), 60000);
    global.wx = { getDeviceInfo: () => ({ platform: "ios" }) };
    assert.equal(realtime.pollingInterval({ intervalMs: 20000 }), 20000);
  } finally {
    global.wx = previousWx;
  }
});

test("an in-flight refresh that settles after stop cannot report a stale error", async () => {
  let rejectRefresh;
  const refresh = new Promise((resolve, reject) => {
    rejectRefresh = reject;
  });
  let refreshCount = 0;
  let errorCount = 0;
  let stop = realtime.subscribe(() => {
    refreshCount += 1;
    return refresh;
  }, () => {
    errorCount += 1;
  }, { intervalMs: 60000 });

  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    await nextTurn();
    assert.equal(refreshCount, 1);
    stop();
    stop = null;
    rejectRefresh(new Error("late failure"));
    await nextTurn();

    assert.equal(errorCount, 0);
    assert.equal(refreshCount, 1);
  } finally {
    if (stop) stop();
  }
});
