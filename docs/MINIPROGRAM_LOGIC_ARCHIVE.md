# 智药康护小程序逻辑归档

归档日期：2026-08-22
适用版本：CloudBase schema revision `3.0-three-box-library`，Release A

本文是当前仓库的业务和协议索引。旧版 23 个独立药仓、舵机开仓、自动出药及取药记录已退出产品逻辑。当前“23”表示板端权威药品种类数，不表示 23 个药仓。

## 1. 产品定位

小程序是家庭照护者的远程查看端。最终产品方向包括今日计划、语音提醒、三柜药库、分人问询摘要、体征记录和用药风险。

当前 Release A 只开放：

1. 账号既有药箱授权。
2. 设备心跳与明确连接状态。
3. 板端 finalized 23 种药品快照的只读展示。

人物、计划、问询、体征、记录、风险事件、自助配对和远程命令暂时显示安全迁移状态，不使用旧数据回退。页面骨架仍保留，后续版本在身份代次和授权合同验收后逐项恢复。

小程序始终不负责：

- 直连板子局域网地址。
- 远程开柜、控制舵机或自动出药。
- 展示或生成旧取药记录。
- 根据数量猜测低库存。
- 远程修改板端药库。
- 伪造在线、测量成功或命令成功。

## 2. 代码位置

```text
miniprogram/            小程序页面、组件和客户端适配层
cloudfunctions/api/     CloudBase Release A 云函数
tests/                  行为、安全与协议回归测试
tools/                  UI 静态检查工具
docs/                   部署、同步和迁移文档
project.config.json     微信开发者工具项目配置
cloudbaserc.json        CloudBase 项目配置
```

实际页面与 TabBar 以 `miniprogram/app.json` 为准。

## 3. 页面结构

| 页面 | 路径 | 职责 |
| --- | --- | --- |
| 首页 | `pages/index/index` | 今日照护焦点与连接状态；人物数据迁移期不伪造空结果 |
| 计划 | `pages/medicationPlans/index` | 后续展示分人计划状态；Release A 安全关闭 |
| 三柜药库 | `pages/library/index` | 三柜摘要和药品待处理事项 |
| 药品清单 | `pages/libraryList/index` | finalized 药品全量、筛选和详情 |
| 用药风险 | `pages/medicationRisks/index` | 后续按人物与药品展示风险；Release A 安全关闭 |
| 健康测量 | `pages/vitals/index` | 后续展示分人体征；Release A 不发测量命令 |
| 照护记录 | `pages/records/index` | 后续展示体征和风险，不读取取药记录 |
| 问询 | `pages/ai/index` | 后续展示分人问询摘要，不在手机端发起 AI 问询 |
| 问询历史 | `pages/ai/history/index` | 后续按需读取问询过程 |
| 家人详情 | `pages/familyDetail/index` | 后续汇总单个人物照护信息 |
| 家人 | `pages/settings/index` | 账号已有授权药箱和连接详情 |

底部五个标签为：首页、药库、问询、照护、家人。

以下兼容目录没有注册到 `app.json`：

```text
pages/cabinet/
pages/medicineList/
pages/addMedicine/
```

这些页面不能重新成为远程药品写入入口；现有提交动作只说明需到 Station 现场维护。

## 4. 三柜药库

| `storageBox` | 用户名称 | 数量 |
| --- | --- | ---: |
| `DAILY` | 日常用药 | 9 |
| `CARE` | 外用护理 | 8 |
| `PRESCRIPTION` | 慢病处方 | 6 |

总计 23 种。S09 双歧杆菌三联活菌肠溶胶囊属于 `PRESCRIPTION`，没有 `COLD` 分类。S03/S13 的兼容身份映射见 [BOARD_23_MEDICINES.md](BOARD_23_MEDICINES.md)。

`miniprogram/data/fixedMedicineCatalog.js` 是展示参考资料，不是可见集合。小程序只能展示当前完整 finalized manifest 中真实存在的行：

- 已知稳定 ID 可补充厂家、说明等展示资料。
- 未知但合同合法的稳定 ID 仍然可见。
- 云端缺失的已知药不能被本地表补出。
- identity 或 `storageBox` 冲突时失败关闭。
- `cabinet_id/cabinetId` 不是云端药品字段。

库存状态只接受：

| `inventoryState` | 含义 |
| --- | --- |
| `STOCKED` | 现场确认仍有药 |
| `DEPLETED` | 现场确认已无药 |
| `UNKNOWN` | 尚未确认余量 |

数量只作为兼容上下文，不能覆盖显式库存事实。

## 5. 数据事实边界

| 数据 | 权威来源 | Release A 状态 |
| --- | --- | --- |
| 设备心跳 | CloudBase 服务端接收 Station 上报的时间 | 开放 |
| 账号设备授权 | 既有 ACTIVE `device_memberships` | 只读开放 |
| 药品 | Station 版本化 finalized snapshot | 只读开放 |
| 人物与计划 | Station + 严格 persona generation | 迁移中，失败关闭 |
| 问询、体征、记录、风险 | Station + 人物代次作用域 | 迁移中，失败关闭 |
| 配对 | 后续严格配对合同 | 关闭 |
| 远程命令 | 后续 Release C | 关闭 |

Release A 不把旧集合中的 ownerless、其它 producer 或 staging 行当成当前家庭药库。

## 6. 同步合同

```text
Station
  -> PING
  -> REPORT_DEVICE
  -> BEGIN_SNAPSHOT
  -> UPSERT_SNAPSHOT_BATCH
  -> FINALIZE_SNAPSHOT / ABORT_SNAPSHOT

小程序
  -> GET_MY_DEVICES
  -> GET_DEVICE
  -> GET_MEDICINE_SNAPSHOT
```

`LIST_MEDICINES` 只为旧客户端提供同一 finalized manifest 的只读数组。旧 `UPLOAD_MEDICINES` 和 `UPLOAD_SNAPSHOT` 被拒绝；`PULL_COMMANDS`、`ACK_COMMAND` 和 `CREATE_COMMAND` 在 Release A 被拒绝。

药品摘要固定使用 `jcs-sha256-v1`。snapshot session 带 lease 和单调 revision；旧实例、跨批重复 ID、重叠 ordinal、内容冲突和迟到 finalize 都失败关闭。

## 7. 设备会话和连接状态

启动顺序：

1. 调用 `PING`，精确检查 schema 与 Release A 七项 capability。
2. 调用 `GET_MY_DEVICES`，只接受账号已有 ACTIVE 授权。
3. 从授权列表恢复选择；没有授权时不保留旧缓存 deviceId。
4. 调用 `GET_DEVICE` 和 `GET_MEDICINE_SNAPSHOT`。
5. 设备切换时立即清空旧页面作用域，忽略迟到响应。

连接状态为：

```text
loading / online / stale / unavailable / unpaired / incompatible
```

只有合法心跳超过 60 秒的 `stale` 显示“等待药箱连接”。云端报错、未授权和版本不兼容都有独立文案。

## 8. 鉴权

板端写入需要 `deviceId + deviceSecret`。生产云函数只读取环境变量 `DEVICE_SECRETS` 中该设备的独立密钥，不支持 `DEVICE_SECRET` 共享回退；缺失映射或密钥错误均拒绝。

小程序身份由云函数上下文获取。设备级读取只允许当前微信账号的有效 membership，不接受客户端自报账号，也不允许手填设备 ID 绕过授权。

## 9. Release A 云函数边界

允许的板端动作：

```text
PING
REPORT_DEVICE
BEGIN_SNAPSHOT
UPSERT_SNAPSHOT_BATCH
FINALIZE_SNAPSHOT
ABORT_SNAPSHOT
```

允许的小程序读取：

```text
PING
GET_MY_DEVICES
GET_DEVICE
GET_MEDICINE_SNAPSHOT
LIST_MEDICINES
```

人物相关 action 返回 `PERSONA_DATA_MIGRATION_IN_PROGRESS`，远程命令相关 action 返回 `REMOTE_COMMANDS_DISABLED`，旧药库上传返回 `SNAPSHOT_PROTOCOL_REQUIRED`。

## 10. 关键代码

```text
miniprogram/app.js                         云环境初始化与授权设备会话
miniprogram/utils/api.js                   严格 CloudBase 适配和 manifest 校验
miniprogram/utils/connectionState.js       显式连接状态机与用户文案
miniprogram/utils/deviceSession.js         授权设备作用域
miniprogram/utils/medicineLibrary.js       三柜分类、筛选和显式库存
miniprogram/data/fixedMedicineCatalog.js   23 种药品展示参考
miniprogram/modules/deviceMemberships.js   Release A capability 与授权解析
cloudfunctions/api/index.js                Release A 动作门禁、鉴权和心跳
cloudfunctions/api/snapshotStore.js        版本化快照、fencing 和 manifest
cloudfunctions/api/canonicalDigest.js      JCS-SHA256 摘要
cloudfunctions/api/memberships.js          既有授权设备读取
```

## 11. 发布前检查

```powershell
node --test tests/*.test.js
node tools/validate-miniprogram-ui.js
```

测试数量会随合同覆盖变化，不在文档中写死。还必须执行 JavaScript 语法、JSON 解析、`git diff --check` 和敏感信息扫描。

本地检查通过不表示线上已部署。部署和第二块板迁移分别见：

- [DEPLOYMENT.md](DEPLOYMENT.md)
- [SYNC_AND_MIGRATION_GUIDE.md](SYNC_AND_MIGRATION_GUIDE.md)
- [MIGRATE_TO_ANOTHER_BOARD.md](MIGRATE_TO_ANOTHER_BOARD.md)
- [THREE_BOX_MIGRATION.md](THREE_BOX_MIGRATION.md)
