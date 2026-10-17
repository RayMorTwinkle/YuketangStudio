# 更新日志

0.5.6:

- 🔧 **@connect 全放开**：`GM_xmlhttpRequest` 域名白名单漏了 `developer.amd.com.cn`（AMD Qwen 解锁码被拒连）。加 `developer.amd.com.cn` + `@connect *`（AI 端点用户自定义，逐一枚举追不上）
- 🔧 **桌面端 FA 图标修复**：页面 CSP **静默拦** inline `<style>` 的 `@font-face`（不抛异常，单 try/catch 回退探测不到）。`ensureFontAwesome()` 改 `GM_addStyle`（扩展通道绕 CSP）+ DOM `<style>` + CDN `<link>` 三通道并发；KaTeX css 同理（`GM_addStyle` + `<link>` 回源）
- 🔧 **公式渲染修复**：marked 把 `(`/`[` 当 ASCII 标点转义吃掉 `\(x_0\)` 的反斜杠（`parse('\\(x_0\\)')` → `(x_0)`），定界符到 typeset 时已消失。`mdToHtml` 在 marked parse 前把 `\(...\)`/`\[...\]` 整段抽成 `\uE000M{n}\uE001` 占位符，parse 完统一还原——ego 实测 `\(x_0\)` 渲染为 `<mjx-container><svg>`
- 💬 **prompt 强化**：「所有数学符号与公式必须用 `\(...\)`/`\(...\)` 包裹——含简单记号（写 `\(x_0\)` 不写 `(x_0)`）」

0.5.5:

- 📦 **桌面端全离线**：`src/vendor/` 把 jsdelivr/cdnjs/hertzen 依赖（katex/katex-auto/marked/dompurify/mermaid/jspdf/html2canvas + KaTeX/FA 字体 data-URI css）以 `?raw` 字符串打进 dist（约 6.2MB）。`ensureLib()` 先内联 `<script>` 注入（不走网络），页面 CSP 拦时退回原 CDN 兜底——双端都不再依赖外网 CDN
- Font Awesome 改 `ensureFontAwesome()`：内嵌 css 优先（`style[data-ykt-fa]`），CSP 拦时退回 `<link>`；KaTeX 字体同理内嵌 css
- `@require` 的 jspdf/mathjax 保留（Tampermonkey 会缓存，无害）

0.5.3 / 0.5.4:

- 🔧 **解锁码换 AMD Qwen**（0.5.3）：`12345678` → `https://developer.amd.com.cn/radeon/api/v1`（`Qwen3.8-27B`，vision+reasoning），删原 `RMwin10.1` 码；`agnes.js` 兼容 AMD 端点的 `reasoning` 字段（除 `reasoning_content` 外）
- 🔧 **重复 X 清理**（0.5.4）：面板嵌进 shell tab 后各面板自带 `close-btn`（fa-times）与 shell 全局 ✕ 并存——删 ai/chat/presentation/settings/tutorial/problem-list 6 个面板的内置 X，统一走 shell 右上角 ✕
- 📦 **全 CDN 离线化**：Font Awesome css+woff2、html2canvas、KaTeX 全进 `assets/cdn/`（katex 前缀 + fontawesome/hertzen 映射），jsdelivr/cdnjs/hertzen 断网也能跑

0.5.2:

- 🔧 **公式渲染三级兜底**：`ensureMathJax` 只认 v3 `typesetPromise`，但有的页面自带 MathJax v2（`Hub.Typeset`，`/m/v2`）或干脆没有 MathJax（`student-lesson-report`），公式一直是生文本。
  - `getMathJax()` 依次查：window v3 → window v2 → `gm.uw` v3 → `gm.uw` v2
  - v2 走 `Hub.Queue(['Typeset', Hub, el])`，`\(...\)` 默认启用
  - 都没有时落 **KaTeX**（自含单文件，打进 `assets/cdn/katex/` 含 20 个 woff2 字体，经 `shouldInterceptRequest` 前缀映射本地回源），`typesetWithKaTeX` 逐文本节点渲染 `\(...\)`/`\[...\]`/`$...$`
- 📦 Android：CDN_ASSETS 加 katex 前缀映射（css 里的相对字体路径也能回源）

0.5.1:

- 🔧 **历史课件 ch2 布局修复**：新版大纲页 slide 图是 `img[alt="ppt"]`（`yangtse-pri-ups/common_uploads`，无 `/slide/` 段），旧收集器只认 `/slide/` URL → 「未收集到任何 slide 图片」。`collectSlideUrls` 加 `img[alt="ppt"]` 兜底（按 DOM 顺序），`expectedPageCount` 已兼容 `（77页）` 计数；跳过新版大纲页的缩略图点击（点击会弹 lightbox 丢图）
- 🔧 **双工具条修复**：`student-lesson-report` 等 `/v2/web/*` 页内嵌 `/m/v2/lesson/student` iframe，两层各挂一套工具条。`index.js` 加 `window.self !== window.top` 判断——iframe 里跳过 `ui._mountAll()` + `installToolbar()`（数据抓取仍跑），只留外层一套 UI
- 🧪 **UI 调试模式**：`?ykt-debug=1` / `localStorage ykt-debug-outline=1` / 控制台 `__yktDebugOutline()` 开启，所有 `ykt-*` 元素描红框（iframe 内橙框）+ `data-ykt-frame` 标记，用于排查嵌套挂载
- 📦 Android：CDN assets 不变；脚本 dist 0.5.0→0.5.1 同步进壳

0.5.0:

**脚本**

- 🧠 **AI 思考开关**：每个 AI profile 独立开关，默认开启 → 发送 `reasoning_effort:"high"`，关闭则不携带该字段（`ai.js`/`chat.js` 调用点读取覆盖）
- ⚙️ **设置界面重构**：合并模型字段（visionModel 收进高级折叠）、删预设下拉、API Key 眼睛切换+测试连接（GM_xhr 真测延迟）、多解锁码共存（`DEV_BLOBS`/`dev_<index>` profile）、自动分析挪组、提示音折叠、password 输入框样式统一

**Android 套壳**

- 📱 **移动端大改版**：Material3 卡片菜单、BottomSheet、chip tab、`/m/v2` 默认首页、缩放 50–100%、备份 v2（含 localStorage）、多账号 AccountStore
- 📸 **扫一扫**：`ScanActivity`（CameraX + ML Kit）扫码 → `POST /api/v3/app/scan` 分发，支持网页登录码（`app-web-qr`）自动确认；微信变体 `weixin.qq.com/q/` 提示不支持
- 📰 **动态 feed**：`POST /api/v3/activities/received/` 拉取最近动态，BottomSheet 列表，点击跳详情
- 🔧 **历史课件修复**：收集页强制桌面 UA（绕过前端按 UA 重定向回 `/m/v2`）；CDN 依赖（jsPDF/marked/DOMPurify/mermaid）打进 `assets/cdn/` 本地回源，jsdelivr 不可达也能跑；`gm-shim` 下载桥补 `dispatchEvent` 路径 + `downloadStart` 同步开流，PDF 不再损坏
- 🛠 **调试后门（仅 debug 包）**：`am broadcast NAV/EVAL/EVALC` 远程导航 / 主页面 eval / 收集页 eval

0.4.0:

- ✅ **题目面板（新 tab）**：课堂全部题目列表，已答/未答筛选、分题型简化作答
  （选项点选/文本输入，不再要求 JSON）、点击题目跳转课件页、过期题走
  `/problem/retry` **补交**（带确认对话框）、查看已答解析
- 🔧 **unlockproblem 多键兼容**：`problemId`/`prob`/`sid`/`pres`/`dt`/`limit`
  各变体统一归一化，重放队列同样规范化
- 🌊 **流式不中断**：切 tab、收起面板均不 abort 正在进行的流式回答
- 🧮 **MathJax `$...$` 修复**：提示词改教模型输出 `\(...\)`/`\[...\]` +
  `dollarToParen` 文本节点正则兜底（pandoc 边界规则，价格/`\$`/跨行不误伤）
- 📱 **Android 套壳 App**（`android/`）：WebView + `addDocumentStartJavaScript`
  注入 `gm-shim.js` + user.js（GM_* 映射 localStorage/fetch/下载桥），
  无需篡改猴。功能：多标签页（＋新建/长按关闭）、历史记录（300 条）、
  下载管理（FileProvider 打开）、桌面端 UA 切换、显示大小调节（50–200%）、
  **登录态备份/还原**（SAF 文件 / 剪贴板，含 HttpOnly Cookie + localStorage）
- 🛠 **壳 Debug 基建**：console→logcat、onReceivedError/HttpError、
  WebViewRenderProcessClient 崩溃自愈、DownloadListener 走系统下载器
- 📖 README 重写：三安装方式、6-tab 说明、Android 章节

0.3.2（未发版，已并入 0.4.0）: 流式不中断 / mermaid 渲染反馈 / 移动浮层钉底
0.3.0-0.3.1（未发版）: 课件面板重构、历史归档、移动端适配完善

0.2.3:

- 📱 引导条二次升级：检测到「点了前往桌面版仍被弹回」（Edge 安卓桌面模式
  不改 Sec-CH-UA-Mobile 头，服务端强制弹回）后，自动切换为推荐
  Firefox 安卓版 + 一键获取链接 + 复制桌面版网址
- 📖 README 手机端改为 Firefox 首选，明确 Edge 桌面模式的技术局限

0.2.2:

- 📱 修复手机端「请求桌面网站无效」：雨课堂服务端按 UA 锁移动入口
  （/m/v2 不随请求桌面网站改变），脚本新增 @match /m/* 使移动版也能注入，
  并内置黄色引导条 +「直接前往桌面版」按钮；移动版判定同时覆盖
  服务端重定向的 next=/m/v2 场景
- 📖 README 修正手机端说明：强调「先勾桌面网站再访问」的顺序，
  并给出已进入移动版时的三条自救路径

0.2.1:

- 📱 **手机端适配**：窄屏下工具栏转纵向 40×40 触控按钮、主面板 tab 移到顶部横排（内容区 220px → 372px）、课件面板单列堆叠、所有触控目标 ≥40px
- 📖 **安装教程重写**：分平台推荐浏览器、篡改猴安装（含国内网络不可达时的离线方案）、手机端 Edge 扩展页路径、雨课堂「请求桌面网站」关键步骤

0.2.0:

- 🤖 **AI 解答全面升级**：题干文本（课堂系统推送，比截图 OCR 可靠）+ 课件截图同时发给模型；调用链切换到流式 + 思考链（思考中自动展开、正文自动折叠）+ 可取消；支持任意 OpenAI 兼容端点
- 💬 **富媒体渲染**：AI 回复中的 mermaid 流程图、SVG、HTML 片段直接渲染成图（DOMPurify 清洗），MathJax 公式排版；markdown 解析器切换为 marked
- ➕ **AI 对话附件**：新增「＋」按钮，可选择多张 PPT 页面或上传本地图片一起发给 AI
- 🎯 **课件跟随当前页**：选中项自动跟随课堂翻页并滚动到可见，手动选择脱离、一键恢复
- 📚 **历史课件批量下载**：多选课堂一次性串行导出，混合进度条，单课失败不中断
- 🖥 **UI 自适应**：窄窗口不溢出、消除对话区底部空白、课件面板两列填满
- 🎨 全新项目图标；教程版本号随构建自动更新
- 内部：ESLint 10 + 三组回归测试 + `npm run check`；渲染层 marked + DOMPurify；日志分级；版本号单一来源

0.1.1:

- **修复构建失败**：`src/core/devmode-blob.js` 由生成器产出、不随源码分发，此前缺失会导致 `rollup` 报晦涩的解析错误；现在缺失时给出明确的修复指引
- **修复设置面板**：解锁开发者模式后表单立即刷新（此前需重开页面才显示新配置）；改动失焦即自动保存（此前不点「保存设置」直接关面板会丢失）
- **修复 PPT 对话**：取不到当前 PPT 页时明确提示「本条为纯文本提问」，不再静默截整页当 PPT 发给 AI；流式回答可真正中断（清空会话 / 关闭面板即取消请求）
- **修复 PDF 导出统计**：内容重复（去重）与图片下载失败分开计数，「去重 n 页」数字不再失真
- **修复历史导入进度**：改用跨标签页实时推送（此前 2 秒轮询会丢进度帧）；课堂列表支持自动翻页（此前最多只看得到 50 场）
- **降低干扰**：定时刷新改为仅在页面隐藏时触发、间隔 1 分钟 → 3 分钟，且面板打开/用户输入时不打断
- **日志分级**：默认只输出警告与错误，排查问题时执行 `localStorage.setItem('yksDebug','1')` 刷新即可全量输出
- **工程化**：版本号单一来源（只改 `package.json`）；接入 ESLint；新增去重、翻页、解锁三组回归测试（`npm run check` 一键跑通）
- 移除上游遗留的明文 API Key、约 190 行死代码；跨域白名单收窄（移除 `@connect *`）

1.30.1:

- 修复 jsPDF 横屏方向参数未正确传递导致 PDF 仍为竖屏的问题1.30.0:

- PDF 导出默认使用横屏 A4 尺寸，修复竖屏 PDF 上下留白过大的问题
- 修复 jsPDF addPage 的 orientation 参数不生效的 bug
- 新增 PDF 导出进度条，替代原有的 toast 进度提示

1.16.7: 

- 更新了工具栏ui，按钮交互ui，避免了窗口遮挡。

1.17.0: 

- 更新了基于Kimi的vision分析模式

- 暂时停用DeepSeek（保留相关文件）

1.17.1：

- 更新了是否自动调用API（由设置控制）

- 在AI panel中支持用户对问题进行编辑

1.17.2:

- 尝试把补交逻辑加回来

1.18.0:

- 弃用原有的text模式，使用vision模式覆盖所有的query

1.18.1:

- 优化图片获取，改为直接使用PPT获取图片

1.18.3：

- 优化ui和弹窗逻辑

1.18.4：

- 支持用户在PPT面板中对单页PPT进行提问

- 分离主界面检测和课件面板检测逻辑

1.18.5：

- 增加了无AI环境的随机答题模式

- 增加了修改AI答案

1.18.6：

- 修改prompts

1.18.7：

- 增加了设置持久化

- 增加了从雨课堂主页面自动进入课堂的逻辑

- 更新用户协议

1.19.0

- 针对141.0.7390.108-chrome及以上版本，增加了fetch拦截接口

- 针对 [#6](https://github.com/ZaytsevZY/yuketang-helper-auto/issues/6)，添加了提示音和自定义提示音

- 修复了自动作答功能显示`lessonid is not defined`的问题

- 重新更改了日志输出格式

- 重构了部分代码

1.19.1

- 针对 [#9](https://github.com/ZaytsevZY/yuketang-helper-auto/issues/9)，增加了markdown渲染器

- 维护了edge兼容性

1.19.2

- 再次尝试把补交逻辑加回来

- 增加了从子frame获取静态PPT的方法

- 修改了日志格式，现在控制台日志更规范了

- 修复了一些已知问题

1.20.0

- 增加了OpenAI协议模型的通用接口

- 优化了UI

- 修复了一些已知问题

1.20.1

- 优化了VLM工作流，将一步改为两步执行

1.20.2

- 增加了输入多张图片的功能

- 增加自动刷新功能

- 修复了一些情况下AI不能正确识别题目类型的问题

- 修复了AI主观题答案解析错误的问题

1.20.3

- 详情图/PDF下载改为高清图片

1.21.0

- 增加了OCR相关的设置

- 修复了一些前端已知问题

1.21.1

- 增加了翻译课件功能
