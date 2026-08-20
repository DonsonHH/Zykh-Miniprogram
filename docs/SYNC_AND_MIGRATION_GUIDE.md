# 智药康护小程序同步与迁移指南

本文档对应 `zykh_station_app` 内置 `CloudSyncWorker` 的联网方案，不再使用本项目旧版 `qsm_agent.pl`。药品数据结构已经切换为三盒药库；先阅读 [THREE_BOX_MIGRATION.md](THREE_BOX_MIGRATION.md)。

## 1. 同步链路

```text
微信小程序
  -> 云函数 api / CloudBase 数据库
  -> QSM368 zykh_station_app CloudSyncWorker
  -> 板端本地服务、溯源码入库与现场记录
```

小程序不会直接访问板子的局域网地址。板子通过 `CloudSyncWorker` 主动访问云函数 HTTP 入口，拉取 `commands` 并上传快照数据。

## 2. 当前命令类型

- `AUDIO_SPEAK`：语音提醒，板端会调用 `QsmClient().audio_speak(...)`
- `AUDIO_BEEP`：提示音兼容命令，只保留历史/调试兼容
- `READ_VITALS_ALL`：远程测量体征
- `AI_CHAT`：AI 问诊
- `UPSERT_MEDICINE`：旧客户端兼容；新流程不使用
- `UPSERT_SERVICE_USER`：服务对象同步
- `UPSERT_TODAY_PLAN`：今日用药计划同步

新版不支持 `OPEN_CABINET`、`DISPENSE` 或舵机出药。药品由 Station 扫描入库，再通过 `UPLOAD_MEDICINES`、`UPLOAD_SNAPSHOT` 或批次快照上传。

用药提醒必须使用 `AUDIO_SPEAK`，payload 至少包含：

```json
{
  "text": "张三请及时用药。",
  "target_user_name": "张三",
  "medicine_name": "阿莫西林胶囊",
  "volume": 230,
  "tts_mode": "auto"
}
```

旧字段 `speak_text` 不再作为小程序主字段使用。

## 3. 云函数

云函数目录：

```text
cloudfunctions/api
```

部署方式：

```text
微信开发者工具 -> 云开发 -> 云函数 -> api -> 上传并部署：云端安装依赖
```

云端环境变量建议配置：

```text
DEVICE_SECRET=<开发阶段共享密钥>
```

多板时可改用：

```json
DEVICE_SECRETS={"zykh-qsm-001":"第一块板密钥","zykh-qsm-002":"第二块板密钥"}
```

## 4. 板端配置

新版板端仓库为：

```text
DonsonHH/Zykh-QSM
```

在第二块板迁移时，应部署完整新版 `zykh_station_app`，不要再复制本小程序旧版 `qsm_agent`。

板端需要配置这些环境项或 `.env` 项，名称以新版仓库实际配置为准：

```text
CLOUD_SYNC_ENABLED=true
CLOUD_SYNC_ENDPOINT=https://你的 CloudBase HTTP 访问地址/api
CLOUD_SYNC_DEVICE_ID=zykh-qsm-002
CLOUD_SYNC_DEVICE_SECRET=<与云函数 DEVICE_SECRETS 对应的设备独立密钥>
```

启动板端服务后，确认 `CloudSyncWorker` 日志能成功调用：

```text
PING
REPORT_DEVICE
PULL_COMMANDS
UPSERT_SNAPSHOT_BATCH
FINALIZE_SNAPSHOT
```

## 5. 小程序迁移到第二块板

1. 第二块板部署最新版 `Zykh-QSM`。
2. 给第二块板设置独立设备号，例如 `zykh-qsm-002`。
3. 云函数环境变量里加入第二块板密钥。
4. 由第二块板签发一次性配对码，在小程序“家人”页完成账号授权并选择 `zykh-qsm-002`。
5. 等待板端上报 `devices.lastSeenAt`，小程序会根据最近 60 秒心跳判断在线。
6. 先测试“测试语音提醒”，确认 `commands` 中 `AUDIO_SPEAK` 从 `pending/running` 变为 `done`。
7. 再测试首页“提醒用药”、AI 问询、三盒药库和记录同步。

## 6. 排障顺序

如果小程序显示未连接：

1. 看云数据库 `devices/{deviceId}.lastSeenAt` 是否刷新。
2. 看板端 `CLOUD_SYNC_ENDPOINT` 是否为真实 HTTP 访问入口。
3. 看 `DEVICE_SECRET / DEVICE_SECRETS` 是否匹配。
4. 看板端是否能访问公网和 CloudBase 域名。

如果语音不响：

1. 看 `commands` 里 `AUDIO_SPEAK` 是否 `done`。
2. 如果 `failed`，查看 `result.error`。
3. 如果 `done` 但没声音，在板端本地测试 `/api/audio/speak` 和音频输出设备。
4. 不要退回 `AUDIO_BEEP` 做用药提醒；蜂鸣只适合硬件链路调试。
