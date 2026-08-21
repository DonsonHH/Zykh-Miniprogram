# 智药康护小程序逻辑归档

归档日期：2026-08-20
适用版本：CloudBase schema revision `3.0-three-box-library`

本文档是当前小程序业务逻辑的权威索引。旧版 23 仓、舵机开仓、自动出药和“取药记录”设计已经退出产品逻辑，不应再作为开发依据。

## 1. 代码位置

工程根目录：

```text
D:\app\wechatlittleprogram
```

主要目录：

```text
miniprogram/            小程序前端源码
cloudfunctions/api/     CloudBase 云函数 api
tests/                  行为与协议回归测试
tools/                  UI 和开发辅助工具
docs/                   部署、同步、迁移和本归档文档
project.config.json     微信开发者工具项目配置
cloudbaserc.json        CloudBase 环境与云函数配置
```

当前固定配置：

```text
小程序 AppID：wx10d3642842a733e8
CloudBase 环境：cloud1-d6gv6t2jf3f2c541c
云函数名称：api
云端 schemaRevision：3.0-three-box-library
```

## 2. 产品定位

小程序是面向家庭照护者的远程查看和协同端，负责：

1. 查看今日用药计划并向药箱发送人物明确的语音提醒。
2. 查看终端扫码入库后的三盒药品、有效期和现场确认的余量状态。
3. 查看按家庭成员归档的 AI 问询摘要与问询过程。
4. 查看心率、血氧、体温等健康测量以及测量对象。
5. 集中查看“哪位家人不宜使用哪种药”的用药风险。
6. 管理家庭成员、账号可访问的药箱和一次性配对。

小程序不负责：

- 不直接连接板子的局域网地址。
- 不远程开柜，不控制舵机，不自动出药。
- 不展示或生成取药记录。
- 不根据数量猜测“低库存”。
- 不在终端没有回传时伪造在线、测量成功或执行成功。

## 3. 当前页面结构

实际生效页面以 `miniprogram/app.json` 为准。

| 页面 | 路径 | 当前职责 |
| --- | --- | --- |
| 首页 | `pages/index/index` | 今日计划、用药提醒、需关注药品、最近体征、问询和风险动态 |
| 三柜药库 | `pages/library/index` | 按日常高频内服、外用消毒护理、慢病处方储备展示 22 种药品及待处理事项 |
| 药品清单 | `pages/libraryList/index` | 查看完整药品列表并按药盒、有效期和余量状态筛选 |
| 用药风险 | `pages/medicationRisks/index` | 按人物与药品聚合风险，查看依据和建议 |
| 健康测量 | `pages/vitals/index` | 查看最新体征，选择授权家庭成员后发起远程测量 |
| 照护记录 | `pages/records/index` | 仅展示健康测量和用药风险，不读取旧取药记录 |
| 问询摘要 | `pages/ai/index` | 按家庭成员展示最近已完成问询摘要，详情按需读取 |
| 问询历史 | `pages/ai/history/index` | 查看更完整的分人问询历史和保存的问询过程 |
| 家人详情 | `pages/familyDetail/index` | 某位家庭成员的计划、体征、问询和风险汇总 |
| 家人 | `pages/settings/index` | 家人概览、授权药箱、一次性配对、语音提醒测试和协同日志 |

底部五个标签为：首页、药库、问询、照护、家人。

以下目录仍在源码中，但没有注册到 `app.json`，不是当前产品入口：

```text
pages/cabinet/
pages/medicineList/
pages/addMedicine/
```

它们属于旧版仓位维护实现，只能作为兼容代码参考。后续清理前应先移除相应测试依赖，不能重新接回用户导航。

## 4. 三盒药库逻辑

三个药柜由 `miniprogram/utils/medicineLibrary.js` 定义：

| storageBox | 用户名称 | 用途 |
| --- | --- | --- |
| `DAILY` | 日常高频内服 | 感冒、发热、咳嗽、过敏与胃肠不适 |
| `CARE` | 外用消毒护理 | 消毒、伤口、皮肤、鼻部与局部疼痛 |
| `PRESCRIPTION` | 慢病处方储备 | 慢病、处方、固定用药与低频储备 |

当前 22 种药品是现阶段正式药品基线，采用三个药柜 `9 / 8 / 5` 分类。映射资料位于：

```text
miniprogram/data/fixedMedicineCatalog.js
docs/FIXED_22_MEDICINES.md
```

旧仓号仅可用于迁移时推导药盒分类，不能再作为药品身份。药品身份优先使用稳定的 `medicineId`、溯源码或条码。

库存只接受明确状态：

| inventoryState | 含义 |
| --- | --- |
| `STOCKED` | 现场最近一次确认仍有药 |
| `DEPLETED` | 现场最近一次确认已经无药，需要补充 |
| `UNKNOWN` | 余量尚未确认 |

有效期继续由药品数据中的 `expireDate` 和 `expiryPrecision` 管理。小程序只展示终端或云端同步的事实，不自行推断药品已经被使用。

## 5. 数据归属

| 数据 | 主要集合 | 权威来源 | 小程序用途 |
| --- | --- | --- | --- |
| 设备状态 | `devices` | Station `CloudSyncWorker` 心跳 | 在线状态、网络和最近上报时间 |
| 药品 | `medicines` | Station 扫码入库与现场确认 | 三盒药库、有效期、余量 |
| 体征 | `vitals` | Station 测量结果 | 健康页、照护页、家人详情 |
| 今日计划 | `today_plans` | Station 快照 | 首页计划和人物语音提醒 |
| 问询 | `inquiries` | Station AI 问询会话 | 分人摘要和按需过程详情 |
| 用药风险 | `medication_safety_events` | Station 风险核验 | 风险页、首页关注、照护记录 |
| 风险已读状态 | `caregiver_event_receipts` | 小程序家属操作 | 每个家属独立的已读状态 |
| 协同命令 | `commands` | 小程序创建、Station 执行 | 语音提醒、远程测量及兼容命令状态 |
| 家属授权 | `device_memberships` | 配对流程 | 限制账号可查看的设备和数据 |
| 配对码 | `device_pairing_codes` | Station 签发 | 一次性绑定新药箱 |

`records` 集合和 `LIST_RECORDS / UPLOAD_RECORD` 云函数动作暂时保留用于旧协议兼容。当前首页和照护页都不会查询它，旧取药数据不会进入用户界面。

## 6. 小程序与板端同步

```text
QSM368 Station
  -> CloudSyncWorker 主动访问 CloudBase HTTP /api
  -> 上传设备、药品、人物、计划、体征、问询和风险快照
  -> 拉取 commands 并在本地执行

微信小程序
  -> wx.cloud.callFunction({ name: "api" })
  -> 云函数校验微信账号与设备授权
  -> 读取云端快照或创建 commands
  -> 页面按 5 至 10 秒周期重新读取
```

小程序没有直接数据库 `watch()`，也不会访问 `127.0.0.1:8080` 或板子 IP。`miniprogram/utils/realtime.js` 实际执行的是受控轮询刷新，页面隐藏或卸载时会停止。

设备在线判断以 `devices.lastSeenAt` 为准；最近 60 秒内有心跳才视为在线。

## 7. 核心闭环

### 7.1 人物语音提醒

```text
首页选择某条待执行计划
  -> 小程序创建 AUDIO_SPEAK 命令
  -> commands: pending
  -> Station 拉取后改为 running
  -> Station 播报“人物名称 + 请及时用药”
  -> Station ACK 为 done 或 failed
  -> 小程序刷新状态
```

语音提醒必须保留计划中的稳定人物身份，不能只根据姓名猜测对象。

### 7.2 远程健康测量

```text
家属在健康页选择授权家庭成员
  -> 创建 READ_VITALS_ALL
  -> Station 执行本地测量
  -> 上传 vitals，包含人物 ID、personaGeneration 和归属来源
  -> 小程序展示真实结果
```

体征无法可靠归属时显示“未登记人员”或“归属信息同步异常”，不能自动套用某位家人姓名。

### 7.3 药品入库与维护

```text
Station 扫描药物溯源码
  -> 建立稳定 medicineId
  -> 识别药品资料与有效期
  -> 归入 DAILY / CARE / PRESCRIPTION
  -> CloudSyncWorker 上传 medicines 快照
  -> 小程序药库自动刷新
```

当前小程序不承担现场扫码，也不发送开柜或出药命令。

### 7.4 AI 问询归档

```text
老人或现场用户在 Station 完成 AI 问询
  -> Station 保存人物身份、症状摘要、建议、风险和对话过程
  -> 云端保存 inquiry 摘要
  -> 小程序按人物展示摘要
  -> 家属点击详情时再读取问询过程
```

当前小程序的“问询”页是家属查看端，不是移动端重新发起一次 AI 问询的入口。

### 7.5 用药风险

```text
Station 结合人物档案与药品资料完成核验
  -> 上报 medication_safety_event
  -> 云端保留人物、药品、依据、规则版本和结果
  -> 小程序在首页、风险页、照护页和家人详情展示
  -> 家属查看后写入个人 read receipt
```

风险模块只提供信息和建议，不提供“批准出药”或“放行”操作。

## 8. 鉴权和设备作用域

小程序启动时先执行设备会话解析：

1. `GET_MY_DEVICES` 获取当前微信账号有权访问的设备。
2. 从授权列表恢复上一次选择的设备。
3. 未配对账号通过 `REDEEM_DEVICE_PAIRING_CODE` 使用一次性配对码。
4. 所有设备级读取和命令都固定在请求开始时的 `deviceId`。
5. 切换设备后立即清空旧设备页面状态，迟到响应不得覆盖新设备。

板端写入需要 `deviceId + deviceSecret`。云函数优先读取环境变量 `DEVICE_SECRETS` 中对应设备的独立密钥，再回退到 `DEVICE_SECRET`。当前实现没有配置密钥时会拒绝板端写入，不是开发模式放行。

## 9. 云函数动作边界

板端主要动作：

```text
PING
REPORT_DEVICE
UPLOAD_MEDICINES
UPLOAD_VITALS
UPLOAD_SNAPSHOT
UPSERT_SNAPSHOT_BATCH
FINALIZE_SNAPSHOT
PULL_COMMANDS
ACK_COMMAND
REPORT_MEDICATION_SAFETY_EVENT
ISSUE_DEVICE_PAIRING_CODE
```

小程序主要动作：

```text
GET_MY_DEVICES
REDEEM_DEVICE_PAIRING_CODE
GET_DEVICE
LIST_MEDICINES
GET_LATEST_VITALS
LIST_VITALS
LIST_COMMANDS
LIST_INQUIRIES
GET_INQUIRY_DETAIL
GET_SNAPSHOT
LIST_MEDICATION_SAFETY_EVENTS
GET_MEDICATION_SAFETY_EVENT
MARK_MEDICATION_SAFETY_EVENT_READ
CREATE_COMMAND
```

当前允许的命令类型：

```text
AUDIO_SPEAK
READ_VITALS_ALL
AUDIO_BEEP              仅历史或硬件调试兼容
AI_CHAT                 旧调用兼容
UPSERT_MEDICINE         旧客户端兼容
UPSERT_SERVICE_USER
UPSERT_TODAY_PLAN
```

不存在 `OPEN_CABINET` 或 `DISPENSE` 命令。

## 10. 关键代码索引

```text
miniprogram/app.js                         云环境初始化与设备授权会话
miniprogram/app.json                       当前页面和 TabBar 唯一入口清单
miniprogram/utils/api.js                   小程序到云函数的统一适配层
miniprogram/utils/realtime.js              页面轮询刷新与停止机制
miniprogram/utils/deviceSession.js         等待授权设备会话
miniprogram/utils/medicineLibrary.js       三盒分类与显式库存状态
miniprogram/data/fixedMedicineCatalog.js   当前 22 种药品参考资料
miniprogram/modules/personaVisibility.js   人物生命周期与数据可见性
miniprogram/modules/vitalsAttribution.js   体征人物归属
miniprogram/modules/medicationSafetyEvents.js  用药风险展示适配
cloudfunctions/api/index.js                云端动作、鉴权、集合读写和命令
cloudfunctions/api/memberships.js          家属授权与一次性配对
cloudfunctions/api/medicationSafetyEvents.js  风险事件云端模块
```

## 11. 发布前检查

```powershell
node --test tests/*.test.js
node tools/validate-miniprogram-ui.js
```

当前归档基线：

```text
442 项自动化测试通过
136 个小程序文件通过 UI 静态校验
活动页面不读取旧取药 records
活动页面不存在远程开柜或 DISPENSE 入口
```

部署与迁移继续参考：

- `docs/DEPLOYMENT.md`
- `docs/SYNC_AND_MIGRATION_GUIDE.md`
- `docs/THREE_BOX_MIGRATION.md`
