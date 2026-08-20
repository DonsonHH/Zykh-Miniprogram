# 小程序与 CloudBase 部署

## 1. 准备

- 微信开发者工具 Stable
- 已创建的小程序与 CloudBase 环境
- 对目标 CloudBase 环境拥有云函数部署权限
- 已完成 Station 端 `3.0-three-box-library` 协议迁移

不要把设备密钥、数据库或一次性配对码写进仓库。

## 2. 配置项目

使用微信开发者工具导入仓库根目录。公共配置位于：

- `project.config.json`
- `cloudbaserc.json`

若 AppID 或环境 ID 与你的环境不同，请在发布前按微信平台配置更新。个人开发者工具状态应保存在 `project.private.config.json`，该文件已被忽略。

## 3. 部署云函数

在微信开发者工具中右键 `cloudfunctions/api`，选择“上传并部署：云端安装依赖”。部署完成后调用 `PING`，至少核对：

```json
{
  "schemaVersion": 2,
  "schemaRevision": "3.0-three-box-library"
}
```

生产环境还应确认 `capabilities` 中声明的功能与实际部署一致。不要仅检查 `schemaVersion`。

## 4. 数据与授权

云端需要按当前 API 建立对应集合和索引。账号必须通过 membership 获得设备访问权限；新账号使用 Station 管理端签发的一次性配对码。

配对码要求：

- 有效期 5–15 分钟
- 仅使用一次
- 明文仅在 Station 管理页面显示一次
- 云端只保存哈希，不可反查

## 5. 发布小程序

1. 在开发者工具完成编译与真机预览。
2. 验证首页、药库、问询、照护、家人五个 Tab。
3. 验证药库只显示日常、对症、护理三个药盒，不出现 23 仓或开柜入口。
4. 验证切换设备不会显示上一台设备的数据。
5. 验证 Station 离线时显示最后同步时间，而不是假在线或空数据。
6. 上传代码并在微信公众平台提交审核。

## 6. 自动化验证

```bash
node --test tests/*.test.js
node tools/validate-miniprogram-ui.js
```

当前发布门槛是全部自动化测试与 UI 校验通过。

## 7. 回滚与兼容

若线上 CloudBase 或 Station 尚未升级，不要通过伪造 capability 强行开启三盒药库；小程序会对明确缺失的能力显示“未支持”或“待确认”。部署前必须完成 [三盒架构迁移](THREE_BOX_MIGRATION.md) 并备份旧数据。
