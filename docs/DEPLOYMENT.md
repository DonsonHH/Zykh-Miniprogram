# CloudBase Release A 部署说明

> 本文件描述待执行流程。仓库中的实现不代表云函数、数据库或真实板端已经部署。

## 1. 发布目标

Release A 只恢复三件事：

1. 已授权账号读取设备状态。
2. Station 上报服务端心跳。
3. Station 通过版本化快照上传 23 种药品，小程序只读 finalized manifest。

人物、计划、问询、体征、记录、风险事件、自助配对和远程命令在本阶段失败关闭。不要为演示伪造 capability、心跳或本地药品。

## 2. 发布前备份

记录 Mini、CloudBase 和 Station 的 commit SHA，并导出以下内容：

- CloudBase 数据集合、索引和安全规则。
- 云函数环境变量、HTTP 触发器、并发数和超时。
- `devices`、membership、命令、人物、计划、问询、体征、记录和风险相关数据。
- Station SQLite 和当前可恢复程序包。

暂停 Station 同步 worker 后再部署云函数，避免协议切换中自动写入。

## 3. 环境变量

生产环境只读取逐设备密钥映射 `DEVICE_SECRETS`：

```json
{"zykh-qsm-001":"<至少 32 字节的独立随机密钥>"}
```

- 不支持共享 `DEVICE_SECRET` 回退。
- 密钥不得写入 Git、截图或日志。
- 每块板使用独立 `deviceId` 和独立密钥。
- 未配置目标设备密钥时，所有板端 action 都应拒绝。

## 4. 数据集合

确认至少存在：

```text
devices
device_memberships
snapshot_heads
snapshot_sessions
snapshot_rows
snapshot_manifests
```

既有业务集合保留，不做全集合清理。`snapshot_rows` 和 `snapshot_manifests` 是不可变版本数据；旧 finalized 版本至少保留 10 分钟。ownerless 或其它 producer 数据不得由 finalize 自动删除。

## 5. 离线验证

在仓库根目录执行：

```bash
node --test tests/*.test.js
node tools/validate-miniprogram-ui.js
```

确认工作树中的云函数来自固定 commit，不从未记录的临时文件直接部署。

## 6. 部署云函数

在微信开发者工具中右键 `cloudfunctions/api`，选择“上传并部署：云端安装依赖”。板端仍保持暂停，先调用 `PING`。

Release A 必须精确返回以下能力：

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

不得出现：

```text
serviceUserPersonaTombstones
devicePairing
devicePairingIssue
remoteCommands
```

PING 不符合时不要启动板端，直接恢复上一版云函数。

## 7. 启动 Station

Station 端必须先实现同一套协议：

```text
PING
REPORT_DEVICE
BEGIN_SNAPSHOT
UPSERT_SNAPSHOT_BATCH
FINALIZE_SNAPSHOT
ABORT_SNAPSHOT
GET_BOARD_MEDICINE_MANIFEST（核对云端 manifest）
```

其中小程序使用 `GET_MEDICINE_SNAPSHOT` 读取完整 finalized envelope；Station 使用受设备鉴权保护的 `GET_BOARD_MEDICINE_MANIFEST` 只读取当前 manifest 元数据，并据此判断是否需要重传。两者不能互换，也不能绕过 finalized pointer 直接读取 staging 行。

Station 需持久化 `instanceId/snapshotId/revision/digest/leaseToken`，重启时带原 lease 恢复上传。lease 过期后由更高 revision 接管，旧 revision 后续 batch/finalize 必须被拒绝。

不要让当前只支持旧 `UPLOAD_MEDICINES` 或 `UPLOAD_SNAPSHOT` 的板端连接 Release A；这两个入口会返回 `SNAPSHOT_PROTOCOL_REQUIRED`。

## 8. 验收

1. `devices/zykh-qsm-001.lastSeenAtEpochMs` 持续刷新。
2. 设备文档显示 `agentVersion=release-a-snapshot-v1` 和 `schemaRevision=3.0-three-box-library`。
3. `GET_DEVICE` 返回服务端计算的 `heartbeatAgeMs`。
4. Station 的 `GET_BOARD_MEDICINE_MANIFEST` 与小程序的 `GET_MEDICINE_SNAPSHOT` 指向同一 finalized 版本。
5. 当前 manifest 恰好 23 行，分类为 9/8/6。
6. S09 可见于“慢病处方”。
7. S03 显示蒙脱石散，S13 显示布洛芬缓释胶囊。
8. 写入未 finalize staging、ownerless 或其它 producer 行，小程序仍只显示上一版 manifest。
9. 停止心跳超过 60 秒后，小程序才显示“等待药箱连接”；恢复后下一轮轮询自动在线。
10. `OPEN_CABINET`、`DISPENSE`、`UPSERT_MEDICINE` 和任意远程命令均不能执行。
11. 人物相关页面显示安全迁移状态，不回退到按姓名或旧 deviceId 读取。

## 9. 小程序发布

真机预览确认首页、药库、问询、照护和家人五个 Tab。药库可见集合必须来自完整 manifest；“家人”页只能选择账号已有 ACTIVE membership 的药箱，不提供手填编号。

确认一轮 20 秒页面轮询和一次 60 秒断网恢复后，再上传小程序并提交审核。

## 10. 回滚

- PING 不合格：保持 Station 暂停，恢复上一版云函数和环境变量。
- 快照失败：暂停 Station，保存日志和 manifest 指针，成对恢复云端指针、版本数据和 Station SQLite。
- 不得通过删除 S09、改回 22 种、放宽摘要或回执校验解决同步失败。
- 小程序发布失败可单独回滚小程序；已验证的云端 manifest 不应因此改写。
