# spec-003 移动端适配补齐

日期：2026-09-23（课堂实测期间）

## 背景

雨课堂移动版（`/m/v2/*`、`/lesson/student/v3/*`）与桌面版是**两套完全不同的前端应用**：
DOM 结构、Vuex store 形状、路由都不同。上个版本已做部分适配
（`@match` 覆盖、`state.cards` 跟随、shell ≤560px 单列、桌面版引导），
本次课堂实测补齐剩余缺口。

## 实测确认已可用的部分

- 脚本在 `/lesson/student/v3/` 注入并挂载（工具栏、shell 面板、全部 tab）
- shell 面板 ≤560px 正确切换为横向 tab 条 + 单列布局，触控目标 ≥40px
- 课件面板加载 158 页缩略图；「跟随当前页」选中 thumb = 老师
  `state.cards` 最新 card 的 `pageIndex`（移动版 store 为扁平结构：
  `lessonId`/`cards`/`presentationId`，无 `lesson.lessonid` 嵌套）
- `/m/` 页面弹出「切换桌面版」引导

## 本次修复

### 1. 早期注入时 UI 挂载崩溃（`index.js`）

`ui._mountAll()`/`installToolbar()` 直接 `document.body.appendChild`，
脚本若在 document-start 注入（移动版 SPA 首次进入实测触发），
`document.body` 为 null → 整条初始化链抛异常 → 工具栏永久缺失，
只能靠手动刷新恢复。

修复：新增 `whenBodyReady()` —— body 未就绪时 50ms 轮询等待（15s 上限），
且面板挂载与工具栏各自 try/catch 隔离，单步失败不再拖垮全部。

### 2. AI 截图选择器无移动版覆盖（`capture/screenshoot.js`）

原选择器 `.ques-title/.problem-body/.ppt-inner/.ppt-courseware-inner`
全部为桌面版 DOM，移动版截图恒返回 null（AI 视觉链路静默失效）。

新增：
- `.timeline-item [class*="problem"/*, "ques"], .timeline__problem` ——
  移动版时间线题目卡片
- 兜底：`.student__timeline .timeline-item` 最后一张卡片
  （老师刚推送的内容，对 AI 上下文有意义且远比整页截图精准；
  仍不退回 `document.body`）

移动版卡片 DOM 实测链：`section.student__timeline.J_cards` →
`section.timeline-item` → `div.timeline-wrapper` → `div.timeline__ppt`
→ `img.cover`。

### 3. 自动进课堂固定跳桌面 fullscreen 页（`state/actions.js`）

`tryApiJumpFirst` 恒跳 `/lesson/fullscreen/v3/{id}`，移动端会被服务端
弹回或进入不适配的桌面页。现按 `isMobileVersionPage() || isNarrowDevice()`
选择 `/lesson/student/v3/{id}`。

## 已知限制 / 环境备注

- **ego lite 内置 Tampermonkey 5.5.0（解包扩展）状态不稳定**：
  实测中脚本数据库被清空（仪表盘显示「没有安装任何脚本」但
  chrome.userScripts 注册仍存活、脚本继续注入），`.user.js`
  安装页接管时好时坏。属浏览器环境问题，非脚本问题；用户真实
  Edge 浏览器中 Tampermonkey 工作正常。
- 移动版题目卡片类名（`timeline__problem` 等）按现有结构推断，
  未在有实时习题推送时验证；兜底选择器保证截图链路不再静默失效。
- 历史课件下载「卡在最后一张」与课堂下载无并发两个老问题，
  已在 spec-002 修复（计数稳定轮询 + 心跳/墙钟超时 + 5 路并发），
  本次 158 页实测通过。
