# 板端 23 种药品参考清单

本表是小程序的展示参考，不是库存事实源。药品是否存在、余量、有效期和分类，均由 Station 上传并完成 `FINALIZE_SNAPSHOT` 的药品 manifest 决定；本地清单只补充说明、标签和图标。

当前权威规模为 23 种，三个药柜分别为 `DAILY=9`、`CARE=8`、`PRESCRIPTION=6`。界面统一显示“日常用药 / 外用护理 / 慢病处方”。

| Station 编号 | 云端 `medicineId` | 药品名称 | `storageBox` |
| ---: | --- | --- | --- |
| S01 | `slot-01-fufang-ganmaoling` | 复方感冒灵颗粒 | DAILY |
| S02 | `slot-02-centrum` | 多维元素片 | PRESCRIPTION |
| S03 | `slot-13-montmorillonite` | 蒙脱石散 | DAILY |
| S04 | `slot-04-amoxicillin` | 阿莫西林胶囊 | PRESCRIPTION |
| S05 | `slot-05-nin-jiom-pei-pa-koa` | 蜜炼川贝枇杷膏 | DAILY |
| S06 | `slot-06-lactulose` | 乳果糖口服液 | PRESCRIPTION |
| S07 | `slot-07-yinhuang` | 银黄颗粒 | DAILY |
| S08 | `slot-08-huoxiang-zhengqi` | 藿香正气丸 | DAILY |
| S09 | `slot-09-bifid-triple` | 双歧杆菌三联活菌肠溶胶囊 | PRESCRIPTION |
| S10 | `slot-10-gauze` | 医用纱布敷料 | CARE |
| S11 | `slot-11-guilin-xiguashuang` | 桂林西瓜霜 | DAILY |
| S12 | `slot-12-hydrotalcite` | 铝碳酸镁咀嚼片 | DAILY |
| S13 | `slot-03-ibuprofen` | 布洛芬缓释胶囊 | DAILY |
| S14 | `slot-14-oseltamivir` | 磷酸奥司他韦胶囊 | PRESCRIPTION |
| S15 | `slot-15-mupirocin` | 莫匹罗星软膏 | CARE |
| S16 | `slot-16-ketoconazole` | 酮康唑乳膏 | CARE |
| S17 | `slot-17-iodophor` | 碘伏消毒液 | CARE |
| S18 | `slot-18-budesonide-nasal` | 布地奈德鼻喷雾剂 | CARE |
| S19 | `slot-19-ketoprofen-gel` | 酮洛芬凝胶 | CARE |
| S20 | `slot-20-bandage` | 创口贴 | CARE |
| S21 | `slot-21-amlodipine` | 苯磺酸氨氯地平片 | PRESCRIPTION |
| S22 | `slot-22-cotton-swab` | 医用棉签 | CARE |
| S23 | `slot-23-desloratadine` | 枸地氯雷他定胶囊 | DAILY |

## 必须保持的映射

- S09 必须保留在 `PRESCRIPTION`，不得隐藏、删除或改成冷藏分类。
- Station S03 蒙脱石散投影为 `slot-13-montmorillonite`，兼容号为 13。
- Station S13 布洛芬缓释胶囊投影为 `slot-03-ibuprofen`，兼容号为 3。
- 未知但结构合法的板端 `medicineId` 仍需显示，不能因本地参考表未收录而丢弃。
- 缺少稳定 ID、分类非法或 camel/snake 身份冲突的行必须隔离并报错，不能猜测分类。

## 使用规则

1. 小程序不得用本表补出 manifest 中不存在的药品。
2. 小程序不得覆盖云端的 `medicineId`、`storageBox`、库存和有效期。
3. `cabinet_id` 属于 Station 本地物理信息，不上传 CloudBase。
4. `legacySlot` 只用于迁移诊断，不决定分类，也不在家庭用户界面展示。
5. 处方药、抗菌药及存在慢病或过敏风险的药品，不因出现在家庭药库中就代表适合某位家人使用。
