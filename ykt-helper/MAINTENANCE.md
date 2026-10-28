# YuketangStudio 维护模式

从 0.7.1 起进入维护模式：**不再主动加功能，只修可复现的 bug。**
答题链路已经收敛到 `src/answer/`，新增功能会破坏稳定性，默认不做。

> **0.8.0 附录（经所有者批准的例外）**：本次发布突破冻结条款，移植桌面端
> `yuketang-helper-auto` 的「新版作业/考试发现 + 取题 + 只读考试回顾」能力，
> 并吸收其 AI 答题优点（置信度）。范围、决策与风险经质询批准
> （plan 文件 1793067093249-quiet-comet.md），要点：
>
> - 新增 `src/quiz/active-core.js`（纯函数，38 用例）+ `active-http.js` + `exercise.js` + `exam.js`；
>   `assignments.js` 行结构扩展（`leafTypeId/skuId/classroomId`），去重 `type:id`，19/20 按保留窗口过滤。
> - **type 19（新版作业）只读展示，绝不提交**；自动暂存仅对 type 4 生效（预留 `target.kind='exercise'`）。
> - **type 20（考试）只读回顾**（已交卷 + 已出分 + 公布时间到，`canReviewExam` 门禁），绝无提交。
> - 答题引擎核心不动：`src/answer/engine.js` 仅遥测多一个 `confidence` 字段；
>   `prompt.js` 工具 schema 加 `confidence`（0-1）；`parse.js` `normalizeConfidence` 归一化。
> - Android `YktBridge.fetchRequest` 增强为带 Cookie/手动重定向(≤5 跳)/Set-Cookie 回写，
>   `gm-shim.js` 与 `fetchBinary` 不动。
> - 行为变化：作业列表不再显示 3 个月外的过期 19/20（保留窗口 = 3 日历月，UTC）；
>   19/20 的「老界面」按钮移除（旧值是误报的 `courseware_id`）。
> - 已知限制：加密字体跨域加载失败时降级为原字符；exam 域白名单硬编码
>   （`tsinghua-exam.yuketang.cn` / `examination.xuetangx.com`）；
>   19 暂存接口未接入（等抓包样本）。
>
> 例外仅限本次；此后继续冻结，只修 bug。

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
