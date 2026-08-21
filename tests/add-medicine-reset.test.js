const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const pagePath = path.join(__dirname, "../miniprogram/pages/addMedicine/index.js");

test("the retired medicine editor is not registered as a user-facing page", () => {
  const app = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../miniprogram/app.json"),
    "utf8",
  ));
  assert.equal(app.pages.includes("pages/addMedicine/index"), false);
});

test("the retained compatibility page cannot submit a remote medicine write", () => {
  const source = fs.readFileSync(pagePath, "utf8");
  assert.doesNotMatch(source, /api\.saveMedicine\s*\(/);
  assert.doesNotMatch(source, /UPSERT_MEDICINE/);
  assert.match(source, /请在药箱端录入/);
  assert.match(source, /以药箱现场识别结果为准/);
});

test("submit only explains Station-side maintenance", () => {
  const previousPage = global.Page;
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  let definition;
  let modal;
  global.Page = value => { definition = value; };
  global.getApp = () => ({ globalData: { deviceId: "zykh-qsm-001" } });
  global.wx = {
    showModal(options) { modal = options; },
  };
  try {
    delete require.cache[require.resolve(pagePath)];
    require(pagePath);
    definition.submit();
    assert.equal(modal.title, "请在药箱端录入");
    assert.equal(modal.showCancel, false);
    assert.match(modal.content, /小程序仅用于查看同步结果/);
  } finally {
    global.Page = previousPage;
    global.wx = previousWx;
    global.getApp = previousGetApp;
  }
});
