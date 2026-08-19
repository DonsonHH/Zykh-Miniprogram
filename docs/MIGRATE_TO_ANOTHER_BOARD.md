# 智药康护小程序与 QSM368 第二块板迁移指南

> 新版完整交接手册请优先阅读：`docs/SYNC_AND_MIGRATION_GUIDE.md`。该文档补充了“小程序如何通过 CloudBase 与板端同步”、USB relay 临时链路、第二台电脑迁移步骤、验证流程和排障清单。

本文给另一位工程师使用，目标是在另一台电脑、另一块 QSM368ZP-WF 开发板上接入同一个微信小程序和同一个 CloudBase 云环境。

迁移完成后的链路是：

```text
微信小程序
  -> CloudBase 云函数 /api
  -> 第二块 QSM368 cloud_agent
  -> 第二块板子本地 server.pl
  -> 板子本地 API / SQLite / 硬件脚本
```

当前工程参数：

```text
小程序 AppID: wx10d3642842a733e8
CloudBase 环境 ID: cloud1-d6gv6t2jf3f2c541c
CloudBase HTTP API: http://cloud1-d6gv6t2jf3f2c541c-1441069580.ap-shanghai.app.tcloudbase.com/api
第一块板 DEVICE_ID: zykh-qsm-001
第二块板建议 DEVICE_ID: zykh-qsm-002
```

> 注意：如果第二块只是裸开发板、没有接 MAX30102/GY-614/STM32/喇叭等外设，那么只能验证“云端到板端 API 的链路”，不能把体征数值当作真实传感器数据。

## 1. 需要交接给第二位工程师的文件

建议直接把整个小程序工程目录打包给对方：

```text
D:\app\wechatlittleprogram
```

至少必须包含：

```text
project.config.json
miniprogram/
cloudfunctions/api/
qsm_agent/
tools/cloudbase-relay.js
docs/MIGRATE_TO_ANOTHER_BOARD.md
```

如果第二块板子还没有板端主程序，还要同时交接 QSM368 板端主代码，例如：

```text
zykh_app/
server.pl
native/go-ui/
scripts/
tools/
data/
bin/
```

或者交接你当前最新的 `Zykh-QSM-main` 压缩包。本文默认第二块板子最终路径仍然是：

```text
/userdata/zykh_app
```

## 2. 第二台电脑准备

第二台电脑需要：

```text
1. 微信开发者工具
2. 可登录该小程序/云开发环境的微信账号
3. ADB 工具
4. Node.js，只有使用 USB relay 调试时需要
5. 能访问互联网
```

检查 ADB：

```powershell
adb version
adb devices -l
```

如果电脑上有多块板子或多个 Android/ADB 设备，后续命令加 `-s` 指定设备：

```powershell
adb -s <设备序列号> shell "echo ok"
```

## 3. 在第二台电脑打开小程序工程

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 项目目录选择交接过来的工程根目录，例如：

   ```text
   D:\app\wechatlittleprogram
   ```

4. 确认 AppID 是：

   ```text
   wx10d3642842a733e8
   ```

5. 确认 `miniprogram/app.js` 里的云环境是：

   ```js
   env: "cloud1-d6gv6t2jf3f2c541c"
   ```

6. 点击“编译”，确认小程序能正常打开。

如果微信开发者工具提示没有云开发权限，需要用有该小程序权限的账号登录，或者让项目管理员给该工程师分配云开发权限。

## 4. 确认云端资源

云端资源通常不需要重建。只需要确认存在：

```text
集合：
devices
medicines
vitals
records
commands

云函数：
api

HTTP 访问服务：
/api -> api
```

在微信开发者工具里检查：

```text
云开发 -> 数据库
云开发 -> 云函数
云开发 -> HTTP 访问服务
```

如果 `/api -> api` 不存在，在 HTTP 访问服务里新增：

```text
路径: /api
资源类型: 云函数
云函数: api
```

也可以用 CloudBase CLI 创建：

```powershell
tcb login
tcb service create -e cloud1-d6gv6t2jf3f2c541c -p api -f api
```

测试 HTTP API：

```powershell
Invoke-RestMethod `
  -Uri "http://cloud1-d6gv6t2jf3f2c541c-1441069580.ap-shanghai.app.tcloudbase.com/api" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"action":"PING"}'
```

正常返回应包含：

```json
{
  "ok": true,
  "collections": {
    "devices": "devices",
    "medicines": "medicines",
    "vitals": "vitals",
    "records": "records",
    "commands": "commands"
  }
}
```

## 5. 是否需要重新部署云函数

如果交接的是当前完整工程，建议第二位工程师先部署一次 `api` 云函数，保证云端代码与本地一致。

在微信开发者工具里：

```text
右键 cloudfunctions/api
-> 上传并部署：云端安装依赖
```

或者用微信开发者工具 CLI：

```powershell
& "微信开发者工具安装目录\cli.bat" cloud functions deploy `
  --project D:\app\wechatlittleprogram `
  --env cloud1-d6gv6t2jf3f2c541c `
  --names api `
  --remote-npm-install
```

部署后重新测试：

```powershell
Invoke-RestMethod `
  -Uri "http://cloud1-d6gv6t2jf3f2c541c-1441069580.ap-shanghai.app.tcloudbase.com/api" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"action":"PING"}'
```

## 6. 规划第二块板的 DEVICE_ID

两块板不能共用同一个 `DEVICE_ID`。

建议：

```text
第一块板：zykh-qsm-001
第二块板：zykh-qsm-002
第三块板：zykh-qsm-003
```

云数据库里会按 `deviceId` 隔离数据：

```text
devices/zykh-qsm-002
medicines/zykh-qsm-002-slot-1
vitals where deviceId == zykh-qsm-002
records where deviceId == zykh-qsm-002
commands where deviceId == zykh-qsm-002
```

## 7. 准备第二块 QSM368 板端主程序

第二块板子上必须有板端主程序：

```text
/userdata/zykh_app/server.pl
/userdata/zykh_app/scripts/
/userdata/zykh_app/data/
```

如果没有，先把板端主代码复制到板子：

```powershell
adb shell "mkdir -p /userdata/zykh_app"
adb push zykh_app /userdata/
```

根据实际压缩包结构，最终必须能看到：

```powershell
adb shell "ls -l /userdata/zykh_app/server.pl"
```

启动板端后端：

```powershell
adb shell "cd /userdata/zykh_app && perl server.pl --daemon"
```

测试本地 API：

```powershell
adb shell "wget -qO- http://127.0.0.1:8080/api/status"
```

能返回 JSON 就说明 `server.pl` 已经可用。

## 8. 安装 cloud_agent 到第二块板

在第二台电脑的工程根目录执行：

```powershell
adb shell "mkdir -p /userdata/zykh_app/scripts /userdata/zykh_app/data"

adb push qsm_agent\cloud_agent.pl /userdata/zykh_app/scripts/cloud_agent.pl
adb push qsm_agent\start_cloud_agent.sh /userdata/zykh_app/scripts/start_cloud_agent.sh
adb push qsm_agent\cloud_agent.env.example /userdata/zykh_app/data/cloud_agent.env

adb shell "sed -i 's/\r$//' /userdata/zykh_app/scripts/cloud_agent.pl /userdata/zykh_app/scripts/start_cloud_agent.sh /userdata/zykh_app/data/cloud_agent.env"
adb shell "chmod +x /userdata/zykh_app/scripts/cloud_agent.pl /userdata/zykh_app/scripts/start_cloud_agent.sh"
```

检查 Perl 语法：

```powershell
adb shell "perl -c /userdata/zykh_app/scripts/cloud_agent.pl"
```

正常输出：

```text
/userdata/zykh_app/scripts/cloud_agent.pl syntax OK
```

## 9. 配置第二块板的 cloud_agent.env

推荐先在电脑本地新建一个 `cloud_agent.env` 文件，内容如下：

```sh
CLOUD_API_URL=http://cloud1-d6gv6t2jf3f2c541c-1441069580.ap-shanghai.app.tcloudbase.com/api
DEVICE_ID=zykh-qsm-002
DEVICE_SECRET=
LOCAL_API=http://127.0.0.1:8080
SYNC_INTERVAL=5
```

推送到板子：

```powershell
adb push cloud_agent.env /userdata/zykh_app/data/cloud_agent.env
adb shell "sed -i 's/\r$//' /userdata/zykh_app/data/cloud_agent.env"
```

检查配置是否被板端 shell 正确读取：

```powershell
adb shell ". /userdata/zykh_app/data/cloud_agent.env; echo DEVICE_ID=\$DEVICE_ID; echo CLOUD_API_URL=\$CLOUD_API_URL"
```

应该输出：

```text
DEVICE_ID=zykh-qsm-002
CLOUD_API_URL=http://cloud1-d6gv6t2jf3f2c541c-1441069580.ap-shanghai.app.tcloudbase.com/api
```

如果输出为空，通常是文件有 Windows 换行，重新执行：

```powershell
adb shell "sed -i 's/\r$//' /userdata/zykh_app/data/cloud_agent.env"
```

## 10. 配置设备密钥，开发阶段可跳过

当前云函数逻辑支持两种模式：

```text
DEVICE_SECRET 为空：开发模式放行
DEVICE_SECRET / DEVICE_SECRETS 不为空：校验板端密钥
```

开发迁移阶段可以先留空：

```sh
DEVICE_SECRET=
```

正式演示或上线建议配置每台设备独立密钥。云函数环境变量配置：

```json
DEVICE_SECRETS={"zykh-qsm-001":"<第一块板独立密钥>","zykh-qsm-002":"<第二块板独立密钥>"}
```

第二块板：

```sh
DEVICE_ID=zykh-qsm-002
DEVICE_SECRET=<第二块板独立密钥>
```

如果命令返回：

```text
unauthorized
```

就是板端 `DEVICE_SECRET` 和云函数环境变量不一致。

## 11. 确认第二块板有外网

正式运行时，第二块板必须能直接访问 CloudBase：

```powershell
adb shell "wget -qO- --header='Content-Type: application/json' --post-data='{\"action\":\"PING\"}' http://cloud1-d6gv6t2jf3f2c541c-1441069580.ap-shanghai.app.tcloudbase.com/api"
```

正常返回：

```json
{"ok":true}
```

如果失败，检查：

```powershell
adb shell "ip addr"
adb shell "ip route"
adb shell "cat /etc/resolv.conf /tmp/resolv.conf 2>/dev/null"
adb shell "ping -c 1 -W 3 223.5.5.5"
adb shell "ping -c 1 -W 3 www.baidu.com"
```

### 4G 常见检查

如果使用 EC200A：

```powershell
adb shell "lsusb"
adb shell "ls -l /dev/ttyUSB*"
adb shell "ifconfig usb0"
adb shell "sh /userdata/zykh_app/scripts/start_4g.sh"
```

如果 `quectel-CM` 日志出现：

```text
AT+CPIN? -> +CME ERROR: 10
```

通常表示 SIM 未插入、SIM 接触不良、卡座/模块没有读到 SIM。先修 SIM，再测云同步。

### Wi-Fi 常见配置

如果第二块板走 Wi-Fi，需要写入 Wi-Fi 配置，具体看板端脚本支持的方式。当前脚本支持：

```text
/userdata/wifi_profiles.conf
```

格式：

```text
SSID|密码
```

然后运行：

```powershell
adb shell "sh /userdata/zykh_app/scripts/start_wifi_964.sh"
```

## 12. 无外网时的 USB relay 临时调试

如果第二块板暂时没有 4G/Wi-Fi，但通过 USB 连着第二位工程师的电脑，可以用 USB relay 先验证板端同步。

这个模式是：

```text
QSM368 -> USB RNDIS 网卡 -> 工程师电脑 relay -> CloudBase /api
```

它是真实板端 agent 在跑，但网络出口借电脑。正式设备不要长期依赖这个方式。

### 12.1 找电脑 USB 网卡 IP

在 Windows 上运行：

```powershell
ipconfig
```

找到类似：

```text
Remote NDIS based Internet Sharing Device
IPv4 Address: 169.254.xx.xx
```

假设电脑 USB 网卡 IP 是：

```text
169.254.19.33
```

### 12.2 启动 relay

在工程根目录执行：

```powershell
$env:RELAY_HOST="0.0.0.0"
$env:RELAY_PORT="18080"
node tools\cloudbase-relay.js
```

看到：

```text
CloudBase relay listening on http://0.0.0.0:18080/api
Forwarding to http://cloud1-d6gv6t2jf3f2c541c-1441069580.ap-shanghai.app.tcloudbase.com/api
```

保持这个窗口不要关。

### 12.3 修改板端 CLOUD_API_URL

第二块板的 `/userdata/zykh_app/data/cloud_agent.env` 改成：

```sh
CLOUD_API_URL=http://169.254.19.33:18080/api
DEVICE_ID=zykh-qsm-002
DEVICE_SECRET=
LOCAL_API=http://127.0.0.1:8080
SYNC_INTERVAL=5
```

其中 `169.254.19.33` 换成第二位工程师电脑自己的 USB 网卡 IP。

测试：

```powershell
adb shell "wget -qO- --header='Content-Type: application/json' --post-data='{\"action\":\"PING\"}' http://169.254.19.33:18080/api"
```

能返回 `ok:true` 就说明 USB relay 可用。

## 13. 前台单轮测试 cloud_agent

在启动常驻进程前，先跑一轮：

```powershell
adb shell "cd /userdata/zykh_app && set -a && . /userdata/zykh_app/data/cloud_agent.env && set +a && RUN_ONCE=1 perl /userdata/zykh_app/scripts/cloud_agent.pl"
```

正常会看到：

```text
cloud agent starting device=zykh-qsm-002 local=http://127.0.0.1:8080 cloud=...
```

如果没有报错，说明：

```text
1. 配置文件读到了
2. CloudBase /api 能访问
3. REPORT_DEVICE 能写入云端
4. PULL_COMMANDS 能执行
```

## 14. 启动第二块板 cloud_agent 常驻进程

```powershell
adb shell "rm -f /var/run/zykh_cloud_agent.pid"
adb shell "sh /userdata/zykh_app/scripts/start_cloud_agent.sh"
```

查看状态：

```powershell
adb shell "cat /var/run/zykh_cloud_agent.pid"
adb shell "tail -n 80 /userdata/zykh_app/data/cloud_agent.log"
```

确认进程还活着：

```powershell
adb shell "pid=\$(cat /var/run/zykh_cloud_agent.pid 2>/dev/null); if [ -n \"\$pid\" ] && kill -0 \"\$pid\" 2>/dev/null; then echo alive=\$pid; else echo dead; fi"
```

## 15. 在小程序绑定第二块板

打开小程序：

```text
设置 -> 绑定设备
```

输入：

```text
zykh-qsm-002
```

绑定后，首页/健康/药柜读取的就是第二块板的数据。

小程序会把绑定值保存到本地缓存：

```text
wx.setStorageSync("deviceId", id)
```

所以重启小程序后不会丢。

## 16. 验证第二块板是否在线

在小程序设置页或首页看设备状态。云数据库 `devices` 里应该出现：

```json
{
  "_id": "zykh-qsm-002",
  "deviceId": "zykh-qsm-002",
  "online": true,
  "cloudAgent": "running",
  "lastSeenAt": "当前时间"
}
```

小程序判断在线的逻辑是：

```text
当前时间 - lastSeenAt < 60 秒
```

所以如果板子关机，最多约 60 秒后小程序会显示离线。

## 17. 验证命令闭环

### 17.1 测试蜂鸣

在小程序：

```text
设置 -> 测试蜂鸣
```

云数据库 `commands` 应出现：

```json
{
  "deviceId": "zykh-qsm-002",
  "type": "AUDIO_BEEP",
  "status": "done"
}
```

如果第二块开发板没有接喇叭，可能听不到声音，但仍可以看命令是否 `done`、`result.local` 是否返回本地 API 结果。

### 17.2 测试一键测量

在小程序：

```text
健康 -> 一键测量
```

云数据库应出现：

```text
commands: READ_VITALS_ALL -> done
vitals: 新增 deviceId=zykh-qsm-002 的记录
```

裸开发板没接传感器时，可能返回：

```text
heartRate: 0
spo2: 0
quality: error
```

这只能说明本地接口返回了错误/空值，不代表云同步失败。

### 17.3 测试录药同步

在小程序：

```text
录药 -> 填药名/规格/仓位/数量/有效期 -> 保存
```

云数据库 `medicines` 应出现固定文档 ID：

```text
zykh-qsm-002-slot-1
```

如果当前版本同时下发了 `UPSERT_MEDICINE` 命令，板端 agent 会调用本地录药 API，再上传板端库存。

## 18. 迁移完成判定标准

满足下面 5 条，就算第二块板迁移成功：

```text
1. 小程序能绑定 zykh-qsm-002
2. devices/zykh-qsm-002 每 5 秒左右刷新 lastSeenAt
3. AUDIO_BEEP 命令能从 pending -> running -> done
4. READ_VITALS_ALL 命令能 done，并产生 vitals 记录
5. cloud_agent.log 没有连续 unauthorized / http request failed / local API failed
```

## 19. 常见问题排查

### 问题 1：cloud_agent 仍然访问 your-cloudbase-http-url

原因：`cloud_agent.env` 没有被正确读取，或者没有 export。

检查：

```powershell
adb shell ". /userdata/zykh_app/data/cloud_agent.env; echo \$CLOUD_API_URL"
```

前台测试必须这样跑：

```powershell
adb shell "cd /userdata/zykh_app && set -a && . /userdata/zykh_app/data/cloud_agent.env && set +a && RUN_ONCE=1 perl /userdata/zykh_app/scripts/cloud_agent.pl"
```

### 问题 2：配置文件里有 `^M`

检查：

```powershell
adb shell "cat -v /userdata/zykh_app/data/cloud_agent.env"
```

修复：

```powershell
adb shell "sed -i 's/\r$//' /userdata/zykh_app/data/cloud_agent.env"
```

### 问题 3：`http request failed`

按顺序查：

```powershell
adb shell "wget -qO- --header='Content-Type: application/json' --post-data='{\"action\":\"PING\"}' <CLOUD_API_URL>"
adb shell "ip route"
adb shell "cat /etc/resolv.conf /tmp/resolv.conf 2>/dev/null"
```

如果板子没外网，先用 4G/Wi-Fi 修网络，或者临时用 USB relay。

### 问题 4：`unauthorized`

原因：云函数设置了 `DEVICE_SECRET` 或 `DEVICE_SECRETS`，但板端 `DEVICE_SECRET` 不匹配。

临时开发可以清空云函数环境变量里的密钥，正式使用要让两边一致。

### 问题 5：小程序显示离线，但 agent 日志正常

检查 `devices/zykh-qsm-002.lastSeenAt` 是否刷新。

如果云端刷新但小程序不刷新：

```text
1. 确认小程序设置页绑定的是 zykh-qsm-002
2. 确认 miniprogram/app.js 的 env 是 cloud1-d6gv6t2jf3f2c541c
3. 重新编译小程序
```

### 问题 6：体征数据不真实

裸开发板没有外设时，这是正常的。此时只能验证：

```text
小程序 -> 云端 -> 板端 agent -> 本地 API -> 云端回写
```

不能验证真实 MAX30102/GY-614。

### 问题 7：ADB 有多个设备

使用：

```powershell
adb devices -l
adb -s <设备序列号> shell "echo ok"
```

后续所有命令都加 `-s <设备序列号>`。

## 20. 给第二位工程师的最短执行清单

```text
1. 在微信开发者工具打开 D:\app\wechatlittleprogram
2. 确认 app.js 环境 ID 是 cloud1-d6gv6t2jf3f2c541c
3. 部署 cloudfunctions/api
4. 确认 HTTP 访问服务 /api -> api
5. ADB 连接第二块 QSM368
6. 确认 /userdata/zykh_app/server.pl 存在并能启动
7. adb push qsm_agent/cloud_agent.pl 和 start_cloud_agent.sh 到 /userdata/zykh_app/scripts
8. 写 /userdata/zykh_app/data/cloud_agent.env，DEVICE_ID=zykh-qsm-002
9. 确认板子能 wget CloudBase /api PING
10. RUN_ONCE=1 前台跑 cloud_agent
11. sh /userdata/zykh_app/scripts/start_cloud_agent.sh 启动常驻
12. 小程序设置页绑定 zykh-qsm-002
13. 测试 AUDIO_BEEP
14. 测试 READ_VITALS_ALL
15. 看 commands 是否 done，devices 是否在线，vitals 是否新增
```

完成以上清单，第二块板就接入同一个小程序体系了。
