# YuketangStudio 维护模式

从 0.7.1 起进入维护模式：**不再主动加功能，只修可复现的 bug。**
答题链路已经收敛到 `src/answer/`，新增功能会破坏稳定性，默认不做。

## 出问题时怎么做

1. 打开 AI 解答面板，点右上角 **诊断**。
2. 报告会直接上传到服务器，成功后自动复制短 ID（`diag_...`），把它发出来即可。
3. 上传失败时会自动复制完整 JSON，直接粘贴给维护者；不会再保存本地文件。
4. 如果强化遥测开着，也可以只发时间；服务器 traces 里有 `runId/taskId`。

诊断报告包含：版本、平台、页面、当前 AnswerTask、题目/选项/空位、题图（≤300KB 时）、最近一次运行结果、最近 60 条答题日志、最近 8 条会话、AI Profile（已脱敏，无 Key）。

服务端位置：

```text
/root/app-configs/svc/data/diagnostics/YYYY-MM-DD.jsonl   # 保留 30 天
GET /yuketangstudio/admin/diagnostics?id=diag_...          # Basic Auth 按 ID 查
```

## 测试命令

```bash
cd ykt-helper

# 单测 + lint + build
npm run check

# 桌面 ego 端到端（答题矩阵，测试模式，不提交）
npm run test:lab

# Android 真机（debug APK + EVAL/NAV 广播，测试模式，不提交）
npm run test:android

# 两端都跑
npm run test:all
```

- `test:lab` 需要本机安装 `ego-browser`。
- `test:android` 需要 debug APK 已安装、`adb devices` 能看到设备。
- 所有提交都走 test-mode mock，不会请求真实答题/暂存接口。

## 发布节奏

- 只发 beta；stable 保持不动，除非明确要求。
- 一个 beta 至少跑完 `npm run check` + `test:lab`；涉及 Android 原生/WebView 的改动再跑 `test:android`。
- 真实课堂/作业的变体不靠反复上课试：出问题时点诊断并记下 `diag_...` ID，之后按 ID 取回完整样本离线回放。

## 服务器 traces

```text
/root/app-configs/svc/data/traces/YYYY-MM-DD.jsonl
```

服务器保留 7 天；按 `runId` 可以把
`answer_start → attempt → parsed/parse_error → submit → error`
串起来。查看入口：

```bash
ssh SM 'cat /root/app-configs/svc/data/traces/2026-10-22.jsonl'
```

或 `GET /yuketangstudio/admin/traces?limit=100`（Basic Auth）。
