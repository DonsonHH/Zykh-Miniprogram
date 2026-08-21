const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

test("the developer build stays within a small media budget", () => {
  const imageRoot = path.join(root, "miniprogram/images");
  const files = filesBelow(imageRoot);
  const bytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);

  assert.ok(bytes <= 300 * 1024, `Mini Program media is ${(bytes / 1024).toFixed(1)} KB`);
  assert.ok(files.every(file => fs.statSync(file).size <= 200 * 1024));
});

test("the checked-in developer configuration cannot re-enable hot reload", () => {
  const shared = JSON.parse(fs.readFileSync(path.join(root, "project.config.json"), "utf8"));
  assert.equal(shared.setting.compileHotReLoad, false);

  const personalPath = path.join(root, "project.private.config.json");
  if (fs.existsSync(personalPath)) {
    const personal = JSON.parse(fs.readFileSync(personalPath, "utf8"));
    assert.equal(personal.setting.compileHotReLoad, false);
  }
});

test("foreground refresh uses one-shot scheduling instead of an overlapping interval", () => {
  const source = fs.readFileSync(path.join(root, "miniprogram/utils/realtime.js"), "utf8");

  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /getSystemInfo(?:Sync)?\s*\(/);
  assert.match(source, /DEVTOOLS_INTERVAL_MS\s*=\s*60000/);
  assert.match(source, /schedule\(options\.immediate === false \? intervalMs : 0\)/);
});

test("the dashboard lets failed background reads trigger polling backoff", () => {
  const source = fs.readFileSync(path.join(root, "miniprogram/pages/index/index.js"), "utf8");

  assert.match(source, /this\.load\(\{ background: true \}\)/);
  assert.match(source, /if \(options\.background === true\) throw error/);
});

test("component styles avoid selectors that the Mini Program compiler rejects", () => {
  const componentRoot = path.join(root, "miniprogram/components");
  const styles = filesBelow(componentRoot).filter(file => file.endsWith(".wxss"));
  const tagSelector = /(^|[\s>+~,])(view|text|label|image|button|input|textarea|scroll-view)(?=[\s>+~,.#:[{]|$)/;

  styles.forEach(file => {
    const selectors = fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(line => line.includes("{") && !line.trim().startsWith("@"))
      .map(line => line.slice(0, line.indexOf("{")).trim());
    selectors.forEach(selector => {
      assert.doesNotMatch(selector, tagSelector, `${file}: ${selector}`);
      assert.doesNotMatch(selector, /#[A-Za-z_]/, `${file}: ${selector}`);
      assert.doesNotMatch(selector, /\[[^\]]+\]/, `${file}: ${selector}`);
    });
  });
});
