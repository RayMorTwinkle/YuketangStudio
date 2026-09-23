# spec-001：渲染 / 跟随当前页 / 答题链路 修复与可靠性加固

> 来源：多 subagent 排查（4 个探索 agent）+ 1 个核对 agent 逐条验证。
> 核对结论：85 条候选全部属实或部分属实。本 spec 收录全部「值得修复」项，按修复分组编排。
> 编号对应审查清单 `.yks-audit-findings.md`（核对表分数见各节标题）。

## 背景：Tampermonkey 沙箱模型（多数 bug 的共同根因）

脚本带 `@grant`，运行在 isolated world：
- `window`（沙箱）≠ `unsafeWindow`（页面世界，代码里 `gm.uw`）
- `<script>` 注入的库（marked/mermaid/DOMPurify/html2canvas）落在 `gm.uw`
- `@require` 的库（jspdf/MathJax）落在沙箱 `window`
- DOM expando（`el.__vue__`）跨 world 不可见

## P0 — 用户报告 bug 的直接根因

### G1. PPT 对话 markdown / HTML 不解析（清单 #1 #3 #4 #2，分 10/8/5/4）

- **#1 (10分)**：`env.js:79-83` `ensureMarked` 用 `gm.uw` 落点；`ai.js:482,524` 读 `window.marked` → 恒 undefined → 永远走 fallback 解析器（不支持列表/表格/链接，`escapeHtml` 转义全部 HTML）。
  **修法**：`mdToHtml` 两处改读 `gm.uw.marked`；`mountChatPanel` 补 `warmupRichAssets()`（现在只有 ai.js:92 预热）。
- **#3 (8分)**：`styles.css:406-513` 整套 `.ai-answer`/`#ykt-ai-answer` 是死选择器（气泡实为 `.ykt-ai-msg.ai`/`.ykt-chat-msg.ai`）→ 即使 marked 修好，表格/列表/代码块/公式对齐仍无样式。
  **修法**：选择器改挂到 `.ykt-ai-msg.ai, .ykt-chat-msg.ai` 下。
- **#4 (5分)**：marked 输出直进 `innerHTML` 无清洗（DOMPurify 只洗 `.ykt-embed` 块）→ 修 #1 后 AI 输出中的恶意 HTML 会在页面执行。
  **修法**：marked 输出过 `DOMPurify.sanitize`（未就绪时用同步 `sanitizeHtml` 兜底）再进 innerHTML。
- **#2 (4分)**：`ai.js:437` `blocks` 模块级数组从不清理 → 流式期间 O(n²) 增长。
  **修法**：改为 `mdToHtml` 内局部数组。

### G2. 「跟随当前页」不工作（清单 #11 #12 #13 #16 #15，分 10/8/6/5/4）

- **#11 (10分)**：`vuex-helper.js:8` 沙箱读 `document.querySelector('#app').__vue__` → 恒 null → `waitForVueReady` 永不 resolve + `log.warn` 每 100ms ×2 面板刷屏 → 跟随当前页与 AI「主界面当前页」识别双失效。
  **修法**：`gm.uw.document.querySelector('#app')?.__vue__`。
- **#12 (8分)**：`presentation.js:229-238` watcher 回调拿到 `slideId` 却从不写 `repo.currentSlideId` → 即使 watcher 工作也跟随的是旧页。
  **修法**：回调里 `repo.currentSlideId = String(slideId)`，并按 slide→presentation 归属同步 `currentPresentationId`。
- **#13 (6分)**：`presentation.html:3-6` 定义 `.slide-thumb.selected`，JS 用 `.active`，CSS 无 `.active` 规则 → 修好也高亮不可见。
  **修法**：HTML 内 `.selected` 改 `.active`（或补样式）。
- **#16 (5分)**：`waitForVueReady` 无限轮询。**修法**：加 ~15s 超时，失败 resolve(null) 停止轮询；`getVueApp` 的 warn 节流（只在首次缺失时打一次）。
- **#15 (4分)**：移动版只 watch cards 数量。**修法**：改 watch「最后一个含 sid 卡片的 sid 值」。

### G3. PPT 对话对普通用户整体不可用（清单 #6，9 分；捎 #5）

- **#6 (9分)**：`chat.js:359-366` `agnesChat` 不传 `override`（ai.js:376-384 传 `getOverride()`）→ `agnes.js:53-57` 回落到 dev config，未解锁即抛「开发者模式未解锁」。
  **修法**：把 ai.js 的 `getOverride` 逻辑导出/复用到 chat.js。
- **#5 (5分)**：`mountChatPanel` 无 `root.__yksOnShow` → 上下文缩略图永不刷新（`refreshCtxThumb` 唯一触发点 `showChatPanel(true)` 不经 `Shell.openTab` 路径）。
  **修法**：`root.__yksOnShow = refreshCtxThumb`。

## P1 — 静默错答与卡死（必须修）

### G4. Promise 悬挂 → answering 永真（清单 #44 #48，分 8/7）

- `openai.js:168-215` `chatCompletion`、`:121-163` `queryAI` 设了 `timeout` 无 `ontimeout` → GM_xhr 超时 Promise 永不 settle → `status.answering` 永真、题卡死无感知。
- `answer.js:34-57` `xhrPost` 无 timeout/ontimeout 同症。
  **修法**：统一补 `ontimeout: () => reject(new Error('请求超时'))`；xhrPost 加 `xhr.timeout=20000`。

### G5. 静默提交垃圾答案（清单 #47 #51 #53 #61，分 9/4/4/5）

- **#47 (9分)**：`ai-format.js:182-184` 无「答案:」行时兜底取 `lines[0]` → prompt 哨兵 `STATE: NO_PROMPT` 被解析成字母提交（单选 'S'、多选一堆字母）。
  **修法**：先匹配 `/^\s*STATE\s*:\s*NO_PROMPT/i` → return null；选择题再校验字母 ⊆ 选项范围。
- **#51 (4分)**：`actions.js:295` `content.split('')` 不过滤 → `'A、B'` 提交含顿号。**修法**：`content.match(/[A-Z]/gi)` 提取。
- **#53 (4分)**：`answer.js:107` `okList.includes(problemId)` 严格相等，类型不一致误报失败。**修法**：`map(String)` 比较。
- **#61 (5分)**：无 API Key 时自动提交 `['A']/[' 1']/略` 默认答案（错答策略）。**修法**：加 `autoAnswerFallbackDefault` 开关（默认关 → 无 key 时跳过作答并 toast）。

### G6. agnes 流式链路（清单 #45 #46 #58 #59，分 7/6/4/5）

- **#45 (7分)**：abort 用自定义 reason（`name:'Error'`），降级判断只认 `AbortError` → 取消/超时后反而再发一个不可取消的 GM_xhr。**修法**：catch 加 `opts.signal?.aborted` 判断；abort 传 `DOMException(name:'AbortError')`。
- **#46 (6分)**：`gmXhrStream` 每次 onprogress 新建 `sseParser` → 跨边界 SSE 行丢失。**修法**：parser 提升出 onprogress。
- **#59 (5分)**：fetch 拿到 HTTP 4xx/5xx 也降级 GM_xhr 重发 → 重复计费。**修法**：只对网络型错误（TypeError）降级，HTTP 错误直抛。
- **#58 (4分)**：`reasoning_effort` 无条件下发。**修法**：仅在显式配置且非 `'off'` 时下发。

## P2 — 网络 / 状态层可靠性

### G7. 拦截器 realm 与健壮性（清单 #27 #32 #37 #40，分 7/3/3/3）

- **#27 (7分)**：`fetch-interceptor.js:8-9` patch 沙箱 `window.fetch` → 页面 fetch 一条拦不到。**修法**：patch `gm.uw.fetch`。
- **#32 (3分)**：`xhr-interceptor.js:20` 对 `responseType=json/blob` 的 `responseText` 抛错被吞。**修法**：按 responseType 取 `this.response`；`open()` 透传 user/password。
- **#37 (3分)**：ws/xhr intercept 的 `catch{}` 吞掉回调内所有异常。**修法**：catch 里 `log.err` 留痕。
- **#40 (3分)**：`isRainClassroomWS` `includes('/ws')` 过宽。**修法**：收紧到 `/wsapp` 前缀。

### G8. slides/problems 键类型与 lessonId（清单 #28 #29 #33 #41，分 7/6/4/3）

- **#28 (7分)**：`repo.slides` 键类型不统一（upsertSlide 原始 / fetch 拦截 String / onUnlockProblem 原始）→ 静默 miss 丢题。**修法**：读写统一 `String(id)`；`problems`/`problemStatus` 同理。
- **#29 (6分)**：`currentLessonId` 仅启动时提取，正则只认 `/lesson/fullscreen/v3/`；SPA 切课不重提 → 存错桶。**修法**：rearm 时重提；正则放宽 `/(fullscreen|student)/`。
- **#33 (4分)**：`actions.js:200` `for (const slide of pres.slides)` 假定数组。**修法**：`(pres.slides || [])`。
- **#41 (3分)**：`repo.setPresentation` `{id,...data}` 若 data.id 覆盖参数；内存 Map 不裁剪。**修法**：`{...data, id}`；同步裁剪内存 Map。

### G9. 自建 WS 与自动进课堂（清单 #31 #35 #36，分 7/5/4）

- **#31 (7分)**：`connectOrAttachLessonWS` 用原生 `new WebSocket` → 无 message 分发，收不到 unlockproblem/timeline；host 只分 pro/www，changjiang 落空。
  **修法**：自建 socket 挂同一套 message 分发；host 用 `wss://${location.hostname}/wsapp/`。
- **#35 (5分)**：`actions.js:428` `_autoOnLessonClickStarted=true` 在路径检查前置位 → 首次课堂页后 SPA 回首页再不装。**修法**：置位挪到路径检查之后。
- **#36 (4分)**：MO 永不 disconnect（disconnect setTimeout 被注释）。**修法**：恢复 30s 超时 disconnect。

### G10. onUnlockProblem 边界（清单 #38 #39 #24 #34，分 7/4/4/4）

- **#38 (7分)**：`limit` 缺失→NaN endTime、`limit=0`→立即过期跳答、slide miss 无重试、重复 unlock 覆盖 `answering`。
  **修法**：`Number.isFinite` 守卫；miss 时进 pending 队列在 `onPresentationLoaded` 后 replay；重复 unlock 保留 `answering`。
- **#39 (4分)**：服务端 `dt` 对本地 `Date.now()` 判过期。**修法**：记录 `clockOffset = data.dt - Date.now()`，比较时用校正时间。
- **#24 (4分)**：`active-problems.js` NaN 倒计时「剩余 NaNs」永不消失。**修法**：`Number.isFinite` 守卫，无限时显示「不限时」。
- **#34 (4分)**：`presentation.js:340-351` 过滤三分支等价 no-op + 空结果回退全量。**修法**：简化为「lessonId 匹配才过滤，否则全量」。

## P3 — 面板 / Shell / 交互一致性

### G11. Shell 状态机（清单 #17 #18 #19 #21，分 6/5/6/5）

- **#17 (6分)**：五面板 ✕ 只摘自身 `visible`，shell 的 `active-tab` 残留 → 壳空内容。**修法**：面板内 ✕ 统一派发 `ykt:close-shell` 事件（避免 import 环），shell 监听后 `showShell(false)`。
- **#18 (5分)**：toolbar 主面板按钮自记 `active` 不同步。**修法**：`showShell` 时同步 `#ykt-btn-shell`；按钮读真实状态。
- **#19 (6分)**：`index.js:66` `.ykt-panel.visible` 被 shell 子面板永久占住 → 周期刷新失效。**修法**：守卫改查 `#ykt-shell-panel.visible`。
- **#21 (5分)**：关 shell/切 tab 不中止流式。**修法**：面板暴露 `__yksOnHide`（chat/ai 接 abortStreaming），shell 切换时调用。

### G12. UI 小修（清单 #20 #22 #23 #25 #26 #82 #84，分 6/7/5/6/4/2/3）

- **#20 (6分)**：`document-start` 时 `document.body` 可能不存在 → mount 崩。**修法**：main() 加 DOM-ready 守卫（拦截器仍最先装）。
- **#22 (7分)**：`presentation.js:499` 大图 `crossOrigin='anonymous'` + OSS 无 CORS → 恒裂图。**修法**：去 crossOrigin（此处不读 canvas）。
- **#23 (5分)**：`presentation.js:376,587` 服务端标题进 innerHTML。**修法**：textContent。
- **#25 (6分)**：`ui-api.js:14` `_config.ai` 判空在赋值后。**修法**：兜底挪前。
- **#26 (4分)**：notify drag 无屏幕右/下界。**修法**：加 `Math.min` 上界。
- **#82 (2分)**：`_bringToFront` 对 notify 恒 no-op。**修法**：去掉 `visible` 前置。
- **#84 (3分)**：active-problems 每秒重建 DOM。**修法**：无活跃题时 early-return。

## P4 — AI/答题链路细节

### G13. 图像与题型（清单 #49 #50 #52 #55 #57，分 6/4/5/2/5）

- **#49 (6分)**：`screenshoot.js` 用 Image+CORS 取图，而项目已有 `fetchAsDataURL`（CORS 免疫）。**修法**：优先 `fetchAsDataURL`。
- **#50 (4分)**：`captureProblemScreenshot` 兜底整页截图，违反项目原则。**修法**：去 body 兜底返回 null。
- **#52 (5分)**：`queryAIVision` 的 problemType 合并是死代码（调用方不传）。**修法**：`actions.js:133` 传 `{problemType: problem.problemType}`。
- **#55 (2分)**：jpeg 被包成 png MIME。**修法**：按实际编码标 `image/jpeg`。
- **#57 (5分)**：`settings.js` DeepSeek 预设 `visionModel='deepseek-chat'`（纯文本模型）。**修法**：置空。

### G14. 答案解析细节（清单 #54 #56 #62，分 2/4/3）

- **#54 (2分)**：`resp.msg` 缺失显示 `undefined (5)`。**修法**：`resp.msg || '服务器返回错误'`。
- **#56 (4分)**：填空题 >50 字符返回对象非数组；≤50 按空白切分破坏合法答案。**修法**：type4 统一返回数组；只按逗号/分号切。
- **#62 (3分)**：`getActiveProfile` 就地 mutate。**修法**：返回拷贝。

### G15. 双击延时与拦截器细节（清单 #30 #43，分 5/2）

- **#30 (5分)**：`autoAnswerTime` 已排延时，`submitAnswer` 内 autoGate 又等一遍 → 实际 ≈2 倍。**修法**：自动路径 `submitAnswer` 传 `autoGate:false`。
- **#43 (2分)**：`checkinClass` 固定 'HTTP 400'。**修法**：带真实 status/note。

## P5 — 历史课件 / 构建

### G16. 收集 tab 隔离（清单 #63 #64 #70，分 7/5/4）

- **#63 (7分)**：任何 student-v3 页都跑 `runHistoryCapture` → 手动浏览也被强制 lightbox+下载。**修法**：`importHistoryLesson` 开 tab 时 URL 加 `#yks-collect=1`；capture 仅在有标记时跑。
- **#64 (5分)**：收集 tab 跑完整 main()，autoJoin 可能把收集页导航走。**修法**：collect 模式只跑收集器（跳过 lessonHelper/autoJoin/周期刷新）。
- **#70 (4分)**：`GM_openInTab {active:true}` 批量导入抢焦点；固定 180s 超时。**修法**：`active:false`；按「60s 无进度」判断超时。

### G17. 收集器细节（清单 #65 #66 #67 #68 #74 #75 #76，分 3/3/3/5/3/4/3）

- **#65**：dedup key 含 m[2] → else 分支永假。**修法**：key 去掉 m[2]（保留 m[1]_m[3]），比较分支才有意义。
- **#66**：`ensureJsPDF` fallback 装主世界查沙箱 → 死代码。**修法**：fallback 后查 `gm.uw.jspdf`；注释勘误。
- **#67**：全图失败时 `doc.save` 裸 TypeError。**修法**：`if (!doc) throw new Error(...)`。
- **#68 (5分)**：`collectStaticSlideURLsFromDom` 硬编码 `thu-private-qn` → 长江部署收集为空。**修法**：正则泛化为 `*-private-qn.yuketang.cn`。
- **#74**：每页一次 GM_setValue 进度推送。**修法**：节流（≥400ms 或 pct 变化）。
- **#75**：`src.includes('token')` 硬假设。**修法**：去掉 token 前置（cover 正则已够）。
- **#76**：`statusEl.innerHTML` 拼接页面可控文本。**修法**：textContent。

### G18. PDF 导出重复实现（清单 #69，5 分）

- `presentation.js:713-809` `downloadPresentationPDF` 重复实现且更差（串行、单图失败整份中止、无去重、无 URL 插空白页、reject Event 显示 [object Event]）。**修法**：直接调 `exportImagesToPdf(urls, title, {onProgress})`。

## P6 — 安全 / 存储 / 死代码

### G19. API Key 存储（清单 #71，5 分）

- `devmode.js`/`storage.js` 全走 localStorage → 页面 JS 可读 API Key。**修法**：`storage.js` 优先 `GM_getValue/GM_setValue`（Tampermonkey 同步 API），缺失时回落 localStorage；读取时把旧 localStorage 值迁移进 GM 存储。

### G20. 死代码与注释（清单 #10 #14 #72 #73 #77 #78 #79 #80 #81 #83 #85 #9，分 1-3）

- 删：kimi.js/deepseek.js/gemini.js/openrouter.js（无 import）、`startAutoAnswerLoop` 双定义+`tickAutoAnswer`、`ensureFontAwesome`（index.js 有内联）、`isNarrowDevice`、死按钮查询（ykt-btn-ai/pres/help）、`types.js` 顶层死配置、`.slide-thumb.selected` 死样式、死 CSS 规则（.ykt-problem-list/.text-status/.ykt-custom-prompt/.ai-question 等/.ykt-panel.dark）、ai.js:307 空块、ai.js:88-90 重复事件监听、actions.js:477 无效 replaceState、index.js BOM、rollup 注释勘误。
- `escapeHtml` 三处重复 → 抽公共 util。
- `npm test` 在干净检出缺 `test-devmode.mjs`（gitignore）→ 失败：**修法**：test 脚本对缺失文件 skip-on-missing。
- 测试断言/循环论证（#77 #78）：本期仅标注，不阻塞。

## 验证计划

- `npm run check`（eslint + rollup build + 两个可离线测试；`test-devmode.mjs` 需要网络，缺失时 skip）
- 手测重点：① PPT 对话发 markdown 表格/列表/HTML 片段；② 课堂页让老师翻页观察跟随与高亮；③ 自动作答超时不再卡死；④ 手动打开历史报告页不再触发收集。
- dist 产物随源码重新构建（`npm run build`）。

## 不处理 / 观察项

- **#60** @connect 自定义域名：Tampermonkey 会弹「允许跨域请求」确认框而非静默拒绝，用户授权一次即可；文档提示即可，不改 meta。
- **#77 #78** 测试桩质量：标注待后续加强。
- **#58 的自动重试**：reasoning_effort 400 自动去掉重试属增强，本期只做「显式配置才下发」。
