package com.yuketangstudio.shell

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewRenderProcessClient
import com.yuketangstudio.shell.databinding.ActivityMainBinding
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var bridge: YktBridge
    private var collectView: WebView? = null
    private var scriptAsset: String = ""
    private var shimAsset: String = ""
    private var docStartSupported = false

    // ---------- 多标签 ----------
    private class Tab(val webView: WebView, var title: String = "新标签页") {
        var fallbackInjected = false
    }
    private val tabs = mutableListOf<Tab>()
    private var activeIndex = -1
    private val activeWebView: WebView? get() = tabs.getOrNull(activeIndex)?.webView

    // ---------- 历史 ----------
    private val history get() = getSharedPreferences("nav_history", Context.MODE_PRIVATE)
    private val HISTORY_KEY = "entries"
    private val HISTORY_MAX = 300

    // ---------- 设置 ----------
    private val prefs get() = getSharedPreferences("settings", Context.MODE_PRIVATE)
    private var desktopMode
        get() = prefs.getBoolean("desktopMode", false)
        set(v) { prefs.edit().putBoolean("desktopMode", v).apply() }
    private var textZoom
        get() = prefs.getInt("textZoom", 100)
        set(v) { prefs.edit().putInt("textZoom", v).apply() }

    enum class Env(val label: String, val origin: String) {
        CHANGJIANG("长江雨课堂", "https://changjiang.yuketang.cn"),
        STANDARD("雨课堂", "https://www.yuketang.cn"),
        PRO("荷塘雨课堂", "https://pro.yuketang.cn"),
    }
    private var env = Env.CHANGJIANG

    // ---------- 登录态备份/还原 ----------
    // 待注入的 localStorage：origin→js，onPageFinished 命中对应 origin 时消费
    private val pendingRestoreLs = mutableMapOf<String, String>()
    private var pendingRestoreReload = false
    private var pendingBackupJson: String? = null
    private val REQ_PICK_BACKUP_FILE = 41
    private val REQ_SAVE_BACKUP_FILE = 42

    companion object {
        private const val TAG = "YktShell"
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        bridge = YktBridge(this)

        shimAsset = assets.open("gm-shim.js").bufferedReader().use { it.readText() }
        scriptAsset = assets.open("yuketangstudio.user.js").bufferedReader().use { it.readText() }
        docStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        Log.i(TAG, "document-start 注入支持: $docStartSupported")

        configureToolbar()
        configureZoomBar()
        askNotificationPermission()
        newTab("${env.origin}/web/")
    }

    // ---------- 标签页管理 ----------

    @SuppressLint("SetJavaScriptEnabled")
    private fun newTab(url: String) {
        val wv = WebView(this)
        val tab = Tab(wv)
        configureWebView(wv, tab)
        wv.layoutParams = android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
        )
        binding.tabContainer.addView(wv)
        tabs.add(tab)
        switchTab(tabs.size - 1)
        if (url.isNotBlank()) wv.loadUrl(url)
        Log.i(TAG, "新建标签页 #${tabs.size - 1} → $url")
    }

    private fun switchTab(index: Int) {
        if (index !in tabs.indices) return
        tabs.forEachIndexed { i, t -> t.webView.visibility = if (i == index) View.VISIBLE else View.GONE }
        activeIndex = index
        renderTabStrip()
        updateNav()
    }

    private fun closeTab(index: Int) {
        if (index !in tabs.indices) return
        val tab = tabs.removeAt(index)
        binding.tabContainer.removeView(tab.webView)
        tab.webView.destroy()
        if (tabs.isEmpty()) { finish(); return }
        switchTab(kotlin.math.min(index, tabs.size - 1))
    }

    private fun renderTabStrip() {
        val inner = binding.tabStripInner
        inner.removeAllViews()
        tabs.forEachIndexed { i, t ->
            val chip = TextView(this).apply {
                text = (if (i == activeIndex) "● " else "") + t.title.take(14)
                setTextColor(if (i == activeIndex) Color.parseColor("#1d63df") else Color.parseColor("#44506b"))
                textSize = 12f
                setPadding(14, 8, 14, 8)
                setOnClickListener { switchTab(i) }
                setOnLongClickListener {
                    if (tabs.size > 1) closeTab(i) else toast("最后一个标签不能关")
                    true
                }
            }
            inner.addView(chip)
        }
        val plus = TextView(this).apply {
            text = "＋"
            textSize = 16f
            setTextColor(Color.parseColor("#1d63df"))
            setPadding(16, 4, 16, 4)
            setOnClickListener { newTab("${env.origin}/web/") }
        }
        inner.addView(plus)
        binding.tabStrip.visibility = View.VISIBLE
        updateNav()
    }

    // ---------- WebView 配置 ----------

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView, tab: Tab) {
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(wv, true)
        }
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            applyDesktopMode(this)
            textZoom = this@MainActivity.textZoom
        }
        wv.addJavascriptInterface(bridge, "YktBridge")

        val combined = shimAsset + "\n;\n" + scriptAsset
        if (docStartSupported) {
            try {
                WebViewCompat.addDocumentStartJavaScript(
                    wv, combined,
                    setOf(
                        "https://changjiang.yuketang.cn",
                        "https://www.yuketang.cn",
                        "https://pro.yuketang.cn",
                    ),
                )
            } catch (e: Exception) {
                Log.e(TAG, "addDocumentStartJavaScript 失败", e)
                docStartSupported = false
            }
        }

        wv.webViewClient = object : WebViewClientCompat() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return handleNavigation(request.url.toString())
            }

            @Deprecated("deprecated")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return handleNavigation(url ?: return false)
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (!docStartSupported && url != null && isYuketang(url) && !tab.fallbackInjected) {
                    tab.fallbackInjected = true
                    view.evaluateJavascript(combined, null)
                    Log.i(TAG, "evaluateJavascript 降级注入: $url")
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                CookieManager.getInstance().flush()
                // 登录态还原：命中排队 origin 时注入 localStorage 再 reload 一次
                val o = originOf(url)
                if (o != null && pendingRestoreLs.containsKey(o)) {
                    val js = pendingRestoreLs.remove(o)!!
                    view.evaluateJavascript(js) { }
                    Log.i(TAG, "localStorage 已注入 $o，自动刷新")
                    view.postDelayed({ view.reload() }, 300)
                    if (pendingRestoreLs.isEmpty()) { status("还原完成"); toast("登录态还原完成") }
                    pendingRestoreReload = false
                }
                val title = view.title ?: url ?: ""
                if (view === activeWebView) {
                    tab.title = title.take(20).ifBlank { "页面" }
                    renderTabStrip()
                    updateNav()
                }
                if (url != null && isYuketang(url)) recordHistory(title, url)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: androidx.webkit.WebResourceErrorCompat) {
                if (request.isForMainFrame) {
                    Log.e(TAG, "onReceivedError ${request.url} code=${error.errorCode} desc=${error.description}")
                    status("加载失败：${error.description}")
                }
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: android.webkit.WebResourceResponse) {
                if (request.isForMainFrame) {
                    Log.w(TAG, "HTTP ${response.statusCode} ${request.url}")
                }
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (view === activeWebView) {
                    binding.pageProgress.progress = newProgress
                    binding.pageProgress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
                }
            }
            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                val text = "[${msg.sourceId()?.substringAfterLast('/') ?: "?"}:${msg.lineNumber()}] ${msg.message()}"
                when (msg.messageLevel()) {
                    android.webkit.ConsoleMessage.MessageLevel.ERROR -> Log.e("YktConsole", text)
                    android.webkit.ConsoleMessage.MessageLevel.WARNING -> Log.w("YktConsole", text)
                    else -> Log.i("YktConsole", text)
                }
                return true
            }
            override fun onReceivedTitle(view: WebView?, title: String?) {
                if (view === activeWebView && !title.isNullOrBlank()) {
                    tabs.getOrNull(activeIndex)?.title = title.take(20)
                    renderTabStrip()
                }
            }
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_CLIENT_BASIC_USAGE)) {
            WebViewCompat.setWebViewRenderProcessClient(wv, object : WebViewRenderProcessClient() {
                override fun onRenderProcessUnresponsive(view: WebView, renderer: androidx.webkit.WebViewRenderProcess?) {
                    Log.e(TAG, "渲染进程无响应 url=${view.url}")
                    status("页面无响应，自动重载")
                    view.reload()
                }
                override fun onRenderProcessResponsive(view: WebView, renderer: androidx.webkit.WebViewRenderProcess?) {}
            })
        }

        wv.setDownloadListener { url, _, contentDisposition, mime, _ ->
            if (url.startsWith("http")) {
                try {
                    val name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mime)
                    val req = DownloadManager.Request(Uri.parse(url))
                    req.setTitle(name)
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, "YuketangStudio/$name")
                    req.addRequestHeader("cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                    status("开始下载 $name")
                    Log.i(TAG, "DownloadManager 下载: $name <- $url")
                } catch (e: Exception) {
                    Log.e(TAG, "下载失败", e)
                }
            }
        }
    }

    private fun applyDesktopMode(settings: WebSettings) {
        if (desktopMode) {
            settings.userAgentString = DESKTOP_UA
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
        } else {
            settings.userAgentString = WebSettings.getDefaultUserAgent(this)
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
        }
    }

    // ---------- 导航/历史 ----------

    private fun isYuketang(url: String): Boolean = runCatching {
        val host = URI(url).host?.lowercase() ?: return false
        URI(url).scheme.equals("https", true) && (host == "yuketang.cn" || host.endsWith(".yuketang.cn"))
    }.getOrDefault(false)

    private fun handleNavigation(url: String): Boolean {
        if (isYuketang(url) || url.startsWith("about:")) return false
        // 新开 yuketang 链接在当前 tab 内走；非 yuketang 丢系统浏览器
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        return true
    }

    private fun recordHistory(title: String, url: String) {
        if (url.contains("/web/login") || url.contains("/v2/web/login")) return
        try {
            val arr = JSONArray(history.getString(HISTORY_KEY, "[]"))
            val entry = JSONObject().put("t", title.ifBlank { url }).put("u", url).put("ts", System.currentTimeMillis())
            // 去重：同 url 挪到最前
            val next = JSONArray()
            next.put(entry)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (o.optString("u") != url) next.put(o)
            }
            val trimmed = JSONArray()
            for (i in 0 until minOf(next.length(), HISTORY_MAX)) trimmed.put(next.getJSONObject(i))
            history.edit().putString(HISTORY_KEY, trimmed.toString()).apply()
        } catch (e: Exception) {
            Log.w(TAG, "写历史失败", e)
        }
    }

    private fun showHistory() {
        Log.i(TAG, "showHistory 打开")
        val arr = JSONArray(history.getString(HISTORY_KEY, "[]"))
        Log.i(TAG, "历史条数 ${arr.length()}")
        if (arr.length() == 0) { toast("暂无历史记录"); return }
        val items = Array(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            val time = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(o.optLong("ts")))
            "${o.optString("t").take(28)}\n  $time"
        }
        AlertDialog.Builder(this)
            .setTitle("历史记录")
            .setItems(items) { _, i ->
                val url = arr.getJSONObject(i).optString("u")
                if (url.isNotBlank()) activeWebView?.loadUrl(url)
            }
            .setNegativeButton("关闭", null)
            .show()
    }

    // ---------- 下载管理 ----------

    private fun showDownloads() {
        Log.i(TAG, "showDownloads 打开")
        val dirs = listOfNotNull(
            android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
                ?.let { java.io.File(it, "YuketangStudio") },
            getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS),
        )
        val files = dirs.flatMap { it.listFiles()?.toList() ?: emptyList() }
            .filter { it.isFile }
            .sortedByDescending { it.lastModified() }
        if (files.isEmpty()) { toast("暂无下载文件"); return }
        val items = files.map {
            val size = if (it.length() > 1048576) "%.1fMB".format(it.length() / 1048576f)
                       else "${it.length() / 1024}KB"
            "${it.name}\n  $size · ${SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(it.lastModified()))}"
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("下载文件（下载/YuketangStudio）")
            .setItems(items) { _, i ->
                val f = files[i]
                val uri = androidx.core.content.FileProvider.getUriForFile(
                    this, "${packageName}.fileprovider", f)
                runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, guessMime(f.name))
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    })
                }.onFailure { toast("没有能打开此文件的应用") }
            }
            .setNegativeButton("关闭", null)
            .show()
    }

    private fun guessMime(name: String) = when {
        name.endsWith(".pdf", true) -> "application/pdf"
        name.endsWith(".pptx", true) -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        name.endsWith(".png", true) -> "image/png"
        name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
        else -> "*/*"
    }

    // ---------- 登录态备份/还原 ----------

    private fun originOf(url: String?): String? = runCatching {
        val u = URI(url ?: return null)
        if (u.host == null) return null
        "${u.scheme}://${u.host}${if (u.port > 0) ":${u.port}" else ""}"
    }.getOrNull()

    /** 提取登录态：Cookie(全部三个环境) + 当前页面的 localStorage，随后按目标分发 */
    private fun backupLogin(toClipboard: Boolean) {
        val cm = CookieManager.getInstance()
        cm.flush()
        val cookies = JSONObject()
        for (e in Env.entries) {
            cm.getCookie(e.origin)?.takeIf { it.isNotBlank() }?.let { cookies.put(e.origin, it) }
        }
        val wv = activeWebView
        val curUrl = wv?.url
        val curOrigin = originOf(curUrl)
        if (wv == null || curOrigin == null || !isYuketang(curUrl!!)) {
            // 当前不在雨课堂页面：只备份 Cookie，localStorage 拿不着
            finishBackup(cookies, JSONObject(), toClipboard)
            return
        }
        // evaluateJavascript 回调只给 JSON 字符串字面量——让页面自己 base64 再解，免转义坑
        wv.evaluateJavascript(
            "try{btoa(unescape(encodeURIComponent(JSON.stringify(localStorage))))}catch(e){''}"
        ) { raw ->
            val ls = JSONObject()
            runCatching {
                val b64 = raw?.removeSurrounding("\"") ?: ""
                if (b64.isNotBlank()) {
                    val decoded = String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT))
                    ls.put(curOrigin, JSONObject(decoded))
                }
            }
            finishBackup(cookies, ls, toClipboard)
        }
    }

    private fun finishBackup(cookies: JSONObject, ls: JSONObject, toClipboard: Boolean) {
        val doc = JSONObject()
            .put("app", "yuketangstudio-login-backup")
            .put("version", 1)
            .put("savedAt", System.currentTimeMillis())
            .put("env", env.name)
            .put("cookies", cookies)
            .put("localStorage", ls)
        val text = doc.toString(2)
        Log.i(TAG, "备份生成: cookies=${cookies.length()}域 ls=${ls.length()}域 size=${text.length}B")
        if (toClipboard) {
            AlertDialog.Builder(this)
                .setTitle("备份到剪贴板")
                .setMessage("备份含登录凭证，任何拿到它的人都能登录你的账号。确定复制到剪贴板？")
                .setPositiveButton("复制") { _, _ ->
                    (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("ykt-login-backup", text))
                    toast("已复制登录态备份到剪贴板")
                }
                .setNegativeButton("取消", null)
                .show()
        } else {
            pendingBackupJson = text
            runCatching {
                startActivityForResult(
                    Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "application/json"
                        putExtra(Intent.EXTRA_TITLE, "ykt-login-backup.json")
                    }, REQ_SAVE_BACKUP_FILE)
            }.onFailure {
                Log.e(TAG, "SAF 创建文件失败", it)
                toast("无法打开文件选择器，改用剪贴板")
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText("ykt-login-backup", text))
            }
        }
    }

    /** 从剪贴板或文件还原 */
    private fun restoreLogin(fromClipboard: Boolean) {
        if (fromClipboard) {
            val clip = (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
            val text = clip.primaryClip?.getItemAt(0)?.text?.toString()
            if (text.isNullOrBlank()) { toast("剪贴板为空"); return }
            applyLoginBackup(text)
        } else {
            runCatching {
                startActivityForResult(
                    Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }, REQ_PICK_BACKUP_FILE)
            }.onFailure { toast("无法打开文件选择器") }
        }
    }

    private fun applyLoginBackup(text: String) {
        val doc = runCatching { JSONObject(text) }.getOrElse {
            toast("备份文件不是合法 JSON")
            return
        }
        if (doc.optString("app") != "yuketangstudio-login-backup") {
            toast("不是 YuketangStudio 登录备份文件")
            return
        }
        val cookies = doc.optJSONObject("cookies") ?: JSONObject()
        val ls = doc.optJSONObject("localStorage") ?: JSONObject()
        AlertDialog.Builder(this)
            .setTitle("还原登录态")
            .setMessage("将覆盖当前的 Cookie 和 localStorage（${cookies.length()} 个域的 Cookie，${ls.length()} 个域的本地存储）。确定继续？")
            .setPositiveButton("还原") { _, _ -> doRestore(cookies, ls) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doRestore(cookies: JSONObject, ls: JSONObject) {
        val cm = CookieManager.getInstance()
        // 1) 写 Cookie：逐条 k=v 喂给 setCookie（不能整串塞，分号会被当成属性）
        for (origin in cookies.keys()) {
            val cookieStr = cookies.optString(origin)
            cookieStr.split("; ").forEach { pair ->
                if (pair.contains('=')) cm.setCookie(origin, pair)
            }
            Log.i(TAG, "还原 Cookie → $origin (${cookieStr.split("; ").size}条)")
        }
        cm.flush()
        // 2) 排队 localStorage 注入：onPageFinished 命中 origin 时执行 + reload
        pendingRestoreLs.clear()
        for (origin in ls.keys()) {
            val entries = ls.optJSONObject(origin) ?: continue
            pendingRestoreLs[origin] =
                "var m=" + entries.toString() +
                ";for(var k in m){try{localStorage.setItem(k,m[k])}catch(e){}}'ok'"
        }
        // 3) 选一个先落到的 origin：优先当前 env
        val lsPending = pendingRestoreLs.size
        val targetOrigin = pendingRestoreLs.keys.firstOrNull { it == env.origin }
            ?: pendingRestoreLs.keys.firstOrNull()
        if (targetOrigin != null) {
            pendingRestoreReload = true
            val cur = originOf(activeWebView?.url)
            if (cur != targetOrigin) {
                activeWebView?.loadUrl("$targetOrigin/web/")
            } else {
                activeWebView?.evaluateJavascript(pendingRestoreLs.remove(targetOrigin)!!) { }
                activeWebView?.reload()
            }
            status("还原中")
        } else {
            status("Cookie 已还原（备份里无 localStorage）")
            activeWebView?.reload()
        }
        Log.i(TAG, "登录态还原：cookies=${cookies.length()}域 ls=${lsPending}域排队 target=$targetOrigin")
    }

    @Deprecated("deprecated")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data?.data == null) return
        when (requestCode) {
            REQ_SAVE_BACKUP_FILE -> {
                val json = pendingBackupJson ?: return
                runCatching {
                    contentResolver.openOutputStream(data.data!!)?.use { it.write(json.toByteArray()) }
                }.onSuccess { toast("备份已保存") }
                    .onFailure { Log.e(TAG, "写备份文件失败", it); toast("保存失败") }
                pendingBackupJson = null
            }
            REQ_PICK_BACKUP_FILE -> {
                val text = runCatching {
                    contentResolver.openInputStream(data.data!!)?.use {
                        it.readBytes().toString(Charsets.UTF_8)
                    }
                }.getOrNull()
                if (text == null) { toast("读取文件失败"); return }
                applyLoginBackup(text)
            }
        }
    }

    // ---------- 工具栏/菜单 ----------

    private fun configureToolbar() {
        binding.envSpinner.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_item,
            Env.entries.map { it.label },
        ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        binding.envSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            var initialized = false
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                if (!initialized) { initialized = true; return }
                val next = Env.entries[pos]
                if (next == env) return
                env = next
                closeCollectPage()
                activeWebView?.loadUrl("${env.origin}/web/")
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        binding.btnBack.setOnClickListener { activeWebView?.let { if (it.canGoBack()) it.goBack() } }
        binding.btnForward.setOnClickListener { activeWebView?.let { if (it.canGoForward()) it.goForward() } }
        binding.btnReload.setOnClickListener { activeWebView?.reload() }
        binding.btnDesktop.setOnClickListener {
            desktopMode = !desktopMode
            tabs.forEach { applyDesktopMode(it.webView.settings) }
            activeWebView?.reload()
            status(if (desktopMode) "已切桌面端模式" else "已切移动端模式")
        }
        binding.btnMenu.setOnClickListener { showMenu() }
    }

    private fun showMenu() {
        Log.i(TAG, "showMenu 触发")
        val items = arrayOf(
            if (desktopMode) "☑ 桌面端模式（点击切回移动端）" else "☐ 桌面端模式",
            "🔍 显示大小调节",
            "📜 历史记录",
            "📥 下载管理",
            "💾 备份登录态",
            "♻️ 还原登录态",
            "🗑 清空当前标签页数据",
        )
        AlertDialog.Builder(this)
            .setTitle("工具")
            .setItems(items) { _, i ->
                when (i) {
                    0 -> binding.btnDesktop.performClick()
                    1 -> toggleZoomBar()
                    2 -> showHistory()
                    3 -> showDownloads()
                    4 -> pickBackupTarget()
                    5 -> pickRestoreSource()
                    6 -> {
                        activeWebView?.let {
                            it.clearCache(true)
                            it.clearHistory()
                            CookieManager.getInstance().flush()
                            toast("已清空当前标签页缓存/历史")
                        }
                    }
                }
            }
            .show()
    }

    private fun pickBackupTarget() {
        AlertDialog.Builder(this)
            .setTitle("备份登录态 · 导出到")
            .setItems(arrayOf("导出到文件", "复制到剪贴板")) { _, i ->
                backupLogin(toClipboard = i == 1)
            }
            .show()
    }

    private fun pickRestoreSource() {
        AlertDialog.Builder(this)
            .setTitle("还原登录态 · 来源")
            .setItems(arrayOf("从剪贴板还原", "从文件还原")) { _, i ->
                restoreLogin(fromClipboard = i == 0)
            }
            .show()
    }

    // ---------- 显示大小 ----------

    private fun configureZoomBar() {
        binding.zoomSeek.max = 150          // 50%~200%
        binding.zoomSeek.progress = textZoom - 50
        binding.zoomLabel.text = "${textZoom}%"
        binding.zoomSeek.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: android.widget.SeekBar?, p: Int, fromUser: Boolean) {
                val zoom = p + 50
                binding.zoomLabel.text = "$zoom%"
                if (fromUser) applyZoom(zoom)
            }
            override fun onStartTrackingTouch(sb: android.widget.SeekBar?) {}
            override fun onStopTrackingTouch(sb: android.widget.SeekBar?) {}
        })
        binding.zoomReset.setOnClickListener {
            binding.zoomSeek.progress = 50
            applyZoom(100)
        }
        binding.zoomDone.setOnClickListener { toggleZoomBar() }
    }

    private fun applyZoom(zoom: Int) {
        textZoom = zoom
        tabs.forEach { it.webView.settings.textZoom = zoom }
    }

    private fun toggleZoomBar() {
        binding.zoomBar.visibility =
            if (binding.zoomBar.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    // ---------- 收集页（隐藏 WebView） ----------

    fun openCollectPage(url: String) {
        runOnUiThread {
            if (collectView == null) {
                val wv = WebView(this)
                configureWebView(wv, Tab(wv, "收集页"))
                wv.layoutParams = android.widget.FrameLayout.LayoutParams(1, 1)
                binding.collectContainer.addView(wv)
                binding.collectContainer.visibility = View.VISIBLE
                collectView = wv
            }
            collectView?.loadUrl(url)
            Log.i(TAG, "收集页打开: $url")
        }
    }

    fun closeCollectPage() {
        runOnUiThread {
            collectView?.let { it.stopLoading(); it.destroy() }
            binding.collectContainer.removeAllViews()
            binding.collectContainer.visibility = View.GONE
            collectView = null
        }
    }

    // ---------- 跨 WebView 值广播 ----------

    fun broadcastValue(name: String, json: String?) {
        evalOnAll("window.__yktBridgeValue && window.__yktBridgeValue(${JSONObject.quote(name)}, ${JSONObject.quote(json)})")
    }

    fun evalOnCollectAndMain(js: String) = evalOnAll(js)

    fun evalOnAll(js: String) {
        runOnUiThread {
            runCatching { activeWebView?.evaluateJavascript(js, null) }
            runCatching { collectView?.evaluateJavascript(js, null) }
        }
    }

    // ---------- 状态/日志 ----------

    fun status(msg: String) = runOnUiThread {
        binding.tvStatus.text = msg.take(24)
    }

    fun log(msg: String) {
        Log.i(TAG, msg)
        status(msg)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun updateNav() {
        activeWebView?.let {
            binding.btnBack.isEnabled = it.canGoBack()
            binding.btnForward.isEnabled = it.canGoForward()
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onPause() { super.onPause(); CookieManager.getInstance().flush() }

    override fun onDestroy() {
        closeCollectPage()
        tabs.forEach { it.webView.apply { stopLoading(); clearHistory(); removeAllViews(); destroy() } }
        tabs.clear()
        super.onDestroy()
    }

    @Deprecated("deprecated")
    override fun onBackPressed() {
        val wv = activeWebView
        when {
            binding.zoomBar.visibility == View.VISIBLE -> toggleZoomBar()
            wv?.canGoBack() == true -> wv.goBack()
            else -> super.onBackPressed()
        }
    }
}
