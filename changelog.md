# 更新日志

0.6.10:

- 🧰 **兼容 DeepSeek DSML 工具调用**：部分自定义端点不把 DSML 转成 `tool_calls`，客户端现在会从正文/思考链解析 `submit_answer` 调用，并去掉 DSML 标记
- ⚠️ 降级提示更准确：端点不支持 `tools` 但能从文本解析到工具调用时，不再误报「不支持工具调用」
- ✅ 新增 `scripts/test-dsml.mjs` 回归测试

0.6.9:

- 🔗 **自定义渠道 URL 支持火山方舟**：`/api/v3` 与 `/api/plan/v3` 自动补 `/chat/completions`，不再错误拼成 `/v1/chat/completions`
- 💡 设置页 URL 提示补充方舟示例（填到 `/v1` 或 `/api/v3` 即可）

0.6.8:

- 📱 **设置界面窄屏适配**：标签/输入框/按钮在手机端纵向堆叠，按钮不再超出屏幕
- 📋 **自定义渠道模型列表**：点「获取模型列表」后直接展开可选列表，点选即填入模型 ID（不再依赖 datalist 下三角）
- 🔒 云端配置仍禁止指定模型；列表仅自定义渠道可用

0.6.7:

- 📱 **Android 自定义供应商修复**：壳内 `GM_xmlhttpRequest` 增加原生 HTTP 代理（支持 POST / 自定义头 / 二进制），Ark 等预检不允许 `Authorization` 的接口在手机上也能正常调用
- 🖼 云端 ark 模型换成 `glm-5.3-flash`（支持图片），图片请求只路由到 vision 供应商
- 🔁 0.6.6 的云端模型限制、更新直链、官网测试版入口一并进入稳定版

0.6.6:

- 📄 **作业/试卷工具（老版界面）**：解析 `/v/quiz/quiz_info/` 的 `quizData`，逐题拼图导出 JPG / ZIP / PDF / 长图
- 🤖 **单题 AI 讲解**：作业页工具栏新增「作业」按钮，逐题把题图发给视觉模型，直接在面板里看解答
- 📥 手机端导出走 `YktBridge` 分块写入「下载/YuketangStudio」，桌面端走浏览器下载

0.6.6:

- ☁️ **云端模型改为完全自动分配**：云端配置不再允许获取/指定模型，即使填了 model 也按渠道权重分配
- 🧩 **模型列表只用于自定义渠道**：填写自定义 URL / Key 后可拉取该渠道的 /models，选择或手填
- ⬇️ **更新直链**：检查到新版本后「下载新版本」/ 通知直接打开当前渠道的脚本下载链接，不再跳到只有稳定版的官网
- 🌐 官网增加测试版脚本 / APK 下载入口

0.6.5:

- 🧠 **AI 配置支持「获取云端模型列表」**：一键拉取可用模型，模型 ID 可直接选择或手填
- 🎯 **按模型精确路由**：选了 step-5-preview 就只发 step，选了 deepseek-v4-flash 就只发 ark
- 🖼 修复截图裸 base64 导致的上游 400 Unsupported image_url

0.6.4:

- 🖼 修复截图裸 base64 导致的上游 400 Unsupported image_url
- 🔔 自动检查更新改为 5 档策略（开启 / 跳过将来 3 个版本 / 7 天 / 30 天 / 彻底关闭）

0.6.3:

- 🖥️ **桌面端固定 1440px**：切换桌面端后按 1440px 宽度渲染，双指缩放替代页面缩放（页面缩放已移除）
- 📡 **稳定 / 测试双更新渠道**：默认稳定渠道，关于与更新页可切换；测试渠道同时接受稳定渠道的更新
- 👋 **首次使用引导**：展示工具栏位置、历史课件下载、PPT 问答 3 个入口，可跳过且不再出现
- ℹ️ **关于与更新页**：版本、检查更新、打开/复制官网、打开 GitHub、复制群号、开源协议、Star 引导
- 📥 **下载管理两区**：正在下载（进度/取消/重试）+ 已下载（APK 点击安装），修复部分机型安装闪退
- ⏰ **30 天暂停自动检查**：检查更新弹窗内可一键暂停，期间不再发更新通知
- 💬 **等待提示**：3/10/20 秒排队提示，首字超时缩至 30 秒，支持取消与重试
- 🤖 **默认模板改 DeepSeek**：新增配置预填 `https://api.deepseek.com` + `deepseek-flash`；云端配置改名「云端模型」
- 🚀 **一键发版脚本** `scripts/release.sh`：支持只编译某一端、跳过 tag/Release/国内上传、渠道与版本参数

0.6.2:

- 📊 **匿名统计默认开启**：新装默认开启；升级用户一次性打开（设置里仍可手动关闭，关掉后不会再被强制打开）
- 📈 **启动即上报**：脚本每次启动（页面加载）上报一次，同一天 60 秒内合并，统计更及时
- 📱 **答题提醒弹窗避让工具栏**：手机端弹窗左侧留出 64px，不再被左下角三按钮工具栏遮挡

0.6.1:

- 🔔 **更新通知点击直达**：点通知不再只是打开 App，而是直接弹「检查更新」；已是最新则显示「已是最新版本」
- 📥 **下载管理升级**：点「下载并安装」立即打开「下载管理」，顶部实时显示更新包进度/百分比/已下载大小，完成后可直接点「安装」
- 📁 **显示安装包保存路径**：页面展示完整路径（`Download/YuketangStudio/…`）并可一键复制；安装失败可去文件管理器手动安装
- 📄 **已下载文件列表**：下载管理里列出全部已下载文件，APK 可直接点开安装
- ♻️ **下载失败可重试**：显示失败原因（空间不足/网络错误等），重试前自动清掉残留文件，避免「文件已存在」
- 🔗 **关于页新增链接**：GitHub 仓库、官方网站、讨论反馈 / 内测群（QQ 群 901466023，可一键复制）
- 🔑 **解锁码提示**：设置页解锁入口标注「加讨论群 901466023 获取解锁码」

0.6.0:

- 🛠 **AI 解答支持「提交答案」工具调用**：模型确定答案后调用 `submit_answer`，AI 气泡内出现「📤 提交答案 A」卡片；点「提交」→ 二次确认 → 提交成功。选择题/填空题/主观题参数自动归一化
- ⏰ **超时补交**：题目已过截止时间时，点提交会再确认一次「是否走补交通道」，确认后走 `/problem/retry`
- 🤖 **自动作答改走工具链路**：开启自动作答后，模型被要求（`tool_choice=required`）必须调用工具，调用后直接提交、不再弹确认；旧的「截图 → 视觉模型 → 文本解析」管线移除（无 API Key 的本地兜底保留）
- 🔁 **失败重试**：模型没调用工具或输出中断时，追加「继续，记得调用工具」重试，总共最多 2 次
- 🪂 **不支持工具的模型自动降级**：端点返回 400/422 时去掉 tools 重发，正文解析成同样的提交卡片
- ⚙️ **兜底开关扩展**：设置里的「无 API Key 时提交兜底答案」同时控制「模型两次都没调工具」时是否解析正文直接提交；未勾选则放弃并提示
- 🧪 **测试模式**：URL 加 `?ykt_test=1` 或 `localStorage['ykt:test-mode']='1'`，控制台可用 `__yktTest.injectProblem()` / `mockTool()` / `mockText()` / `mockNoTools()` / `mockSubmit()` / `ask()` / `askAuto()`，无需真实课堂即可验证全链路
- 🧱 提交链路统一到 `tsm/submit-flow`（手动/工具共用）；自动作答使用独立会话 + 串行队列，避免污染聊天记录

0.5.15:

- 🛑 **批量下载历史课件可以真正取消了**：原来点 ✕ 只是置一个标记，**当前这一课仍会跑完**（收集页要 1–2 分钟），看起来就是「点叉没用」。现在 ✕ → **二次确认**（「取消整批下载？」/ 继续下载 · 确认取消）→ 立即中止当前课堂、关闭收集页、整批停止；已下载完成的文件保留
- 🔔 **下载完成有系统通知**：原来只有一次 Toast，切到别的 App 或锁屏就完全无感。现在保存完成后发系统通知「下载完成 · 文件名」，点通知直接打开文件；同名文件覆盖通知，不会堆满通知栏
- 🔔 **批量任务结束也通知**：完成 / 取消 / 失败都会发一条，包含「完成 N 个，失败 M 个」摘要
- 📱 进度条与 ✕ 适配手机：宽度自适应（左右各留 12px）、✕ 放大到 34×34 触控区、标题过长省略

0.5.14:

- 🐛 **手机端输入框被挤出屏幕**：shell 内容区在 442px 高的小屏上只有 195px，而聊天/AI 面板的 log 区 `min-height` 加上上下文行、输入区共 300+px——输入框和「发送」按钮跑到面板外，**发消息必须先滚整个面板**。压缩 shell 头部/标签条/面板头，log 改 `min-height:0`，输入区固定 36px，现在 chat/AI 溢出为 0
- 🐛 **「附带当前页」勾选框看不见**：雨课堂页面全局 CSS 把 `input[type=checkbox]` 设成 `appearance:none` + 0 尺寸，聊天和 AI 面板的裸 checkbox 直接不可见（桌面端同样受影响）。显式还原为原生 checkbox 14×14
- 🐛 **关于页内容看不全**：shell 内面板统一 `overflow:hidden`，关于页 854px 内容在 195px 容器里被裁掉且**无法滚动**；改为 `overflow:auto`（设置/题目同理）
- 🐛 **课件面板内容溢出**：手机端 `panel-body` 被设为 `height:auto`，内容 580px 直接超出面板；改为 `height:100% + overflow:auto` 单列滚动
- 🐛 **悬浮工具栏压住面板**：窄屏下面板打开时，左下角工具栏（46×90px）盖住输入区；面板打开时隐藏，关闭后恢复
- 🐛 **每次 CDN 请求刷异常日志**：`assets/cdn/` 删除后拦截器成死代码，每个 jsdelivr/cdnjs 请求都抛 `FileNotFoundException`；整段移除

0.5.13:

- 🐛 **账号存储彻底修复**：`fingerprint()` 只扫 localStorage 的 `authorization`/`token`，但雨课堂把登录态放在 **Cookie**（localStorage 里只有 `user_profile`）——所以永远判定「未登录」，保存/识别账号全失效。改用 `user_profile.user_id` 作指纹、`user_profile.name` 作显示名
- 🐛 **账号状态不再丢**：`currentAccountId` 之前只是内存变量，重启后菜单显示「未登录」且无法把 session 存回正确账号；改为持久化
- 🐛 **不再反复弹保存提示**：点过「暂不」的账号记住指纹，同一账号不再骚扰
- 🐛 **切账号不再串号**：切换前先清空所有环境的 Cookie，避免两个账号的凭证混在一起
- ✨ 账号面板新增「更新当前账号快照」，登录态变化后可手动刷新
- 🐛 **面板只能下滑不能上滑**：`BottomSheetDialog` 默认手势把竖向滑动当成「拖拽收起」，还会把事件穿透到下层（实测滑一下就打开了扫一扫）。统一面板基座改为 `isDraggable=false` + ScrollView 接管，菜单/动态/账号面板均可双向滚动且不会误关
- 🎨 **Header 重做**：系统自带图标（`ic_media_rew` 等 Android 2.x 风格）换成 Material 矢量图标（← → ⟳ / 账号 / 动态 / ⋮），按钮 40dp→36dp、高度与多标签条齐平；环境切换移入菜单，「移动端」文字改为底部浮动状态提示（2.2s 自动消失）
- 🧹 移除已废弃的 `assets/cdn/` 本地回源拦截器（vendor 早已内联进脚本，这段每次 CDN 请求都抛 FileNotFoundException 刷日志）

0.5.12:

- 💬 **mermaid 提示词补强**：节点文本含空格/括号/斜杠/中文标点时要求 LLM 用双引号包裹（`A["真实函数 f(x)"]`），否则整张图渲染失败
- ⏱️ **超时语义改为「最后字符后 15s」**：不再用固定总时长——首字最多等 90s，之后只要还有数据就一直等；吐出最后一个字符后 15s 无新数据才判超时。长回答/长思考不会再被总时长误杀
- 🔍 **「输出到一半突然停」现在会报错**：此前流在没收到 `[DONE]`/`finish_reason` 时结束被当成正常完成，完全静默。现在检测截断并在气泡下方提示「⚠️ 输出中断：连接被提前关闭（已收到的内容保留）」；服务端 `copyFlush` 也会记录上游中断日志
- 🎯 **默认配置模板改为 DeepSeek**：新用户默认 `https://api.deepseek.com` + `deepseek-flash`（原 Kimi/moonshot）
- 🌐 官网电脑端安装步骤新增：首次使用需点「始终允许」访问外链，否则 AI 功能不可用

0.5.11:

- 🔧 **脚本自动更新失效修复**：`userscript.meta.js` 缺 `@updateURL`/`@downloadURL`——Tampermonkey 根本不知道去哪检查更新（之前只有脚本内 `checkForUpdate` 弹通知，不会安装）。现指向 `api.raymor.top/yuketangstudio/dl/userscript`（稳定 302 → 最新文件，国内可达）
- ✨ **教程页 → 关于页**：tab 改名「关于」，只保留项目信息（介绍/仓库/致谢/反馈/注意事项），并新增「版本与更新」块——显示当前版本、**检查更新**按钮、发现新版时出现「前往下载」。状态分色（已是最新绿/有新版本黄/失败红）
- 📱 **手机端检查更新移到外壳**：menu 新增「检查更新」（显示当前 vX.Y.Z）。原生拉 `/latest` 比对版本，有新版弹窗提供「下载并安装」（DownloadManager 下载完自动询问安装）或「浏览器打开」

0.5.10:

- 🐛 **「匿名统计使用情况」开关不可见**：该开关用了裸 `<input type="checkbox">`，而面板 CSS 把原生 checkbox 设为 `opacity:0; height:0; width:0`，靠 `.checkbox-label + .checkmark` 画可见方框——所以真实勾选框完全看不到。改为与面板其他开关一致的结构
- 🐛 **「重置为默认」漏项**：`Object.assign(config, DEFAULT_CONFIG)` 只会覆盖 `DEFAULT_CONFIG` 里存在的键，而它缺了 `autoJoinEnabled`/`autoAnswerOnAutoJoin`/`aiAutoAnalyze`/`aiSlidePickPriority`/`notifyPopupDuration`/`notifyVolume`/`customNotifyAudioSrc`/`customNotifyAudioName`——重置后这些还留着旧值。补全默认值 + 重置时先删残留键再整体覆盖；遥测开关（独立 storage key）也一并复位

0.5.9:

- 📊 **匿名使用统计**：设置最底部新增「匿名统计使用情况」开关（默认关）。开启后上报安装ID/平台/版本/是否用码/当日调用次数/首字时间/总时长聚合。**开启遥测才能使用解锁码**（解锁时校验 + 云端调用时二次校验）
- ⚡ **流式卡顿修复**：svc `io.Copy` 改逐次 Write+Flush（之前 SSE chunk 攒在服务端缓冲凑批发，视觉上「一卡一卡」）；nginx `proxy_buffering off` + `X-Accel-Buffering:no` 双保险
- ⚡ **「请求超时」修复**：svc `Client.Timeout:120s` 是总超时——思考型流超 120s 被服务端掐断；改 `ResponseHeaderTimeout` 只管首字节。客户端 `fetchStream` 同步改 60s 空闲超时（每读 chunk 重置），流式总预算放宽到 300s
- ⚡ **打字机平滑**：客户端新增 StreamSmoother——上游攒批发来的 delta 进队列按 24ms 心跳吐出，backlog 大自动加速追平，视觉连续流畅
- 🖥️ **遥测后台**：`https://api.raymor.top/yuketangstudio/admin`（Basic Auth）按日期×设备展示 IP/属地/平台/次数/首字ms/总时长ms；属地 CF-IPCountry + ip-api.com 批查回填
- 🎚️ **思考强度可调**：AI 设置新增「思考强度」下拉——低/中/高/超高(max)，默认**中**（此前硬编码 high）。强度越高推理越充分，但首字更慢、流式间隔更大

0.5.8:

- 🔧 **流式内容消失修复**：`StreamRenderer.attach()` 在 slot 重挂（每次 repaint 新建 slot）时把 `sealed`/`live` **重建为空 div**——之前所有已封板内容被清空，用户看到「前面段落消失、只剩最后一段」。改成 `isConnected=false` 时把**现有节点移动**到新 slot 而不是新建。ego 实测：封板文字量单调递增 `115→232→232→389`，4 点回答 + mermaid 完整保留
- 🔧 **壳内云端解锁修复**：`gm-shim.js` 的 `GM_xmlhttpRequest` 用 `credentials:'include'`——跨域 `api.raymor.top` 时 CORS 规范禁止 `*` + credentials 导致预检拦截；改 `same-origin`（雨课堂同源照带 cookie，跨域不带就能用 `*`）。同时修 `fetchBinary` 兜底的 `responseText` 恒为空（验码解析空 JSON 当失败）
- 🔧 **APK 瘦身 ~13MB**：删 `assets/cdn/`（user.js 已内嵌全部 vendor，本地回源是冗余兜底）、`ndk.abiFilters` 裁 `x86`/`x86_64`（barhopper_v3.so 单 ABI 省 ~6MB）
- 真机实测（T508N）：`12341234` → `云端·agnes` 解锁成功；17 处 KaTeX + mermaid SVG 流中渲染，无丢段
- ego 实测：`12341234` 解锁 → 「分 4 点 + 公式 + mermaid」→ 7 处 KaTeX + mermaid SVG 全在，无丢段

0.5.7:

- 🚀 **流式增量渲染**：新增 `StreamRenderer`（封板区 + 活跃区），`findSafeBoundary` 在「不在围栏/公式内 + `\n\n`/围栏闭合/display math 闭合」处切板，已封板内容就地 `renderRich`——mermaid 图、公式、embed 在流式输出**过程中**就渲染，不再堆到流末
- 🚀 **公式即时渲染**：`mdToHtml` 的 `\uE000M` 占位符还原升级为 KaTeX 同步 `renderToString`（已加载则直接出 `<span class="katex">`），未加载/失败仍还原裸文本留给 MathJax 兜底；`warmupRichAssets` 预热 KaTeX 让面板打开即就绪
- 🔧 **mermaid/embed `data-raw` 改 base64**：源码里的 `-->` 会被 HTML parser 当注释结束符吃掉整个属性（DOMPurify `ADD_ATTR` 也救不回来），改用 `data-raw-b64` 存储
- 🔧 **`@connect api.raymor.top` + `app.raymor.top`**：`@connect *` 在 Tampermonkey 5.5 对云端验码域名不生效（pending 不报错），显式补白名单
- 🔧 **`env.js` vendor 改动态 `import()`**：node `npm test` 裸跑不认识 `.txt` 扩展（rollup string plugin 只在构建时处理），改成字面量动态 import 后 `npm test` 恢复通过（12/12）
- 清理：删 `scripts/gen-devmode.js`/`test-devmode.mjs`（云端验码方案后废弃）、`.gitignore` 对应条目、`package.json` `gen:devmode` 脚本

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
