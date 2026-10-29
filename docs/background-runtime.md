# Android 后台运行与诊断

> 版本：0.9.6  
> 架构：Script-First。JavaScript 继续负责课堂业务，Kotlin 只负责 Android 生命周期、通知、后台状态和恢复。

## 一、已实现的后台套件

### 1. Foreground Service

- `BackgroundRuntimeService`
- 用户从「设置 → 后台」手动开启
- 常驻通知显示：
  - 监听中
  - 等待脚本心跳
  - 脚本可能已停止
  - 页面渲染进程已回收
- 通知提供「停止」
- Android 14 使用 `specialUse` 前台服务类型，并在 Manifest 中声明 subtype

### 2. WebView 保留

- `onPause` 只刷新 Cookie，不暂停 JS
- 没有调用 `pauseTimers()`
- 普通切后台不销毁 WebView
- 只有 Activity 被真正销毁或用户关闭页面时才销毁

### 3. Renderer 恢复

- 明确设置 `RENDERER_PRIORITY_IMPORTANT`
- 实现 `onRenderProcessGone`
- 保留原 tab URL，换一个新 WebView 恢复到原位置
- `onRenderProcessUnresponsive` 不再立即 reload，只标记状态
- 恢复后提示“页面已恢复，请确认课堂状态”

### 4. JS / Native 双向心跳

- JS 每 10 秒上报：
  - 页面可见性 / 焦点
  - WebSocket 状态
  - 最后课堂消息时间
  - 最后 unlockproblem 时间
  - 当前 lessonId
  - timer lag
  - 自动作答/自动进入开关
- Native 每 15 秒向 Activity 广播一次 ping，Activity 调用 `window.__yktRuntimePing()` 反向确认 JS 仍能响应
- 心跳超过 30 秒未更新时，通知显示“脚本可能已停止”
- 不把“心跳还在”当作 WebSocket 或课堂事件正常的证明

### 5. 电池优化与强力模式

- 设置页检查 `PowerManager.isIgnoringBatteryOptimizations`
- 用户点击后打开系统官方授权页
- 可选「强力保活」：
  - `PARTIAL_WAKE_LOCK`
  - Wi-Fi high-performance lock
  - 关闭监听时立即释放
  - 默认关闭，避免无意义耗电

### 6. 考试域注入

Android document-start 白名单补上：

```text
changjiang-exam.yuketang.cn
tsinghua-exam.yuketang.cn
examination.xuetangx.com
```

## 二、后台运行的边界

以下情况无法保证持续运行：

- 用户强制停止 App
- 系统因内存压力回收整个进程
- 深度 Doze 限制网络
- 厂商省电策略限制
- WebView Renderer 被回收后页面尚未恢复
- Activity 被销毁后没有可用的 WebView

因此实现目标是：

```text
尽最大努力保持
+ 能发现中断
+ 能恢复页面
+ 明确报告可能漏掉的事件
```

而不是伪装成“永不掉线”。

## 三、诊断用户“挂上了但没答题”

### 先问的问题

1. 实际版本和渠道是什么？（关于页截图）
2. “挂上”指自动进入课堂、页面留后台、锁屏，还是只打开面板？
3. 自动进入 / 自动作答 / 自动进入后自动作答分别是什么状态？
4. 当时有没有出现习题提醒？
   - 有提醒但没答
   - 没提醒也没答
   - 有题目但 AI 没反应
   - AI 报错
5. AI 配置是云端还是自定义？设置页测试连接是否正常？
6. 浏览器、脚本管理器、脚本版本；是否开了多个课堂标签页？
7. 页面当时是否在后台标签/最小化窗口？是否切到别的 App？
8. 让用户点击 AI 面板「诊断」，把返回的短 ID 发来。

### 诊断报告现在包含

- 脚本版本 / 平台 / 页面
- 自动作答、自动进入、自动进入后自动作答、提醒开关
- AI Profile 的 endpoint/model 与 key 是否存在（不含 key）
- 运行时：
  - 后台服务是否开启
  - 强模式
  - 心跳年龄
  - 可见性 / 焦点
  - WebSocket 状态
  - 最后课堂事件
  - 最后 unlockproblem
  - 最后错误
- 最近一次 AI 任务与运行结果
- 最近 60 条答题日志

### 新增的诊断事件

```text
unlock_received
auto_answer_scheduled
auto_answer_started
auto_answer_skip
auto_answer_timer_lag
auto_answer_completed
auto_answer_error
auto_join_attempt
auto_join_skip
auto_join_success
auto_join_error
runtime_heartbeat
runtime_visibility
```

其中 `auto_answer_skip.reason` 会区分：

```text
auto_disabled
no_status
answering
already_done
expired
no_api_profile
```

这能直接回答：

- 题目有没有到达脚本
- 自动作答有没有被安排
- 有没有到计时器
- 是否因为后台节流而晚触发
- AI 是否开始
- 失败在哪一步

## 四、真机验证建议

优先在 Android 上验证：

1. 开启后台监听，允许通知
2. 返回桌面 5 分钟，检查通知和 `dumpsys activity services`
3. 锁屏 30 分钟，检查心跳和最后课堂事件
4. 断网再恢复，检查 WebSocket 重连
5. 用 `adb shell dumpsys deviceidle force-idle` 测试 Doze
6. 杀 WebView Renderer，检查恢复
7. 强制停止 App，确认不会虚报“仍在运行”

测试验收不能只看通知还在，要看模拟 WebSocket 发出的带序号事件实际收到多少条。
