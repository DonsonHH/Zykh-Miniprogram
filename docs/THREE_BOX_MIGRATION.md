# 三盒药库与板端同步迁移说明

本文档对应 CloudBase schema revision `3.0-three-box-library`。目标是把旧版“23 个独立药仓 + 电控出药”迁移为“终端溯源码入库 + 三个分类药盒 + 家庭药品管理”。

## 1. 新的职责边界

```text
QSM368 Station
  扫描溯源码、建立药品档案、AI 问询、风险核验、现场用药确认
        ↓ 主动上传
CloudBase api 云函数
  设备鉴权、快照存储、账号授权、风险与记录查询
        ↓
微信小程序
  家属查看、提醒、药品维护提示、问询摘要、用药风险与照护记录
```

小程序不再提供仓位编辑、开柜、舵机控制或自动出药。药品扫描入库以 Station 本地数据库为事实源。

## 2. 三个普通药柜与冷藏药品

| `storageBox` | 界面名称 | 内容 |
| --- | --- | --- |
| `DAILY` | 日常高频内服 | 感冒、发热、咳嗽、过敏与胃肠不适 |
| `CARE` | 外用消毒护理 | 消毒、伤口、皮肤、鼻部与局部疼痛 |
| `PRESCRIPTION` | 慢病处方储备 | 慢病、处方、固定用药与低频储备 |

双歧杆菌三联活菌肠溶胶囊使用 `COLD` 标识，存放在冰箱，不计入三个普通药柜。

旧 23 仓数据的一次性默认映射如下：

| 新药盒 | 旧仓号 |
| --- | --- |
| 日常高频内服 | 1、3、5、7、8、11、12、13、23 |
| 外用消毒护理 | 10、15、16、17、18、19、20、22 |
| 慢病处方储备 | 2、4、6、14、21 |
| 冷藏药品 | 9 |

该映射只用于迁移现有 23 条记录。迁移后必须把结果写入 `storage_box`，不得继续按旧仓号决定药品位置。

23 种药品的准确名称、厂家和盒内顺序见 [FIXED_23_MEDICINES.md](FIXED_23_MEDICINES.md)。

## 3. Station 数据库迁移

建议在本地 `medicines` 表增加并回填：

```text
medicine_id       TEXT NOT NULL   稳定药品记录 ID
storage_box       TEXT NOT NULL   DAILY / CARE / PRESCRIPTION / COLD
trace_code        TEXT            溯源码
inventory_state   TEXT            STOCKED / DEPLETED / UNKNOWN
expire_date       TEXT            YYYY-MM 或 YYYY-MM-DD
expiry_precision  TEXT            month / day
```

规则：

1. `medicine_id` 一经生成不得随名称、有效期或药盒变化而改变。
2. 新扫描记录应使用本地 UUID 或数据库稳定主键生成 `medicine_id`，不要用药盒位置作为身份。
3. 旧记录可先使用 `legacy-slot-<旧仓号>`，完成迁移后仍保持该 ID 稳定。
4. `trace_code` 用于追溯和识别；除非业务确认唯一，不应代替数据库主键。
5. `inventory_state` 是余量事实。不要仅根据 `quantity` 推导缺药或低余量。

## 4. 药品上传契约

Station 使用 `UPLOAD_MEDICINES` 或快照批次接口上传。每条记录至少包含：

```json
{
  "medicineId": "med-8d3d4f2a",
  "name": "阿莫西林胶囊",
  "spec": "0.25g*24粒",
  "traceCode": "追溯码或条码",
  "manufacturer": "生产厂家",
  "storageBox": "DAILY",
  "inventoryState": "STOCKED",
  "expireDate": "2027-12",
  "expiryPrecision": "month"
}
```

云端文档 ID 由 `deviceId + medicineId` 生成。`slot` / `hardware_slot` 仍可随旧记录上传，但只作为兼容字段，小程序不会显示或操作它。

## 5. 余量状态更新

当前版本不建立取药流程，也不生成取药记录。若终端确认某种药已经用完，只更新该药品的余量事实：

```json
{
  "inventoryState": "DEPLETED",
  "depletionConfirmedAt": "2026-08-19 20:00:05",
  "depletionConfirmationSource": "ON_DEVICE_CONFIRMATION"
}
```

小程序据此生成补药提醒；`UNKNOWN` 不生成补药待办。

## 6. 用药风险事件

AI 给出药品建议前，Station 应结合当前人物档案和药库信息完成核验。明确风险事件示例：

```json
{
  "type": "MEDICATION_SAFETY_EVENT",
  "event_id": "risk-20260819-001",
  "service_user_id": "person-zhang",
  "persona_generation": "g1",
  "person_display_name": "张三",
  "medicine_id": "med-ibuprofen",
  "medicine_name": "布洛芬缓释胶囊",
  "check_status": "BLOCKED",
  "dispense_status": "NOT_APPLICABLE",
  "reason_codes": ["CONTRAINDICATION"],
  "caregiver_summary": "与已登记的消化道溃疡病史存在禁忌冲突。",
  "occurred_at": "2026-08-19 20:10:00",
  "read_state": "UNREAD"
}
```

小程序按“人物身份版本 + 药品身份”合并重复核验，集中显示谁不宜使用哪些药；原始事件仍保留在照护历史中。

## 7. 旧功能处理

- 停止板端产生 `OPEN_CABINET`、`DISPENSE` 或舵机执行请求。
- 不再把 `dispense_status=DISPENSED` 作为新版用药完成依据。
- `UPSERT_MEDICINE` 仅作为旧客户端兼容命令；新流程必须由 Station 扫码入库后上传快照。
- 旧 `slot` 字段不得出现在新版用户界面、提醒文案或风险结论中。

## 8. 部署与验收

1. 部署本仓库 `cloudfunctions/api`，调用 `PING`，确认 `schemaRevision` 为 `3.0-three-box-library`。
2. 确认能力包含 `medicineStorageBoxes=v1` 和 `medicationRiskRegistry=v1`。
3. 完成本地数据库迁移并上传一次完整药品快照。
4. 备份并清理该设备旧版随机 ID 药品文档；云函数只会自动回收由 `zykh_station_app` 标记为同步所有者的旧快照。
5. 在云数据库确认同一设备每个 `medicineId` 只有一条药品文档。
6. 打开小程序“药库”，确认日常高频内服 9 种、外用消毒护理 8 种、慢病处方储备 5 种，冷藏药品 1 种。
7. 修改一条药品有效期并重新上传，确认小程序在下一次实时刷新后更新。
8. 上传一条 `DEPLETED` 药品，确认出现补药提示；上传 `UNKNOWN`，确认只显示余量待确认。
9. 上传一条 `BLOCKED + NOT_APPLICABLE` 风险事件，确认“用药风险”页按人物和药品展示。
10. 确认小程序不存在取药记录、23 仓、开柜、出药或舵机操作入口。

## 9. 回滚原则

迁移前备份 Station SQLite 和 CloudBase `medicines` 集合。若新版同步异常，只回滚程序版本和数据库备份，不要让新版 `medicineId` 与旧版随机文档 ID 同时写入同一设备作用域。
