// eslint.config.mjs
// ESLint 10 flat config（官方推荐用 defineConfig from 'eslint/config'）
//
// 项目有三类代码，规则分区设置：
//   1. src/        —— 油猴脚本源码（浏览器环境 + GM_* API）
//   2. scripts/    —— Node 端工具与测试（node 环境）
//   3. *.mjs/*.js 根配置 —— 构建配置（node 环境）
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  // 全局忽略：构建产物与依赖
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/core/devmode-blob.js',   // 自动生成的加密 blob，不参与 lint
    ],
  },

  // 基线：所有 JS 文件用官方推荐规则
  js.configs.recommended,

  // ---------- 脚本源码（浏览器 + 油猴） ----------
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // 油猴 API（meta 里 @grant 声明过的）
        GM_addStyle: 'readonly',
        GM_notification: 'readonly',
        GM_xmlhttpRequest: 'readonly',
        GM_openInTab: 'readonly',
        GM_getValue: 'readonly',
        GM_setValue: 'readonly',
        GM_addValueChangeListener: 'readonly',
        GM_removeValueChangeListener: 'readonly',
        GM_getTab: 'readonly',
        GM_getTabs: 'readonly',
        GM_saveTab: 'readonly',
        unsafeWindow: 'readonly',
        // 构建期注入（rollup replace 插件）
        __BUILD_TIME__: 'readonly',
        __BUILD_VERSION__: 'readonly',
        // 动态加载的第三方库（挂到 window 上）
        jspdf: 'readonly',
        html2canvas: 'readonly',
        MathJax: 'writable',
      },
    },
    rules: {
      // 未使用变量：允许以 _ 开头的占位参数（catch {} / 回调占位很常见）
      'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // 调试残留：生产脚本里不该有裸 console（统一走 core/log.js）
      // 但 log.js 本身是出口，单独豁免（见下方 override）
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // 允许空 catch（本项目的降级/兜底语义大量使用）
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 未定义变量：真错误，必须拦住
      'no-undef': 'error',
      // 允许三元/短路等常见写法
      'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },

  // 日志出口模块：允许直接调用 console
  {
    files: ['src/core/log.js'],
    rules: { 'no-console': 'off' },
  },

  // ---------- Node 端脚本（构建/生成器/测试） ----------
  {
    files: ['scripts/**/*.{js,mjs}', '*.mjs', '*.config.mjs', 'userscript.meta.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 脚本/测试里输出进度是正常的
      'no-console': 'off',
    },
  },

  // ---------- 测试脚本：允许定义被测模块需要的浏览器全局 ----------
  {
    files: ['scripts/test-*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // 测试会故意构造"只用到部分字段"的 stub 对象
      'no-unused-vars': 'warn',
    },
  },
]);
