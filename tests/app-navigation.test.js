const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("five tabs follow the family-care journey and use the shared Station palette", () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, "../miniprogram/app.json"), "utf8"));
  const tabs = app.tabBar.list;

  assert.deepEqual(tabs.map(item => item.pagePath), [
    "pages/index/index",
    "pages/library/index",
    "pages/ai/index",
    "pages/records/index",
    "pages/settings/index",
  ]);
  assert.deepEqual(tabs.map(item => item.text), ["首页", "药库", "问询", "照护", "家人"]);
  assert.equal(app.window.backgroundColor, "#F6F9FC");
  assert.equal(app.window.navigationBarBackgroundColor, "#F6F9FC");
});
