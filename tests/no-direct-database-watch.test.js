const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const sourceRoot = path.join(__dirname, "../miniprogram");

function productionScripts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionScripts(target);
    return /\.(?:js|wxs)$/i.test(entry.name) ? [target] : [];
  });
}

test("mini program production code never bypasses scoped APIs with a direct database watch", () => {
  const violations = [];
  productionScripts(sourceRoot).forEach(file => {
    const source = fs.readFileSync(file, "utf8");
    if (/\bwx\.cloud\.database\s*\(/.test(source) || /\.watch\s*\(/.test(source)) {
      violations.push(path.relative(sourceRoot, file));
    }
  });
  assert.deepEqual(violations, []);
});
