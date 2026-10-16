# spec-005 官方 App 逆向 & 扫一扫/动态页移植

> 状态：**进行中**。扫一扫框架已装机可扫；分发 API 契约已实测；签到码 type 值待补。
> 最近提交：`20826eb`（v0.5.0 大改版 + 扫一扫 + 动态 feed）；ScanActivity manifest 注册修复未提交。

## 1. 目标

把官方雨课堂 App（`com.xuetangx.ykt`，Flutter）的两个独有能力移植进我们的 Android WebView 壳：

1. **扫一扫**（高优先级）：扫码 → 服务端识别类型 → 登录/签到/进课堂
2. **「动态」tab**（已完成）：官方 app 底栏第 2 tab 的课件/测验/公告 feed

## 2. 官方 App 逆向结论

### 2.1 架构

- Flutter app：`libapp.so`（20MB Dart AOT）+ `libflutter.so`（11MB，SSL 符号全剥）
- 扫码栈：`flutter_hms_scan_kit`（`com.ara.flutter_hms_scan_kit`）
  - `CommonHandler` 扫到 → `MethodChannel("com.xuetangx.hmsscan").invokeMethod("scanResult", raw)` → Dart
  - `ScanView`（CameraX PlatformView）+ `mobile_scanner`（`dev.steenbakker`）+ `libscannative.so` + `libbarhopper_v3.so`（ML Kit）
- 扫码页路由：`scan_code_page` → `login_confirm_page` / `secret_code_page` / `other_teacher_teaching_page` / `scan_login_success_page`

### 2.2 扫码分发 API（已实测 ✅）

```
POST https://changjiang.yuketang.cn/api/v3/app/scan
Headers: x-client: app
         xtbz: ykt-app
         Cookie: <web session>
         Content-Type: application/json
Body:    {"url": "<二维码原文>"}
```

响应：`{"code":0,"data":{"flow":"normal","type":"<类型>","value":"<值>"}}`

- 已确认 type：`app_web_login`（登录码）→ 弹「授权登录」确认页
- 错误：`{"code":50033,"msg":"QR_CODE_NOT_FOUND"}`（非雨课堂码/过期码/微信封装码）
- **签到码的 type 值未知**——需要一张真签到码实测（见 §6）

### 2.3 二维码内容格式

| 类型 | 格式 | 来源 |
|---|---|---|
| 登录码（APP 模式） | `https://changjiang.yuketang.cn/api/v3/user/login/app-web-qr?u=<uuid>&t=<ts>&s=<sign>&v=1` | 实测 + `GET /api/v3/user/login/app-web-pre-info` 可生成 |
| 微信封装码 | `http://weixin.qq.com/q/<id>` | login.js `data-qr-switch=wx` 变体，**app 端扫显示「请对准雨课堂二维码」** |

⚠️ 教训：login.js 的二维码有两种模式（`wx`=微信扫 / `ws`=雨课堂APP扫）。微信封装码只能微信扫，雨课堂 app 不认。测试务必用 APP 模式的码。

### 2.4 后续确认 API（未实测）

- `POST /api/v3/user/login/scan-handler` —— 「授权登录」点击后调用。**需要 app token**（非 web cookie），纯 Cookie 调返回 `UNAUTHENTICATED`。
- app token 位置：`/data/data/com.xuetangx.ykt/shared_prefs/FlutterSharedPreferences.xml` 的 `flutter.token`（如 `4TBVeCDmQmfyLsRzVleqTTjkkWTncVvj`）+ `flutter.sessionid` + `flutter.device_token`
- 猜测 header：`X-UID`（user id）、`X-PB`（token 签名？）—— 各种 scheme 都试过仍 UNAUTHENTICATED，X-PB 大概率是派生签名
- 相关串：`client_scan_login`、`web_scan_login`（libapp.so）

**结论**：壳里扫码登录确认做不了（缺 app token 生成逻辑）；但**签到码若 type→loadUrl 走 webview 有 cookie 就能进**，这正是我们壳需要的。

### 2.5 「动态」feed API（已实测 ✅）

```
POST https://changjiang.yuketang.cn/api/v3/activities/received/
Body: {"size":30,"type":[]}
Headers: Cookie 即可（纯 web 鉴权）
```

- GET → 405；带 `x-client:app`+`xtbz` 反而 UNAUTHENTICATED（**用纯 Cookie**）
- 返回 `[{id, coursewareType, coursewareId, coursewareTitle, url, createTime, classroomId, courseName, teacher, avatar, universityId, content, sort}]`
- `coursewareType`：14=课件 5=测验 20=测试 2=推送
- 壳实现：`MainActivity.showFeed()/fetchFeed()/feedRow()`（`MainActivity.kt`），BottomSheet 列表，点击跳 `item.url` 或 `/v2/web/studentLog/<classroomId>`
- 官方 app 缓存这个响应在 `flutter.https://changjiang.yuketang.cn/api/v3/activities/received/{size:10,...}` 的 prefs key 里

### 2.6 其他发现的 API

- `/api/v3/lesson/checkin*`、`location-checkin/*`、`/api/v3/classroom/join`、`/v2/api/web/classroom/announcements?classroom_id=`（公告列表，Cookie 可用）
- `X-CSRFToken` header 在 libapp.so 里有出现

## 3. 官方 App 环境坑（已踩过）

| 问题 | 解法 |
|---|---|
| VPN 联网被 app 拒绝（输验证码报网络错误） | Frida hook `NetworkCapabilities.hasTransport(1)=true` + `hasCapability(12/14/16)=true` + `NetworkInfo.*` 伪 WiFi（`/tmp/…/netspoof.js`） |
| 相机预览空白 | T508N 上官方 app 相机确实黑屏，**但 `scanResult` MethodChannel 注入可绕过**（`FlutterHmsScanKitPlugin.Companion.getChannel().invokeMethod("scanResult", raw)`，需在扫码页前台） |
| `invokeMethod` hook 递归 | hook 内再调 `invokeMethod` 会打自己——注入用独立脚本不带 hook |
| Dart TLS 明文 | `libflutter.so`/`libapp.so` SSL 符号全剥，社区签名全不匹配，**未解决**（暂不需要） |

Frida 连接：`adb -s T6PA04CJ6EH01DD`，设备 Magisk root，`frida-server` 在 `/data/local/tmp/`（17.17.0）。attach 用 PID：`adb shell pidof com.xuetangx.ykt`。

## 4. 壳内实现（已提交 `20826eb`）

| 文件 | 内容 |
|---|---|
| `ScanActivity.kt` | CameraX Preview + `ImageAnalysis` + ML Kit BarcodeScanning；全屏黑底+取景框+取消；结果走 `onResult` 静态回调 |
| `MainActivity.startScan()/handleScanResult()` | 菜单入口；非 yuketang 链接直接 loadUrl |
| `dispatchYktScan()/handleScanDispatch()` | POST `/api/v3/app/scan` → type 分发：`app_web_login`→loadUrl+确认，其他→loadUrl 原链接兜底 |
| `showFeed()/fetchFeed()/feedRow()` | 动态 feed（§2.5） |
| `AndroidManifest.xml` | `CAMERA` 权限 + `ScanActivity`（**已加、待提交**） |
| `build.gradle.kts` | camera-core/camera2/lifecycle/view 1.4.0 + mlkit barcode-scanning 17.3.0 |

## 5. 待办

- [ ] **签到码 type 值**：需一张真签到码（上课时老师投屏，几秒一刷）。拿到后 `curl /api/v3/app/scan` 看 `type`，在 `handleScanDispatch` 补分支
- [ ] 「课堂暗号」输入路径：app 扫码菜单里有「课堂暗号」项，若是输数字码则不走二维码——确认后可在壳里做个输入框
- [ ] `scan-handler` 登录确认 API：需要 app token 生成/签名逻辑（X-PB？），逆向成本高，暂缓——签到用不到
- [ ] ScanActivity manifest 注册 diff 未提交（`M AndroidManifest.xml`）
- [ ] `versionName` 升 0.5.0 + 发版

## 6. 复现/测试指引

```bash
# 生成一个可扫的登录码（测试 dispatchYktScan 端到端）
curl -s "https://changjiang.yuketang.cn/api/v3/user/login/app-web-pre-info" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['qrContent'])"
# → https://changjiang.yuketang.cn/api/v3/user/login/app-web-qr?u=...&t=...&s=...&v=1
# 用这个 URL 生成二维码（qr 工具/在线生成），壳里扫一扫应该返回 type=app_web_login

# 服务端直测 scan API
curl -X POST "https://changjiang.yuketang.cn/api/v3/app/scan" \
  -H "x-client: app" -H "xtbz: ykt-app" \
  -H "Cookie: <web session>" -H "Content-Type: application/json" \
  -d '{"url":"<二维码原文>"}'

# 动态 feed
curl -X POST "https://changjiang.yuketang.cn/api/v3/activities/received/" \
  -H "Cookie: <web session>" -H "Content-Type: application/json" \
  -d '{"size":30,"type":[]}'
```

## 7. 官方 App 关键文件（逆向产物）

- APK：`/private/var/folders/3r/kplgtc2j4710_9w9y82__gb80000gn/T/opencode/yuketang.apk`（122MB）
- jadx 源码：`…/ykt-jadx/sources/`（Java 壳，Dart 层不可见）
- libapp.so：`…/ykt-lib/lib/arm64-v8a/`（53755 Dart AOT 函数，字符串池化→xref 无效）
- Frida 脚本：`/tmp/ida-ykt/frida-scan.js`、`…/netspoof.js`、`…/fake-scan*.js`、`…/inject-only.js`、`…/net-hooks.js`
- app prefs（token/feed 缓存）：`adb shell su -c 'cat /data/data/com.xuetangx.ykt/shared_prefs/FlutterSharedPreferences.xml'`
