// userscript.meta.js
// 版本号单一来源：从 package.json 读取，发版只改一处
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

export const meta = `
// ==UserScript==
// @name         YuketangStudio 雨课堂助手
// @namespace    https://github.com/RayMorTwinkle/YuketangStudio
// @version      ${version}
// @description  课堂习题提醒、AI解答（思考/图片/流式）、PPT提取与多轮对话、历史课件归档
// @license      MIT
// @icon         https://raw.githubusercontent.com/RayMorTwinkle/YuketangStudio/main/static/icon.svg
// @match        https://pro.yuketang.cn/web/*
// @match        https://pro.yuketang.cn/web
// @match        https://changjiang.yuketang.cn/web/*
// @match        https://changjiang.yuketang.cn/web
// @match        https://www.yuketang.cn/web/*
// @match        https://www.yuketang.cn/web
// @match        https://*.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://*.yuketang.cn/lesson/student/v3/*
// @match        https://*.yuketang.cn/v2/web/*
// @match        https://*.yuketang.cn/m/v2/*
// @match        https://*.yuketang.cn/m/*
// @match        https://www.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://www.yuketang.cn/v2/web/*
// @match        https://pro.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://pro.yuketang.cn/v2/web/*
// @match        https://pro.yuketang.cn/v2/web/index
// @match        https://pro.yuketang.cn/v2/web/student-lesson-report/*
// @match        https://changjiang.yuketang.cn/lesson/fullscreen/v3/*
// @match        https://changjiang.yuketang.cn/v2/web/*
// @match        https://changjiang.yuketang.cn/v2/web/index
// @match        https://changjiang.yuketang.cn/v2/web/student-lesson-report/*
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_getTab
// @grant        GM_getTabs
// @grant        GM_saveTab
// @grant        unsafeWindow
// @connect      api.moonshot.cn
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @connect      generativelanguage.googleapis.com
// @connect      api.longcat.chat
// @connect      api.agnes-ai.cn
// @connect      yuketang.cn
// @connect      *.yuketang.cn
// @connect      changjiang-private-qn.yuketang.cn
// @connect      thu-private-qn.yuketang.cn
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.min.js
// ==/UserScript==
`;
