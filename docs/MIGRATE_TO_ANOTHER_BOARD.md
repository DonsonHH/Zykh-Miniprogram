# 智药康护第二块 QSM368 迁移手册

> 适用版本：CloudBase schema revision `3.0-three-box-library`，Release A。本文供另一台电脑上的工程师独立完成迁移。当前仓库未包含 Station 主程序，也不包含任何设备密钥。

## 1. 迁移目标

第二块板接入同一个 CloudBase 和同一个小程序，但拥有独立身份、独立药库和独立心跳：

```text
QSM368 #1 -> zykh-qsm-001 -> 自己的心跳与 23 行药库
QSM368 #2 -> zykh-qsm-002 -> 自己的心跳与 23 行药库
                              ↓
                     同一个 CloudBase api
                              ↓
                     经授权的小程序账号
```

两块板不能共用 `deviceId`、密钥、SQLite 或快照会话。Release A 不迁移远程命令、人物、计划、问询、体征、记录、风险或自助配对。

## 2. 交接物

向第二位工程师提供：

1. 本小程序仓库的固定 commit 或发布压缩包。
2. 与 Release A 兼容的 `Zykh-QSM Station` 固定 commit 或安装包。
3. CloudBase 环境 ID、HTTP 访问入口和有权限的开发账号。
4. 第二块板的全新 `deviceId`。
5. 第二块板的独立密钥，通过安全渠道单独交接。
6. 该微信账号所需的既有 membership 变更单。
7. 云函数、数据库与第一块板的回滚备份位置。

不要交接第一块板的 `.env`、SQLite、密钥、快照 lease 或运行缓存。

## 3. 第二台电脑准备

安装：

- 微信开发者工具 Stable。
- Git 与 Node.js 20 或更高版本。
- Station 仓库要求的板端部署工具。
- 可访问 CloudBase 的网络。

从固定 commit 检出小程序：

```powershell
git clone https://github.com/DonsonHH/Zykh-Miniprogram.git
Set-Location Zykh-Miniprogram
git checkout <交接的固定 commit>
```

运行离线检查：

```powershell
node --test tests/*.test.js
node tools/validate-miniprogram-ui.js
```

所有检查通过后，用微信开发者工具导入仓库根目录，不能只导入 `miniprogram/` 子目录。

## 4. CloudBase 核对

当前工程使用的环境以 `miniprogram/app.js` 和 `cloudbaserc.json` 为准。生产发布前确认：

```text
/api HTTP 入口 -> cloudfunctions/api
schemaVersion -> 2
schemaRevision -> 3.0-three-box-library
```

`PING` 必须只声明 Release A 七项能力：

```text
snapshotBatch=v2
snapshotFencing=v1
snapshotCanonicalDigest=jcs-sha256-v1
boardMedicineSnapshot=v1
explicitInventoryState=v1
medicineStorageBoxes=v1
caregiverMembership=v1
```

若出现 `remoteCommands`、`devicePairing` 或人物代次能力，停止迁移并核对发布版本。若缺任一七项能力，也不要启动第二块板同步。

## 5. 创建设备身份

为第二块板生成唯一 ID，例如：

```text
zykh-qsm-002
```

生成至少 32 字节的随机密钥，不要复用第一块板密钥。把它加入云函数环境变量 `DEVICE_SECRETS`：

```json
{
  "zykh-qsm-001": "<第一块板密钥>",
  "zykh-qsm-002": "<第二块板密钥>"
}
```

更新时必须保留仍在使用的第一块板映射。生产云函数没有共享 `DEVICE_SECRET` 回退，目标 ID 未配置时会拒绝所有板端写入。

## 6. 建立账号授权

Release A 不开放自助配对。上线前由管理员在受控维护流程中，为目标微信账号建立 `device_memberships` ACTIVE 授权，并确保：

- membership 指向 `zykh-qsm-002`。
- 账号标识来自可信的 CloudBase 身份，不由客户端自报。
- 没有把第一块板的数据或人物 scope 复制给第二块板。
- 权限只满足设备状态和药库只读需要。

小程序只能从 `GET_MY_DEVICES` 返回的授权列表选择设备，不能手填 ID。

## 7. 部署第二块 Station

使用交接的固定 Station 构建。配置项名称以 Station 仓库为准，语义至少包含：

```text
CLOUD_SYNC_ENABLED=true
CLOUD_SYNC_ENDPOINT=https://<CloudBase HTTP 域名>/api
CLOUD_SYNC_DEVICE_ID=zykh-qsm-002
CLOUD_SYNC_DEVICE_SECRET=<第二块板独立密钥>
```

Station 必须实现：

```text
PING
REPORT_DEVICE
BEGIN_SNAPSHOT
UPSERT_SNAPSHOT_BATCH
FINALIZE_SNAPSHOT
ABORT_SNAPSHOT
```

并持久化：

```text
instanceId
snapshotId
snapshotRevision
digest
leaseToken
```

只支持 `UPLOAD_MEDICINES` 或 `UPLOAD_SNAPSHOT` 的旧构建不兼容 Release A，不能上线。

## 8. 首次启动顺序

1. 保持第一块板运行状态不变，记录其当前心跳和 manifest。
2. 启动第二块板，但先只允许 `PING`。
3. 核对云端版本和七项 capability。
4. 开放 `REPORT_DEVICE`，确认只更新 `zykh-qsm-002`。
5. 确认第一块板 `zykh-qsm-001` 的心跳没有被覆盖。
6. 上传第二块板完整 23 行药库 staging。
7. finalize 后核对 manifest 总数 23，分类 9/8/6。
8. 核对 S03、S09、S13 的稳定 ID 和分类。
9. 在小程序授权列表切换到第二块板，确认显示的是它自己的药库。
10. 切回第一块板，确认页面状态、药库和迟到响应都没有串到第二块板。

## 9. 药库验收

第二块板当前权威药库合同：

- 总计 23 种。
- `DAILY=9`、`CARE=8`、`PRESCRIPTION=6`。
- S09 `slot-09-bifid-triple` 属于 `PRESCRIPTION`。
- Station S03 蒙脱石散投影为 `slot-13-montmorillonite`。
- Station S13 布洛芬缓释胶囊投影为 `slot-03-ibuprofen`。
- 不存在 `COLD` 分类。
- 每条药品有稳定 `medicineId`、合法 `storageBox` 和显式 `inventoryState`。
- `cabinet_id/cabinetId` 不上传 CloudBase。

小程序可见集合必须完全来自 finalized manifest。本地参考表只能补充名称、厂家等展示字段，不能生成第 24 种药或补回云端缺失药。

## 10. 小程序验收

1. 冷启动先显示加载状态，不闪现“等待药箱连接”。
2. 心跳新鲜时显示在线。
3. 停止第二块板超过 60 秒后才显示“等待药箱连接”。
4. 云端读取失败显示“状态暂不可用”。
5. 云端版本不匹配显示“云端版本待升级”。
6. 无授权账号进入授权恢复页，不读取设备数据。
7. 药库显示 23 行、9/8/6，并保留未知但合同合法的未来药品。
8. staging、ownerless 和其它 producer 行不可见。
9. 小程序没有远程改药、开柜、出药或命令入口。

## 11. 常见问题

### `unauthorized`

检查 `deviceId` 是否存在于 `DEVICE_SECRETS`，以及第二块板是否使用自己的密钥。不要添加共享密钥回退。

### `SNAPSHOT_PROTOCOL_REQUIRED`

板端仍在调用旧上传接口。升级 Station 到支持 begin/batch/finalize/fencing 的构建。

### 小程序显示“云端版本待升级”

线上 `PING` 与 Release A 不精确匹配。停止 Station，修正云函数版本后再继续。

### 小程序显示“等待药箱连接”

这是合法心跳已超过 60 秒。检查 Station worker、网络、HTTP 入口、设备身份和 `REPORT_DEVICE` 日志。

### 药库为空但设备在线

检查是否已有 finalized medicines manifest。仅写 staging 不会改变小程序当前药库。

### 两块板数据串用

立即停止第二块板，检查是否复制了第一块板 `deviceId`、SQLite、instanceId 或 lease。恢复备份后用新身份重新迁移。

## 12. 回滚

1. 停止第二块板同步 worker。
2. 保留日志、失败 session 和 staging 审计数据。
3. 从 `DEVICE_SECRETS` 移除第二块板映射，不修改第一块板映射。
4. 撤销第二块板 membership。
5. 恢复迁移前 manifest pointer 和相关版本数据；不要清空整个集合。
6. 恢复 Station 程序和 SQLite 时必须成对处理，避免本地 hash 与云端 manifest 不一致。

不得通过复用第一块板身份、删除 S09、退回 22 种、伪造在线或放宽快照校验完成回滚。

## 13. 交接签字清单

- [ ] Mini 固定 commit 与测试结果已记录。
- [ ] Station 固定 commit 与构建哈希已记录。
- [ ] 第二块板 ID 唯一。
- [ ] 第二块板密钥独立并通过安全渠道交付。
- [ ] `DEVICE_SECRETS` 保留第一块板且新增第二块板。
- [ ] 目标账号已有受控 membership。
- [ ] PING 精确匹配 Release A。
- [ ] 两块板心跳可同时刷新且互不覆盖。
- [ ] 第二块板 manifest 为 23 行、9/8/6。
- [ ] 小程序切换设备不串数据。
- [ ] 回滚备份和负责人已确认。
