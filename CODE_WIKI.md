# 雨课堂助手 (Yuketang Helper) - Code Wiki

> **项目版本**: 1.21.1  
> **最后更新**: 2026.03.12  
> **项目类型**: 浏览器用户脚本 (Tampermonkey Userscript)  
> **适用平台**: Chrome / Edge  
> **许可证**: MIT

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [核心模块详解](#4-核心模块详解)
   - 4.1 [入口与启动 (index.js)](#41-入口与启动-indexjs)
   - 4.2 [核心工具 (core/)](#42-核心工具-core)
   - 4.3 [网络拦截 (net/)](#43-网络拦截-net)
   - 4.4 [状态管理 (state/)](#44-状态管理-state)
   - 4.5 [AI 服务 (ai/)](#45-ai-服务-ai)
   - 4.6 [截图服务 (capture/)](#46-截图服务-capture)
   - 4.7 [业务逻辑 (tsm/)](#47-业务逻辑-tsm)
   - 4.8 [用户界面 (ui/)](#48-用户界面-ui)
5. [关键数据流](#5-关键数据流)
6. [依赖关系](#6-依赖关系)
7. [构建与运行](#7-构建与运行)
8. [配置说明](#8-配置说明)
9. [版本历史](#9-版本历史)

---

## 1. 项目概述

雨课堂助手是一个浏览器用户脚本，为 [雨课堂](https://www.yuketang.cn/) 和 [荷塘雨课堂](https://pro.yuketang.cn/) 提供智能化辅助功能。主要特性包括：

- **习题提醒**: 新习题发布时通过浏览器通知和提示音提醒
- **AI 智能解答**: 支持多种 VLM (Vision Language Model) API 解答课堂习题
- **自动作答**: 自动检测并作答新发布的习题
- **课件浏览**: 查看、下载课件幻灯片，支持 OCR 文字识别和翻译
- **自动进入课堂**: 检测正在上课的课程并自动进入

### 支持的题目类型

| 类型码 | 题型 | 作答方式 |
|--------|------|----------|
| 1 | 单选题 | 选择单个选项 |
| 2 | 多选题 | 选择多个选项 |
| 3 | 投票题 | 选择单个选项 |
| 4 | 填空题 | 填写文本内容 |
| 5 | 主观题 | 文本回答 |

### 支持的 AI 提供商

| 提供商 | API 地址 | 默认模型 |
|--------|----------|----------|
| MoonShot (Kimi) | `https://api.moonshot.cn/v1/chat/completions` | `moonshot-v1-8k-vision-preview` |
| 硅基流动 | `https://api.siliconflow.cn/v1/chat/completions` | `Qwen/Qwen3-VL-32B-Instruct` |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3-vl-plus` |
| 并行科技 | `https://ai.paratera.com/v1/chat/completions` | `GLM-4V-Plus` |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     雨课堂网页 (yuketang.cn)                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  WebSocket  │  │   XHR/Fetch │  │   Vue.js 应用状态    │  │
│  │   通信      │  │   请求      │  │   (Vuex Store)      │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                    │             │
│  ┌──────▼────────────────▼────────────────────▼──────────┐  │
│  │              网络拦截层 (net/)                          │  │
│  │   ┌─────────────┐ ┌─────────────┐ ┌──────────────┐    │  │
│  │   │ ws-interceptor│ │xhr-interceptor│ │fetch-interceptor│  │  │
│  │   └─────────────┘ └─────────────┘ └──────────────┘    │  │
│  └──────┬────────────────────────────────────────────────┘  │
│         │                                                   │
│  ┌──────▼────────────────────────────────────────────────┐  │
│  │              状态管理层 (state/)                        │  │
│  │   ┌─────────────┐    ┌─────────────────────────────┐  │  │
│  │   │   repo.js   │◄───│         actions.js          │  │  │
│  │   │  (数据仓库)  │    │     (业务动作处理器)          │  │  │
│  │   └─────────────┘    └─────────────────────────────┘  │  │
│  └──────┬────────────────────────────────────────────────┘  │
│         │                                                   │
│  ┌──────▼──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   AI 服务层      │  │   截图服务    │  │   业务逻辑层   │  │
│  │    (ai/)        │  │  (capture/)  │  │    (tsm/)     │  │
│  │  ┌───────────┐  │  │              │  │               │  │
│  │  │ openai.js │  │  │ screenshot.js│  │ ai-format.js  │  │
│  │  │(统一API封装)│  │  │              │  │  answer.js    │  │
│  │  └───────────┘  │  │              │  │               │  │
│  └────────┬────────┘  └──────┬───────┘  └───────┬───────┘  │
│           │                  │                  │          │
│  ┌────────▼──────────────────▼──────────────────▼────────┐ │
│  │                  UI 层 (ui/)                           │ │
│  │  ┌─────────┐ ┌──────────┐ ┌─────────────┐ ┌─────────┐ │ │
│  │  │ toolbar │ │ panels/  │ │  styles.js  │ │ toast   │ │ │
│  │  │ (工具栏) │ │(各种面板) │ │  (样式注入)  │ │ (提示)  │ │ │
│  │  └─────────┘ └──────────┘ └─────────────┘ └─────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 架构特点

1. **拦截器模式**: 通过重写原生 `WebSocket`、`XMLHttpRequest` 和 `fetch` 来拦截雨课堂的通信数据
2. **集中状态管理**: 使用 `repo` 对象集中管理所有数据状态
3. **模块化设计**: 按功能划分为独立的 ES6 模块
4. **AI 抽象层**: 统一的 OpenAI 兼容 API 封装，支持多提供商切换
5. **Vision 融合**: 结合幻灯片截图和文本信息进行智能分析

---

## 3. 目录结构

```
ykt-helper/
├── src/                          # 源代码目录
│   ├── index.js                  # 主入口：初始化所有模块
│   ├── core/                     # 核心工具与配置
│   │   ├── env.js               # 环境适配器 (GM API, 脚本加载)
│   │   ├── storage.js           # localStorage 封装
│   │   ├── types.js             # 常量与默认配置
│   │   └── vuex-helper.js       # Vue/Vuex 状态访问辅助
│   ├── net/                      # 网络拦截
│   │   ├── ws-interceptor.js    # WebSocket 拦截与主动连接
│   │   ├── xhr-interceptor.js   # XHR 拦截与课堂 API
│   │   └── fetch-interceptor.js # Fetch 拦截（补充 slide 数据）
│   ├── state/                    # 状态管理
│   │   ├── repo.js              # 数据仓库（Map 结构）
│   │   └── actions.js           # 业务动作处理器
│   ├── ai/                       # AI 服务层
│   │   ├── openai.js            # 统一 OpenAI 协议封装（主入口）
│   │   ├── kimi.js              # Kimi API（历史文件）
│   │   ├── deepseek.js          # DeepSeek API（备用）
│   │   ├── gemini.js            # Gemini API
│   │   └── openrouter.js        # OpenRouter API
│   ├── capture/                  # 截图服务
│   │   └── screenshoot.js       # 幻灯片截图与图片下载
│   ├── tsm/                      # 雨课堂业务逻辑 (The School Management)
│   │   ├── ai-format.js         # AI Prompt 格式化与答案解析
│   │   └── answer.js            # 答题接口与提交逻辑
│   └── ui/                       # 用户界面
│       ├── styles.css           # 全局样式
│       ├── styles.js            # 样式注入器
│       ├── toast.js             # Toast 提示
│       ├── toolbar.js           # 左下角工具栏
│       ├── ui-api.js            # UI 统一接口
│       └── panels/              # 面板组件
│           ├── settings.html    # 设置面板模板
│           ├── settings.js      # 设置面板逻辑
│           ├── ai.html          # AI 面板模板
│           ├── ai.js            # AI 面板逻辑
│           ├── presentation.html# 课件面板模板
│           ├── presentation.js  # 课件面板逻辑
│           ├── problem-list.html# 题目列表模板
│           ├── problem-list.js  # 题目列表逻辑
│           ├── active-problems.html # 活跃题目模板
│           ├── active-problems.js   # 活跃题目逻辑
│           ├── tutorial.html    # 教程面板模板
│           ├── tutorial.js      # 教程面板逻辑
│           └── auto-answer-popup.js # 自动作答弹窗
├── flat/                         # 扁平化构建产物（历史）
├── package.json                  # 项目配置
├── rollup.config.mjs            # Rollup 构建配置
├── userscript.meta.js           # 用户脚本元数据头
└── readme.md                     # 开发文档

release/                          # 发布版本目录
├── ykt-helper-1180.user.js
├── ykt-helper-1181.user.js
├── ...
└── ykt-helper-1211.user.js      # 最新版本

ykt-helper-allinone/              # 旧版 Vue 实现（已归档）
└── old/
    ├── src/
    │   ├── components/          # Vue 组件
    │   ├── App.vue
    │   ├── api.js
    │   ├── main.js
    │   └── ...
    └── package.json
```

---

## 4. 核心模块详解

### 4.1 入口与启动 (index.js)

**文件**: [src/index.js](file:///workspace/ykt-helper/src/index.js)

**职责**: 脚本的主入口，负责按顺序初始化所有子系统。

**启动流程**:

```javascript
main() {
  1. maybeAutoReloadOnMount()   // 延迟挂载时自动刷新一次
  2. startPeriodicReload()      // 启动周期性刷新（防僵尸会话）
  3. injectStyles()             // 注入 CSS 样式
  4. ui._mountAll()             // 挂载所有 UI 面板
  5. installWSInterceptor()     // 安装 WebSocket 拦截器
  6. installXHRInterceptor()    // 安装 XHR 拦截器
  7. installToolbar()           // 加载工具栏
  8. actions.startAutoAnswerLoop()  // 启动自动作答轮询
  9. actions.launchLessonHelper()   // 启动课堂助手
}
```

**关键函数**:

| 函数 | 说明 |
|------|------|
| `maybeAutoReloadOnMount()` | 如果脚本在 DOM 已加载后才挂载，自动刷新一次以确保拦截器尽早生效 |
| `startPeriodicReload(opts)` | 周期性刷新页面，防止会话过期；支持仅后台刷新、跳过课堂页等选项 |

---

### 4.2 核心工具 (core/)

#### 4.2.1 env.js - 环境适配器

**文件**: [src/core/env.js](file:///workspace/ykt-helper/src/core/env.js)

**职责**: 封装 Tampermonkey GM API，提供环境无关的工具函数。

**导出内容**:

```javascript
export const gm = {
  notify(opt)       // GM_notification 包装
  addStyle(css)     // GM_addStyle 包装（降级为 <style> 标签）
  xhr(opt)          // GM_xmlhttpRequest 包装
  uw                // unsafeWindow 或 window
};

export function loadScriptOnce(src)        // 动态加载外部脚本
export async function ensureHtml2Canvas()  // 确保 html2canvas 可用
export async function ensureJsPDF()        // 确保 jsPDF 可用
export function randInt(l, r)              // 生成随机整数
export async function ensureFontAwesome()  // 确保 FontAwesome 加载
```

#### 4.2.2 storage.js - 存储管理

**文件**: [src/core/storage.js](file:///workspace/ykt-helper/src/core/storage.js)

**职责**: 基于 `localStorage` 的键值存储，支持 JSON 序列化和 Map 结构。

```javascript
export class StorageManager {
  constructor(prefix)           // 键前缀，如 'ykt-helper:'
  get(key, defaultValue)        // 读取并解析 JSON
  set(key, value)               // 序列化并存储
  remove(key)                   // 删除键
  getMap(key)                   // 读取为 Map 对象
  setMap(key, map)              // 存储 Map 对象
  alterMap(key, fn)             // 读取-修改-写入 Map
}

export const storage = new StorageManager('ykt-helper:');
```

#### 4.2.3 types.js - 类型与配置常量

**文件**: [src/core/types.js](file:///workspace/ykt-helper/src/core/types.js)

**职责**: 定义题目类型映射和默认配置。

```javascript
export const PROBLEM_TYPE_MAP = {
  1: '单选题',
  2: '多选题',
  3: '投票题',
  4: '填空题',
  5: '主观题',
};

export const DEFAULT_CONFIG = {
  notifyProblems: true,           // 习题提醒开关
  autoAnswer: false,              // 自动作答开关
  autoAnswerDelay: 3000,          // 自动作答基础延迟(ms)
  autoAnswerRandomDelay: 2000,    // 随机延迟范围(ms)
  iftex: true,                    // 是否启用 LaTeX 渲染
  ai: {                           // AI 配置
    provider: 'kimi',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
    visionModel: 'moonshot-v1-8k-vision-preview',
    temperature: 0.3,
    maxTokens: 1000,
    // ... 更多字段
  },
  profiles: [...],                // AI 配置档案列表
  activeProfileId: 'default',
  showAllSlides: false,           // 课件面板显示全部/仅习题页
  maxPresentations: 5,            // 本地存储课件数量上限
};
```

#### 4.2.4 vuex-helper.js - Vue 状态访问

**文件**: [src/core/vuex-helper.js](file:///workspace/ykt-helper/src/core/vuex-helper.js)

**职责**: 访问雨课堂 Vue 应用的内部状态（Vuex Store）。

```javascript
export function getVueApp()              // 获取 #app.__vue__ 实例
export function getCurrentMainPageSlideId()  // 获取当前主页面 slideId
export function watchMainPageChange(callback) // 监听页面切换
export function waitForVueReady()        // 等待 Vue 应用就绪
```

---

### 4.3 网络拦截 (net/)

#### 4.3.1 ws-interceptor.js - WebSocket 拦截

**文件**: [src/net/ws-interceptor.js](file:///workspace/ykt-helper/src/net/ws-interceptor.js)

**职责**: 
- 拦截雨课堂 WebSocket 通信
- 解析服务器推送的消息（timeline、unlockproblem、lessonfinished）
- 支持主动建立课堂 WebSocket 连接（用于自动进入课堂）

**消息处理**:

| WebSocket 消息类型 | 处理动作 |
|-------------------|----------|
| `fetchtimeline` | 调用 `actions.onFetchTimeline()` 处理时间线 |
| `unlockproblem` | 调用 `actions.onUnlockProblem()` 处理新习题 |
| `lessonfinished` | 调用 `actions.onLessonFinished()` 处理课程结束 |

**主动连接函数**:

```javascript
export function connectOrAttachLessonWS({ lessonId, auth })
// 根据当前域名选择 ws 地址，发送 hello 握手消息
```

#### 4.3.2 xhr-interceptor.js - XHR 拦截

**文件**: [src/net/xhr-interceptor.js](file:///workspace/ykt-helper/src/net/xhr-interceptor.js)

**职责**:
- 拦截 XHR 请求，提取课件数据和答题结果
- 提供自动进入课堂所需的 API 封装

**拦截的 API**:

| API 路径 | 用途 |
|----------|------|
| `/api/v3/lesson/presentation/fetch` | 课件数据，调用 `actions.onPresentationLoaded()` |
| `/api/v3/lesson/problem/answer` | 答题提交，更新题目状态 |
| `/api/v3/lesson/problem/retry` | 补交答案 |

**API 封装函数**:

```javascript
export async function getOnLesson()              // 获取正在上课的列表
export async function checkinClass(lessonId)     // 课堂签到，获取 lessonToken
export async function getActivePresentationId(lessonId)  // 获取当前课件 ID
```

#### 4.3.3 fetch-interceptor.js - Fetch 拦截

**文件**: [src/net/fetch-interceptor.js](file:///workspace/ykt-helper/src/net/fetch-interceptor.js)

**职责**: 补充拦截 `fetch` 请求，提取响应中的 `slides` 数据并填充到 `repo.slides`。

---

### 4.4 状态管理 (state/)

#### 4.4.1 repo.js - 数据仓库

**文件**: [src/state/repo.js](file:///workspace/ykt-helper/src/state/repo.js)

**职责**: 集中存储所有运行时数据，使用 Map 结构管理。

**数据结构**:

```javascript
export const repo = {
  // 课件与题目数据
  presentations: new Map(),      // presentationId -> { id, slides, ... }
  slides: new Map(),             // slideId -> { id, cover, coverAlt, problem, ... }
  problems: new Map(),           // problemId -> { problemId, problemType, body, options, ... }
  problemStatus: new Map(),      // problemId -> { presentationId, slideId, startTime, endTime, done, autoAnswerTime, answering }
  encounteredProblems: [],       // [{ problemId, problemType, body, options, slide, presentationId }]
  
  // 当前状态
  currentPresentationId: null,
  currentSlideId: null,
  currentLessonId: null,
  currentSelectedUrl: null,
  
  // 自动进入课堂状态
  listeningLessons: new Set(),   // 已建立 WS 监听的 lessonId
  lessonTokens: new Map(),       // lessonId -> token
  lessonSockets: new Map(),      // lessonId -> WebSocket 实例
  autoJoinRunning: false,        // 自动加入轮询开关
  autoJoinedLessons: new Set(),  // 自动进入的课堂
  forceAutoAnswerLessons: new Set(),
  
  // 方法
  setPresentation(id, data),     // 设置课件并持久化到 localStorage
  upsertSlide(slide),            // 更新/插入幻灯片
  upsertProblem(prob),           // 更新/插入题目
  pushEncounteredProblem(prob, slide, presentationId),
  loadStoredPresentations(),     // 从 localStorage 加载课件
  markLessonConnected(lessonId, ws, token),
  isLessonConnected(lessonId),
  markLessonAutoJoined(lessonId, enabled),
};
```

#### 4.4.2 actions.js - 业务动作处理器

**文件**: [src/state/actions.js](file:///workspace/ykt-helper/src/state/actions.js)

**职责**: 处理所有业务逻辑，是连接网络拦截、AI 服务和 UI 的枢纽。

**核心函数**:

```javascript
export const actions = {
  // 网络事件处理
  onFetchTimeline(timeline),           // 处理时间线数据
  onPresentationLoaded(id, data),      // 课件加载完成
  onUnlockProblem(data),               // 新习题解锁（触发提醒和自动作答）
  onLessonFinished(),                  // 课程结束通知
  onAnswerProblem(problemId, result),  // 更新答题结果
  
  // 自动作答
  handleAutoAnswer(problem),           // 处理自动作答（融合模式）
  startAutoAnswerLoop(),               // 启动自动作答轮询
  tickAutoAnswer(),                    // 检查并触发到期的自动作答
  
  // 手动操作
  submit(problem, content),            // 手动提交答案
  parseManual(problemType, content),   // 解析手动输入
  navigateTo(presId, slideId),         // 导航到指定幻灯片
  
  // 课堂助手
  launchLessonHelper(),                // 启动课堂助手（检测 lessonId）
  
  // 自动进入课堂
  startAutoJoinLoop(),                 // 启动自动进入课堂轮询
  stopAutoJoinLoop(),                  // 停止自动进入课堂
  maybeStartAutoJoin(),                // 条件启动自动进入
  installRouterRearm(),                // 安装路由变化监听
  startAutoClickOnOnLessonBar(),       // 自动点击"正在上课"条
};
```

**自动作答流程** (`handleAutoAnswerInternal`):

```
1. 检查题目状态（是否已作答、是否超时）
2. 若无 AI API Key → 使用默认答案（单选选A，填空填" 1"，主观题答"略"）
3. 获取幻灯片图片 (captureSlideImage)
4. 若幻灯片图片失败 → 回退到 DOM 截图 (captureProblemForVision)
5. 构建 Vision Prompt (formatProblemForVision)
6. 调用 AI Vision API (queryAIVision)
7. 解析 AI 回答 (parseAIAnswer)
8. 提交答案 (submitAnswer)
9. 更新状态并显示弹窗
```

---

### 4.5 AI 服务 (ai/)

#### 4.5.1 openai.js - 统一 AI 接口

**文件**: [src/ai/openai.js](file:///workspace/ykt-helper/src/ai/openai.js)

**职责**: 提供统一的 OpenAI 兼容协议封装，支持文本和 Vision 模式。

**核心函数**:

```javascript
// 文本模式（单步）
export async function queryAI(question, aiCfg)

// Vision 模式（单步/两步）
export async function queryAIVision(imageBase64, textPrompt, aiCfg, options)
// options:
//   - disableTwoStep: 强制使用单步
//   - twoStepDebug: 输出调试日志
//   - timeout: 超时时间
//   - problemType: 后端题型（用于题型合并）

// OCR 识别
export async function queryOCRVision(imageBase64, aiCfg)

// 文本翻译
export async function queryTranslationText(text, targetLanguage, aiCfg)
```

**两步 Vision 流程**:

```
Step 1 (Vision 模型):
  - 输入: 幻灯片截图 + 可选文本
  - 输出: 结构化 JSON { question_type, stem, options, image_facts, requires_image_for_solution }
  - 若失败 → 回退到单步 Vision

Step 2 (文本模型):
  - 输入: 结构化题目信息
  - 输出: 格式化的答案
  - 若失败 → 回退到单步 Vision
```

**配置档案**:

```javascript
// 支持多档案管理
profiles: [
  {
    id: 'default',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
    apiKey: '',
    model: 'moonshot-v1-8k',
    visionModel: 'moonshot-v1-8k-vision-preview',
  }
]
```

---

### 4.6 截图服务 (capture/)

#### 4.6.1 screenshoot.js

**文件**: [src/capture/screenshoot.js](file:///workspace/ykt-helper/src/capture/screenshoot.js)

**职责**: 获取题目相关的图像数据，用于 Vision 模式分析。

```javascript
// 截取题目区域 DOM 为 Canvas
export async function captureProblemScreenshot()

// 获取指定幻灯片的图片（优先使用 coverAlt/cover URL）
export async function captureSlideImage(slideId)

// 获取 Vision API 用的 base64 图像（DOM 截图方式）
export async function captureProblemForVision()

// 下载图片并转 base64（自动压缩）
async function downloadImageAsBase64(url)
```

**图像获取优先级**:
1. `slide.coverAlt` - 高清替代图
2. `slide.cover` - 封面图
3. `slide.image` - 图片字段
4. `slide.thumbnail` - 缩略图
5. 回退: DOM 截图

---

### 4.7 业务逻辑 (tsm/)

#### 4.7.1 ai-format.js - AI 格式化

**文件**: [src/tsm/ai-format.js](file:///workspace/ykt-helper/src/tsm/ai-format.js)

**职责**: 生成 AI Prompt 和解析 AI 回答。

```javascript
// 生成文本模式 Prompt
export function formatProblemForAI(problem, TYPE_MAP)

// 生成 Vision 模式 Prompt（融合模式）
export function formatProblemForVision(problem, TYPE_MAP, hasTextInfo)

// 格式化题目用于显示
export function formatProblemForDisplay(problem, TYPE_MAP)

// 解析 AI 回答为结构化答案
export function parseAIAnswer(problem, aiAnswer)
```

**答案解析规则**:

| 题型 | 解析规则 | 示例输入 | 输出 |
|------|----------|----------|------|
| 单选/投票 | 提取第一个大写字母 | `答案: A` | `['A']` |
| 多选 | 顿号/逗号分隔，去重排序 | `答案: A、B、C` | `['A','B','C']` |
| 填空 | 按分隔符拆分，清理格式 | `答案: 氧气,葡萄糖` | `['氧气','葡萄糖']` |
| 主观 | 保留完整文本 | `答案: 光合作用...` | `{ content: '...', pics: [] }` |

#### 4.7.2 answer.js - 答题接口

**文件**: [src/tsm/answer.js](file:///workspace/ykt-helper/src/tsm/answer.js)

**职责**: 封装答题提交逻辑，支持正常作答和补交。

```javascript
// 正常答题
export async function answerProblem(problem, result, options)
// POST /api/v3/lesson/problem/answer

// 补交答案
export async function retryAnswer(problem, result, dt, options)
// POST /api/v3/lesson/problem/retry

// 智能提交（自动判断 answer/retry）
export async function submitAnswer(problem, result, submitOptions)
// submitOptions:
//   - startTime/endTime: 用于判断是否超时
//   - forceRetry: 强制使用补交
//   - autoGate: 是否启用自动等待
//   - waitMs: 覆盖等待时间
//   - lessonId: 所属课堂
```

---

### 4.8 用户界面 (ui/)

#### 4.8.1 toolbar.js - 工具栏

**文件**: [src/ui/toolbar.js](file:///workspace/ykt-helper/src/ui/toolbar.js)

**职责**: 在页面左下角创建浮动工具栏，提供功能入口。

**按钮**:

| 图标 | ID | 功能 | 快捷键 |
|------|-----|------|--------|
| 🔔 | `#ykt-btn-bell` | 习题提醒开关 | - |
| 📄 | `#ykt-btn-pres` | 课件浏览面板 | - |
| 🤖 | `#ykt-btn-ai` | AI 解答面板 | - |
| ✨ | `#ykt-btn-auto-answer` | 自动作答开关 | - |
| ⚙️ | `#ykt-btn-settings` | 设置面板 | - |
| ❓ | `#ykt-btn-help` | 使用教程 | - |

#### 4.8.2 ui-api.js - UI 统一接口

**文件**: [src/ui/ui-api.js](file:///workspace/ykt-helper/src/ui/ui-api.js)

**职责**: 整合所有 UI 功能，提供统一的接口给业务层调用。

```javascript
export const ui = {
  config,                    // 配置对象（响应式）
  saveConfig(),              // 保存配置到 localStorage
  
  // 面板控制（带 z-index 管理）
  showPresentationPanel(visible),
  showProblemListPanel(visible),
  showAIPanel(visible),
  toggleSettingsPanel(),
  toggleTutorialPanel(),
  
  // 数据更新
  updatePresentationList(),
  updateSlideView(),
  updateProblemList(),
  updateActiveProblems(),
  
  // 通知系统
  notifyProblem(problem, slide),   // 自定义悬浮弹窗 + 声音
  toast(message),                  // Toast 提示
  nativeNotify(opt),               // 原生系统通知
  
  // 工具
  getProblemDetail(problem),       // 获取题目详情文本
  setCustomNotifyAudio({ src, name }),  // 设置自定义提示音
  updateAutoAnswerBtn(),           // 更新自动作答按钮状态
};
```

**通知系统**:
- 自定义悬浮弹窗（右下角，可拖拽，自动消失）
- 原生系统通知（GM_notification）
- 提示音（Web Audio API 合成音或自定义音频文件）

#### 4.8.3 面板组件 (panels/)

| 面板 | 文件 | 功能 |
|------|------|------|
| 设置面板 | `settings.js` + `settings.html` | API Key 配置、自动作答参数、AI 档案管理 |
| AI 面板 | `ai.js` + `ai.html` | AI 提问交互、Markdown 渲染、多页 PPT 提问 |
| 课件面板 | `presentation.js` + `presentation.html` | 幻灯片浏览、PDF 导出、OCR、翻译 |
| 题目列表 | `problem-list.js` + `problem-list.html` | 历史题目查看、强制补交 |
| 活跃题目 | `active-problems.js` + `active-problems.html` | 当前可作答题目列表 |
| 教程面板 | `tutorial.js` + `tutorial.html` | 使用说明 |
| 自动作答弹窗 | `auto-answer-popup.js` | 自动作答结果展示 |

---

## 5. 关键数据流

### 5.1 新习题发布到自动作答

```
雨课堂服务器
    │
    ▼ WebSocket push
┌─────────────────┐
│  unlockproblem  │
│  { prob, sid,   │
│    pres, dt,    │
│    limit }      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│ ws-interceptor  │────►│ actions.onUnlock│
│   .listen()     │     │   Problem()     │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌─────────┐  ┌─────────┐  ┌─────────────┐
              │  提醒    │  │ 自动作答 │  │  更新UI      │
              │ notify  │  │ 计时器   │  │ updateActive│
              │ Problem │  │ 设置     │  │  Problems   │
              └─────────┘  └────┬────┘  └─────────────┘
                                │
                    延迟到期后   ▼
                          ┌─────────────┐
                          │handleAuto   │
                          │AnswerInternal│
                          └──────┬──────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌──────────┐     ┌──────────┐      ┌──────────┐
        │capture   │     │ queryAI  │      │submitAnswer│
        │SlideImage│     │ Vision   │      │          │
        └──────────┘     └──────────┘      └──────────┘
```

### 5.2 课件数据流

```
雨课堂 XHR/Fetch
    │
    ▼ 响应拦截
┌─────────────────┐
│ xhr-interceptor │────► actions.onPresentationLoaded(id, data)
│ fetch-interceptor│────► repo.slides.set(id, slide)
└─────────────────┘
         │
         ▼
┌─────────────────┐
│    repo.js      │
│  setPresentation│──► localStorage 持久化
│  upsertSlide    │
│  upsertProblem  │
└─────────────────┘
         │
         ▼
┌─────────────────┐
│   ui-api.js     │
│ updatePresentationList()
│ updateSlideView()
└─────────────────┘
```

---

## 6. 依赖关系

### 6.1 模块依赖图

```
index.js (入口)
├── core/env.js ◄─────── 被几乎所有模块依赖
├── core/storage.js ◄─── repo.js, ui-api.js
├── core/types.js ◄───── ui-api.js, actions.js, ai-format.js
├── core/vuex-helper.js ◄── ai.js
├── net/ws-interceptor.js ──► actions.js, repo.js
├── net/xhr-interceptor.js ──► actions.js
├── net/fetch-interceptor.js ──► repo.js, actions.js
├── state/repo.js ◄────── 被 net/, state/, ui/ 依赖
├── state/actions.js ──► repo.js, ui-api.js, answer.js, openai.js, 
│                        screenshoot.js, ai-format.js, auto-answer-popup.js,
│                        ws-interceptor.js, xhr-interceptor.js
├── ai/openai.js ──► env.js
├── capture/screenshoot.js ──► env.js, repo.js
├── tsm/answer.js ──► ui-api.js, repo.js
├── tsm/ai-format.js ──► (无外部依赖，纯工具)
└── ui/
    ├── styles.js ──► env.js
    ├── toolbar.js ──► ui-api.js
    ├── toast.js ──► (独立)
    ├── ui-api.js ──► env.js, storage.js, types.js, repo.js, toast.js
    │                 以及所有 panels
    └── panels/*.js ──► ui-api.js, repo.js, actions.js, 各功能模块
```

### 6.2 外部依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| Tampermonkey GM API | 浏览器扩展 | 跨域请求、样式注入、系统通知 |
| FontAwesome 6.4.0 | CDN | 工具栏图标 |
| html2canvas | CDN (动态加载) | DOM 截图 |
| jsPDF 2.5.1 | CDN (@require) | PDF 导出 |
| MathJax 3 | CDN (@require) | LaTeX 公式渲染 |

### 6.3 构建依赖

| 包 | 版本 | 用途 |
|----|------|------|
| rollup | ^4.21.2 | 模块打包 |
| @rollup/plugin-node-resolve | ^15.2.3 | Node 模块解析 |
| @rollup/plugin-commonjs | ^25.0.7 | CommonJS 转换 |
| @rollup/plugin-replace | ^5.0.7 | 编译期变量替换 |
| @rollup/plugin-terser | ^0.4.4 | 代码压缩（保留可读性） |
| @rollup/plugin-typescript | ^11.1.6 | TypeScript 支持 |
| @bkuri/rollup-plugin-string | ^1.0.0 | 导入 HTML/CSS 为字符串 |
| typescript | ^5.6.3 | 类型检查 |

---

## 7. 构建与运行

### 7.1 环境要求

- Node.js (推荐 v18+)
- npm 或 yarn

### 7.2 构建步骤

```bash
# 进入项目目录
cd ykt-helper

# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 生产构建
npm run build
```

### 7.3 构建输出

构建产物位于 `dist/ykt-helper-1211.user.js`，是一个完整的 Tampermonkey 用户脚本，可直接导入浏览器扩展使用。

### 7.4 Rollup 配置

**文件**: [rollup.config.mjs](file:///workspace/ykt-helper/rollup.config.mjs)

```javascript
export default {
  input: 'src/index.js',
  output: {
    file: 'dist/ykt-helper-1211.user.js',
    format: 'iife',              // 立即执行函数，适合 userscript
    banner: () => meta,          // Userscript 元数据头
    inlineDynamicImports: true,  // 禁用代码分割，单文件输出
  },
  plugins: [
    string({ include: ['**/*.html', '**/*.css'] }),  // 导入模板为字符串
    resolve({ browser: true }),
    commonjs(),
    replace({
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __BUILD_VERSION__: JSON.stringify(process.env.BUILD_VERSION || 'dev'),
    }),
    terser({
      mangle: false,              // 不混淆变量名
      compress: { defaults: false, sequences: false },
      format: { beautify: true, indent_level: 2, comments: 'all' },
    }),
  ],
};
```

### 7.5 安装使用

1. 在 Chrome/Edge 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开 Tampermonkey 控制面板，创建新脚本
3. 复制 `dist/ykt-helper-1211.user.js` 的内容粘贴保存
4. 访问雨课堂页面，左下角出现工具栏即表示加载成功

---

## 8. 配置说明

### 8.1 用户脚本元数据

**文件**: [userscript.meta.js](file:///workspace/ykt-helper/userscript.meta.js)

```javascript
export const meta = `
// ==UserScript==
// @name         AI雨课堂助手（JS版）
// @version      1.21.1
// @match        https://pro.yuketang.cn/web/*
// @match        https://changjiang.yuketang.cn/web/*
// @match        https://*.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://*.yuketang.cn/v2/web/*
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.min.js
// ==/UserScript==
`;
```

### 8.2 运行时配置

配置存储在 `localStorage` 中，键名为 `ykt-helper:config`。

**主要配置项**:

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `notifyProblems` | boolean | true | 新习题提醒 |
| `autoAnswer` | boolean | false | 自动作答开关 |
| `autoAnswerDelay` | number | 3000 | 自动作答基础延迟(ms) |
| `autoAnswerRandomDelay` | number | 2000 | 随机延迟范围(ms) |
| `autoJoinEnabled` | boolean | false | 自动进入课堂 |
| `autoAnswerOnAutoJoin` | boolean | true | 自动进入后自动作答 |
| `notifyPopupDuration` | number | 5000 | 通知弹窗显示时长(ms) |
| `notifyVolume` | number | 0.6 | 提示音音量(0-1) |
| `customNotifyAudioSrc` | string | '' | 自定义提示音 URL |
| `iftex` | boolean | true | 启用 LaTeX 渲染 |
| `showAllSlides` | boolean | false | 课件面板显示全部页面 |
| `maxPresentations` | number | 5 | 本地存储课件数量上限 |
| `ai.profiles` | array | [...] | AI 配置档案列表 |
| `ai.activeProfileId` | string | 'default' | 当前使用的档案 ID |
| `ai.ocrApi` | string | '' | OCR 专用 API 地址 |
| `ai.ocrApiKey` | string | '' | OCR 专用 API Key |
| `ai.translateApi` | string | '' | 翻译专用 API 地址 |
| `ai.translateApiKey` | string | '' | 翻译专用 API Key |
| `ai.translateModel` | string | '' | 翻译专用模型 |

---

## 9. 版本历史

### 主要版本特性

| 版本 | 发布日期 | 主要特性 |
|------|----------|----------|
| 1.21.1 | 2026.03 | 课件翻译功能 |
| 1.21.0 | 2026.03 | 新增 OCR 系统 |
| 1.20.3 | - | 高清图片下载 |
| 1.20.2 | - | 多图输入、自动刷新 |
| 1.20.1 | - | Agent 模式、AI 工作流优化 |
| 1.20.0 | - | 更多 AI 提供商支持 |
| 1.19.2 | - | 子 frame PPT 获取 |
| 1.19.1 | - | Markdown 渲染器 |
| 1.19.0 | - | 自定义习题提醒、提示音 |
| 1.18.7 | - | 自动进入课堂功能 |
| 1.18.5 | - | 无 AI 随机答题模式 |
| 1.18.0 | - | 全面转向 Vision 模式 |
| 1.17.0 | - | Kimi Vision 模型支持 |
| 1.16.0 | - | 大模型答案弹窗 |
| 1.15.0 | - | 答案模糊匹配 |
| 1.14.0 | - | 自动刷新页面 |
| 1.13.0 | - | 自动作答功能 |
| 1.12.0 | - | AI 作答功能 |

---

## 附录

### A. 环境适配

脚本自动检测运行环境：

| 域名 | 环境类型 | 特殊处理 |
|------|----------|----------|
| `www.yuketang.cn` | 标准雨课堂 | 默认 ws: `wss://www.yuketang.cn/wsapp/` |
| `pro.yuketang.cn` | 荷塘雨课堂 | ws: `wss://pro.yuketang.cn/wsapp/` |
| `changjiang.yuketang.cn` | 长江雨课堂 | 兼容 API 路径 |

### B. 调试信息

所有模块使用统一的日志前缀格式：

```
[雨课堂助手][级别][模块名] 消息内容
```

级别: `DBG` (调试) / `INFO` (信息) / `WARN` (警告) / `ERR` (错误)

### C. 安全注意事项

1. API Key 仅存储在浏览器 localStorage 中，不会上传到任何第三方服务器
2. 题目信息仅在用户主动触发时发送给配置的 AI API
3. 脚本不会收集或上传用户的个人信息
4. 自动作答功能仅供参考，不保证答案正确性
