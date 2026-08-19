# 板端与小程序兼容性审计（2026-08-09）

审计对象为 GitHub `main` 的 `a27057c`（v1.8.9）及当前小程序工作区。

## 结论

核心业务数据模型可以对应，但 CloudBase 适配层存在版本漂移，**不能直接用 GitHub
最新板端的 `cloudfunctions/api` 覆盖当前生产云函数**。

| 位置 | 已知 revision | 说明 |
| --- | --- | --- |
| 已部署 CloudBase | `2.1-miniprogram` | 当前仍支持按需读取问询过程 |
| 小程序工作区云函数 | `2.2-miniprogram` | 使用摘要列表与详情懒加载契约 |
| 最新板端仓库云函数 | `2.4-medicine-safety-contract` | 新药品校验更严格，但缺少若干小程序能力 |

## 上线阻断项

1. `2.4` 未实现 `GET_INQUIRY_DETAIL`；小程序“查看过程”依赖该动作。直接部署会让问询详情读取失败。
2. 小程序药品 patch 同时兼容 `expiryPrecision` 与 `expiry_precision`，而 `2.4` 只接受前者；新增药品或改有效期会被拒绝。
3. `2.4` 列表/快照直接返回完整问询 messages，回退了“列表只摘要、点击再读取过程”的隐私与性能边界。

`AUDIO_SPEAK` 已在 `2.4` 的命令允许列表中；板端同步文档的支持列表未列出它，属于文档缺口而非运行时不兼容。

## 部署前的最小合并方案

以小程序工作区云函数为基础吸收板端药品安全校验，同时保留：

- `GET_INQUIRY_DETAIL`；
- 摘要列表和过程详情分层；
- `expiry_precision` 的兼容别名，或同步让所有小程序版本只发送驼峰字段。

部署校验必须同时确认 `schemaVersion` **和**预期 `schemaRevision`，不能只检查都为
`2`。

## 设备与数据安全

- 停用旧 `qsm_agent/cloud_agent.pl`，或在 schema 2 下拒绝它的 `UPLOAD_*`。旧代理没有
  `agentVersion`，且会用精简药品行覆盖新的安全资料字段。
- `FINALIZE_SNAPSHOT` 不能针对“只同步最近 100 条”的问询或体征列表执行；否则会删掉较早
  的云端历史。应使用追加同步或分页完整快照。
- 读取与创建命令需要设备成员授权。设备成员关系不能放在 `devices` 文档中，因为
  `REPORT_DEVICE` 会整体写入该文档；应使用独立关系集合或授权云函数。
- 客户端直连监听的集合也必须受数据库规则保护，否则完整问询消息仍可能绕过云函数下发。

## 已验证的对应项

- 问询终态 `result/escalated` 和 `show_recommendation/complete/escalate` 与小程序
  “只隐藏未完成问询”的规则一致；已完成访客记录可正常显示。
- 真实取药记录的 `dry_run`、`qsm_ok`、`target_user_type` 与小程序记录过滤一致。
- 核心体征字段 `heartRate`、`spo2`、`bodyTemp`、`quality`、`createdAt` 兼容。

## 后续兼容测试

跨端契约测试至少覆盖：问询详情、摘要脱敏、`AUDIO_SPEAK`、药品精度别名、库存 `0`、
设备成员授权，以及超过 100 条的问询/体征历史不丢失。
