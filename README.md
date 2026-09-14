<p align="center">
  <a href="https://github.com/RayMorTwinkle/YuketangStudio/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="license"/>
  </a>
  <img src="https://img.shields.io/badge/version-0.1.0-blue.svg" alt="版本">
  <img src="https://img.shields.io/badge/platform-Tampermonkey-green.svg" alt="平台">
  <img src="https://img.shields.io/badge/学校-长江雨课堂%20%7C%20通用-orange.svg" alt="适配">
</p>

<h1 align="center">YuketangStudio</h1>
<h3 align="center">雨课堂学习增强助手（油猴脚本）</h3>

> 上课专用：PPT 提取导出、答题提醒、AI 解答、PPT 多轮对话——一应俱全。

## 功能一览

| 功能 | 说明 |
|---|---|
| 📑 **PPT 提取导出** | 课堂/历史课件导出为**横屏 PDF**（页面按图片实际宽高比生成，无白边），自动去重 |
| 🔔 **答题提醒** | 老师推题时弹通知，摸鱼不错过 |
| 🤖 **AI 解答** | 提取题干与选项，可选附带 PPT 截图调用视觉模型；支持思考模式（默认开启）、流式输出 |
| 💬 **PPT 多轮对话** | 不是题目也能问：截当前 PPT 与 AI 连续追问，思考链可折叠查看 |
| 📚 **历史课件归档** | 不上课时也能把之前上过课的 PPT 一键导出（内容级去重，同页多讲只保留一份） |

## 安装

> 本脚本不上架任何脚本市场，通过本仓库直接分发，`dist/YuketangStudio-latest.user.js` 始终指向最新构建。

**方式一：一键安装（推荐）**

1. 浏览器安装 [篡改猴 (Tampermonkey)](https://www.tampermonkey.net/)，并开启**开发者模式**与「允许运行用户脚本」
2. 点击下面的按钮，浏览器打开 raw 文件后油猴会自动弹出安装界面：

   **[📥 点此一键安装](https://raw.githubusercontent.com/RayMorTwinkle/YuketangStudio/main/dist/YuketangStudio-latest.user.js)**

   （链接始终指向最新构建）

**方式二：手动导入**

下载 [`dist/YuketangStudio-latest.user.js`](https://github.com/RayMorTwinkle/YuketangStudio/blob/main/dist/YuketangStudio-latest.user.js)，在篡改猴「实用工具 → 导入」或新建脚本粘贴。

**方式三：从源码构建**

```bash
git clone https://github.com/RayMorTwinkle/YuketangStudio.git
cd YuketangStudio/ykt-helper
npm i
npm run build      # 产物：dist/YuketangStudio-<版本>.user.js + YuketangStudio-latest.user.js
```

构建后按方式一/二安装 `dist/` 下的产物。

## 使用说明

登录雨课堂网页版后，页面左下角会出现工具栏：

- **💼 主面板**：打开主面板，左侧标签切换全部功能（PPT对话 / AI解答 / 课件 / 题目列表 / 设置 / 教程）
- **🔔 习题提醒**：新习题出现时弹窗 + 提示音
- **✨ 自动作答**：切换自动作答（默认关闭）

### 历史课件导出

主面板 → 课件 → 「📥 历史课件」：自动列出该班级的全部往期课堂，选择后自动收集全部幻灯片并生成**横屏 PDF**（页面比例与原图一致，无白边；内容级去重，老师回跳重讲的页面只保留一份）。

> 提示：图片走 `*.yuketang.cn` CDN 下载，若开启全局代理建议将其加入直连规则，速度可提升 10 倍以上。

## 项目结构

```
YuketangStudio/
├── ykt-helper/              # 脚本源码（唯一源码目录）
│   ├── src/
│   │   ├── index.js         # 入口
│   │   ├── ai/              # LLM 适配器（agnes / kimi / deepseek / openrouter…）
│   │   ├── capture/         # 截图（html2canvas）
│   │   ├── core/            # 环境、存储、加密配置、PDF 导出、历史收集
│   │   ├── net/             # WS / XHR / fetch 拦截
│   │   ├── state/           # 数据仓库与动作（答题循环）
│   │   ├── tsm/             # 雨课堂业务（题目格式化、提交）
│   │   └── ui/              # 主面板壳、工具栏、各功能面板
│   ├── scripts/             # 构建辅助（加密配置生成、测试）
│   ├── rollup.config.mjs
│   └── userscript.meta.js
├── dist/                    # 构建产物（YuketangStudio-latest.user.js 随版本提交）
├── static/                  # README 截图
├── CODE_WIKI.md             # 代码结构 Wiki（上游遗留，部分描述基于旧版本）
└── changelog.md
```

## 版本说明

版本号自 `0.1.0` 起独立计数。当前基于上游 `ykt-helper v1.30.1` 重构：重命名项目、清理结构、内置加密 LLM 配置、PPT 多轮对话、历史课件收集导出（横屏 PDF + 内容去重）、统一主面板 UI。

## 致谢

- [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto) —— 本项目基于其代码重构发展而来，核心的 WS 拦截、答题流程、课件面板均源于该项目
- [hotwords123/yuketang-helper](https://github.com/hotwords123/yuketang-helper) —— 项目灵感来源

## 免责声明

- 本工具仅供个人学习参考，请独立思考完成学业
- AI 解答功能需调用 LLM API，可能产生费用；AI 可能出错，请自行核对
- 本项目不在任何服务器存储用户数据，仅将题目内容发送给你自己配置的 LLM API
