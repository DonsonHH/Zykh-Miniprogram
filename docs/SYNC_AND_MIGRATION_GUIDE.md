# 智药康护同步与迁移指南

> 当前仓库实现 CloudBase Release A，尚未部署。Release A 只恢复设备心跳、既有账号授权和板端药库快照；人物资料、计划、问询、体征、记录、风险、自助配对及远程命令暂时失败关闭。

## 1. 同步链路

```text
QSM368 Station（现场事实源）
  -> 主动访问 CloudBase HTTP /api
  -> 上报服务端心跳
  -> 上传并 finalize 23 种药品的版本化快照

微信小程序（家庭照护端）
  -> wx.cloud.callFunction({ name: "api" })
  -> 读取账号已获授权的设备
  -> 读取 finalized 药库 manifest
```

小程序不直连板子的 IP 或 `127.0.0.1`。Release A 不拉取命令，也不执行语音、测量、问询、开柜、出药或远程改药。

## 2. Release A 云端合同

`PING` 必须精确返回：

```json
{
  "ok": true,
  "schemaVersion": 2,
  "schemaRevision": "3.0-three-box-library",
  "capabilities": {
    "snapshotBatch": "v2",
    "snapshotFencing": "v1",
    "snapshotCanonicalDigest": "jcs-sha256-v1",
    "boardMedicineSnapshot": "v1",
    "explicitInventoryState": "v1",
    "medicineStorageBoxes": "v1",
    "caregiverMembership": "v1"
  }
}
```

不得提前声明：

```text
serviceUserPersonaTombstones
devicePairing
devicePairingIssue
remoteCommands
```

人物数据和命令要等后续独立版本完成身份代次、安全迁移和验收后再开放。

## 3. 设备身份与密钥

每块板必须使用唯一 `deviceId` 和独立随机密钥。生产云函数只读取 `DEVICE_SECRETS`：

```json
{
  "zykh-qsm-001": "<第一块板独立密钥>",
  "zykh-qsm-002": "<第二块板独立密钥>"
}
```

不支持共享 `DEVICE_SECRET` 回退。密钥不得提交到 Git、写入文档、截图或普通日志。

Station 本地配置名称以板端仓库实际实现为准，语义至少包括：

```text
CLOUD_SYNC_ENABLED=true
CLOUD_SYNC_ENDPOINT=https://<CloudBase HTTP 域名>/api
CLOUD_SYNC_DEVICE_ID=zykh-qsm-001
CLOUD_SYNC_DEVICE_SECRET=<该设备对应的独立密钥>
```

## 4. 心跳

Station 调用 `REPORT_DEVICE`。云函数忽略客户端伪造的在线状态和时间，写入服务端时间：

```text
lastSeenAt
lastSeenAtEpochMs
```

`GET_DEVICE` 和 `GET_MY_DEVICES` 由服务端返回 `heartbeatAgeMs`。小程序据此区分：

- `loading`：正在确认授权和状态。
- `online`：合法心跳仍新鲜。
- `stale`：心跳超过 60 秒，显示“等待药箱连接”。
- `unavailable`：云端读取失败。
- `unpaired`：账号没有有效授权。
- `incompatible`：云端版本或能力不匹配。

只有 `stale` 可以使用“等待药箱连接”，其它状态不能伪装成离线。

## 5. 药库快照

当前药库以 Station 的 23 行数据为唯一事实源，分类为：

| `storageBox` | 显示名 | 数量 |
| --- | --- | ---: |
| `DAILY` | 日常用药 | 9 |
| `CARE` | 外用护理 | 8 |
| `PRESCRIPTION` | 慢病处方 | 6 |

完整身份映射见 [BOARD_23_MEDICINES.md](BOARD_23_MEDICINES.md)。本地参考表只补充展示资料，不能凭空补出云端缺失药品。

上传顺序：

```text
BEGIN_SNAPSHOT
  -> snapshotId / revision / leaseToken
UPSERT_SNAPSHOT_BATCH
  -> 不可变 staging rows
FINALIZE_SNAPSHOT
  -> 校验数量、唯一 ID 和 JCS-SHA256 后原子切换 manifest
```

失败或主动取消使用 `ABORT_SNAPSHOT`。Station 必须持久化会话字段，以便进程重启后使用原 lease 续传。旧 revision、过期 lease 和迟到 finalize 必须被拒绝。

小程序通过 `GET_MEDICINE_SNAPSHOT` 读取完整 finalized manifest。兼容接口 `LIST_MEDICINES` 也只读取同一 manifest，并一次返回全部行。staging、ownerless 和其它 producer 数据不能进入家庭端药库。

旧 `UPLOAD_MEDICINES`、`UPLOAD_SNAPSHOT` 返回 `SNAPSHOT_PROTOCOL_REQUIRED`，不能继续作为新链路使用。

## 6. 既有账号授权

Release A 只接受已经存在且有效的 `device_memberships`：

1. 小程序调用 `GET_MY_DEVICES`。
2. 只能从返回的 ACTIVE 授权设备中选择。
3. 不允许手填设备编号。
4. 不提供自助签发或兑换配对码。
5. 未授权时停止所有设备级读取。

新增家属授权需要管理员在受控维护流程中完成。自助配对属于后续版本，不得为了演示绕开权限。

## 7. 部署顺序

1. 记录 Mini、CloudBase 和 Station commit，并备份数据库、索引、规则、环境变量和 Station SQLite。
2. 暂停 Station 同步 worker。
3. 在本仓库运行完整测试和 UI 静态校验。
4. 部署 `cloudfunctions/api`，但先不启动 Station。
5. 核对 `PING` 的版本与七项能力精确一致。
6. 确认目标 `deviceId` 已配置于 `DEVICE_SECRETS`，且账号已有有效 membership。
7. 部署兼容 Release A 快照协议的 Station 构建。
8. 先观察心跳，再上传 23 行 canary 快照。
9. 核对 manifest、9/8/6 分类以及 S03、S09、S13。
10. 最后预览并发布小程序。

详细操作和回滚见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 8. 第二块板迁移

第二块板不能复制第一块板的身份：

1. 分配新 `deviceId`，例如 `zykh-qsm-002`。
2. 生成新的独立随机密钥。
3. 在云函数 `DEVICE_SECRETS` 中新增映射，保留第一块板原映射。
4. 部署同一已验证 Station 构建和同一协议配置。
5. 为目标家属账号建立该设备的有效 membership。
6. 先用空业务写入之外的 `PING/REPORT_DEVICE` 验证身份。
7. 上传第二块板自己的 23 行 finalized 药库，不复制第一块板的库存、有效期或 SQLite。
8. 小程序从授权设备列表切换并分别验证两台设备数据不会串用。

完整交接清单见 [MIGRATE_TO_ANOTHER_BOARD.md](MIGRATE_TO_ANOTHER_BOARD.md)。

## 9. 排障顺序

小程序状态异常时按以下顺序排查：

1. `PING` 是否精确匹配 Release A。
2. `devices/{deviceId}.lastSeenAtEpochMs` 是否持续刷新。
3. `GET_DEVICE.heartbeatAgeMs` 是否小于 60 秒。
4. 当前微信账号是否有该设备的 ACTIVE membership。
5. Station 的 endpoint、deviceId 和设备独立密钥是否对应。
6. 当前 manifest 是否 finalized、恰好 23 行且摘要一致。
7. 小程序是否读取了 `GET_MEDICINE_SNAPSHOT`，而不是旧集合或静态药表。

不要通过写死 `online=true`、伪造本地药品、放宽密钥、重新启用旧命令或删除 S09 来绕过问题。

## 10. 当前状态

本仓库已经包含 Release A 代码和离线测试，但这不等于线上云函数已部署，也不等于真实 Station 已升级。只有云端、Station 和小程序按同一 commit 完成真机验收后，才可以宣告同步恢复。
