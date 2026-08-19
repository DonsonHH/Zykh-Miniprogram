# 智药康护微信小程序

智药康护是面向家庭照护者的微信小程序，与 QSM368ZP-WF 药箱 Station 和微信云开发后端协同工作。V1 聚焦“看清今天要处理什么、确认药箱事实、查看家庭健康记录”，不在移动端伪造硬件尚未回传的执行结果。

> `v1.0.0` 是 V1 系列最终版。后续架构或协议的不兼容演进将进入 V2。

## 功能

- 首页：聚合当天照护焦点、药品风险、提醒、问询和最近健康动态。
- 药箱：查看 23 个仓位，按效期、库存状态筛选并维护药品。
- 问询：按家庭成员查看已完成问询摘要，并按需读取过程详情。
- 照护：统一展示用药、健康测量和用药安全核查记录。
- 家人：查看服务对象、计划、安全摘要、授权药箱和个人历史。
- 健康测量：展示心率、血氧、体温及明确的测量归属。
- 账号授权：通过 `GET_MY_DEVICES` 获取可访问药箱，支持一次性配对码。

## V1 设计原则

- 小程序是照护端，Station 是现场执行端；硬件事实以 Station 回传为准。
- 每页只突出一个当前焦点，重复操作改为整卡或整行点击。
- 库存使用 `STOCKED / DEPLETED / UNKNOWN` 显式状态，不从数量猜测事实。
- 人物数据按稳定 ID 与 `personaGeneration` 隔离，不按姓名合并。
- 体征、问询、安全事件和命令始终固定在发起请求时的药箱作用域。
- 小程序不直接监听受保护集合，也不提供远程开柜、批准或放行入口。

更多界面与交互约束见 [DESIGN.md](DESIGN.md)。

## 项目结构

```text
miniprogram/            小程序业务代码、页面、组件和领域模块
cloudfunctions/api/     微信云函数 API
tests/                  Node.js 行为与契约测试
tools/                  小程序 UI 静态校验工具
docs/                   兼容、同步与部署文档
project.config.json     微信开发者工具公共项目配置
cloudbaserc.json        CloudBase CLI 公共配置
```

本仓库不包含 Station 主程序、设备密钥、数据库、个人开发者配置或构建缓存。

## 开发环境

- 微信开发者工具 Stable
- 微信基础库 `3.16.1`
- CloudBase 云函数 Node.js `20.19`
- 本地测试 Node.js 20 或更高版本

## 本地运行

1. 克隆仓库。
2. 使用微信开发者工具导入仓库根目录。
3. 确认 `project.config.json` 中的小程序 AppID 与当前账号匹配；若需要使用自己的 AppID，只在本地修改或使用私有项目配置，不要提交凭据。
4. 选择或创建 CloudBase 环境，并按 [部署说明](docs/DEPLOYMENT.md) 部署 `cloudfunctions/api`。
5. 编译小程序，在“家人”页选择账号已获授权的药箱；未授权账号需使用 Station 管理端生成的一次性配对码。

## 验证

```bash
node --test tests/*.test.js
node tools/validate-miniprogram-ui.js
```

V1 最终版基线：

- 428 项自动化测试通过
- 122 个小程序文件通过 UI 静态校验
- 生产小程序代码无数据库直接 `watch()`

## 云端与 Station 兼容

本版本对应 CloudBase schema revision `2.7-runtime-consistency`。小程序会先读取 `PING` 能力，再决定是否启用账号授权、一次性配对、人物生命周期、显式库存、体征归属和用药安全事件。

- 新云端：启用能力驱动的严格数据契约。
- 旧云端：仅在明确支持的兼容范围内降级，并在界面显示“未支持”或“待确认”。
- 网络或权限失败：不得呈现为“0 条风险”或“空药箱”。

板端部署、设备密钥和数据库迁移不属于本仓库。Station 必须使用与本版本匹配的同步协议，并持续上报设备心跳。

## 发布说明

完整变更见 [CHANGELOG.md](CHANGELOG.md)。部署前请阅读 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 与 [SECURITY.md](SECURITY.md)。

## License

本项目采用 MIT License。
