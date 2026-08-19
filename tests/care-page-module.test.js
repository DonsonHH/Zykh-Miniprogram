const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CarePageError,
  composeCarePage,
  loadingCarePage,
} = require("../miniprogram/utils/carePage");

test("care page gives callers one semantic focus, overview, and section interface", () => {
  const model = composeCarePage({
    key: "cabinet",
    title: "家庭药箱",
    online: true,
    focus: {
      eyebrow: "仓位维护",
      title: "2 项药品需要处理",
      supporting: "先处理过期药品，再补充空仓。",
      state: { kind: "warn", label: "待处理" },
      action: { id: "medicine.add", label: "登记药品" },
    },
    overview: [
      { key: "expired", label: "已过期", value: 1, state: "danger" },
      { key: "depleted", label: "待补药", value: 0, state: "warn" },
    ],
    sections: [{
      key: "priority",
      intent: "inventory",
      title: "药品概览",
      items: [{
        key: "slot-2",
        leading: "2",
        title: "阿司匹林",
        supporting: "10mg · 药箱已确认无药",
        state: { kind: "pending", label: "待补药" },
        action: { id: "medicine.edit.2", label: "维护", payload: { slot: 2 } },
      }],
    }],
  });

  assert.equal(model.focus.action.role, "primary");
  assert.equal(model.focus.state.kind, "pending");
  assert.equal(model.overview[0].state.kind, "risk");
  assert.equal(model.overview[1].value, "0");
  assert.match(model.overview[0].ariaLabel, /已过期.*1/);
  assert.equal(model.sections[0].items[0].action.role, "secondary");
  assert.deepEqual(model.sections[0].items[0].action.payload, { slot: 2 });
  assert.match(model.sections[0].items[0].ariaLabel, /阿司匹林.*维护/);
});

test("care page can activate its one focus action from the whole surface without inventing a second action", () => {
  const model = composeCarePage({
    key: "inquiry",
    title: "家庭问询",
    focus: {
      eyebrow: "最近问询",
      title: "头痛",
      supporting: "已同步照护摘要。",
      action: {
        id: "inquiry.open.0.0",
        label: "打开问询详情",
        payload: { groupIndex: 0, recordIndex: 0 },
      },
      activation: "surface",
    },
  });
  const root = path.join(__dirname, "../miniprogram/components/careScreen");
  const layout = fs.readFileSync(path.join(root, "index.wxml"), "utf8");
  const behavior = fs.readFileSync(path.join(root, "index.js"), "utf8");

  assert.equal(model.focus.activation, "surface");
  assert.equal(model.focus.action.role, "primary");
  assert.deepEqual(model.focus.action.payload, { groupIndex: 0, recordIndex: 0 });
  assert.match(model.focus.ariaLabel, /头痛.*打开问询详情/);
  assert.match(layout, /class="care-focus[^\"]*\{\{model\.focus\.activation === 'surface' \? 'is-actionable' : ''\}\}/);
  assert.match(layout, /aria-role="\{\{model\.focus\.activation === 'surface' \? 'button' : ''\}\}"/);
  assert.match(layout, /aria-label="\{\{model\.focus\.ariaLabel\}\}"/);
  assert.match(layout, /bindtap="onFocusOpen"/);
  assert.match(layout, /wx:if="\{\{model\.focus\.action && model\.focus\.activation === 'button'\}\}"/);
  assert.match(behavior, /onFocusOpen\(\)[\s\S]*focus\.activation !== "surface"[\s\S]*focus\.action[\s\S]*"focus"/);
});

test("care screen emits a surface focus once and keeps button or disabled focuses inert", () => {
  let definition = null;
  const source = fs.readFileSync(path.join(__dirname, "../miniprogram/components/careScreen/index.js"), "utf8");
  vm.runInNewContext(source, {
    Component(value) {
      definition = value;
    },
  });
  const events = [];
  const focus = {
    activation: "surface",
    action: { id: "records.open", label: "打开记录", payload: { recordId: "one" }, disabled: false },
  };
  const instance = Object.assign({
    data: { model: { focus } },
    triggerEvent(name, detail) {
      events.push({ name, detail });
    },
  }, definition.methods);

  instance.onFocusOpen();
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "action");
  assert.equal(events[0].detail.id, "records.open");
  assert.equal(events[0].detail.label, "打开记录");
  assert.equal(events[0].detail.payload.recordId, "one");
  assert.equal(events[0].detail.source, "focus");

  focus.action.disabled = true;
  instance.onFocusOpen();
  focus.action.disabled = false;
  focus.activation = "button";
  instance.onFocusOpen();
  assert.equal(events.length, 1);
});

test("care page rejects shallow escape hatches and ambiguous action identities", () => {
  assert.throws(() => composeCarePage({
    title: "家庭药箱",
    focus: { title: "药箱状态" },
    overview: Array.from({ length: 5 }, (_, index) => ({ label: String(index), value: index })),
  }), CarePageError);

  assert.throws(() => composeCarePage({
    title: "家庭药箱",
    focus: {
      title: "药箱状态",
      action: { id: "open", label: "打开" },
    },
    sections: [{
      key: "items",
      items: [{ key: "one", title: "一", action: { id: "open", label: "打开" } }],
    }],
  }), /duplicate action id/);

  assert.throws(() => composeCarePage({
    title: "家庭药箱",
    focus: {
      title: "药箱状态",
      action: { id: "maintain", label: "立即维护" },
      activation: "floating",
    },
  }), /focus activation must be button or surface/);
});

test("loading care pages use the same interface without inventing a fake focus", () => {
  const model = loadingCarePage("家庭问询", "正在整理问询摘要…");
  assert.equal(model.phase.kind, "loading");
  assert.equal(model.focus, null);
  assert.equal(model.phase.message, "正在整理问询摘要…");
  assert.equal(model.showStatus, false);
});

test("error care pages can expose one semantic retry action", () => {
  const model = composeCarePage({
    key: "cabinet-error",
    title: "家庭药箱",
    phase: {
      kind: "error",
      message: "药品数据读取失败。",
      action: { id: "cabinet.retry", label: "重新读取药箱" },
    },
  });
  const layout = fs.readFileSync(path.join(__dirname, "../miniprogram/components/careScreen/index.wxml"), "utf8");

  assert.equal(model.focus, null);
  assert.equal(model.phase.kind, "error");
  assert.equal(model.phase.action.id, "cabinet.retry");
  assert.equal(model.phase.action.role, "primary");
  assert.match(layout, /wx:if="\{\{model\.phase\.action\}\}"[\s\S]*bindtap="onPhaseAction"/);
});

test("care screen owns the readable type scale and never exposes page styling props", () => {
  const root = path.join(__dirname, "../miniprogram");
  const layout = fs.readFileSync(path.join(root, "components/careScreen/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "components/careScreen/index.wxss"), "utf8");
  const logic = fs.readFileSync(path.join(root, "utils/carePage.js"), "utf8");

  assert.match(layout, /<app-header/);
  assert.match(layout, /model\.focus\.title/);
  assert.match(layout, /model\.sections/);
  assert.match(styles, /\.care-focus__title\s*\{[^}]*font-size:\s*44rpx/s);
  assert.match(styles, /\.care-section__title\s*\{[^}]*font-size:\s*34rpx/s);
  assert.match(styles, /\.care-item__title\s*\{[^}]*font-size:\s*30rpx/s);
  assert.match(styles, /\.care-item__supporting\s*\{[^}]*font-size:\s*26rpx/s);
  assert.doesNotMatch(logic, /customClass|fontSize|borderRadius|boxShadow/);
});
