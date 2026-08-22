const test = require("node:test");
const assert = require("node:assert/strict");

function installStorage() {
  const storage = new Map();
  global.wx = {
    getStorageSync(key) {
      return storage.has(key) ? storage.get(key) : "";
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
  };
  return storage;
}

test("offline page cache restores the last successful view as stale data", () => {
  installStorage();
  const cache = require("../miniprogram/utils/offlinePageCache");
  const updatedAtMs = new Date(2026, 7, 22, 14, 30).getTime();
  assert.equal(cache.savePage("box-a", "home", {
    device: { deviceId: "box-a", online: true, connection: { state: "online", online: true } },
    carePage: {
      phase: { kind: "ready", message: "", action: null },
      focus: { title: "王奶奶今日计划", supporting: "08:00 · 布洛芬" },
      online: true,
      connectionState: "online",
    },
    todoCount: 3,
    detailVisible: true,
  }, { updatedAtMs }), true);

  const restored = cache.restorePage("box-a", "home");
  assert.equal(restored.data.todoCount, 3);
  assert.equal(restored.data.detailVisible, false);
  assert.equal(restored.data.stale, true);
  assert.equal(restored.data.device.online, false);
  assert.equal(restored.data.device.connectionState, "stale");
  assert.equal(restored.data.carePage.connectionStatusText, "上次同步");
  assert.match(restored.data.carePage.focus.supporting, /当前显示上次同步数据/);
  assert.match(restored.data.carePage.focus.supporting, /08:00 · 布洛芬/);
});

test("offline page cache is isolated by medication box and page", () => {
  installStorage();
  const cache = require("../miniprogram/utils/offlinePageCache");
  cache.savePage("box-a", "home", { marker: "a-home" });
  cache.savePage("box-a", "library", { marker: "a-library" });
  cache.savePage("box-b", "home", { marker: "b-home" });

  assert.equal(cache.loadPage("box-a", "home").data.marker, "a-home");
  assert.equal(cache.loadPage("box-a", "library").data.marker, "a-library");
  assert.equal(cache.loadPage("box-b", "home").data.marker, "b-home");
  assert.equal(cache.loadPage("box-b", "library"), null);
});

test("offline page cache overwrites one bounded entry instead of growing per refresh", () => {
  const storage = installStorage();
  const cache = require("../miniprogram/utils/offlinePageCache");
  for (let index = 0; index < 40; index += 1) {
    cache.savePage("box-a", "home", { revision: index });
  }
  const pageKeys = [...storage.keys()].filter(key => key.startsWith("zykh.offline-page.v1:"));
  assert.equal(pageKeys.length, 1);
  assert.equal(cache.loadPage("box-a", "home").data.revision, 39);
});

test("oversized page snapshots are rejected without replacing the last good view", () => {
  installStorage();
  const cache = require("../miniprogram/utils/offlinePageCache");
  cache.savePage("box-a", "records", { marker: "last-good" });
  const oversized = "x".repeat(cache.MAX_ENTRY_BYTES + 1);
  assert.equal(cache.savePage("box-a", "records", { oversized }), false);
  assert.equal(cache.loadPage("box-a", "records").data.marker, "last-good");
});

test("a partial refresh cannot replace a complete last-known snapshot", () => {
  installStorage();
  const cache = require("../miniprogram/utils/offlinePageCache");
  assert.equal(cache.savePage("box-a", "home", { marker: "complete" }, {
    updatedAtMs: 100,
    quality: "complete",
  }), true);
  assert.equal(cache.savePage("box-a", "home", { marker: "partial" }, {
    updatedAtMs: 200,
    quality: "partial",
  }), false);
  const stored = cache.loadPage("box-a", "home");
  assert.equal(stored.quality, "complete");
  assert.equal(stored.updatedAtMs, 100);
  assert.equal(stored.data.marker, "complete");
});

test("a complete refresh upgrades a partial first-use snapshot", () => {
  installStorage();
  const cache = require("../miniprogram/utils/offlinePageCache");
  cache.savePage("box-a", "home", { marker: "partial" }, { quality: "partial" });
  assert.equal(cache.loadPage("box-a", "home").quality, "partial");
  cache.savePage("box-a", "home", { marker: "complete" }, { quality: "complete" });
  assert.equal(cache.loadPage("box-a", "home").quality, "complete");
  assert.equal(cache.loadPage("box-a", "home").data.marker, "complete");
});
