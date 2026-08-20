# 药箱端同步升级交接

> **旧版文档，仅供追溯。** 本文描述 23 个物理仓位和 `UPSERT_MEDICINE` 维护流程，已经被取消，不能用于当前部署。当前实现请阅读 `docs/THREE_BOX_MIGRATION.md` 与 `docs/SYNC_AND_MIGRATION_GUIDE.md`。

## 当前状态

小程序已经改为**只**创建 `UPSERT_MEDICINE` 命令，不再直接写 CloudBase 的
`medicines` 集合。提交前会严格读取当前仓位快照；读取失败时不会创建命令，以免
旧版同步器用空值覆盖已有药品字段。

命令进入队列时，小程序只显示“已提交，等待药箱同步”。这不表示药箱已写入，也不
表示随后生成的快照已回传云端。

GitHub 原始提交 `e6155ccf3c87179efd127c5c203d1b7a9e3f9d43` 的新版
`zykh_station_app` 曾不支持 `operation: "patch"`：它忽略嵌套 `patch`，并会将
未携带的 barcode、category、unit、expiry 写成默认值或空字符串，且把库存 `0` 改成
`1`。

对应修复现已实现在本地隔离副本
`D:\zykh_miniprogam\.board_patch_e615\zykh_station_app` 中，并已提交为
`de3363fc6c5e5b795c9fd8fa067ca542ea445a26`（未推送远端）。部署时请将该补丁合入
实际运行的 Station 板端仓库。该副本不等于用户提供的微信小程序 ZIP，后者不含
Station/Python 板端代码。

## 小程序命令契约

小程序会始终携带板端现有值的顶层兼容字段，同时将本次变更放入 `patch`：

```json
{
  "schemaVersion": 2,
  "operation": "patch",
  "slot": 3,
  "hardware_slot": 3,
  "name": "示例药品",
  "barcode": "6901234567890",
  "code": "6901234567890",
  "category": "消化系统",
  "unit": "瓶",
  "quantity": 8,
  "stock": 8,
  "expireDate": "2027-12",
  "expire_date": "2027-12",
  "expiryPrecision": "month",
  "lowStockLine": 2,
  "trace_code": "trace-001",
  "patch": {
    "quantity": 8,
    "expireDate": "2027-12",
    "expire_date": "2027-12"
  }
}
```

规则：

- `barcode/code` 只表示条码；不能把 `traceCode/trace_code` 当作条码回退。
- `YYYY-MM` 与 `YYYY-MM-DD` 必须原样保存。月精度代表该月最后一天到期。
- `patch` 允许只放变化；顶层字段在兼容旧 Worker 时仍必须完整。
- 小程序与修复后的板端均支持库存 `0`。在部署板端补丁之前，不应把支持 `0` 的小程序
  发布到仍运行原始 Worker 的药箱。

## 已完成、待合入的新版 Station 板端改动

目标代码为：

```text
zykh_station_app/backend/app/
  db.py
  schemas/medicine.py
  repositories/medicine_repository.py
  services/cloud_sync_service.py
```

### 1. 以仓位为身份实现 patch 合并

在 `CloudSyncWorker._upsert_medicine` 中：

1. 将 `hardware_slot` / `slot` 规范为 1–23 的整数。
2. 按仓位查询本地药品，而不是按 barcode 查询。
3. `operation == "patch"` 时先读取嵌套 `payload.patch`；仅当字段实际出现时才更新。
   不能使用 `value or default`，否则 `0` 和空字符串会被误判为缺失。
4. 顶层 `barcode/code`、`traceCode/trace_code`、`category`、`unit` 可作为兼容
   字段合并；新 patch 协议不得把 `spec` 当作 `category`。
5. 已有仓位用仓储层的 merge 更新。空仓位新增时按仓位创建，不能调用
   `create_from_scan` 的 barcode 去重路径；相同条码可以在不同仓位出现。
6. 只有创建新仓位时才要求 `name` 和建档默认值。

现有 `MedicineRepository.update()` 已经具备“未传字段保留”的基础能力；问题在于
Worker 调用它之前主动构造了默认字段。本补丁新增：

```python
get_by_hardware_slot(slot)
create_for_hardware_slot(...)
```

### 2. 补齐持久化字段

当前表中已有 `barcode/category/unit/stock/expire_date`，无需为这些字段迁移。
但小程序使用而新版 Station 尚未持久化的字段是：

```text
spec             # 规格 / 包装；不要再借用 category
low_stock_line   # 自定义低库存阈值
trace_code       # 药品追溯码
```

在 `db.py` 的建表和可重复执行迁移中加入：

```python
_ensure_column(conn, "medicines", "spec", "TEXT DEFAULT ''")
_ensure_column(conn, "medicines", "low_stock_line", "INTEGER NOT NULL DEFAULT 1")
_ensure_column(conn, "medicines", "trace_code", "TEXT DEFAULT ''")
```

随后贯通 `Medicine` / 更新 schema / SELECT / row mapper / create / update。
`expire_date TEXT` 可直接保存月或日精度，不需要单独增加精度列；快照可从格式推导
`expiryPrecision`。

### 3. 修正快照

`_build_snapshot()` 必须回传真实字段：

```text
spec             <- medicine.spec
lowStockLine     <- medicine.low_stock_line
traceCode        <- medicine.trace_code
barcode/category/unit/stock/expire_date <- 对应本地真实值
expiryPrecision  <- expire_date 是 YYYY-MM ? month : day
```

不要再把 `spec` 映射成 `category`，也不要把 `lowStockLine` 写死为 `1`。

### 4. ACK 与快照的正确语义

当前 Worker 的顺序是：

```text
写入本地 SQLite
  -> ACK_COMMAND done
  -> 本轮稍后构建并上传快照
```

因此 `done` 只表示命令已落板端本地数据库；若随后网络中断，CloudBase 快照会在之后
补传。小程序不应把命令 ACK 表示为“云端已保存”。

## 回归测试

至少覆盖：

1. 已有仓位只改库存，仍保留 barcode、category、unit、spec、低库存线和有效期。
2. `quantity: 0` 能正确保存为 0。
3. `2027-12` 与 `2027-12-31` 原样 round-trip。
4. `expiryPrecision` 与日期格式不匹配时拒绝命令。
5. 相同 barcode 在空仓位创建时不会返回另一个仓位。
6. 快照可完整回传 spec、lowStockLine、traceCode 及现有字段。

已验证命令：

```bash
python -m unittest tests.test_cloud_sync_service tests.test_medicine_inventory_contract tests.test_medicine_guidance tests.test_dispense_identity_records
```

当前结果：**50 项通过**。另跑过整套 `unittest discover`；其中与本次改动无关的
`test_vitals_uart8_parser` 因 Windows 缺少 Unix `termios` 而无法导入。完整运行中
`test_qsm_camera_service` 曾出现一次 Windows 文件并发拒绝访问；单独复跑其 3 项后通过。

## 部署注意

工作区中的旧 `qsm_agent/cloud_agent.pl` 与 `zykh_app/server.pl` 并不是上述新版
Station Worker，不能用旧代理直接替换新版服务。用户提供的
`wechatlittleprogram (2)(1).zip` 也只含小程序和云函数；请从本地隔离副本或 GitHub
提交中把这次 Station 补丁合入实际部署分支，再完成设备侧集成测试。
