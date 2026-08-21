# 三柜药库与板端同步迁移说明

本文档对应 CloudBase schema revision `3.0-three-box-library`。Station 是药品事实源；CloudBase 保存版本化快照；小程序是家庭照护端只读投影。

## 1. 职责边界

```text
QSM368 Station
  溯源码入库、23 种稳定药品身份、三柜分类、现场余量和有效期
        ↓ 主动上传并 finalize
CloudBase api
  逐设备认证、心跳、fencing 会话、不可变行和 authoritative manifest
        ↓ 账号授权读取
微信小程序
  家属查看药库、同步状态和后续照护信息
```

小程序不编辑药品、不发送 `UPSERT_MEDICINE`、不维护物理柜号，也不提供开柜、出药或点灯入口。

## 2. 三个药柜

| `storageBox` | 小程序名称 | 当前数量 |
| --- | --- | ---: |
| `DAILY` | 日常用药 | 9 |
| `CARE` | 外用护理 | 8 |
| `PRESCRIPTION` | 慢病处方 | 6 |

总计 23 种。完整身份与 S03/S09/S13 特殊映射见 [BOARD_23_MEDICINES.md](BOARD_23_MEDICINES.md)。

`storageBox` 是跨端分类码，不等于物理柜号。Station 本地 `cabinet_id` 不上传 CloudBase。

## 3. 药品行合同

每条 Station 药品行至少包含：

```json
{
  "deviceId": "zykh-qsm-001",
  "medicineId": "slot-09-bifid-triple",
  "name": "双歧杆菌三联活菌肠溶胶囊",
  "storageBox": "PRESCRIPTION",
  "inventoryState": "STOCKED",
  "expireDate": "2027-12",
  "expiryPrecision": "month"
}
```

规则：

1. `medicineId` 非空且在同一快照内全局唯一。
2. camel/snake 身份或分类同时存在时必须一致。
3. `storageBox` 只允许 `DAILY / CARE / PRESCRIPTION`。
4. `inventoryState` 使用 `STOCKED / DEPLETED / UNKNOWN`，不能仅凭数量猜测。
5. `cabinet_id/cabinetId` 被云端拒绝。
6. 未被小程序本地参考表识别但结构合法的药品仍可见。

## 4. 版本化快照

Station 不再直接覆盖 live medicines 集合：

```text
BEGIN_SNAPSHOT
  -> 获得 snapshotId / 单调 revision / 一次性 leaseToken
UPSERT_SNAPSHOT_BATCH
  -> 写入该版本不可变 staging rows
FINALIZE_SNAPSHOT
  -> 校验 count / ID / ordinal / JCS-SHA256 后原子切换 manifest
```

- 摘要版本固定为 `jcs-sha256-v1`。
- 同键同 canonical bytes 重试幂等；同键不同内容冲突。
- 同一会话不允许重复 ID、batch ordinal 或覆盖区间。
- 旧实例、过期 lease 和迟到 finalize 均由 fencing 拒绝。
- `ABORT_SNAPSHOT` 隔离失败会话，不立即删除审计数据。
- 旧 finalized 版本至少保留 10 分钟，持有旧 version token 的在途读仍能完成。
- ownerless 和其它 producer 行不自动删除，也永远不进入家庭端药库。

`LIST_MEDICINES` 仅作为旧客户端只读兼容接口，数据源仍是同一 finalized manifest，并一次返回完整数组，不使用默认 20 条截断。

## 5. 小程序投影

小程序调用 `GET_MEDICINE_SNAPSHOT`，只接受包含以下证明的响应：

```text
boardMedicineSnapshot=v1
protocol=boardMedicineSnapshot:v1
kind=medicines
canonicalDigestVersion=jcs-sha256-v1
snapshotComplete=true
snapshotId/revision/digest/rowCount/deviceId 完整且一致
```

任何缺失、冲突或非法行都失败关闭。上次成功数据可单独标记为 last-known，但不能伪装成当前快照，也不能把协议不兼容误写成“等待药箱连接”。

## 6. Release A 限制

Release A 仅同步心跳和药库。人物、计划、问询、体征、记录、风险事件、自助配对和远程命令仍处于迁移门禁中。

因此：

- `UPLOAD_MEDICINES/UPLOAD_SNAPSHOT` 返回 `SNAPSHOT_PROTOCOL_REQUIRED`。
- `UPSERT_MEDICINE` 永久禁用。
- `OPEN_CABINET/DISPENSE` 永久禁用。
- 人物相关 action 返回 `PERSONA_DATA_MIGRATION_IN_PROGRESS`。
- 命令相关 action 返回 `REMOTE_COMMANDS_DISABLED`。

## 7. 验收

1. 云端 PING 与 Release A 七项能力精确一致。
2. 当前 manifest 为 23 行、9/8/6。
3. S09 位于慢病处方，无 `COLD` 分类。
4. S03/S13 使用正确 canonical ID 和名称。
5. staging、ownerless 和其它 producer 行不进入小程序。
6. finalize 前持续读取旧完整版本，finalize 后一次切换到新完整版本。
7. 小程序所有药品维护入口只提示到 Station 现场操作。

## 8. 回滚

迁移前备份 Station SQLite、CloudBase manifest pointer、session、rows 和 membership。失败时先暂停 Station，再成对恢复云端版本指针和本地 SQLite；不能全表删除，也不能退回 22 种或删除 S09。
