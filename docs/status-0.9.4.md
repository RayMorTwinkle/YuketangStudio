# YuketangStudio 0.9.4 审查与交接

> 日期：2026-10-29  
> 范围：0.9.3 beta、0.9.4 开发分支、补充 8 条修复。  
> 原则：只记录已验证事实；不把“可能”“也许”写成警告，不为不确定场景加防御性假成功。

---

## 0. 当前状态

| 项 | 状态 |
|---|---|
| Stable | `0.6.10`，未动 |
| Beta | `0.9.3`，已发布 |
| 0.9.4 | **beta 已发布**（国内渠道） |
| 0.9.4 分支 | `feat/0.9.4-courseware` |
| 0.9.4 提交 | `ee9a6b7` + release `cee0a73` |
| 0.9.4 版本 | `0.9.4` / Android `versionCode=50` |
| 0.9.4 本地 APK | `YuketangStudio-main/android/app/build/outputs/apk/release/app-release.apk` |
| 后续 | 0.9.5 继续做真实环境验证与体验修整 |

0.9.4 beta 链接：

- 信息：https://api.raymor.top/yuketangstudio/latest?channel=beta
- 用户脚本：https://dl.raymor.top/f/KN88DY
- APK：https://dl.raymor.top/f/6Jkey4
- GitHub Release：https://github.com/RayMorTwinkle/YuketangStudio/releases/tag/v0.9.4

0.9.3 beta 链接：

- 信息：https://api.raymor.top/yuketangstudio/latest?channel=beta
- 用户脚本：https://dl.raymor.top/f/KN88DY
- APK：https://dl.raymor.top/f/fytDkM
- Release：https://github.com/RayMorTwinkle/YuketangStudio/releases/tag/v0.9.3

---

## 1. 记忆（后续接手必须先读）

### 产品底线

- 作业工具只缓存/暂存单题，**不提交整张试卷**。
- 考试绝不自动提交。
- 考试 AI 自动填入只写答案，用户自己交卷。
- 不伪造完成、不伪造分数；未知就显示未知。
- 跨域 iframe 不假装能填；拿不到就说拿不到。

### 版本与发布

- 发版走 `ykt-helper/scripts/release.sh`。
- stable 与 beta 分开；本次只发 beta。
- `stable` 仍是 `0.6.10`，不要顺手改。
- 发版前工作区必须干净；`dist` 和 Android asset 由 release 脚本生成/提交。

### 关键文件

| 功能 | 文件 |
|---|---|
| 课程上下文 | `ykt-helper/src/core/course-context.js` |
| 刷课数据汇聚 | `ykt-helper/src/quiz/course-data.js` |
| 刷课 UI | `ykt-helper/src/ui/panels/brush.js` / `brush.html` |
| 作业/考试 | `ykt-helper/src/ui/panels/assignments-panel.js` |
| 课件单列 | `ykt-helper/src/ui/panels/presentation.js` / `presentation.html` |
| 共享题目组件 | `ykt-helper/src/ui/problem-card.js` |
| AI 图源 | `ykt-helper/src/ui/slide-source.js` / `slide-image.js` |
| 考试填入 | `ykt-helper/src/quiz/exam-fill.js` |
| 考试免责/上传 | `ykt-helper/src/core/exam-consent.js` |
| 手机壳 | `android/app/src/main/java/com/yuketangstudio/shell/` |
| 云服务同意接口 | `ServerX/svc/main.go` |

---

## 2. 目标与完成矩阵

### 原始 11 条

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| 1 | 进入课程页自动切换作业/刷课课程 | ✅ | 统一 `course-context`；桌面/移动都按 URL 解析 |
| 2 | 刷课任意页面显示已完成和分数 | ✅ | 改为 API 优先；补 `classrooms/{cid}` 取 `free_sku_id`；真实课程验证 |
| 3 | 课件页单列 PPT/内嵌题目/导航轨/多 PPT | 🟡 | 代码完成，合成课件 E2E 通过；真实课堂未完整验证 |
| 4 | 题目页答题组件/PPT 页码/在课件页查看/补交 | 🟡 | 代码完成；控件与提交流程已做，真实提交未全测 |
| 5 | 手机端习题提醒避开工具栏且可收起 | ✅ | 已完成；CDP 390×844 实测不重叠，收起/展开 E2E 通过 |
| 5a | AI 解答/PPT 对话图源选择并持久化 | 🟡 | 代码完成，切换与持久化 E2E 通过；真实 AI 图片未测 |
| 6 | 设置页现代组件 | ✅ | 已完成；5 个分区、10 个开关、滑杆/导航/保存状态，移动端实测 |
| 7 | 自动作答/自动进入课堂稳定性测试 | 🟡 | 自动作答 E2E 21 条通过；自动进入课堂未真实课堂验证 |
| 8 | 新/老作业考试页显示工具栏并自动切作业栏 | 🟡 | 老版真实页面通过；新版/exam 域未真实页面验证 |
| 9 | 新版批量 AI 解答 | 🟡 | 代码已同时支持 type 4/19/20；未真调真实模型批量 |
| 10 | 新版 AI 带图；新版优先；AI/批量兼容两版 | 🟡 | 代码完成；真实新版题目图片链路未真机验证 |
| 11 | 作业页改名「作业/考试」 | ✅ | 面板标题和 tab 均已改 |

### 补充 8 条

| # | 问题 | 状态 | 结论 |
|---|---|---|---|
| 1 | `/ai-workspace`、`changjiang-exam` 不显示工具栏 | 🟡 | 根因是 `@match` 缺路径，已补；`ai-workspace` 注入实测工具条存在，exam 域未完成真实页面验证 |
| 2 | 手机端作业/考试不跟随课程 | ✅ | 根因是面板已加载后未按课程上下文重载；已修，移动课程页实测选中正确课程 |
| 3 | 刷课开关看不出状态 | ✅ | 已改 label 高亮 + accent checkbox，实测 active/checked 同步 |
| 4 | 手机壳更新后无法安装 | 🟡 | 已加 `REQUEST_INSTALL_PACKAGES`、未知来源设置跳转、授权返回自动续装；APK 构建与权限检查通过，未真机点完整安装流程 |
| 5 | 脚本与手机壳互通 | 🟡 | 已加 `YktBridge.openAboutAndUpdate()`；关于页隐藏渠道并改按钮；浏览器模拟通过，未真机验证 |
| 6 | 匿名统计默认开关 | ✅ | 新环境实测 `telemetry.enabled=true`，仅用户主动关闭才为 false |
| 7 | 关于页补充模型/补交说明 | ✅ | 已加入文本 |
| 8 | 班级课件/历史课件统一入口 | ✅ | 统一为「下载历史课件」，弹窗按「课堂回放 / 班级上传」区分；选择器和页头有来源标签 |

---

## 3. 已完成内容

### 0.9.3

- 统一课程上下文解析：桌面日志、报告、student-v3、班级课件、新版作业、老版试卷、移动版。
- 课程列表没有 `skuId` 的问题：用 `/v2/api/web/classrooms/{classId}?role=5` 的 `free_sku_id` 补齐。
- 刷课改为 API 优先：成绩 `leaf_level_infos` + 学习日志 + 班级课件进度 + 作业/考试状态。
- 已完成内容可显示、可复刷；每项显示加权成绩和原始成绩。
- 作业/考试页自动打开主面板、切到「作业/考试」、选中当前项。
- 新版作业 AI 自动截图；批量 AI 同时支持老版/新版/可回顾考试。
- 进行中考试：免责确认后自动填入，不提交；同意状态上传服务器（只传匿名元数据）。
- 0.9.3 beta 已发布。

### 0.9.4

- 课件页改为单列 PPT，移除右侧预览窗。
- 每页「下载本页 / 问 AI」。
- 右侧导航轨标记老师当前页、课件选中页、题目页。
- 多 PPT 下拉切换；全局下载只有一个，多份时弹选择。
- 题目平铺在对应 PPT 下方。
- 共享题目组件：
  - 单选/投票：单选控件
  - 多选：复选框
  - 填空：按空位输入
  - 主观：文本编辑
  - 提交/补交分离，点选项不提交
- 题目卡显示 PPT 页码；题目列表「在课件页查看」跳转并高亮。
- AI 解答/PPT 对话支持「老师当前页 / 课件选中页」，切换后持久化。
- 课件来源统一入口与标签。
- 手机端习题提醒避开工具栏，可收起为小卡片，收起时暂停自动消失。
- 设置页按 AI/自动作答/提醒/提示词/隐私分组，使用开关、滑杆、分类导航和保存状态。
- 关于页手机壳互通。
- Android 安装未知来源权限与续装逻辑。

---

## 4. 没做完 / 待验证

### 未开始

- 0.9.5 后续修整（真实课堂/考试回归、零散体验）。

### 代码完成但未真实环境验证

- 真实课堂中的单列课件、老师翻页联动、题目内嵌与提交。
- 新版作业真实题目图片链路、真实批量 AI 调用。
- `changjiang-exam.yuketang.cn/exam` 真实考试页工具栏与考试填入。
- 手机壳真实升级安装（允许未知应用后的自动续装）。
- 手机壳真实关于页原生回调。
- 自动进入课堂连续稳定性（自动作答链路已有 E2E）。

---

## 5. 工程约束（不做防御性编程）

- 不为“理论上可能”加空警告；只在真实失败路径提示。
- 不猜答案、不猜完成、不猜题目映射。
- 没有 `slide.problem` 的班级/历史 PPT 不强行配题。
- 跨域 iframe 不能填就返回失败，不伪造成功。
- 考试只写答案，不提交；这是产品硬边界，不是可选防御。
- 真实接口失败时显示可操作的原因，不静默降级成假数据。

---

## 6. 端到端验证

### 6.1 本地基础检查

```bash
cd ykt-helper
npm run lint
npm test
npm run build
```

最近结果：

- 单元测试：`127 通过，0 失败`
- Answer Engine E2E：`22 通过，0 失败`
- Android release 构建：成功

### 6.2 ego 浏览器 E2E

`npm run e2e:answer` 在某些机器上 cwd 会变成 `/`，脚本找不到 `dist`。可用临时绝对路径版本：

```bash
cd ykt-helper
python3 - <<'PY'
from pathlib import Path
s = Path('scripts/e2e-answer.mjs').read_text().replace(
  "const ROOT = process.env.YKS_ROOT || process.env.PWD || process.cwd();",
  "const ROOT = '/绝对路径/ykt-helper';"
)
Path('/tmp/yks-e2e-answer.mjs').write_text(s)
PY
ego-browser nodejs < /tmp/yks-e2e-answer.mjs
```

覆盖：工具调用、自动作答、非法答案不提交、作业暂存、题目列表 AI、regex 模式。

### 6.3 真实账号验证（本次做过）

课程：

```text
https://changjiang.yuketang.cn/v2/web/studentLog/26739809
```

刷课扫描结果：

```text
我的总评 65
班级平均 56.5
班级最高 77
班级最低 9
试卷：占比 50% · 已完成 · 成绩 47/50 · 原始 94/100
课堂：占比 30% · 已完成 · 成绩 18/30
```

手机首页刷课：

```text
https://changjiang.yuketang.cn/m/v2
自动选中：晚上班
总评/班级统计/已完成项均能显示
```

老版试卷：

```text
https://changjiang.yuketang.cn/v/quiz/quiz_info/1747018/?pageIndex=1
自动打开「作业/考试」
50 题列表展开
```

移动课程页：

```text
https://changjiang.yuketang.cn/m/v2/course/3697615/logs/3697615/26739809
作业面板自动选中：物理实验绪论2026秋-1
列表：1 项
```

### 6.4 合成/E2E 验证

- 课件单列：注入两份测试课件，选择器、导航轨、题目卡正常。
- 题目控件：单选 2 个 radio、提交按钮存在；提交后显示已作答。
- 「在课件页查看」：切到课件 tab，滚动到对应页。
- AI 图源：切到「课件选中页」后配置持久化为 `selected`。
- 关于页手机壳模拟：按钮变为「打开手机端关于与更新」，渠道隐藏，点击回调成功。
- 统一入口：弹窗出现「课堂回放 / 班级上传」。
- 刷课开关：勾选后 label active 与 checkbox 状态同步。
- 考试 DOM：选择题/填空题共 2 题成功填入。

### 6.5 Android

```bash
cd android
./gradlew assembleRelease
```

验证：

```text
versionCode=50
versionName=0.9.4
REQUEST_INSTALL_PACKAGES 已声明
```

---

## 7. 雨课堂适配经验

### 7.1 URL 与课程上下文

| 页面 | 形态 |
|---|---|
| 桌面课程日志 | `/v2/web/studentLog/{classId}` |
| 报告 | `/v2/web/student-lesson-report/{classId}` |
| 课堂 | `/v2/web/student-v3/{classId}/...` |
| 班级课件 | `/v2/web/studentCards/{classId}/...` |
| 移动课程日志 | `/m/v2/course/{courseId}/logs/{courseId}/{classId}` |
| 新版作业 | `/ai-workspace/lms-graph/{classId}/exercise/{id}` |
| 新版考试 | `/ai-workspace/lms-graph/{classId}/quiz/{id}` |
| 老版试卷 | `/v/quiz/quiz_info/{quizId}/` |

- 不要在各面板重复写正则；统一走 `course-context.js`。
- 作业面板已加载过也要监听课程上下文变化，否则手机端从首页进课程不会换课。
- 首页的手动选课不能覆盖课程页 URL 里的课程。

### 7.2 数据接口

- `GET /v2/api/web/courses/list?identity=2`：课程列表可能**没有** `free_sku_id`。
- `GET /v2/api/web/classrooms/{cid}?role=5`：这里才有成绩接口需要的 `free_sku_id`。
- `GET /c27/online_courseware/schedule/score_detail/single/{skuId}/0/?classroom_id=&sku_id=`：成绩明细。
- `GET /c27/online_courseware/schedule/score_statistic/{cid}/{skuId}/?...`：班级统计。
- `leaf_level_infos` 中 `leaf_type_id` / `lesson_id` 比成绩行 `id` 更适合与作业、课件合并。
- 学习日志 `type=4` 老作业带 `score/total_score`；`type=14` 是课堂记录；`type=2` 是班级上传课件。
- 班级课件：`cards/detlist` 取页面，`cards/view_depth` 取逐页进度。

### 7.3 课件数据

- `repo.presentations` 是课件容器；`repo.slides` 是页面索引。
- 只有正在上的课堂 slide 有 `problem`；班级上传/历史导入的 `problem` 为 `null`。
- 不要按页码猜题；没有关联就不内嵌题目。
- 老师翻页来自 Vue store：`getCurrentMainPageSlideId` / `watchMainPageChange`。
- 课件面板选中页和老师当前页要分开存：
  - `repo.teacherSlideId`
  - `repo.selectedSlideId`
- 课件单列必须按 DOM 实际位置算导航标记，不能用 `offsetTop` 猜。

### 7.4 新旧作业/考试

- 老版作业有 `quizData`；新版是接口数据。
- 新版作业详情：`get_exercise_list`。
- 考试回顾有四重门禁：交卷、出分、允许查看、公布时间。
- 进行中考试不在列表接口里给题目；只能当前打开页面抓 DOM。
- 考试自动填入的 DOM 适配器必须保守：
  - 找题目根节点
  - 找 radio/checkbox/text/textarea
  - 原生 setter + input/change
  - 绝不点提交按钮
- 跨域 iframe 无法读写；同源 iframe 可递归收集。

### 7.5 手机端与 WebView

- 手机版是另一套前端：`/m/v2/*`，不要假设桌面 store 结构。
- 手机端课程页进入后，作业面板需要按 classId 重载。
- WebView 更新 APK 需要：
  - `REQUEST_INSTALL_PACKAGES`
  - `canRequestPackageInstalls()`
  - `ACTION_MANAGE_UNKNOWN_APP_SOURCES`
  - 授权返回后继续安装
- 脚本在 WebView 里要检测 `window.YktBridge`，避免展示错误的 Web 更新入口。

### 7.6 LLM 与图片

- 新版作业 AI 不能只看文本：题干/选项可能含图或加密字体。
- 加密字体：先注入 `@font-face`，再 html2canvas 截图。
- 普通新版题也建议截图；文本只作为辅助。
- 批量解析要限速、逐题失败不中断、输出 Markdown，不提交。
- 考试填入的 AI 输出只取最终答案；选择题解析字母，填空题纯文本。

### 7.7 测试经验

- 真实账号优先验证 API 数据，不要只靠 mock。
- 测试模式 `?ykt_test=1` 可验证答题链路，不真实提交。
- ego 的 nodejs cwd 可能是 `/`，E2E 脚本找不到 dist 时改绝对 `ROOT`。
- Android 真机测试走 `scripts/e2e-android.mjs`；本机需 debug APK。
- 合成课件 E2E 适合验证渲染/导航；真实课堂才能验证老师翻页和 `slide.problem`。

---

## 8. 下一步

1. 真机安装 0.9.4 APK，验证安装权限和原生关于回调。
2. 真实考试页验证 `@match`、工具栏、考试填入。
3. 真实课堂验证单列课件、老师翻页、题目内嵌、补交。
4. GitHub main/tag/Release 已补推；国内 beta 已上线。
