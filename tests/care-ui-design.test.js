const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const miniRoot = path.join(root, "miniprogram");
const carePages = ["index", "cabinet", "vitals", "records", "ai", "settings", "familyDetail"];
const primaryTabs = ["index", "library", "ai", "records", "settings"];

function pageFile(page, name) {
  return path.join(miniRoot, "pages", page, name);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function openingTag(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing interactive marker: ${marker}`);
  const start = source.lastIndexOf("<", markerIndex);
  const end = source.indexOf(">", markerIndex);
  assert.notEqual(start, -1, `missing opening tag for: ${marker}`);
  assert.notEqual(end, -1, `unterminated opening tag for: ${marker}`);
  return source.slice(start, end + 1);
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{`).exec(source);
  const start = match ? source.indexOf("{", match.index) : -1;
  assert.notEqual(start, -1, `missing CSS rule: ${selector}`);
  const end = source.indexOf("}", start);
  return source.slice(start, end + 1);
}

function filesBelow(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(file, extension);
    return file.endsWith(extension) ? [file] : [];
  });
}

test("every primary care page renders through one semantic care-screen seam", () => {
  for (const page of carePages) {
    const config = JSON.parse(read(pageFile(page, "index.json")));
    const layout = read(pageFile(page, "index.wxml"));
    const logic = read(pageFile(page, "index.js"));

    assert.equal(config.usingComponents["care-screen"], "/components/careScreen/index", page);
    assert.match(layout, /<care-screen model="\{\{carePage\}\}" bind:action="onCarePageAction"\s*\/>/, page);
    assert.doesNotMatch(layout, /<app-header/, page);
    assert.match(logic, /composeCarePage/, page);
    assert.match(logic, /loadingCarePage/, page);
  }
});

test("the care screen owns one focus, compact facts and flat semantic lists", () => {
  const layout = read(path.join(miniRoot, "components", "careScreen", "index.wxml"));
  const styles = read(path.join(miniRoot, "components", "careScreen", "index.wxss"));

  assert.equal((layout.match(/class="care-focus /g) || []).length, 1);
  assert.equal((layout.match(/class="care-primary \{\{model\.focus\.action\.disabled/g) || []).length, 1);
  assert.match(layout, /wx:for="\{\{model\.overview\}\}"/);
  assert.match(layout, /wx:for="\{\{model\.sections\}\}"/);
  assert.match(layout, /care-section--\{\{section\.intent\}\}/);
  assert.match(layout, /class="care-fact__arrow"/);
  assert.match(layout, /aria-label="\{\{item\.ariaLabel\}\}"/);
  assert.match(layout, /class="care-filters" aria-role="tablist"/);
  assert.match(layout, /aria-role="tab"/);
  assert.match(layout, /aria-selected="\{\{filter\.active\}\}"/);
  assert.match(layout, /aria-label="\{\{entry\.ariaLabel\}\}"/);
  assert.match(layout, /aria-disabled="\{\{section\.more\.disabled\}\}"/);
  assert.match(layout, /hover-class="\{\{section\.more\.disabled \? 'none' : 'care-pressed'\}\}"/);
  assert.match(cssRule(styles, ".care-focus"), /box-shadow/);
  assert.doesNotMatch(cssRule(styles, ".care-item"), /box-shadow|border-radius|background:/);
  assert.doesNotMatch(cssRule(styles, ".care-list"), /box-shadow/);
});

test("the shared care type scale makes hierarchy explicit and keeps body text readable", () => {
  const styles = read(path.join(miniRoot, "components", "careScreen", "index.wxss"));

  assert.match(cssRule(styles, ".care-focus__title"), /font-size:\s*44rpx/);
  assert.match(cssRule(styles, ".care-focus__supporting"), /-webkit-line-clamp:\s*4/);
  assert.match(cssRule(styles, ".care-section__title"), /font-size:\s*34rpx/);
  assert.match(cssRule(styles, ".care-item__title"), /font-size:\s*30rpx/);
  assert.match(cssRule(styles, ".care-item__supporting"), /font-size:\s*26rpx/);
  assert.match(cssRule(styles, ".care-state"), /font-size:\s*24rpx/);
  assert.match(cssRule(styles, ".care-fact__label"), /font-size:\s*25rpx/);
});

test("no Mini Program stylesheet can reintroduce sub-24rpx visible text", () => {
  const violations = [];
  for (const file of filesBelow(miniRoot, ".wxss")) {
    const source = read(file);
    for (const match of source.matchAll(/font-size:\s*(\d+)rpx/g)) {
      if (Number(match[1]) < 24) {
        violations.push(`${path.relative(root, file)}:${match.index}:${match[1]}rpx`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("interactive care controls preserve at least a 44px touch target", () => {
  const care = read(path.join(miniRoot, "components", "careScreen", "index.wxss"));
  const shared = read(path.join(miniRoot, "styles", "care-ui.wxss"));
  const medicineList = read(pageFile("medicineList", "index.wxss"));
  const editor = read(pageFile("addMedicine", "index.wxss"));
  const settings = read(pageFile("settings", "index.wxss"));

  for (const [source, selector] of [
    [care, ".care-primary"],
    [care, ".care-filter"],
    [care, ".care-link"],
    [care, ".care-detail-action"],
    [shared, ".ui-link"],
    [shared, ".ui-sheet-close"],
    [medicineList, ".cabinet-primary"],
    [medicineList, ".cabinet-filter"],
    [editor, ".medicine-segmented__item"],
    [editor, ".medicine-reset"],
    [settings, ".device-action"],
  ]) {
    assert.match(cssRule(source, selector), /min-height:\s*(?:88|9\d|1\d{2,})rpx/, selector);
  }
});

test("detail-heavy flows remain on demand instead of crowding first screens", () => {
  const expectations = {
    index: [/class="ui-sheet"/, /wx:for="\{\{todoItems\}\}"/, /wx:for="\{\{timeline\}\}"/],
    vitals: [/class="ui-sheet vitals-sheet"/, /wx:for="\{\{detailRows\}\}"/],
    records: [/class="ui-sheet care-record-sheet"/, /wx:for="\{\{detailList\}\}"/],
    ai: [/class="ui-sheet inquiry-sheet"/, /activeInquiry\.messages/],
    settings: [/class="ui-sheet family-detail-sheet"/, /detailMode === 'device'/],
  };

  for (const [page, patterns] of Object.entries(expectations)) {
    const layout = read(pageFile(page, "index.wxml"));
    patterns.forEach(pattern => assert.match(layout, pattern, page));
  }
});

test("secondary interaction surfaces expose button, label and selection semantics", () => {
  const settings = read(pageFile("settings", "index.wxml"));
  const medicineList = read(pageFile("medicineList", "index.wxml"));
  const home = read(pageFile("index", "index.wxml"));

  for (const [marker, label] of [
    ['bindtap="testVoiceReminder"', "测试药箱语音提醒"],
    ['bindtap="toggleBindForm"', "更换绑定药箱"],
    ['bindtap="bindDevice"', "确认切换药箱"],
    ['bindtap="showCommandDetails"', "查看协同日志"],
    ['bindtap="showDeviceDetails"', "返回药箱管理"],
  ]) {
    const tag = openingTag(settings, marker);
    assert.match(tag, /aria-role="button"/);
    assert.match(tag, new RegExp(`aria-label="${label}"`));
  }

  const member = openingTag(settings, 'wx:if="{{item.personId}}"');
  assert.match(member, /bindtap="openMemberDetail"/);
  assert.match(member, /aria-role="button"/);
  assert.match(member, /aria-label="[^"]*item\.careStatusText[^"]*"/);

  const staticMember = openingTag(settings, 'wx:else class="family-member"');
  assert.doesNotMatch(staticMember, /bindtap=|aria-role="button"/);

  const cancelBinding = openingTag(settings, 'aria-label="取消更换药箱"');
  assert.match(cancelBinding, /bindtap="toggleBindForm"/);
  assert.match(cancelBinding, /aria-role="button"/);

  for (const [filter, label] of [
    ["all", "显示全部药品"],
    ["expiring", "只显示临期药品"],
    ["expired", "只显示已过期药品"],
    ["missing", "只显示待补有效期药品"],
    ["depleted", "只显示待补药药品"],
  ]) {
    const tag = openingTag(medicineList, `data-filter="${filter}"`);
    assert.match(tag, /aria-role="tab"/);
    assert.match(tag, new RegExp(`aria-label="${label}"`));
    assert.match(tag, new RegExp(`aria-selected="\\{\\{filter == '${filter}'\\}\\}"`));
  }

  const medicineFilters = openingTag(medicineList, 'class="cabinet-filter-row"');
  assert.match(medicineFilters, /aria-role="tablist"/);
  assert.match(medicineFilters, /aria-label="药品筛选"/);

  const registration = openingTag(medicineList, 'bindtap="goAddMedicine"');
  assert.match(registration, /aria-label="登记\{\{primarySlot\}\}号仓药品"/);

  const medicineRow = openingTag(medicineList, 'bindtap="selectSlot"');
  assert.match(medicineRow, /aria-role="button"/);
  assert.match(medicineRow, /aria-label="维护\{\{item\.slot\}\}号仓/);

  const homeTodo = openingTag(home, 'data-action="{{item.action}}"');
  assert.match(homeTodo, /aria-role="button"/);
  assert.match(homeTodo, /aria-label="\{\{item\.title\}\}，\{\{item\.desc\}\}，\{\{item\.actionLabel\}\}"/);

  const timelineRow = openingTag(home, 'wx:for="{{timeline}}"');
  assert.doesNotMatch(timelineRow, /aria-role="button"/);
});

test("forms and full histories stay purpose-built but use the same readable primitives", () => {
  const editor = read(pageFile("addMedicine", "index.wxml"));
  const history = read(pageFile("ai/history", "index.wxml"));
  const historyLogic = read(pageFile("ai/history", "index.js"));

  assert.match(editor, /<app-header[\s\S]*title="药品维护"/);
  assert.match(editor, /medicine-flow__step/);
  assert.match(history, /<app-header[\s\S]*title="\{\{pageTitle\}\}"/);
  assert.match(historyLogic, /pageTitle:\s*"问询历史"/);
  assert.match(history, /wx:for="\{\{inquiryGroups\}\}"/);
  assert.match(history, /class="inquiry-card ui-pressable"[\s\S]*aria-role="button"/);
  assert.match(history, /aria-label="[^"]*\{\{record\.topic\}\}[^"]*"/);
  assert.match(history, /activeInquiry\.processError/);
});

test("page styles import domain styles, never another page implementation", () => {
  const imports = [];
  for (const file of filesBelow(path.join(miniRoot, "pages"), ".wxss")) {
    for (const match of read(file).matchAll(/@import\s+"([^"]+)"/g)) {
      imports.push({ file, target: match[1] });
    }
  }

  assert.ok(imports.some(item => item.file.endsWith(path.join("ai", "index.wxss"))));
  assert.ok(imports.some(item => item.file.endsWith(path.join("ai", "history", "index.wxss"))));
  imports.forEach(item => {
    assert.match(item.target, /styles\//, `${path.relative(root, item.file)} imports ${item.target}`);
    assert.doesNotMatch(item.target, /pages\//);
  });
  assert.doesNotMatch(read(pageFile("medicineList", "index.wxss")), /cabinet\/index\.wxss/);
});

test("inquiry detail presentation has one shared domain stylesheet", () => {
  const mainStyles = read(pageFile("ai", "index.wxss"));
  const historyStyles = read(pageFile("ai/history", "index.wxss"));
  const shared = read(path.join(miniRoot, "styles", "inquiry-detail.wxss"));

  assert.match(mainStyles, /inquiry-detail\.wxss/);
  assert.match(historyStyles, /inquiry-detail\.wxss/);
  assert.match(cssRule(shared, ".inquiry-card__title"), /font-size:\s*30rpx/);
  assert.match(cssRule(shared, ".inquiry-message__text"), /font-size:\s*26rpx/);
  assert.match(cssRule(shared, ".inquiry-message--system"), /box-sizing:\s*border-box/);
});

test("the shared primitives retain restrained motion and flat repeated rows", () => {
  const shared = read(path.join(miniRoot, "styles", "care-ui.wxss"));
  const pageEnterStart = shared.indexOf("@keyframes care-page-enter");
  const pageEnterEnd = shared.indexOf("@keyframes care-mask-enter", pageEnterStart);
  const pageEnterAnimation = shared.slice(pageEnterStart, pageEnterEnd);

  assert.match(shared, /@keyframes care-page-enter/);
  assert.doesNotMatch(pageEnterAnimation, /transform:/);
  assert.match(cssRule(shared, ".care-page"), /animation:\s*care-page-enter\s+180ms/);
  assert.match(cssRule(shared, ".ui-pressable"), /transition:\s*transform\s+140ms/);
  assert.match(cssRule(shared, ".ui-sheet-mask"), /animation:\s*care-mask-enter/);
  assert.match(cssRule(shared, ".ui-sheet"), /animation:\s*care-sheet-enter/);
  assert.match(cssRule(shared, ".ui-loading__spinner"), /animation:\s*care-spinner\s+720ms\s+linear\s+infinite/);
  assert.doesNotMatch(cssRule(shared, ".ui-surface"), /box-shadow/);
  assert.match(cssRule(shared, ".ui-surface--raised"), /box-shadow/);
});

test("the shared header keeps family-facing wording, brand and readable supporting text", () => {
  const logic = read(path.join(miniRoot, "components", "appHeader", "index.js"));
  const layout = read(path.join(miniRoot, "components", "appHeader", "index.wxml"));
  const styles = read(path.join(miniRoot, "components", "appHeader", "index.wxss"));
  const markPath = path.join(miniRoot, "images", "brand-mark.png");

  assert.match(logic, /compact:\s*\{[\s\S]*?value:\s*true/);
  assert.match(layout, /药箱在线/);
  assert.match(layout, /等待药箱连接/);
  assert.doesNotMatch(layout, /站点在线/);
  assert.match(layout, /src="\/images\/brand-mark\.png"/);
  assert.match(layout, /<text[^>]*>智药康护<\/text>/);
  assert.match(styles, /\n\.app-header__subtitle\s*\{[\s\S]*?font-size:\s*26rpx/);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(markPath)).digest("hex"),
    "485fc7b7b58028950ea23248a56cac763cee823defec8f702b665c36240a3991",
  );
});

test("retired template demo code stays removed from the shipped Mini Program", () => {
  const app = JSON.parse(read(path.join(miniRoot, "app.json")));
  const example = path.join(miniRoot, "pages", "example");
  const cloudTip = path.join(miniRoot, "components", "cloudTipModal");

  assert.deepEqual(fs.existsSync(example) ? fs.readdirSync(example) : [], []);
  assert.deepEqual(fs.existsSync(cloudTip) ? fs.readdirSync(cloudTip) : [], []);
  assert.doesNotMatch(JSON.stringify(app), /pages\/example|cloudTipModal/);
});

test("the five-tab navigation keeps the care vocabulary", () => {
  const app = JSON.parse(read(path.join(miniRoot, "app.json")));
  assert.deepEqual(app.tabBar.list.map(item => item.pagePath), primaryTabs.map(page => `pages/${page}/index`));
  assert.deepEqual(app.tabBar.list.map(item => item.text), ["首页", "药库", "问询", "照护", "家人"]);
});
