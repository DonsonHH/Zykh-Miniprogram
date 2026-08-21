# 智药康护小程序交接入口

更新时间：2026-08-21

## 工程位置

```text
D:\app\wechatlittleprogram
```

微信开发者工具应直接导入这个根目录，不要只导入 `miniprogram` 子目录。

## 当前产品基线

- 面向家庭照护者，而不是工程调试人员。
- 药品按“日常高频内服、外用消毒护理、慢病处方储备”三个药柜管理，共 22 种，数量为 `9 / 8 / 5`。
- 当前药品是固定参考基线，不再代表 23 个物理药仓。
- 不支持舵机开仓、自动出药、远程出药或取药记录。
- 照护页只展示健康测量和用药风险。
- AI 问询按人物归档，先展示摘要，点击后按需读取过程。
- 库存只使用 `STOCKED / DEPLETED / UNKNOWN` 明确事实，不从数量猜测低余量。

## 首要文档

1. `docs/MINIPROGRAM_LOGIC_ARCHIVE.md`：当前页面、数据、同步和业务闭环的权威归档。
2. `docs/SYNC_AND_MIGRATION_GUIDE.md`：新版 Station `CloudSyncWorker` 接云流程。
3. `docs/THREE_BOX_MIGRATION.md`：三盒药库数据迁移。
4. `docs/DEPLOYMENT.md`：小程序与云函数部署。

旧的 `qsm_agent.pl`、23 仓和 `DISPENSE` 文档不能作为当前实现依据。

## 核心代码

```text
miniprogram/            小程序前端
cloudfunctions/api/     CloudBase 云函数
tests/                  回归测试
tools/                  UI 校验
```

CloudBase 环境：

```text
cloud1-d6gv6t2jf3f2c541c
```

## 交接验证

```powershell
node --test tests/*.test.js
node tools/validate-miniprogram-ui.js
```

归档时的验证结果：449 项测试通过，141 个小程序文件通过 UI 校验。

本地修改没有自动推送到 GitHub；部署云函数或上传小程序版本必须由接手工程师在微信开发者工具中明确执行。
