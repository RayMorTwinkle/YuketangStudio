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
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.AdapterView
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewRenderProcessClient
import com.google.android.material.bottomsheet.BottomSheetDialog
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

    // ---------- 持久化 ----------
    private val historyPrefs get() = getSharedPreferences("nav_history", Context.MODE_PRIVATE)
    private val prefs get() = getSharedPreferences("settings", Context.MODE_PRIVATE)

    // ---------- 更新检查 ----------
    private var pendingApkId: Long = -1
    private var pendingApkVersion: String = ""
    private var updateReceiver: android.content.BroadcastReceiver? = null

    private var desktopMode
        get() = prefs.getBoolean("desktopMode", false)
        set(v) { prefs.edit().putBoolean("desktopMode", v).apply() }
    private var scaleMobile       // 移动端页面缩放 50-100
        get() = prefs.getInt("scaleMobile", 100)
        set(v) { prefs.edit().putInt("scaleMobile", v).apply() }
    private var scaleDesktop      // 桌面端页面缩放 50-100
        get() = prefs.getInt("scaleDesktop", 70)
        set(v) { prefs.edit().putInt("scaleDesktop", v).apply() }
    private var envIndex
        get() = prefs.getInt("envIndex", 0)
        set(v) { prefs.edit().putInt("envIndex", v).apply() }

    private val currentScale get() = if (desktopMode) scaleDesktop else scaleMobile

    enum class Env(val label: String, val origin: String) {
        CHANGJIANG("长江雨课堂", "https://changjiang.yuketang.cn"),
        STANDARD("雨课堂", "https://www.yuketang.cn"),
        PRO("荷塘雨课堂", "https://pro.yuketang.cn"),
    }
    private var env = Env.CHANGJIANG

    /** 当前模式入口：移动端 → /m/v2，桌面端 → /web/ */
    private fun homeUrl() = if (desktopMode) "${env.origin}/web/" else "${env.origin}/m/v2"

    // ---------- 还原排队 ----------
    private val pendingRestoreLs = mutableMapOf<String, String>()  // origin→js
    private var pendingBackupJson: String? = null
    private val REQ_PICK_BACKUP_FILE = 41
    private val REQ_SAVE_BACKUP_FILE = 42

    // ---------- 账号 ----------
    private var currentAccountId: String? = null

    companion object {
        private const val TAG = "YktShell"
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        private const val BRAND = 0xFF1D63DF.toInt()
        private const val TEXT_SEC = 0xFF66718A.toInt()
        private const val TXT = 0xFF1A2233.toInt()
        private const val DIVIDER = 0xFFE5E9F0.toInt()

        // 更新检查：与脚本共用同一份 svc 元数据（版本号/下载链接唯一来源）
        private const val LATEST_URL = "https://api.raymor.top/yuketangstudio/latest"
        private const val SITE_URL = "https://app.raymor.top/yuketangstudio/"

        // jsdelivr 路径 → assets/cdn/ 本地副本（MathJax 不在列：tex-svg 会递归拉组件，需单独方案）
        private val CDN_ASSETS = mapOf(
            "npm/jspdf@2.5.1/dist/jspdf.umd.min.js" to "jspdf.umd.min.js",
            "npm/marked@9.1.6/marked.min.js" to "marked.min.js",
            "npm/dompurify@3.1.6/dist/purify.min.js" to "purify.min.js",
            "npm/mermaid@10.9.1/dist/mermaid.min.js" to "mermaid.min.js",
        )
    }

    // ============================================================
    // 生命周期
    // ============================================================

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        bridge = YktBridge(this)

        env = Env.entries[envIndex.coerceIn(0, Env.entries.size - 1)]
        shimAsset = assets.open("gm-shim.js").bufferedReader().use { it.readText() }
        scriptAsset = assets.open("yuketangstudio.user.js").bufferedReader().use { it.readText() }
        docStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        Log.i(TAG, "document-start 注入支持: $docStartSupported")

        configureToolbar()
        registerUpdateReceiver()
        configureZoomBar()
        askNotificationPermission()
        newTab(homeUrl())
        status(if (desktopMode) "桌面端" else "移动端")

        // 调试广播（仅 debug）：NAV 导航 + EVAL 注入 JS
        // am broadcast -a com.yuketangstudio.shell.NAV --es url 'https://...'
        // am broadcast -a com.yuketangstudio.shell.EVAL --es js 'document.title'
        if (BuildConfig.DEBUG) {
            registerReceiver(object : android.content.BroadcastReceiver() {
                override fun onReceive(ctx: Context?, intent: Intent?) {
                    val u = intent?.getStringExtra("url") ?: return
                    Log.i(TAG, "调试导航: $u")
                    runOnUiThread { activeWebView?.loadUrl(u) }
                }
            }, android.content.IntentFilter("com.yuketangstudio.shell.NAV"), Context.RECEIVER_EXPORTED)
            registerReceiver(object : android.content.BroadcastReceiver() {
                override fun onReceive(ctx: Context?, intent: Intent?) {
                    val js = intent?.getStringExtra("js") ?: return
                    runOnUiThread {
                        activeWebView?.evaluateJavascript(js) { r ->
                            Log.i(TAG, "EVAL 结果: $r")
                        }
                    }
                }
            }, android.content.IntentFilter("com.yuketangstudio.shell.EVAL"), Context.RECEIVER_EXPORTED)
            registerReceiver(object : android.content.BroadcastReceiver() {
                override fun onReceive(ctx: Context?, intent: Intent?) {
                    val js = intent?.getStringExtra("js") ?: return
                    runOnUiThread {
                        collectView?.evaluateJavascript(js) { r ->
                            Log.i(TAG, "EVALC 结果: $r")
                        } ?: Log.i(TAG, "EVALC: collectView 不存在")
                    }
                }
            }, android.content.IntentFilter("com.yuketangstudio.shell.EVALC"), Context.RECEIVER_EXPORTED)
        }
    }

    override fun onPause() { super.onPause(); CookieManager.getInstance().flush() }

    override fun onDestroy() {
        updateReceiver?.let { runCatching { unregisterReceiver(it) } }
        updateReceiver = null
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

    // ============================================================
    // 标签页
    // ============================================================

    @SuppressLint("SetJavaScriptEnabled")
    private fun newTab(url: String) {
        val wv = WebView(this)
        val tab = Tab(wv)
        configureWebView(wv, tab)
        wv.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
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
        switchTab(minOf(index, tabs.size - 1))
    }

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun renderTabStrip() {
        val inner = binding.tabStripInner
        inner.removeAllViews()
        tabs.forEachIndexed { i, t ->
            val active = i == activeIndex
            val chip = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundResource(if (active) R.drawable.bg_chip_active else R.drawable.bg_chip)
                setPadding(dp(12), dp(6), dp(6), dp(6))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { marginEnd = dp(6) }
                setOnClickListener { switchTab(i) }
            }
            chip.addView(TextView(this).apply {
                text = t.title.take(12).ifBlank { "页面" }
                textSize = 12f
                setTextColor(if (active) BRAND else TEXT_SEC)
                if (active) setTypeface(typeface, Typeface.BOLD)
            })
            if (tabs.size > 1) {
                chip.addView(TextView(this).apply {
                    text = "✕"
                    textSize = 11f
                    setTextColor(TEXT_SEC)
                    setPadding(dp(8), 0, dp(2), 0)
                    setOnClickListener { closeTab(i) }
                })
            }
            inner.addView(chip)
        }
        // ＋ 新建
        inner.addView(TextView(this).apply {
            text = "＋"
            textSize = 18f
            setTextColor(BRAND)
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(2), dp(12), dp(2))
            setOnClickListener { newTab(homeUrl()) }
        })
        binding.tabStrip.visibility = View.VISIBLE
        updateNav()
    }

    // ============================================================
    // WebView 配置
    // ============================================================

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
            setSupportZoom(true)
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            applyDesktopMode(this)
        }
        // 整体页面缩放（layout viewport），须在任何 loadUrl 前设置
        wv.setInitialScale(currentScale)
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

            // 设备网络常连不上 jsdelivr/cdnjs：CDN 依赖打进 assets/cdn/ 本地回源
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                val path = url.path?.removePrefix("/") ?: return null
                val mimeFor = { a: String -> when {
                    a.endsWith(".woff2") || a.endsWith(".woff") -> "font/woff2"
                    a.endsWith(".ttf") -> "font/ttf"
                    a.endsWith(".css") -> "text/css"
                    else -> "application/javascript"
                } }
                val asset = when (url.host) {
                    "cdn.jsdelivr.net" -> when {
                        path.startsWith("npm/katex@0.16.21/dist/") ->
                            "katex/" + path.removePrefix("npm/katex@0.16.21/dist/")
                        else -> CDN_ASSETS[path]
                    }
                    "cdnjs.cloudflare.com" -> when {
                        path.startsWith("ajax/libs/font-awesome/6.4.0/") ->
                            "fontawesome/" + path.removePrefix("ajax/libs/font-awesome/6.4.0/")
                        else -> null
                    }
                    "html2canvas.hertzen.com" ->
                        if (path == "dist/html2canvas.min.js") "html2canvas.min.js" else null
                    else -> null
                }
                if (asset != null) {
                    return try {
                        WebResourceResponse(mimeFor(asset), "utf-8", assets.open("cdn/$asset"))
                    } catch (e: Exception) {
                        Log.w(TAG, "CDN 本地回源失败: $asset", e); null
                    }
                }
                return super.shouldInterceptRequest(view, request)
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
                val o = originOf(url)
                if (o != null && pendingRestoreLs.containsKey(o)) {
                    val js = pendingRestoreLs.remove(o)!!
                    view.evaluateJavascript(js) { }
                    Log.i(TAG, "localStorage 已注入 $o，自动刷新")
                    view.postDelayed({ view.reload() }, 300)
                    if (pendingRestoreLs.isEmpty()) { status("还原完成"); toast("还原完成") }
                }
                val title = view.title ?: url ?: ""
                if (view === activeWebView) {
                    tab.title = title.take(20).ifBlank { "页面" }
                    renderTabStrip()
                    updateNav()
                }
                if (url != null && isYuketang(url)) {
                    recordHistory(title, url)
                    detectAccount(view, o)
                }
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
        settings.userAgentString = if (desktopMode) DESKTOP_UA else WebSettings.getDefaultUserAgent(this)
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
    }

    // ============================================================
    // 工具栏 / 菜单（BottomSheet）
    // ============================================================

    private fun configureToolbar() {
        binding.btnEnv.text = "${env.label} ▾"
        binding.btnEnv.setOnClickListener { pickEnv() }
        binding.btnBack.setOnClickListener { activeWebView?.let { if (it.canGoBack()) it.goBack() } }
        binding.btnForward.setOnClickListener { activeWebView?.let { if (it.canGoForward()) it.goForward() } }
        binding.btnReload.setOnClickListener { activeWebView?.reload() }
        binding.btnDesktop.setOnClickListener { toggleDesktopMode() }
        binding.btnMenu.setOnClickListener { showMenu() }
    }

    private fun pickEnv() {
        val labels = Env.entries.map { it.label }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("切换环境")
            .setItems(labels) { _, i ->
                val next = Env.entries[i]
                if (next == env) return@setItems
                env = next
                envIndex = i
                binding.btnEnv.text = "${env.label} ▾"
                closeCollectPage()
                activeWebView?.loadUrl(homeUrl())
                Log.i(TAG, "切换环境 → ${env.label}")
            }
            .show()
    }

    private fun toggleDesktopMode() {
        desktopMode = !desktopMode
        val scale = if (desktopMode) 70 else 100     // 用户要求：桌面端自动 70%
        if (desktopMode) scaleDesktop = scale else scaleMobile = scale
        tabs.forEach {
            applyDesktopMode(it.webView.settings)
            it.webView.setInitialScale(scale)
        }
        binding.zoomSeek.progress = scale - 50
        binding.zoomLabel.text = "$scale%"
        activeWebView?.loadUrl(homeUrl())
        status(if (desktopMode) "桌面端 70%" else "移动端")
        Log.i(TAG, "切换模式 → ${if (desktopMode) "桌面端" else "移动端"} scale=$scale")
    }

    /** BottomSheet 菜单 */
    private fun showMenu() {
        Log.i(TAG, "showMenu")
        val sheet = BottomSheetDialog(this)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(8), dp(8), dp(24))
        }
        fun row(icon: String, label: String, sub: String? = null, onClick: () -> Unit) {
            val item = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(16), dp(14), dp(16), dp(14))
                background = ripple()
                setOnClickListener { sheet.dismiss(); onClick() }
            }
            item.addView(TextView(this).apply { text = icon; textSize = 20f })
            val col = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), 0, 0, 0)
            }
            col.addView(TextView(this).apply {
                text = label; textSize = 15f; setTextColor(TXT)
            })
            if (sub != null) col.addView(TextView(this).apply {
                text = sub; textSize = 11f; setTextColor(TEXT_SEC); setPadding(0, dp(2), 0, 0)
            })
            item.addView(col)
            layout.addView(item)
        }
        fun divider() {
            layout.addView(View(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                    setMargins(dp(16), dp(4), dp(16), dp(4))
                }
                setBackgroundColor(DIVIDER)
            })
        }

        row("👤", "账号", currentAccountId?.let { id ->
            AccountStore.all(this).find { it.id == id }?.name ?: "已登录"
        } ?: "未登录") { showAccountSheet() }
        divider()
        row(if (desktopMode) "🖥️" else "📱", "切换${if (desktopMode) "移动" else "桌面"}端",
            "桌面端自动 70% 缩放") { toggleDesktopMode() }
        row("🔍", "页面缩放", "当前 ${currentScale}%（50–100%）") { toggleZoomBar() }
        divider()
        row("📜", "历史记录") { showHistory() }
        row("📥", "下载管理") { showDownloads() }
        row("📷", "扫一扫", "扫码进课堂/签到") { startScan() }
        row("📰", "动态", "查看课件/测验/公告推送") { showFeed() }
        divider()
        row("💾", "备份设置", "登录态+全部配置+账号+历史") { pickBackupTarget() }
        row("♻️", "还原设置") { pickRestoreSource() }
        divider()
        row("🔄", "检查更新", "当前 v${BuildConfig.VERSION_NAME}") { checkAppUpdate() }
        divider()
        row("🗑", "清空当前标签页数据") {
            activeWebView?.let {
                it.clearCache(true); it.clearHistory()
                CookieManager.getInstance().flush()
                toast("已清空当前标签页缓存/历史")
            }
        }
        sheet.setContentView(ScrollView(this).apply { addView(layout) })
        sheet.show()
    }

    // ============================================================
    // 检查更新（外壳侧，不依赖脚本运行）
    // ============================================================

    /**
     * 拉 svc /latest 元数据，和 BuildConfig.VERSION_NAME 比对。
     * 与脚本的 update-check.js 共用同一份元数据，版本号单一来源。
     * 有新版 → 对话框提供「下载并安装」（DownloadManager + 安装器）或「用浏览器打开」。
     */
    private fun checkAppUpdate() {
        val cur = BuildConfig.VERSION_NAME
        val dlg = AlertDialog.Builder(this)
            .setTitle("检查更新")
            .setMessage("当前版本 v$cur\n\n正在连接更新服务器…")
            .setNegativeButton("关闭", null)
            .create()
        dlg.show()

        Thread {
            var message = ""
            var apkUrl: String? = null
            var latest: String? = null
            try {
                val conn = (java.net.URL(LATEST_URL).openConnection() as java.net.HttpURLConnection).apply {
                    connectTimeout = 10000
                    readTimeout = 10000
                    instanceFollowRedirects = true
                }
                val code = conn.responseCode
                val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()
                if (code !in 200..299) {
                    message = "服务器返回 $code"
                } else {
                    val obj = org.json.JSONObject(body)
                    latest = obj.optString("version").ifBlank { null }
                    apkUrl = obj.optString("apk").ifBlank { null }
                    val notes = obj.optString("notes")
                    message = when {
                        latest == null -> "响应缺少版本号"
                        isNewer(latest, cur) ->
                            "发现新版本 v$latest（当前 v$cur）" + if (notes.isNotBlank()) "\n\n$notes" else ""
                        else -> "已是最新版本（服务器 v$latest）"
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "检查更新失败", e)
                message = "检查失败：${e.message ?: e.javaClass.simpleName}"
            }

            val hasUpdate = latest != null && isNewer(latest, cur) && !apkUrl.isNullOrBlank()
            runOnUiThread {
                if (dlg.isShowing) dlg.dismiss()
                AlertDialog.Builder(this)
                    .setTitle("检查更新")
                    .setMessage(message)
                    .apply {
                        if (hasUpdate) {
                            setPositiveButton("下载并安装") { _, _ -> downloadAndInstall(apkUrl!!, latest!!) }
                            setNeutralButton("浏览器打开") { _, _ ->
                                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl))) }
                                    .onFailure { toast("没有可用的浏览器") }
                            }
                        }
                        setNegativeButton("关闭", null)
                    }
                    .show()
            }
        }.start()
    }

    /** 语义化版本比较：a 比 b 新 → true（与前缀非数字段容错，与脚本 cmpVer 一致） */
    private fun isNewer(a: String, b: String): Boolean {
        val pa = a.split(".").map { it.toIntOrNull() ?: 0 }
        val pb = b.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val d = (pa.getOrNull(i) ?: 0) - (pb.getOrNull(i) ?: 0)
            if (d != 0) return d > 0
        }
        return false
    }

    /**
     * 注册 APK 下载完成广播：下载成功后弹窗询问是否立即安装。
     * Android 13+ 注册带包名的 receiver 需要 RECEIVER_NOT_EXPORTED（系统广播仍可收到）。
     */
    private fun registerUpdateReceiver() {
        if (updateReceiver != null) return
        val rx = object : android.content.BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                if (id <= 0 || id != pendingApkId) return
                Log.i(TAG, "APK 下载完成 id=$id version=$pendingApkVersion")
                // 校验确实下载成功（失败时 getUriForDownloadedFile 会返回 null）
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("下载完成")
                    .setMessage("新版本 v$pendingApkVersion 已下载完成，是否立即安装？")
                    .setPositiveButton("安装") { _, _ -> installApk(id) }
                    .setNegativeButton("稍后") { _, _ -> toast("安装包在「下载/YuketangStudio」") }
                    .show()
            }
        }
        updateReceiver = rx
        val filter = android.content.IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(rx, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(rx, filter)
        }
    }

    /** DownloadManager 入队下载 APK，并在完成后由 registerUpdateReceiver 拉起安装器 */
    private fun downloadAndInstall(apkUrl: String, version: String) {
        try {
            val name = "YuketangStudio-$version.apk"
            val req = DownloadManager.Request(Uri.parse(apkUrl)).apply {
                setTitle(name)
                setDescription("正在下载新版本 v$version")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, "YuketangStudio/$name")
                setMimeType("application/vnd.android.package-archive")
            }
            val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            pendingApkId = dm.enqueue(req)
            pendingApkVersion = version
            toast("开始下载 v$version，完成后自动提示安装")
            Log.i(TAG, "APK 下载中: $name <- $apkUrl")
        } catch (e: Exception) {
            Log.e(TAG, "APK 下载失败", e)
            toast("下载失败：${e.message}")
        }
    }

    /** 下载完成 → 拉起系统安装器（package installer） */
    private fun installApk(downloadId: Long) {
        try {
            val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            val uri = dm.getUriForDownloadedFile(downloadId) ?: run {
                toast("没找到已下载的安装包")
                return
            }
            startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            })
            Log.i(TAG, "拉起安装器 id=$downloadId")
        } catch (e: Exception) {
            Log.e(TAG, "拉起安装器失败", e)
            toast("无法打开安装器：${e.message}")
        }
    }

    // ============================================================
    // 扫一扫
    // ============================================================

    private fun startScan() {
        ScanActivity.onResult = { raw -> handleScanResult(raw) }
        startActivity(Intent(this, ScanActivity::class.java))
        Log.i(TAG, "打开扫一扫")
    }

    /** 扫到二维码内容 → 判断走哪条链路 */
    private fun handleScanResult(raw: String) {
        Log.i(TAG, "扫码内容: $raw")
        runOnUiThread {
            when {
                // 雨课堂二维码 → 走 app 扫描分发 API
                isYuketangQr(raw) -> dispatchYktScan(raw)
                // 其他 http 链接也直接打开（可能是班级邀请等）
                raw.startsWith("http") -> {
                    activeWebView?.loadUrl(raw)
                    status("打开链接")
                }
                else -> {
                    (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("scan", raw))
                    toast("已复制：${raw.take(30)}")
                }
            }
        }
    }

    /** 判断是否为雨课堂二维码（yuketang.cn 域下的码） */
    private fun isYuketangQr(raw: String): Boolean {
        return raw.contains("yuketang.cn") && raw.startsWith("http")
    }

    /** 调 app 的扫描分发 API：POST /api/v3/app/scan {url} → {flow,type,value} → 按 type 分发 */
    private fun dispatchYktScan(raw: String) {
        status("识别中…")
        Thread {
            try {
                val url = "${env.origin}/api/v3/app/scan"
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("x-client", "app")
                conn.setRequestProperty("xtbz", "ykt-app")
                conn.setRequestProperty("Cookie", CookieManager.getInstance().getCookie(env.origin) ?: "")
                conn.outputStream.write(JSONObject().put("url", raw).toString().toByteArray())
                val code = conn.responseCode
                val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    .bufferedReader().readText()
                Log.i(TAG, "scan api $code $body")
                runOnUiThread { handleScanDispatch(code, body, raw) }
            } catch (e: Exception) {
                Log.e(TAG, "scan api fail", e)
                runOnUiThread { toast("识别失败"); status("识别失败") }
            }
        }.start()
    }

    /** 按 scan API 返回的 type 路由 */
    private fun handleScanDispatch(code: Int, body: String, raw: String) {
        try {
            val obj = JSONObject(body)
            if (obj.optInt("code", -1) != 0) {
                toast(obj.optString("msg", "无法识别的二维码"))
                status("识别失败")
                return
            }
            val data = obj.optJSONObject("data") ?: run { toast("空结果"); return }
            val type = data.optString("type")
            val value = data.optString("value")
            Log.i(TAG, "scan type=$type value=$value")
            when (type) {
                "app_web_login" -> {
                    // 扫码登录：打开确认页（授权 web 登录）
                    activeWebView?.loadUrl("$raw&scan_result=confirm")
                    status("扫码登录")
                }
                else -> {
                    // 签到/课件/其他：value 可能是后续资源标识，先打开原链接兜底
                    toast("类型: $type")
                    activeWebView?.loadUrl(raw)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "dispatch fail", e)
            // 兜底：直接打开原始链接
            activeWebView?.loadUrl(raw)
        }
    }

    /** 动态 feed：拉 /api/v3/activities/received/ 展示推送的课件/测验/公告 */
    private fun showFeed() {
        val ctx = this
        val sheet = BottomSheetDialog(this)
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(24))
        }
        sheet.setContentView(ScrollView(this).apply { addView(list) })
        sheet.show()
        status("加载动态…")
        Thread {
            val items = fetchFeed()
            runOnUiThread {
                status("动态")
                if (items.isEmpty()) {
                    list.addView(TextView(ctx).apply {
                        text = "暂无动态"; textSize = 15f; setPadding(dp(8), dp(24), 0, dp(24))
                        gravity = Gravity.CENTER
                    })
                } else {
                    items.forEach { list.addView(feedRow(it) { sheet.dismiss() }) }
                }
            }
        }.start()
    }

    private data class FeedItem(
        val title: String, val courseName: String, val teacher: String,
        val type: Int, val time: Long, val url: String, val classroomId: String)

    private fun fetchFeed(): List<FeedItem> {
        return try {
            val conn = java.net.URL("${env.origin}/api/v3/activities/received/")
                .openConnection() as java.net.HttpURLConnection
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Cookie", CookieManager.getInstance().getCookie(env.origin) ?: "")
            conn.outputStream.write("{\"size\":30,\"type\":[]}".toByteArray())
            val d = JSONObject(conn.inputStream.bufferedReader().readText())
            if (d.optInt("code", -1) != 0) return emptyList()
            val arr = d.getJSONArray("data")
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                FeedItem(
                    title = o.optString("coursewareTitle"),
                    courseName = o.optString("courseName"),
                    teacher = o.optString("teacher"),
                    type = o.optInt("coursewareType"),
                    time = o.optLong("createTime"),
                    url = o.optString("url"),
                    classroomId = o.optString("classroomId"),
                )
            }
        } catch (e: Exception) { Log.e(TAG, "feed fail", e); emptyList() }
    }

    private fun feedRow(item: FeedItem, onOpen: () -> Unit): View {
        val typeLabel = when (item.type) {
            14 -> "课件"; 5 -> "测验"; 20 -> "测试"; 2 -> "推送"
            else -> "类型${item.type}"
        }
        val timeStr = if (item.time > 0)
            SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(item.time)) else ""
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), dp(10), dp(4), dp(10))
            background = ripple()
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(TextView(this@MainActivity).apply {
                    text = typeLabel; textSize = 11f; setTextColor(Color.WHITE)
                    background = GradientDrawable().apply {
                        setColor(0xFF5096F5.toInt()); cornerRadius = dp(4).toFloat() }
                    setPadding(dp(6), dp(2), dp(6), dp(2))
                })
                addView(TextView(this@MainActivity).apply {
                    text = "  ${item.courseName}"; textSize = 13f
                    setTextColor(0xFF666666.toInt())
                })
            })
            addView(TextView(this@MainActivity).apply {
                text = item.title; textSize = 15f; setPadding(0, dp(4), 0, dp(2))
                setTextColor(0xFF222222.toInt())
            })
            addView(TextView(this@MainActivity).apply {
                text = "${item.teacher}  $timeStr"; textSize = 12f
                setTextColor(0xFF999999.toInt())
            })
            setOnClickListener {
                // 跳详情：优先 url，否则进该课的日志页
                val target = item.url.takeIf { it.isNotBlank() }
                    ?: "${env.origin}/v2/web/studentLog/${item.classroomId}"
                activeWebView?.loadUrl(target)
                status(item.title.take(10))
                onOpen()
            }
        }
    }

    private fun ripple(): android.graphics.drawable.Drawable {
        val tv = TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true)
        return androidx.core.content.ContextCompat.getDrawable(this, tv.resourceId)
            ?: GradientDrawable()
    }

    // ============================================================
    // 账号
    // ============================================================

    /** 页面加载完成后探测登录态：有 token 且不属于任何已存 profile → 提示保存 */
    private fun detectAccount(view: WebView, origin: String?) {
        if (origin == null) return
        view.evaluateJavascript(
            "try{btoa(unescape(encodeURIComponent(JSON.stringify(localStorage))))}catch(e){''}"
        ) { raw ->
            val b64 = raw?.removeSurrounding("\"") ?: return@evaluateJavascript
            if (b64.isBlank()) return@evaluateJavascript
            val ls = runCatching {
                JSONObject(String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)))
            }.getOrNull() ?: return@evaluateJavascript
            val fp = AccountStore.fingerprint(ls)
            if (fp.isEmpty()) return@evaluateJavascript  // 未登录

            val profiles = AccountStore.all(this)
            val matched = profiles.find { it.authFingerprint() == fp }
            if (matched != null) {
                // 已存账号：静默刷新 snapshot + 记为当前
                if (currentAccountId != matched.id) {
                    currentAccountId = matched.id
                    Log.i(TAG, "识别账号: ${matched.name}")
                    status(matched.name.take(8))
                }
                refreshProfileSession(matched, ls)
                return@evaluateJavascript
            }
            // 新账号 → 提示保存
            val guess = AccountStore.guessName(ls, "账号${profiles.size + 1}")
            Log.i(TAG, "检测到新账号 guess=$guess fp=${fp.takeLast(6)}…")
            AlertDialog.Builder(this)
                .setTitle("检测到新登录账号")
                .setMessage("是否保存为「$guess」？之后可一键切换。")
                .setPositiveButton("保存") { _, _ ->
                    val p = AccountStore.Profile(
                        id = "acc_${System.currentTimeMillis()}",
                        name = guess, env = env.name, origin = origin,
                        cookies = allCookies(), localStorage = ls,
                        savedAt = System.currentTimeMillis())
                    AccountStore.upsert(this, p)
                    currentAccountId = p.id
                    status(guess.take(8))
                    toast("账号「$guess」已保存")
                }
                .setNegativeButton("暂不", null)
                .show()
        }
    }

    /** 已存账号的 session 静默刷新（token 轮换/有效期更新） */
    private fun refreshProfileSession(p: AccountStore.Profile, ls: JSONObject) {
        p.localStorage = ls
        p.cookies = allCookies()
        p.savedAt = System.currentTimeMillis()
        AccountStore.upsert(this, p)
    }

    private fun allCookies(): JSONObject {
        val cm = CookieManager.getInstance()
        val out = JSONObject()
        for (e in Env.entries) {
            cm.getCookie(e.origin)?.takeIf { it.isNotBlank() }?.let { out.put(e.origin, it) }
        }
        return out
    }

    /** 账号 BottomSheet：列表 + 保存当前 + 退出登录 */
    private fun showAccountSheet() {
        val sheet = BottomSheetDialog(this)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(16), dp(8), dp(24))
        }
        layout.addView(TextView(this).apply {
            text = "账号管理"; textSize = 17f; setTypeface(typeface, Typeface.BOLD)
            setTextColor(TXT); setPadding(dp(16), 0, 0, dp(12))
        })

        val profiles = AccountStore.all(this)
        if (profiles.isEmpty()) {
            layout.addView(TextView(this).apply {
                text = "暂无已保存账号\n登录后会自动提示保存"
                textSize = 13f; setTextColor(TEXT_SEC)
                setPadding(dp(16), 0, dp(16), dp(16))
            })
        }
        profiles.forEach { p ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(16), dp(12), dp(12), dp(12))
                background = ripple()
            }
            val col = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(TextView(this).apply {
                text = (if (p.id == currentAccountId) "● " else "") + p.name
                textSize = 15f
                setTextColor(if (p.id == currentAccountId) BRAND else TXT)
            })
            col.addView(TextView(this).apply {
                val e = Env.entries.find { it.name == p.env }?.label ?: p.env
                val d = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(p.savedAt))
                text = "$e · $d"
                textSize = 11f; setTextColor(TEXT_SEC); setPadding(0, dp(2), 0, 0)
            })
            row.addView(col)
            // 编辑 + 删除
            row.addView(TextView(this).apply {
                text = "改名"; textSize = 12f; setTextColor(TEXT_SEC); setPadding(dp(10), 0, dp(6), 0)
                setOnClickListener { sheet.dismiss(); renameAccount(p) }
            })
            row.addView(TextView(this).apply {
                text = "删除"; textSize = 12f; setTextColor(0xFFD64545.toInt()); setPadding(dp(6), 0, dp(4), 0)
                setOnClickListener { sheet.dismiss(); deleteAccount(p) }
            })
            row.setOnClickListener {
                sheet.dismiss()
                if (p.id == currentAccountId) toast("已是当前账号")
                else switchAccount(p)
            }
            layout.addView(row)
        }
        // 底部动作
        layout.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply { setMargins(dp(16), dp(8), dp(16), dp(8)) }
            setBackgroundColor(DIVIDER)
        })
        layout.addView(TextView(this).apply {
            text = "💾 保存当前登录账号"; textSize = 15f; setTextColor(BRAND)
            setPadding(dp(16), dp(12), dp(16), dp(12)); background = ripple()
            setOnClickListener { sheet.dismiss(); saveCurrentAccountManual() }
        })
        layout.addView(TextView(this).apply {
            text = "🚪 退出登录"; textSize = 15f; setTextColor(0xFFD64545.toInt())
            setPadding(dp(16), dp(12), dp(16), dp(12)); background = ripple()
            setOnClickListener { sheet.dismiss(); confirmLogout() }
        })
        sheet.setContentView(ScrollView(this).apply { addView(layout) })
        sheet.show()
    }

    private fun renameAccount(p: AccountStore.Profile) {
        val input = EditText(this).apply { setText(p.name) }
        AlertDialog.Builder(this)
            .setTitle("账号改名")
            .setView(input)
            .setPositiveButton("保存") { _, _ ->
                val name = input.text.toString().trim().ifBlank { return@setPositiveButton }
                AccountStore.rename(this, p.id, name)
                toast("已改名为「$name」")
            }
            .setNegativeButton("取消", null).show()
    }

    private fun deleteAccount(p: AccountStore.Profile) {
        AlertDialog.Builder(this)
            .setTitle("删除账号「${p.name}」")
            .setMessage("仅删除本机保存的登录快照，不会登出雨课堂。")
            .setPositiveButton("删除") { _, _ ->
                AccountStore.remove(this, p.id)
                if (currentAccountId == p.id) currentAccountId = null
                toast("已删除「${p.name}」")
            }
            .setNegativeButton("取消", null).show()
    }

    private fun saveCurrentAccountManual() {
        val wv = activeWebView ?: return
        val o = originOf(wv.url)
        if (o == null || !isYuketang(wv.url ?: "")) { toast("当前页不是雨课堂"); return }
        wv.evaluateJavascript(
            "try{btoa(unescape(encodeURIComponent(JSON.stringify(localStorage))))}catch(e){''}"
        ) { raw ->
            val b64 = raw?.removeSurrounding("\"") ?: ""
            val ls = runCatching {
                JSONObject(String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)))
            }.getOrNull() ?: JSONObject()
            if (AccountStore.fingerprint(ls).isEmpty()) { toast("当前未登录"); return@evaluateJavascript }
            val profiles = AccountStore.all(this)
            val guess = AccountStore.guessName(ls, "账号${profiles.size + 1}")
            val p = AccountStore.Profile(
                id = "acc_${System.currentTimeMillis()}",
                name = guess, env = env.name, origin = o,
                cookies = allCookies(), localStorage = ls,
                savedAt = System.currentTimeMillis())
            AccountStore.upsert(this, p)
            currentAccountId = p.id
            toast("账号「$guess」已保存")
            status(guess.take(8))
            Log.i(TAG, "手动保存账号 $guess")
        }
    }

    /** 切账号：先存当前 session 回其 profile，再注入目标 profile */
    private fun switchAccount(target: AccountStore.Profile) {
        val wv = activeWebView ?: return
        fun apply() {
            val cm = CookieManager.getInstance()
            for (origin in target.cookies.keys()) {
                target.cookies.optString(origin).split("; ").forEach { pair ->
                    if (pair.contains('=')) cm.setCookie(origin, pair)
                }
            }
            cm.flush()
            pendingRestoreLs.clear()
            val js = "var m=" + target.localStorage.toString() +
                ";for(var k in m){try{localStorage.setItem(k,m[k])}catch(e){}}'ok'"
            val tOrigin = target.origin.ifBlank { env.origin }
            pendingRestoreLs[tOrigin] = js
            val targetEnv = Env.entries.find { it.name == target.env }
            if (targetEnv != null && targetEnv != env) {
                env = targetEnv; envIndex = Env.entries.indexOf(targetEnv)
                binding.btnEnv.text = "${env.label} ▾"
            }
            currentAccountId = target.id
            status(target.name.take(8))
            if (originOf(wv.url) == tOrigin) {
                wv.evaluateJavascript(pendingRestoreLs.remove(tOrigin)!!) { }
                wv.reload()
            } else {
                wv.loadUrl(homeUrl())
            }
            toast("切换到「${target.name}」")
            Log.i(TAG, "切换账号 → ${target.name}")
        }
        // 当前有登录态就先存回去
        val curId = currentAccountId
        if (curId != null && curId != target.id) {
            wv.evaluateJavascript(
                "try{btoa(unescape(encodeURIComponent(JSON.stringify(localStorage))))}catch(e){''}"
            ) { raw ->
                runCatching {
                    val b64 = raw?.removeSurrounding("\"") ?: ""
                    if (b64.isNotBlank()) {
                        val ls = JSONObject(String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)))
                        AccountStore.all(this).find { it.id == curId }?.let {
                            refreshProfileSession(it, ls)
                        }
                    }
                }
                apply()
            }
        } else apply()
    }

    private fun confirmLogout() {
        AlertDialog.Builder(this)
            .setTitle("退出登录")
            .setMessage("清除当前登录态（Cookie + 凭证）。已保存的账号快照保留，可随时切回。")
            .setPositiveButton("退出") { _, _ -> doLogout() }
            .setNegativeButton("取消", null).show()
    }

    private fun doLogout() {
        val cm = CookieManager.getInstance()
        for (e in Env.entries) cm.setCookie(e.origin, "")
        cm.removeAllCookies { }
        cm.flush()
        // 只删 auth 系 key，保留脚本设置
        activeWebView?.evaluateJavascript(
            "try{for(var k in localStorage){var kl=k.toLowerCase();" +
            "if(kl.indexOf('authorization')>=0||kl.indexOf('token')>=0){localStorage.removeItem(k)}}'ok'}" +
            "catch(e){'e'}"
        ) { }
        currentAccountId = null
        status("已登出")
        toast("已退出登录")
        activeWebView?.loadUrl(homeUrl())
        Log.i(TAG, "退出登录")
    }

    // ============================================================
    // 历史 / 下载
    // ============================================================

    private fun showHistory() {
        Log.i(TAG, "showHistory")
        val arr = JSONArray(historyPrefs.getString("entries", "[]"))
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

    private fun recordHistory(title: String, url: String) {
        if (url.contains("/web/login") || url.contains("/v2/web/login") || url.contains("/login")) return
        try {
            val arr = JSONArray(historyPrefs.getString("entries", "[]"))
            val entry = JSONObject().put("t", title.ifBlank { url }).put("u", url).put("ts", System.currentTimeMillis())
            val next = JSONArray()
            next.put(entry)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (o.optString("u") != url) next.put(o)
            }
            val trimmed = JSONArray()
            for (i in 0 until minOf(next.length(), 300)) trimmed.put(next.getJSONObject(i))
            historyPrefs.edit().putString("entries", trimmed.toString()).apply()
        } catch (e: Exception) {
            Log.w(TAG, "写历史失败", e)
        }
    }

    private fun showDownloads() {
        val dirs = listOfNotNull(
            android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
                ?.let { java.io.File(it, "YuketangStudio") },
            getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS),
        )
        val files = dirs.flatMap { it.listFiles()?.toList() ?: emptyList() }
            .filter { it.isFile }.sortedByDescending { it.lastModified() }
        if (files.isEmpty()) { toast("暂无下载文件"); return }
        val items = files.map {
            val size = if (it.length() > 1048576) "%.1fMB".format(it.length() / 1048576f)
                       else "${it.length() / 1024}KB"
            "${it.name}\n  $size · ${SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(it.lastModified()))}"
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("下载文件")
            .setItems(items) { _, i ->
                val f = files[i]
                val uri = androidx.core.content.FileProvider.getUriForFile(this, "${packageName}.fileprovider", f)
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

    // ============================================================
    // 全量备份 / 还原
    // ============================================================

    private fun originOf(url: String?): String? = runCatching {
        val u = URI(url ?: return null)
        if (u.host == null) return null
        "${u.scheme}://${u.host}${if (u.port > 0) ":${u.port}" else ""}"
    }.getOrNull()

    private fun pickBackupTarget() {
        AlertDialog.Builder(this)
            .setTitle("备份设置 · 导出到")
            .setItems(arrayOf("导出到文件", "复制到剪贴板")) { _, i ->
                startBackup(toClipboard = i == 1)
            }
            .show()
    }

    /** 全量备份：cookies + 所有 tab 的 localStorage + prefs + history + accounts */
    private fun startBackup(toClipboard: Boolean) {
        val cookies = allCookies()
        val lsAll = JSONObject()
        // 收集所有已加载 tab 的 localStorage（同 origin 去重）
        val views = buildList {
            tabs.forEach { add(it.webView) }
            collectView?.let { add(it) }
        }.filter { isYuketang(it.url ?: "") }
        val origins = views.mapNotNull { originOf(it.url) }.distinct()
        if (origins.isEmpty()) { finishBackup(cookies, lsAll, toClipboard); return }
        var remaining = origins.size
        origins.forEach { origin ->
            val view = views.first { originOf(it.url) == origin }
            view.evaluateJavascript(
                "try{btoa(unescape(encodeURIComponent(JSON.stringify(localStorage))))}catch(e){''}"
            ) { raw ->
                runCatching {
                    val b64 = raw?.removeSurrounding("\"") ?: ""
                    if (b64.isNotBlank()) {
                        lsAll.put(origin, JSONObject(
                            String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT))))
                    }
                }
                if (--remaining == 0) finishBackup(cookies, lsAll, toClipboard)
            }
        }
    }

    private fun finishBackup(cookies: JSONObject, ls: JSONObject, toClipboard: Boolean) {
        // prefs 全量导出（含默认值，保证还原后行为一致）
        val prefsJson = JSONObject()
            .put("desktopMode", desktopMode)
            .put("scaleMobile", scaleMobile)
            .put("scaleDesktop", scaleDesktop)
            .put("envIndex", envIndex)
        val accountsArr = JSONArray()
        AccountStore.all(this).forEach { accountsArr.put(it.toJson()) }
        val doc = JSONObject()
            .put("app", "yktstudio-backup")
            .put("version", 2)
            .put("savedAt", System.currentTimeMillis())
            .put("env", env.name)
            .put("cookies", cookies)
            .put("localStorage", ls)
            .put("prefs", prefsJson)
            .put("history", JSONArray(historyPrefs.getString("entries", "[]")))
            .put("accounts", accountsArr)
        val text = doc.toString(2)
        Log.i(TAG, "备份生成: cookies=${cookies.length()}域 ls=${ls.length()}域 " +
            "prefs=${prefsJson.length()}项 accounts=${accountsArr.length()}个 size=${text.length}B")
        if (toClipboard) {
            AlertDialog.Builder(this)
                .setTitle("备份到剪贴板")
                .setMessage("备份含登录凭证与全部设置，任何拿到它的人都能登录你的账号。确定复制？")
                .setPositiveButton("复制") { _, _ ->
                    (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("yktstudio-backup", text))
                    toast("已复制备份到剪贴板")
                }
                .setNegativeButton("取消", null).show()
        } else {
            pendingBackupJson = text
            runCatching {
                startActivityForResult(
                    Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "application/json"
                        putExtra(Intent.EXTRA_TITLE, "yktstudio-backup.json")
                    }, REQ_SAVE_BACKUP_FILE)
            }.onFailure {
                Log.e(TAG, "SAF 创建文件失败", it)
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText("yktstudio-backup", text))
                toast("无法打开文件选择器，已复制到剪贴板")
            }
        }
    }

    private fun pickRestoreSource() {
        AlertDialog.Builder(this)
            .setTitle("还原设置 · 来源")
            .setItems(arrayOf("从剪贴板还原", "从文件还原")) { _, i ->
                if (i == 0) {
                    val clip = (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                    val text = clip.primaryClip?.getItemAt(0)?.text?.toString()
                    if (text.isNullOrBlank()) { toast("剪贴板为空"); return@setItems }
                    applyBackup(text)
                } else {
                    runCatching {
                        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
                        }, REQ_PICK_BACKUP_FILE)
                    }.onFailure { toast("无法打开文件选择器") }
                }
            }
            .show()
    }

    private fun applyBackup(text: String) {
        val doc = runCatching { JSONObject(text) }.getOrElse {
            toast("备份文件不是合法 JSON"); return
        }
        val app = doc.optString("app")
        if (app != "yktstudio-backup" && app != "yuketangstudio-login-backup") {
            toast("不是 YuketangStudio 备份文件"); return
        }
        val v2 = app == "yktstudio-backup"
        val cookies = doc.optJSONObject("cookies") ?: JSONObject()
        val ls = doc.optJSONObject("localStorage") ?: JSONObject()
        val extra = if (v2)
            "（含 ${doc.optJSONObject("prefs")?.length() ?: 0} 项设置、" +
            "${doc.optJSONArray("accounts")?.length() ?: 0} 个账号、" +
            "${doc.optJSONArray("history")?.length() ?: 0} 条历史）"
        else ""
        AlertDialog.Builder(this)
            .setTitle("还原设置")
            .setMessage("将覆盖 Cookie、本地存储${extra}。确定继续？")
            .setPositiveButton("还原") { _, _ -> doFullRestore(doc, v2) }
            .setNegativeButton("取消", null).show()
    }

    private fun doFullRestore(doc: JSONObject, v2: Boolean) {
        // prefs
        if (v2) {
            doc.optJSONObject("prefs")?.let { p ->
                val e = prefs.edit()
                for (k in p.keys()) {
                    when (val v = p.get(k)) {
                        is Boolean -> e.putBoolean(k, v)
                        is Int -> e.putInt(k, v)
                        is String -> e.putString(k, v)
                        else -> {}
                    }
                }
                e.apply()
            }
            doc.optJSONArray("history")?.let {
                historyPrefs.edit().putString("entries", it.toString()).apply()
            }
            doc.optJSONArray("accounts")?.let { arr ->
                val list = mutableListOf<AccountStore.Profile>()
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    list += AccountStore.Profile(
                        id = o.optString("id"), name = o.optString("name"),
                        env = o.optString("env"), origin = o.optString("origin"),
                        cookies = o.optJSONObject("cookies") ?: JSONObject(),
                        localStorage = o.optJSONObject("localStorage") ?: JSONObject(),
                        savedAt = o.optLong("savedAt"))
                }
                AccountStore.save(this, list)
            }
            // env 同步 UI
            env = Env.entries[envIndex.coerceIn(0, Env.entries.size - 1)]
            binding.btnEnv.text = "${env.label} ▾"
        }
        // cookies + localStorage
        doRestore(doc.optJSONObject("cookies") ?: JSONObject(),
                  doc.optJSONObject("localStorage") ?: JSONObject())
    }

    private fun doRestore(cookies: JSONObject, ls: JSONObject) {
        val cm = CookieManager.getInstance()
        for (origin in cookies.keys()) {
            cookies.optString(origin).split("; ").forEach { pair ->
                if (pair.contains('=')) cm.setCookie(origin, pair)
            }
        }
        cm.flush()
        pendingRestoreLs.clear()
        for (origin in ls.keys()) {
            val entries = ls.optJSONObject(origin) ?: continue
            pendingRestoreLs[origin] =
                "var m=" + entries.toString() +
                ";for(var k in m){try{localStorage.setItem(k,m[k])}catch(e){}}'ok'"
        }
        val lsPending = pendingRestoreLs.size
        val targetOrigin = pendingRestoreLs.keys.firstOrNull { it == env.origin }
            ?: pendingRestoreLs.keys.firstOrNull()
        if (targetOrigin != null) {
            val cur = originOf(activeWebView?.url)
            if (cur != targetOrigin) {
                activeWebView?.loadUrl("$targetOrigin/web/")
            } else {
                activeWebView?.evaluateJavascript(pendingRestoreLs.remove(targetOrigin)!!) { }
                activeWebView?.reload()
            }
            status("还原中")
        } else {
            activeWebView?.reload()
        }
        Log.i(TAG, "还原：cookies=${cookies.length()}域 ls=${lsPending}域排队 target=$targetOrigin")
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
                applyBackup(text)
            }
        }
    }

    // ============================================================
    // 页面缩放
    // ============================================================

    private fun configureZoomBar() {
        binding.zoomSeek.max = 50            // 50%–100%
        binding.zoomSeek.progress = currentScale - 50
        binding.zoomLabel.text = "${currentScale}%"
        binding.zoomSeek.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: android.widget.SeekBar?, p: Int, fromUser: Boolean) {
                binding.zoomLabel.text = "${p + 50}%"
            }
            override fun onStartTrackingTouch(sb: android.widget.SeekBar?) {}
            override fun onStopTrackingTouch(sb: android.widget.SeekBar?) {
                // 松手才应用（setInitialScale 必须 reload 才生效，拖动中应用会打断流式）
                applyScale(sb?.progress?.plus(50) ?: 100)
            }
        })
        binding.zoomReset.setOnClickListener {
            binding.zoomSeek.progress = 50
            binding.zoomLabel.text = "100%"
            applyScale(100)
        }
        binding.zoomDone.setOnClickListener { toggleZoomBar() }
    }

    private fun applyScale(scale: Int) {
        if (desktopMode) scaleDesktop = scale else scaleMobile = scale
        tabs.forEach { it.webView.setInitialScale(scale) }
        activeWebView?.reload()
        status("缩放 ${scale}%")
        Log.i(TAG, "页面缩放 → $scale% (${if (desktopMode) "桌面" else "移动"}端)")
    }

    private fun toggleZoomBar() {
        binding.zoomBar.visibility =
            if (binding.zoomBar.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    // ============================================================
    // 收集页 / 桥接
    // ============================================================

    fun openCollectPage(url: String) {
        runOnUiThread {
            if (collectView == null) {
                val wv = WebView(this)
                configureWebView(wv, Tab(wv, "收集页"))
                // 收集页是隐藏后台窗口：强制桌面 UA —— 雨课堂前端会按 UA 把
                // /v2/web/* 页面 JS 重定向回 /m/v2，移动端 UA 下收集器永远跑不起来
                wv.settings.userAgentString = DESKTOP_UA
                wv.layoutParams = FrameLayout.LayoutParams(1, 1)
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

    // ============================================================
    // 状态 / 工具
    // ============================================================

    fun status(msg: String) = runOnUiThread {
        binding.tvStatus.text = msg.take(12)
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

    private fun isYuketang(url: String): Boolean = runCatching {
        val host = URI(url).host?.lowercase() ?: return false
        URI(url).scheme.equals("https", true) && (host == "yuketang.cn" || host.endsWith(".yuketang.cn"))
    }.getOrDefault(false)

    private fun handleNavigation(url: String): Boolean {
        if (isYuketang(url) || url.startsWith("about:")) return false
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        return true
    }
}
