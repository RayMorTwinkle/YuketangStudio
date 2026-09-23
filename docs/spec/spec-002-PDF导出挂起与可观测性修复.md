# spec-002 PDF 导出挂起与可观测性修复

## 背景

用户报告：「整册下载(PDF)」导出 100+ 页课件时进度卡在约 145 页，面板关闭按钮无响应，无任何报错。
因已下课无法浏览器复现，由 3 个只读 subagent 对代码逐条核对（证据见 `.yks-audit-findings.md` 增补或本文件）。

## 已核实根因（按严重度）

### A. 致命：Promise 永不 settle（无报错挂死）

1. `env.js fetchAsDataURL` 的 `onload` 回调里 `reader.readAsDataURL(res.response)` 若 `res.response` 不是
   Blob（GM 实现差异/响应为空），同步 throw 发生在 GM 回调内 → `reject` 永不被调用 → Promise 永久 pending。
   - 无 `onabort` 回调；GM `timeout` 字段在部分实现被忽略时无任何兜底计时器。
2. `pdf-export.js loadImageViaGM` 的 `new Image()` 无超时；`fetchAsDataURL` 失败后回退 `img.src = 原URL`
   直载，网络静默挂死时 `onload/onerror` 都可能不触发 → 永久 pending。
3. 上述任一挂起点都会让 phase-1 的 `Promise.all` 永不返回 → 进度定格在 `已下载 N/M 张`，零日志。
4. `env.js loadScriptOnce` 无超时（ensureJsPDF 兜底路径同理可挂）。

### B. 致命：phase-2 同步循环冻结主线程（关闭按钮失效）

5. `pdf-export.js:54-91` phase-2 `for` 循环零 await：`toGrey256` + `mae`(O(n²·36K)) +
   `doc.addImage(img,'PNG')`（内部 canvas 全尺寸重编码 PNG）。145+ 页 → 主线程阻塞数分钟，
   onProgress 写的 DOM 不 paint、点击事件不 dispatch →「关闭键点不动」的直接成因。

### C. 高：内存与体积放大

6. `imgs[]` 持有全部 Image 解码位图（145×1920×1080×4B ≈ 1.2GB+）+ 全部 dataURL 字符串 +
   jsPDF 累积页数据，无释放点 → GC 抖动/OOM 崩 tab（崩 tab 亦无报错）。
7. `addImage(img,'PNG')` 把 JPEG 源图重编码为无损 PNG，体积放大 5-10 倍，加剧内存与 doc.save 耗时。
   jsPDF 对 JPEG/PNG dataURL 可直接内嵌原始字节（免重编码）。
8. `fetchAsDataURL` 失败后直载跨域图 → canvas 污染 → `doc.save`/`addImage` 内部 toDataURL
   SecurityError → 单页失败拖垮全册（应计 failed 跳过）。

### D. 高：历史课件链路（链路 B）超时语义错误

9. `importHistoryLesson` 用迭代次数 `i<180` 当超时——`GM_openInTab(active:true)` 后主页面变后台，
   `setTimeout` 被节流到 ~1min/次 → 名义 180s 实际可数小时，「收集超时」形同虚设。
   且无停滞检测（`lastProgressTs` 只用于去重）。
10. `runHistoryCapture` 收集阶段 `thumb.click()` 后固定 `sleep(3500)` 一次性扫 DOM：
    lightbox 懒渲染/虚拟滚动时只收集到部分页 → 静默产出缺页 PDF。
    URL 过滤要求 `includes('token')`、正则 `cover(\d+)_(\d+)` 对命名漂移脆弱（部分过滤=静默缺页）。
11. 结果/进度 key 只含 lessonId 无 runId：上一次超时残留的收集 tab 会把旧结果写给新 run → 串扰。
12. `GM_openInTab` 返回值在 GM4/Violentmonkey 下是 Promise，`collectTab?.close?.()` 静默无效 → 残留 tab。

### E. 中：可观测性与可控性

13. `exportImagesToPdf` 的 `opts.signal` 无任何调用方传入（死代码）；phase-1 worker 不检查 aborted；
    进度条无取消按钮；shell 关闭（`__yksOnHide`）不中止导出。
14. 停滞时用户侧无任何提示：进度条停格、toast 4-12s 即逝、log 只进 console。
    需要：停滞检测文案、失败明细可见、per-image 超时的 warn 日志含域名。
15. 批量导入部分失败时 `failList` 明细被丢弃（只显示计数）。
16. `handleProgress/handleResult` 回调内异常逃逸会提前终结等待循环。
17. listener 半程注册失败时 `id1` 泄漏未 remove。
18. `naturalWidth=0` 畸形图 → `format=[0,0]` 传入 jsPDF 行为未定义（应计 failed）。

## 修复方案

### pdf-export.js（重写导出核心）
- `loadImageViaGM` 返回 `{ img, dataUrl }`；Image 加载包 `Promise.race` 超时（默认 30s，可配 `imageTimeoutMs`）；
  GM 下载失败 → **不再直载跨域原图**，直接计 failed（直载必然污染 canvas 导致全册失败）。
- phase-1 worker 循环内检查 `opts.signal.aborted`。
- phase-2 每页 `await yieldFrame()`（`setTimeout(0)`）+ 每页 try/catch（单页异常计 failed 继续）；
  addImage 后 `imgs[i]=null; img.src=''` 释放位图。
- addImage 优先传原始 dataURL（mime jpeg→'JPEG'、png→'PNG' 原字节内嵌，免重编码）；
  其他格式回退 img+'PNG'（仍在 per-page try 内）。
- `naturalWidth===0` → failed。
- onProgress 附加 `pages` 字段。

### env.js
- `fetchAsDataURL`：onload 回调整体 try/catch；`res.response` 非 Blob 时 `new Blob([response])` 兜底；
  注册 `onabort`；GM `timeout` 之外加自己的兜底计时器（`timeoutMs+5s` 强制 reject）。
- `loadScriptOnce`：加 30s 超时 reject。

### history-capture.js
- `importHistoryLesson`：墙钟 deadline（`Date.now()+超时`）替代迭代计数；超时上限按页数动态
  （基础 120s + 2s/页，封顶 15min）；`lastProgressTs` 用于停滞检测（>90s 无进展→报「收集页可能已卡死」）；
  `handleProgress/handleResult` 调用包 try；listener 半程失败时清理已注册项；
  `GM_openInTab` 返回值 `await Promise.resolve(...)` 兼容 Promise。
- URL 带 runId：`#yks-collect-<nonce>`；收集页 result/progress 写 `runId`，主页面校验不一致则丢弃。
- `runHistoryCapture`：入口即写 `{phase:'start'}` 心跳；收集阶段改轮询——滚动 lightbox 容器 +
  每秒重扫 img，连续 3 次计数不变才收尾（上限 45s）；读 `currentSrc||src||dataset.src`；
  URL 过滤放宽为 `/slide/\d+/` + 图片扩展名（去掉 token 硬要求），被过滤的 `/slide/` URL 采样记日志；
  收集数与页面声明总页数不一致时在 result 里带 `expectedTotal` 告警。
- report 函数节流（≥150ms 间隔才 GM_setValue，最终结果始终写）。

### presentation.js / presentation.html
- `downloadPresentationPDF`：建 `AbortController` 传入 `signal`；进度条加 ✕ 取消按钮（html 加元素）；
  停滞检测：>45s 无 onProgress → 文本显示「已停滞 Xs（可能在解码大图或网络挂起）」；
  `host.__yksOnHide` → abort 导出并 toast。
- `showImportProgressBar`：加 ✕ 取消（置 aborted 标志，批量循环每轮检查）；`fail`/`done` 不再自动 remove
  （改 30s 或手动关闭）；失败明细写入 bar 文本与 log.warn。
- 打开收集页改 `active:false`（不切走焦点，避免主页面节流；收集页对用户不可见也合理）。

### 测试
- `scripts/test-pdf-dedup.mjs`：Image stub 支持 `HANG` 标记（永不回调）+ 用例验证超时计入 failed；
  jsPDF stub 记录 addImage 参数；保持既有 14 条断言通过。

## 验收

- `npm run lint && npm run build && node scripts/test-pdf-dedup.mjs && node scripts/test-activities-paging.mjs` 全绿。
- 单图挂起 → 30s 后计 failed 继续；phase-2 期间 UI 可响应（关闭/取消可用）；取消按钮生效。
- 链路 B 停滞 90s 报明确错误而非静默等待；收集页数不足时结果含告警。
