const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pageRoot = path.resolve(__dirname, "../miniprogram/pages/addMedicine");

test("medicine form leaves depleted state to the board's post-dispense confirmation", () => {
  const wxml = fs.readFileSync(path.join(pageRoot, "index.wxml"), "utf8");
  const source = fs.readFileSync(path.join(pageRoot, "index.js"), "utf8");

  assert.doesNotMatch(wxml, /data-key="quantity"/);
  assert.doesNotMatch(wxml, /data-key="lowStockLine"/);
  assert.match(wxml, /bindtap="markRefilled"/);
  assert.match(source, /function inventoryStateFor/);
  assert.match(source, /markRefilled/);
});

test("medicine maintenance renders UNKNOWN and refill command progress without changing the observed fact", () => {
  const wxml = fs.readFileSync(path.join(pageRoot, "index.wxml"), "utf8");

  assert.match(wxml, /inventoryState\.isInventoryUnknown\s*\?\s*'is-unknown'/);
  assert.match(wxml, /inventoryState\.isInventoryUnknown\s*\?\s*'库存待确认'/);
  assert.match(wxml, /inventoryUpdateStatus === 'pending'[\s\S]*更新中/);
  assert.match(wxml, /inventoryUpdateStatus === 'failed'[\s\S]*更新失败/);
  assert.match(wxml, /inventoryUpdateStatus === 'succeeded'[\s\S]*药箱已确认/);
  assert.match(wxml, /inventoryIntent === 'STOCKED'[\s\S]*已记录补药/);
});

test("a registered UNKNOWN legacy slot can record a refill without exposing the action on a new slot", () => {
  const wxml = fs.readFileSync(path.join(pageRoot, "index.wxml"), "utf8");

  assert.match(
    wxml,
    /wx:if="\{\{\(inventoryState\.isDepleted \|\| inventoryState\.isInventoryUnknown\) && baseMedicine\.name && inventoryIntent !== 'STOCKED'\}\}"/,
  );
});

test("changing an exact expiry to month precision requires confirmation", () => {
  const source = fs.readFileSync(path.join(pageRoot, "index.js"), "utf8");

  assert.match(source, /wx\.showModal/);
  assert.match(source, /applyExpiryPrecision/);
});

test("medicine form exposes one readable maintenance stage at a time", () => {
  const wxml = fs.readFileSync(path.join(pageRoot, "index.wxml"), "utf8");
  const source = fs.readFileSync(path.join(pageRoot, "index.js"), "utf8");

  assert.match(wxml, /currentStep === 1/);
  assert.match(wxml, /currentStep === 2/);
  assert.match(wxml, /currentStep === 3/);
  assert.match(wxml, /bindtap="nextStep"/);
  assert.match(wxml, /bindtap="previousStep"/);
  assert.match(wxml, /bindtap="submit"/);
  assert.match(source, /currentStep:\s*1/);
  assert.match(source, /nextStep\(\)/);
  assert.match(source, /previousStep\(\)/);
});
