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
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
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
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
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
        var lastUrl: String = ""
        var recovering = false
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

    // 更新下载页：进度轮询 + 页面引用
    private val uiHandler = Handler(Looper.getMainLooper())
    private var updateSheet: BottomSheetDialog? = null
    private var updatePoll: Runnable? = null
    // 未授权“安装未知应用”时暂存安装目标，授权返回后自动继续
    private var pendingInstallUri: Uri? = null
    private var pendingInstallPath: String? = null
    private var runtimePingReceiver: android.content.BroadcastReceiver? = null

    // ---------- 原生设置 ----------
    private var settingsSheet: BottomSheetDialog? = null
    private var settingsRuntimeSwitch: SwitchCompat? = null
    private var settingsStrongSwitch: SwitchCompat? = null
    private var settingsBatteryButton: Button? = null
    private var settingsBatteryText: TextView? = null
    private var settingsStatusText: TextView? = null
    private var settingsRefreshTask: Runnable? = null
    private var settingsRefreshing = false

    private var desktopMode
        get() = prefs.getBoolean("desktopMode", false)
        set(v) { prefs.edit().putBoolean("desktopMode", v).apply() }
    // 更新渠道：stable（默认，老版本没有该字段也走 stable）/ beta
    private var updateChannel
        get() = prefs.getString("updateChannel", "stable") ?: "stable"
        set(v) { prefs.edit().putString("updateChannel", v).apply() }
    private var envIndex
        get() = prefs.getInt("envIndex", 0)
        set(v) { prefs.edit().putInt("envIndex", v).apply() }

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
    // 持久化：之前只是内存变量，重启后「账号」显示未登录、也无法把当前 session
    // 存回正确的 profile
    private var currentAccountId: String?
        get() = prefs.getString("account.currentId", null)
        set(v) { prefs.edit().putString("account.currentId", v).apply() }

    /** 用户点过「暂不」的账号指纹：同一账号不再反复弹窗 */
    private fun ignoredFps(): MutableSet<String> =
        prefs.getStringSet("account.ignoredFps", mutableSetOf())!!.toMutableSet()

    private fun ignoreFp(fp: String) {
        prefs.edit().putStringSet("account.ignoredFps", ignoredFps().apply { add(fp) }).apply()
    }

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
        registerRuntimePingReceiver()
        askNotificationPermission()
        newTab(homeUrl())
        // 后台服务由外壳拥有：上次开启过且进程被系统回收后，本次冷启动恢复。
        if (RuntimeState.read(this).optBoolean("enabled", false)) {
            BackgroundRuntimeService.start(
                this,
                RuntimeState.read(this).optBoolean("strong", false),
            )
        }
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

        // 冷启动：从「更新通知」点进来时直接弹检查更新
        if (savedInstanceState == null) handleIntentAction(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntentAction(intent)
    }

    /** 通知点击携带的 action（如 check_update） */
    private fun handleIntentAction(intent: Intent?) {
        val action = intent?.getStringExtra("ykt_action") ?: return
        intent.removeExtra("ykt_action")
        Log.i(TAG, "通知 action: $action")
        if (action == "check_update") {
            if (!autoCheckAllowed()) {
                Log.i(TAG, "自动检查更新已关闭/暂停")
                return
            }
            binding.root.postDelayed({
                if (!isFinishing && !isDestroyed) checkAppUpdate()
            }, 600)
        }
    }

    override fun onPause() { super.onPause(); CookieManager.getInstance().flush() }

    override fun onDestroy() {
        stopUpdatePoll()
        runCatching { updateSheet?.dismiss() }
        updateSheet = null
        updateReceiver?.let { runCatching { unregisterReceiver(it) } }
        updateReceiver = null
        runtimePingReceiver?.let { runCatching { unregisterReceiver(it) } }
        runtimePingReceiver = null
        closeCollectPage()
        tabs.forEach { it.webView.apply { stopLoading(); clearHistory(); removeAllViews(); destroy() } }
        tabs.clear()
        super.onDestroy()
    }

    @Deprecated("deprecated")
    override fun onBackPressed() {
        val wv = activeWebView
        when {
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
        tab.lastUrl = url
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
        wv.addJavascriptInterface(bridge, "YktBridge")
        // 明确使用重要渲染优先级；这是 WebView 的默认策略，写上便于审查和后续回退。
        if (Build.VERSION.SDK_INT >= 26) {
            runCatching { wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false) }
        }

        val combined = shimAsset + "\n;\n" + scriptAsset
        if (docStartSupported) {
            try {
                WebViewCompat.addDocumentStartJavaScript(
                    wv, combined,
                    setOf(
                        "https://changjiang.yuketang.cn",
                        "https://www.yuketang.cn",
                        "https://pro.yuketang.cn",
                        "https://changjiang-exam.yuketang.cn",
                        "https://tsinghua-exam.yuketang.cn",
                        "https://examination.xuetangx.com",
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

            override fun onRenderProcessGone(
                view: WebView,
                detail: android.webkit.RenderProcessGoneDetail,
            ): Boolean {
                Log.e(TAG, "WebView Renderer 已退出 didCrash=${detail.didCrash()}")
                BackgroundRuntimeService.reportRendererState(this@MainActivity, "gone")
                if (view === collectView) {
                    closeCollectPage()
                    return true
                }
                val target = tabs.firstOrNull { it.webView === view }
                if (target != null) {
                    runOnUiThread { recoverTabAfterRendererGone(target) }
                }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (!url.isNullOrBlank()) tab.lastUrl = url
                BackgroundRuntimeService.reportRendererState(this@MainActivity, "responsive")
                if (!docStartSupported && url != null && isYuketang(url) && !tab.fallbackInjected) {
                    tab.fallbackInjected = true
                    view.evaluateJavascript(combined, null)
                    Log.i(TAG, "evaluateJavascript 降级注入: $url")
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (!url.isNullOrBlank()) tab.lastUrl = url
                BackgroundRuntimeService.reportRendererState(this@MainActivity, "responsive")
                CookieManager.getInstance().flush()
                // 桌面端固定 1440px 视口；双指缩放由 WebSettings 支持
                if (desktopMode) {
                    view.evaluateJavascript(
                        "(function(){var m=document.querySelector('meta[name=viewport]');" +
                        "if(!m){m=document.createElement('meta');m.setAttribute('name','viewport');document.head.appendChild(m);}" +
                        "m.setAttribute('content','width=1440');})();", null
                    )
                }
                if (view === activeWebView) {
                    syncUpdateChannelToScript()
                    syncUpdatePolicyToScript()
                }
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
                    BackgroundRuntimeService.reportRendererState(this@MainActivity, "unresponsive")
                    status("页面无响应，后台监听会保留状态")
                }
                override fun onRenderProcessResponsive(view: WebView, renderer: androidx.webkit.WebViewRenderProcess?) {
                    BackgroundRuntimeService.reportRendererState(this@MainActivity, "responsive")
                }
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

    /**
     * Renderer 被系统回收/崩溃后，保留原来的 tab 位置和 URL，换一个 WebView 重新加载。
     * 不复制页面内存状态；会明确标记这是恢复后的页面，避免假装什么都没发生。
     */
    private fun recoverTabAfterRendererGone(tab: Tab) {
        if (tab.recovering || tabs.none { it === tab }) return
        tab.recovering = true
        val index = tabs.indexOf(tab)
        val url = tab.lastUrl.ifBlank { homeUrl() }
        try {
            binding.tabContainer.removeView(tab.webView)
            tabs.removeAt(index)
            tab.webView.destroy()

            val wv = WebView(this)
            val replacement = Tab(wv, tab.title)
            replacement.lastUrl = url
            configureWebView(wv, replacement)
            wv.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            binding.tabContainer.addView(wv)
            tabs.add(index.coerceIn(0, tabs.size), replacement)
            switchTab(tabs.indexOf(replacement))
            wv.loadUrl(url)
            status("页面已恢复，请确认课堂状态")
            Log.i(TAG, "Renderer 恢复 → $url")
        } catch (e: Throwable) {
            Log.e(TAG, "Renderer 恢复失败", e)
            status("页面恢复失败，请重新打开课堂")
        }
    }

    private fun applyDesktopMode(settings: WebSettings) {
        settings.userAgentString = if (desktopMode) DESKTOP_UA else WebSettings.getDefaultUserAgent(this)
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        // 桌面端固定 1440px 视口（见 onPageFinished 注入），用双指缩放代替页面缩放
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
    }

    // ============================================================
    // 工具栏 / 菜单（BottomSheet）
    // ============================================================

    /** 前台服务 → 页面 JS 的反向心跳；没有响应时服务会显示脚本失联。 */
    private fun registerRuntimePingReceiver() {
        if (runtimePingReceiver != null) return
        val rx = object : android.content.BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                for (tab in tabs.toList()) {
                    runCatching {
                        tab.webView.evaluateJavascript(
                            "window.__yktRuntimePing && window.__yktRuntimePing()",
                            null,
                        )
                    }
                }
            }
        }
        runtimePingReceiver = rx
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(rx, android.content.IntentFilter(BackgroundRuntimeService.ACTION_PING), Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(rx, android.content.IntentFilter(BackgroundRuntimeService.ACTION_PING))
            }
        } catch (e: Throwable) {
            runtimePingReceiver = null
            Log.w(TAG, "register runtime ping receiver failed", e)
        }
    }

    private fun configureToolbar() {
        binding.btnBack.setOnClickListener { activeWebView?.let { if (it.canGoBack()) it.goBack() } }
        binding.btnForward.setOnClickListener { activeWebView?.let { if (it.canGoForward()) it.goForward() } }
        binding.btnReload.setOnClickListener { activeWebView?.reload() }
        binding.btnAccount.setOnClickListener { showAccountSheet() }
        binding.btnFeed.setOnClickListener { showFeed() }
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
                status("已切换到 ${env.label}")
                closeCollectPage()
                activeWebView?.loadUrl(homeUrl())
                Log.i(TAG, "切换环境 → ${env.label}")
            }
            .show()
    }

    private fun toggleDesktopMode() {
        desktopMode = !desktopMode
        tabs.forEach { applyDesktopMode(it.webView.settings) }
        activeWebView?.loadUrl(homeUrl())
        status(if (desktopMode) "桌面端 1440px" else "移动端")
        Log.i(TAG, "切换模式 → ${if (desktopMode) "桌面端 1440px" else "移动端"}")
    }

    /**
     * 统一底部面板基座：标题 + 关闭 + 可滚动内容。
     *
     * 关键：isDraggable=false —— 之前用 BottomSheetDialog 默认手势，竖向滑动会被
     * 面板当成「拖拽收起」，结果只能下滑不能上滑，还会把事件穿透到下层
     * （实测滑一下就打开了扫一扫）。禁用拖拽后所有竖向手势交给 ScrollView。
     */
    private fun showSheet(title: String, build: (LinearLayout) -> Unit): BottomSheetDialog {
        val sheet = BottomSheetDialog(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = androidx.core.content.ContextCompat.getDrawable(this@MainActivity, R.drawable.bg_sheet)
        }
        // 顶部拖拽指示条（纯装饰，不响应手势）
        root.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(36), dp(4)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = dp(8)
                bottomMargin = dp(2)
            }
            background = GradientDrawable().apply {
                setColor(0xFFD8DEE9.toInt()); cornerRadius = dp(2).toFloat()
            }
        })
        // 标题 + 关闭
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(2), dp(6), dp(6))
        }
        header.addView(TextView(this).apply {
            text = title; textSize = 17f
            setTypeface(typeface, Typeface.BOLD); setTextColor(TXT)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        header.addView(ImageButton(this).apply {
            setImageResource(R.drawable.ic_close)
            background = ripple()
            val pad = dp(8)
            setPadding(pad, pad, pad, pad)
            layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
            contentDescription = "关闭"
            setOnClickListener { sheet.dismiss() }
        })
        root.addView(header)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), 0, dp(8), dp(24))
        }
        root.addView(ScrollView(this).apply {
            isFillViewport = true
            addView(content)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        build(content)
        sheet.setContentView(root)
        sheet.setOnDismissListener { if (activeSheet === sheet) activeSheet = null }
        activeSheet = sheet

        sheet.behavior.isDraggable = false
        sheet.behavior.skipCollapsed = true
        sheet.behavior.peekHeight = (resources.displayMetrics.heightPixels * 0.88f).toInt()
        sheet.show()
        sheet.behavior.state = com.google.android.material.bottomsheet.BottomSheetBehavior.STATE_EXPANDED
        return sheet
    }

    /** 面板里的一行（图标 + 标题 + 副标题） */
    private fun sheetRow(
        parent: LinearLayout, icon: String, label: String, sub: String? = null,
        dismissOnClick: Boolean = true, onClick: () -> Unit
    ) {
        val item = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(13), dp(16), dp(13))
            background = ripple()
            setOnClickListener {
                if (dismissOnClick) dismissSheet()
                onClick()
            }
        }
        item.addView(TextView(this).apply { text = icon; textSize = 19f })
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, 0, 0)
        }
        col.addView(TextView(this).apply { text = label; textSize = 15f; setTextColor(TXT) })
        if (sub != null) col.addView(TextView(this).apply {
            text = sub; textSize = 11f; setTextColor(TEXT_SEC); setPadding(0, dp(2), 0, 0)
        })
        item.addView(col)
        parent.addView(item)
    }

    private fun sheetDivider(parent: LinearLayout) {
        parent.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                setMargins(dp(16), dp(4), dp(16), dp(4))
            }
            setBackgroundColor(DIVIDER)
        })
    }

    /** 菜单 */
    private fun showMenu() {
        Log.i(TAG, "showMenu")
        showSheet("菜单") { layout ->
            sheetRow(layout, "🌐", "切换环境", "当前：${env.label}") { pickEnv() }
            sheetRow(layout, "👤", "账号", currentAccountId?.let { id ->
                AccountStore.all(this).find { it.id == id }?.name ?: "已登录"
            } ?: "未登录") { showAccountSheet() }
            sheetDivider(layout)
            sheetRow(layout, if (desktopMode) "🖥️" else "📱", "切换${if (desktopMode) "移动" else "桌面"}端",
                "桌面端自动 70% 缩放") { toggleDesktopMode() }
            sheetRow(layout, "⚙️", "设置", "后台、更新、备份与界面") { showSettingsSheet() }
            sheetDivider(layout)
            sheetRow(layout, "📜", "历史记录") { showHistory() }
            sheetRow(layout, "📥", "下载管理") { showDownloads() }
            sheetRow(layout, "📷", "扫一扫", "扫码进课堂/签到") { startScan() }
            sheetRow(layout, "📰", "动态", "查看课件/测验/公告推送") { showFeed() }
            sheetDivider(layout)
            sheetRow(layout, "ℹ️", "关于", "版本 v${BuildConfig.VERSION_NAME} · 官网 / GitHub") { showAboutSheet() }
            sheetDivider(layout)
            sheetRow(layout, "🗑", "清空当前标签页数据") {
                activeWebView?.let {
                    it.clearCache(true); it.clearHistory()
                    CookieManager.getInstance().flush()
                    toast("已清空当前标签页缓存/历史")
                }
            }
        }
    }

    // ============================================================
    // 原生设置
    // ============================================================

    /** 设置里的分组标题，比 sectionTitle 更突出。 */
    private fun settingsSection(parent: LinearLayout, title: String) {
        parent.addView(TextView(this).apply {
            text = title
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(TEXT_SEC)
            setPadding(dp(16), dp(14), dp(16), dp(4))
        })
    }

    /** 带开关的设置行。点击图标/文字也能切换，整行不会被 BottomSheet 吃掉。 */
    private fun sheetSwitchRow(
        parent: LinearLayout,
        icon: String,
        label: String,
        sub: String?,
        checked: Boolean,
        onChange: (Boolean) -> Unit,
    ): SwitchCompat {
        val item = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(10))
            background = ripple()
        }
        item.addView(TextView(this).apply { text = icon; textSize = 19f })
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, dp(10), 0)
        }
        col.addView(TextView(this).apply { text = label; textSize = 15f; setTextColor(TXT) })
        if (sub != null) col.addView(TextView(this).apply {
            text = sub; textSize = 11f; setTextColor(TEXT_SEC); setPadding(0, dp(2), 0, 0)
        })
        item.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val sw = SwitchCompat(this).apply {
            isChecked = checked
            isClickable = true
            setOnCheckedChangeListener { _, value ->
                if (!settingsRefreshing) onChange(value)
            }
        }
        item.addView(sw)
        col.setOnClickListener { sw.toggle() }
        item.getChildAt(0).setOnClickListener { sw.toggle() }
        parent.addView(item)
        return sw
    }

    /** 只读的设置行，右侧显示当前值/状态。 */
    private fun sheetValueRow(
        parent: LinearLayout,
        icon: String,
        label: String,
        sub: String?,
        value: String,
    ): TextView {
        val item = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }
        item.addView(TextView(this).apply { text = icon; textSize = 19f })
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, dp(10), 0)
        }
        col.addView(TextView(this).apply { text = label; textSize = 15f; setTextColor(TXT) })
        if (sub != null) col.addView(TextView(this).apply {
            text = sub; textSize = 11f; setTextColor(TEXT_SEC); setPadding(0, dp(2), 0, 0)
        })
        item.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val valueView = TextView(this).apply {
            text = value
            textSize = 12f
            setTextColor(TEXT_SEC)
            gravity = Gravity.END
            maxWidth = dp(150)
        }
        item.addView(valueView)
        parent.addView(item)
        return valueView
    }

    /** 运行状态块：多行文本放在标题下方，避免窄屏右侧被挤成一条。 */
    private fun sheetStatusBlock(
        parent: LinearLayout,
        icon: String,
        label: String,
        sub: String?,
    ): TextView {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(TextView(this).apply { text = icon; textSize = 19f })
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, 0, 0)
        }
        col.addView(TextView(this).apply { text = label; textSize = 15f; setTextColor(TXT) })
        if (sub != null) col.addView(TextView(this).apply {
            text = sub; textSize = 11f; setTextColor(TEXT_SEC); setPadding(0, dp(2), 0, 0)
        })
        head.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        wrap.addView(head)
        val value = TextView(this).apply {
            text = "读取中…"
            textSize = 12f
            setTextColor(TEXT_SEC)
            setPadding(dp(12), dp(9), dp(12), dp(9))
            background = GradientDrawable().apply {
                setColor(0xFFF8FAFC.toInt())
                cornerRadius = dp(9).toFloat()
                setStroke(dp(1), 0xFFE5E9F2.toInt())
            }
        }
        wrap.addView(value, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(8) })
        parent.addView(wrap)
        return value
    }

    /** 设置里的按钮行，不关闭设置面板。 */
    private fun sheetButtonRow(parent: LinearLayout, text: String, onClick: () -> Unit): Button {
        val button = Button(this).apply {
            this.text = text
            textSize = 12f
            setOnClickListener { onClick() }
        }
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(dp(16), dp(2), dp(16), dp(8))
        }
        wrap.addView(button, LinearLayout.LayoutParams(dp(132), dp(36)))
        parent.addView(wrap)
        return button
    }

    private fun showSettingsSheet() {
        stopSettingsRefresh()
        settingsRuntimeSwitch = null
        settingsStrongSwitch = null
        settingsBatteryButton = null
        settingsBatteryText = null
        settingsStatusText = null

        val sheet = showSheet("设置") { layout ->
            settingsSection(layout, "后台运行")
            settingsRuntimeSwitch = sheetSwitchRow(
                layout, "🛰️", "开启后台监听",
                "提高进程优先级并显示常驻通知；不代表 WebView 一定在线。",
                RuntimeState.read(this).optBoolean("enabled", false),
            ) { enabled ->
                if (enabled) {
                    val strong = settingsStrongSwitch?.isChecked == true
                    if (!BackgroundRuntimeService.start(this, strong)) {
                        toast("后台服务启动失败，请查看系统通知权限/日志")
                    }
                } else {
                    BackgroundRuntimeService.stop(this)
                }
                refreshSettingsUi()
            }
            settingsStrongSwitch = sheetSwitchRow(
                layout, "🔒", "强力保活",
                "持有 Partial WakeLock / Wi-Fi Lock；更稳但更耗电。",
                RuntimeState.read(this).optBoolean("strong", false),
            ) { strong ->
                BackgroundRuntimeService.setStrong(this, strong)
                refreshSettingsUi()
            }
            settingsBatteryText = sheetValueRow(
                layout, "🔋", "电池优化", "允许后台运行可减少系统休眠时回收。",
                if (isIgnoringBatteryOptimizations()) "已允许" else "未允许",
            )
            settingsBatteryButton = sheetButtonRow(layout, "去授权") {
                requestIgnoreBatteryOptimizations()
                uiHandler.postDelayed({ refreshSettingsUi() }, 800)
            }
            settingsStatusText = sheetStatusBlock(
                layout, "📡", "运行状态", "服务、脚本心跳与最近课堂事件。",
            )

            settingsSection(layout, "更新")
            sheetRow(layout, "🔄", "检查更新", "当前 v${BuildConfig.VERSION_NAME}", dismissOnClick = false) {
                checkAppUpdate()
            }
            sheetRow(layout, "📡", "更新渠道",
                if (updateChannel == "beta") "测试版（尝鲜）" else "稳定版（推荐）",
                dismissOnClick = false) { pickUpdateChannel() }
            sheetRow(layout, "🔔", "自动检查更新", autoCheckSummary(), dismissOnClick = false) {
                pickAutoCheckPolicy()
            }

            settingsSection(layout, "数据")
            sheetRow(layout, "💾", "备份设置", "登录态 + 全部配置 + 账号 + 历史",
                dismissOnClick = false) { pickBackupTarget() }
            sheetRow(layout, "♻️", "还原设置", "从文件或剪贴板恢复",
                dismissOnClick = false) { pickRestoreSource() }

            settingsSection(layout, "界面")
            sheetRow(layout, "🌐", "切换环境", "当前：${env.label}", dismissOnClick = false) { pickEnv() }
            sheetRow(layout, if (desktopMode) "🖥️" else "📱",
                "切换${if (desktopMode) "移动" else "桌面"}端",
                "桌面端自动 70% 缩放", dismissOnClick = false) { toggleDesktopMode() }

            settingsSection(layout, "关于")
            sheetRow(layout, "ℹ️", "关于 YuketangStudio",
                "版本 v${BuildConfig.VERSION_NAME} · 官网 / GitHub") { showAboutSheet() }
        }

        settingsSheet = sheet
        sheet.setOnDismissListener {
            if (activeSheet === sheet) activeSheet = null
            if (settingsSheet === sheet) {
                settingsSheet = null
                stopSettingsRefresh()
                settingsRuntimeSwitch = null
                settingsStrongSwitch = null
                settingsBatteryButton = null
                settingsBatteryText = null
                settingsStatusText = null
            }
        }
        refreshSettingsUi()
        startSettingsRefresh()
    }

    private fun startSettingsRefresh() {
        stopSettingsRefresh()
        val task = object : Runnable {
            override fun run() {
                if (settingsSheet?.isShowing != true) return
                refreshSettingsUi()
                settingsRefreshTask = this
                uiHandler.postDelayed(this, 2_000L)
            }
        }
        settingsRefreshTask = task
        uiHandler.post(task)
    }

    private fun stopSettingsRefresh() {
        settingsRefreshTask?.let { uiHandler.removeCallbacks(it) }
        settingsRefreshTask = null
    }

    private fun refreshSettingsUi() {
        val state = runCatching {
            JSONObject(BackgroundRuntimeService.snapshot(this))
        }.getOrNull() ?: JSONObject()
        val enabled = state.optBoolean("enabled", false)
        val running = state.optBoolean("running", false)
        val strong = state.optBoolean("strong", false)
        val age = state.optLong("heartbeatAgeMs", -1L)
        settingsRefreshing = true
        settingsRuntimeSwitch?.isChecked = enabled
        settingsStrongSwitch?.isChecked = strong
        settingsStrongSwitch?.isEnabled = enabled
        settingsRefreshing = false

        val batteryIgnored = isIgnoringBatteryOptimizations()
        settingsBatteryText?.text = if (batteryIgnored) "已允许" else "未允许"
        settingsBatteryButton?.apply {
            isEnabled = !batteryIgnored
            text = if (batteryIgnored) "已授权" else "去授权"
        }

        val lines = mutableListOf<String>()
        lines += if (running) "服务：运行中" else "服务：未运行"
        if (!running) {
            lines += "开启后台监听后才会持续上报心跳。"
        } else {
            when {
                age < 0 -> lines += "脚本心跳：等待脚本上报"
                age > 30_000 -> lines += "脚本心跳：可能已停止（${fmtRuntimeTime(state.optLong("heartbeatAt", 0L))}）"
                else -> lines += "脚本心跳：正常（${age / 1000} 秒前）"
            }
            state.optString("lastWsState", "").takeIf { it.isNotBlank() }?.let { lines += "WebSocket：$it" }
            state.optLong("lastEventAt", 0L).takeIf { it > 0 }?.let {
                lines += "最后课堂事件：${fmtRuntimeTime(it)}"
            }
            state.optString("lastError", "").takeIf { it.isNotBlank() }?.let {
                lines += "最近错误：$it"
            }
        }
        settingsStatusText?.text = lines.joinToString("\n")
    }

    private fun fmtRuntimeTime(ms: Long): String {
        if (ms <= 0) return "—"
        return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(ms))
    }

    // ============================================================
    // 检查更新（外壳侧，不依赖脚本运行）
    // ============================================================

    // ---------- 自动检查更新策略 ----------
    private var updateAutoCheck: Boolean
        get() = prefs.getBoolean("update.autoCheck", true)
        set(v) { prefs.edit().putBoolean("update.autoCheck", v).apply() }
    private var updateSkipRemaining: Int
        get() = prefs.getInt("update.skipRemaining", 0)
        set(v) { prefs.edit().putInt("update.skipRemaining", v).apply() }
    private var updateLastSkippedVersion: String
        get() = prefs.getString("update.lastSkippedVersion", "") ?: ""
        set(v) { prefs.edit().putString("update.lastSkippedVersion", v).apply() }

    private fun updateSnoozeUntil(): Long = prefs.getLong("update.snoozeUntil", 0L)
    fun isUpdateSnoozed(): Boolean = System.currentTimeMillis() < updateSnoozeUntil()
    fun isUpdateAutoCheckEnabled(): Boolean = updateAutoCheck
    private fun updateSnoozeDaysLeft(): Int {
        val left = updateSnoozeUntil() - System.currentTimeMillis()
        return if (left <= 0) 0 else ((left + 86_400_000L - 1) / 86_400_000L).toInt()
    }
    private fun setUpdateSnooze(days: Int) {
        prefs.edit().putLong("update.snoozeUntil", System.currentTimeMillis() + days * 86_400_000L).apply()
    }
    private fun clearUpdateSnooze() {
        prefs.edit().remove("update.snoozeUntil").apply()
    }
    private fun autoCheckAllowed(): Boolean = updateAutoCheck && !isUpdateSnoozed()

    private fun autoCheckSummary(): String {
        if (!updateAutoCheck) return "已彻底关闭"
        if (isUpdateSnoozed()) return "暂停中（剩余 ${updateSnoozeDaysLeft()} 天）"
        if (updateSkipRemaining > 0) return "跳过将来 ${updateSkipRemaining} 个版本"
        return "开启"
    }

    /** 跳过版本计数：新版本首次出现扣 1；返回 true 表示这条更新通知应丢弃 */
    fun consumeUpdateSkip(title: String, text: String): Boolean {
        val skip = updateSkipRemaining
        if (skip <= 0) return false
        val v = Regex("v(\\d+(?:\\.\\d+)+)").find("$title $text")?.groupValues?.get(1) ?: ""
        if (v.isNotEmpty() && v != updateLastSkippedVersion) {
            updateLastSkippedVersion = v
            updateSkipRemaining = skip - 1
            // notify() 来自 JS 桥线程，evaluateJavascript 必须切回 UI 线程
            runOnUiThread { syncUpdatePolicyToScript() }
        }
        return true
    }

    private fun pickAutoCheckPolicy() {
        val labels = arrayOf(
            "开启自动检查更新",
            "跳过将来 3 个版本",
            "7 天不检查",
            "30 天不检查",
            "彻底关闭",
        )
        val current = when {
            !updateAutoCheck -> 4
            isUpdateSnoozed() -> if (updateSnoozeDaysLeft() <= 7) 2 else 3
            updateSkipRemaining > 0 -> 1
            else -> 0
        }
        AlertDialog.Builder(this)
            .setTitle("自动检查更新")
            .setSingleChoiceItems(labels, current) { d, which ->
                when (which) {
                    0 -> {
                        updateAutoCheck = true
                        clearUpdateSnooze()
                        updateSkipRemaining = 0
                        updateLastSkippedVersion = ""
                    }
                    1 -> {
                        updateAutoCheck = true
                        clearUpdateSnooze()
                        updateSkipRemaining = 3
                        updateLastSkippedVersion = ""
                    }
                    2 -> {
                        updateAutoCheck = true
                        clearUpdateSnooze()
                        setUpdateSnooze(7)
                    }
                    3 -> {
                        updateAutoCheck = true
                        clearUpdateSnooze()
                        setUpdateSnooze(30)
                    }
                    4 -> {
                        updateAutoCheck = false
                        clearUpdateSnooze()
                        updateSkipRemaining = 0
                    }
                }
                syncUpdatePolicyToScript()
                d.dismiss()
                toast("自动检查更新：" + autoCheckSummary())
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 同步策略给用户脚本（脚本检查更新走同一套规则） */
    private fun syncUpdatePolicyToScript() {
        val v = updateLastSkippedVersion.replace("'", "")
        activeWebView?.evaluateJavascript(
            "try{" +
                "GM_setValue('ykt-helper:update.autoCheck',${updateAutoCheck});" +
                "GM_setValue('ykt-helper:update.snoozeUntil',${updateSnoozeUntil()});" +
                "GM_setValue('ykt-helper:update.skipRemaining',${updateSkipRemaining});" +
                "GM_setValue('ykt-helper:update.lastSkippedVersion','$v');" +
                "}catch(e){}", null
        )
    }

    // ---------- 关于与更新 ----------
    fun openAboutAndUpdate() {
        runOnUiThread { showAboutSheet() }
    }

    private fun showAboutSheet() {
        val site = "https://app.raymor.top/yuketangstudio/"
        val github = "https://github.com/RayMorTwinkle/YuketangStudio"
        showSheet("关于与更新") { layout ->
            layout.addView(TextView(this).apply {
                text = "YuketangStudio"
                textSize = 22f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(TXT)
                setPadding(dp(16), dp(4), dp(16), dp(2))
            })
            layout.addView(TextView(this).apply {
                text = "版本 v${BuildConfig.VERSION_NAME} · 雨课堂学习增强助手"
                textSize = 13f
                setTextColor(TEXT_SEC)
                setPadding(dp(16), dp(0), dp(16), dp(6))
            })
            layout.addView(TextView(this).apply {
                text = "⭐ 如果这个工具帮到了你，欢迎到 GitHub 点个 Star，这是对作者最大的支持。"
                textSize = 13f
                setTextColor(TXT)
                setPadding(dp(16), dp(4), dp(16), dp(10))
            })
            sheetDivider(layout)
            sheetRow(layout, "🔄", "检查更新", "当前 v${BuildConfig.VERSION_NAME}") { checkAppUpdate() }
            sheetRow(layout, "📡", "更新渠道", if (updateChannel == "beta") "测试版（尝鲜）" else "稳定版（推荐）") { pickUpdateChannel() }
            sheetRow(layout, "🔔", "自动检查更新", autoCheckSummary()) { pickAutoCheckPolicy() }
            sheetRow(layout, "🌐", "打开官网", "app.raymor.top/yuketangstudio") { openUrl(site) }
            sheetRow(layout, "📋", "复制官网地址", "发给朋友") { copyTextToClipboard(site, "已复制官网地址") }
            sheetRow(layout, "⭐", "打开 GitHub", "github.com/RayMorTwinkle/YuketangStudio") { openUrl(github) }
            sheetRow(layout, "💬", "复制讨论群号", "QQ 群 901466023") { copyTextToClipboard("901466023", "已复制群号 901466023") }
            sheetDivider(layout)
            sheetRow(layout, "📄", "开源协议", "MIT License") { openUrl("$github/blob/main/LICENSE") }
        }
    }

    private fun pickUpdateChannel() {
        val labels = arrayOf("稳定版（推荐）", "测试版（尝鲜）")
        AlertDialog.Builder(this)
            .setTitle("更新渠道")
            .setSingleChoiceItems(labels, if (updateChannel == "beta") 1 else 0) { d, which ->
                updateChannel = if (which == 1) "beta" else "stable"
                syncUpdateChannelToScript()
                d.dismiss()
                toast(if (which == 1) "已切换到测试渠道" else "已切换到稳定渠道")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 同步给用户脚本：脚本检查更新也走同一渠道 */
    private fun syncUpdateChannelToScript() {
        activeWebView?.evaluateJavascript(
            "try{GM_setValue('ykt-helper:update.channel','$updateChannel')}catch(e){}", null
        )
    }

    private fun openUrl(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            .onFailure { toast("没有可用的浏览器") }
    }

    private fun copyTextToClipboard(text: String, msg: String) {
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("ykt", text))
        toast(msg)
    }

    /**
     * 拉 svc /latest 元数据，和 BuildConfig.VERSION_NAME 比对。
     * 与脚本的 update-check.js 共用同一份元数据，版本号单一来源。
     * 有新版 → 对话框提供「下载并安装」（DownloadManager + 安装器）或「用浏览器打开」。
     */
    private data class LatestMeta(val version: String, val apk: String, val notes: String, val channel: String)

    private fun fetchLatestMeta(channel: String): LatestMeta? {
        return try {
            val conn = (java.net.URL("$LATEST_URL?channel=$channel").openConnection() as java.net.HttpURLConnection).apply {
                connectTimeout = 10000
                readTimeout = 10000
                instanceFollowRedirects = true
            }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            if (code !in 200..299) return null
            val obj = org.json.JSONObject(body)
            val v = obj.optString("version").ifBlank { null } ?: return null
            LatestMeta(v, obj.optString("apk"), obj.optString("notes"), channel)
        } catch (e: Exception) {
            Log.e(TAG, "拉取 $channel 渠道更新失败", e)
            null
        }
    }

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
                // 测试渠道同时看 beta + stable，取版本更高的一边；
                // 稳定渠道只看 stable
                val stable = fetchLatestMeta("stable")
                val beta = if (updateChannel == "beta") fetchLatestMeta("beta") else null
                val chosen = when {
                    beta != null && stable != null -> if (isNewer(beta.version, stable.version)) beta else stable
                    beta != null -> beta
                    else -> stable
                }
                if (chosen == null) {
                    message = "检查失败：无法连接更新服务器"
                } else {
                    latest = chosen.version
                    apkUrl = chosen.apk.ifBlank { null }
                    val chLabel = if (chosen.channel == "beta") " · 测试渠道" else ""
                    message = when {
                        isNewer(chosen.version, cur) ->
                            "发现新版本 v${chosen.version}（当前 v$cur）$chLabel" +
                                if (chosen.notes.isNotBlank()) "\n\n${chosen.notes}" else ""
                        else -> "已是最新版本（服务器 v${chosen.version}）$chLabel"
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
                // 重启后 pendingApkId 丢失，退回持久化的下载 id
                val expectedId = if (pendingApkId > 0) pendingApkId else prefs.getLong("apkDl.id", -1L)
                if (id <= 0 || id != expectedId) return
                val ver = pendingApkVersion.ifBlank { prefs.getString("apkDl.version", "") ?: "" }
                Log.i(TAG, "APK 下载完成 id=$id version=$ver")
                // 下载管理页正开着 → 页面自己会显示「安装」，不再弹窗打断
                if (updateSheet?.isShowing == true) return
                // 校验确实下载成功（失败时 getUriForDownloadedFile 会返回 null）
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("下载完成")
                    .setMessage("新版本 v$ver 已下载完成，是否立即安装？")
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
            prefs.edit()
                .putLong("apkDl.id", pendingApkId)
                .putString("apkDl.version", version)
                .putString("apkDl.name", name)
                .putString("apkDl.url", apkUrl)
                .apply()
            toast("开始下载 v$version")
            Log.i(TAG, "APK 下载中: $name <- $apkUrl")
            // 立即打开下载管理：进度 / 保存路径 / 安装按钮都在这里
            showDownloads()
        } catch (e: Exception) {
            Log.e(TAG, "APK 下载失败", e)
            toast("下载失败：${e.message}")
        }
    }

    /**
     * 下载完成 → 拉起系统安装器。
     * 优先用我们自己的 FileProvider：部分国产 ROM 的安装器读不了
     * DownloadManager 的 content://downloads/... URI，会直接闪退。
     * FileProvider 不可用时再退回 DownloadManager URI。
     */
    private fun installApk(downloadId: Long) {
        try {
            val name = prefs.getString("apkDl.name", "") ?: ""
            val path = apkDownloadPath(name)
            val file = java.io.File(path)
            if (path.isNotBlank() && file.exists() && file.length() > 0 && file.canRead()) {
                val uri = androidx.core.content.FileProvider.getUriForFile(
                    this, "$packageName.fileprovider", file,
                )
                launchInstaller(uri, path)
                return
            }
            val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            val uri = dm.getUriForDownloadedFile(downloadId)
            if (uri != null) {
                launchInstaller(uri, path)
            } else {
                toast("没找到已下载的安装包")
            }
        } catch (e: Throwable) {
            Log.e(TAG, "拉起安装器失败", e)
            toast("无法打开安装器：${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun canInstallPackages(): Boolean {
        return Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()
    }

    private fun openUnknownSourcesSettings() {
        try {
            startActivity(Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:$packageName"),
            ))
        } catch (e: Throwable) {
            Log.w(TAG, "打开未知来源设置失败", e)
            runCatching { startActivity(Intent(Settings.ACTION_SETTINGS)) }
            toast("请手动允许本应用安装未知应用")
        }
    }

    private fun launchInstaller(uri: Uri, path: String) {
        if (!canInstallPackages()) {
            pendingInstallUri = uri
            pendingInstallPath = path
            toast("请先允许 YuketangStudio 安装未知应用，返回后会自动继续")
            openUnknownSourcesSettings()
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
            Log.i(TAG, "拉起安装器: $uri")
        } catch (e: Throwable) {
            Log.e(TAG, "启动安装器失败", e)
            toast("没有可用的安装器，安装包位置：$path")
        }
    }

    override fun onResume() {
        super.onResume()
        if (settingsSheet?.isShowing == true) refreshSettingsUi()
        val uri = pendingInstallUri ?: return
        if (!canInstallPackages()) return
        val path = pendingInstallPath ?: ""
        pendingInstallUri = null
        pendingInstallPath = null
        launchInstaller(uri, path)
    }

    // ============================================================
    // 更新下载页：进度 / 保存路径 / 安装
    // ============================================================

    private fun apkDownloadPath(name: String): String {
        if (name.isBlank()) return ""
        return try {
            java.io.File(
                android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS),
                "YuketangStudio/$name",
            ).absolutePath
        } catch (e: Exception) {
            ""
        }
    }

    private fun fmtSize(bytes: Long): String =
        if (bytes >= 1048576L) "%.1fMB".format(bytes / 1048576f) else "${bytes / 1024}KB"

    private fun downloadFailReason(reason: Int): String = when (reason) {
        DownloadManager.ERROR_FILE_ALREADY_EXISTS -> "文件已存在"
        DownloadManager.ERROR_FILE_ERROR -> "文件读写错误"
        DownloadManager.ERROR_HTTP_DATA_ERROR -> "网络数据错误"
        DownloadManager.ERROR_INSUFFICIENT_SPACE -> "存储空间不足"
        DownloadManager.ERROR_TOO_MANY_REDIRECTS -> "重定向过多"
        DownloadManager.ERROR_UNHANDLED_HTTP_CODE -> "HTTP 错误"
        DownloadManager.ERROR_CANNOT_RESUME -> "无法断点续传"
        DownloadManager.ERROR_UNKNOWN -> "未知错误"
        else -> "错误码 $reason"
    }

    private fun stopUpdatePoll() {
        updatePoll?.let { uiHandler.removeCallbacks(it) }
        updatePoll = null
    }

    /** 轮询进行中的下载；完成后自动重开页面，把安装包归到「已下载」 */
    private fun startUpdatePoll(
        progressBar: ProgressBar?,
        tvPercent: TextView?,
        tvStatus: TextView?,
        actionBtn: Button?,
    ) {
        stopUpdatePoll()
        val run = object : Runnable {
            override fun run() {
                val id = prefs.getLong("apkDl.id", -1L)
                if (id <= 0) return
                val info = queryDownload(id) ?: return
                when (info.status) {
                    DownloadManager.STATUS_RUNNING -> {
                        progressBar?.isIndeterminate = info.total <= 0
                        if (info.total > 0) {
                            val pct = ((info.soFar * 100) / info.total).toInt().coerceIn(0, 100)
                            progressBar?.progress = pct
                            tvPercent?.text = "$pct%  ·  ${fmtSize(info.soFar)} / ${fmtSize(info.total)}"
                        } else {
                            tvPercent?.text = "下载中…"
                        }
                        tvStatus?.text = "正在下载…"
                        actionBtn?.text = "取消"
                    }
                    DownloadManager.STATUS_PENDING -> {
                        tvStatus?.text = "等待下载…"
                        actionBtn?.text = "取消"
                    }
                    DownloadManager.STATUS_PAUSED -> {
                        tvStatus?.text = "已暂停，可在通知栏继续"
                        actionBtn?.text = "取消"
                    }
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        progressBar?.isIndeterminate = false
                        progressBar?.progress = 100
                        tvPercent?.text = "100%"
                        tvStatus?.text = "下载完成"
                        stopUpdatePoll()
                        uiHandler.postDelayed({
                            if (updateSheet?.isShowing == true) showDownloads()
                        }, 500)
                        return
                    }
                    DownloadManager.STATUS_FAILED -> {
                        tvStatus?.text = "下载失败：${downloadFailReason(info.reason)}"
                        stopUpdatePoll()
                        return
                    }
                }
                uiHandler.postDelayed(this, 500)
            }
        }
        updatePoll = run
        uiHandler.post(run)
    }

    private fun retryApkDownload() {
        val url = prefs.getString("apkDl.url", "") ?: ""
        val version = prefs.getString("apkDl.version", "") ?: ""
        if (url.isBlank()) {
            checkAppUpdate()
            return
        }
        // 先移除旧任务：DownloadManager 会同时删掉残留的半成品文件，
        // 否则重新入队到同一路径会直接报「文件已存在」
        val oldId = prefs.getLong("apkDl.id", -1L)
        if (oldId > 0) runCatching {
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).remove(oldId)
        }
        downloadAndInstall(url, version)
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
        showSheet("动态") { layout ->
            val loading = TextView(this).apply {
                text = "加载中…"; textSize = 14f; setTextColor(TEXT_SEC)
                gravity = Gravity.CENTER; setPadding(0, dp(28), 0, dp(28))
            }
            layout.addView(loading)
            Thread {
                val items = fetchFeed()
                runOnUiThread {
                    layout.removeView(loading)
                    if (items.isEmpty()) {
                        layout.addView(TextView(this).apply {
                            text = "暂无动态"; textSize = 15f
                            gravity = Gravity.CENTER
                            setTextColor(TEXT_SEC)
                            setPadding(0, dp(28), 0, dp(28))
                        })
                    } else {
                        items.forEach { layout.addView(feedRow(it) { dismissSheet() }) }
                    }
                }
            }.start()
        }
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
            if (fp in ignoredFps()) return@evaluateJavascript  // 用户明确说过「暂不」

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
                .setNegativeButton("暂不") { _, _ -> ignoreFp(fp) }
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

    /** 账号面板：列表 + 保存/更新当前快照 + 退出登录 */
    private fun showAccountSheet() {
        val profiles = AccountStore.all(this)
        showSheet("账号管理") { layout ->
            if (profiles.isEmpty()) {
                layout.addView(TextView(this).apply {
                    text = "暂无已保存账号\n登录雨课堂后会自动提示保存，也可点下方「保存当前登录账号」"
                    textSize = 13f; setTextColor(TEXT_SEC)
                    setPadding(dp(16), dp(8), dp(16), dp(16))
                })
            }
            profiles.forEach { p ->
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(16), dp(12), dp(8), dp(12))
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
                row.addView(TextView(this).apply {
                    text = "改名"; textSize = 12f; setTextColor(TEXT_SEC)
                    setPadding(dp(10), dp(6), dp(8), dp(6))
                    setOnClickListener { dismissSheet(); renameAccount(p) }
                })
                row.addView(TextView(this).apply {
                    text = "删除"; textSize = 12f; setTextColor(0xFFD64545.toInt())
                    setPadding(dp(6), dp(6), dp(8), dp(6))
                    setOnClickListener { dismissSheet(); deleteAccount(p) }
                })
                row.setOnClickListener {
                    dismissSheet()
                    if (p.id == currentAccountId) toast("已是当前账号")
                    else switchAccount(p)
                }
                layout.addView(row)
            }
            sheetDivider(layout)
            sheetRow(layout, "💾", "保存当前登录账号", "把当前 Cookie + 本地数据存为账号快照") {
                dismissSheet(); saveCurrentAccountManual()
            }
            if (currentAccountId != null) {
                sheetRow(layout, "🔄", "更新当前账号快照", "登录态变化后手动刷新") {
                    dismissSheet(); refreshCurrentAccountSnapshot()
                }
            }
            sheetRow(layout, "🚪", "退出登录") {
                dismissSheet(); confirmLogout()
            }
        }
    }

    /** 当前打开的面板（供行点击后关闭用） */
    private var activeSheet: BottomSheetDialog? = null

    private fun dismissSheet() {
        activeSheet?.dismiss()
        activeSheet = null
    }

    /** 手动刷新当前账号快照（登录态/token 变化后） */
    private fun refreshCurrentAccountSnapshot() {
        val wv = activeWebView ?: return
        val id = currentAccountId ?: run { toast("当前没有识别到账号"); return }
        wv.evaluateJavascript(
            "try{btoa(unescape(encodeURIComponent(JSON.stringify(localStorage))))}catch(e){''}"
        ) { raw ->
            val b64 = raw?.removeSurrounding("\"") ?: ""
            val ls = runCatching {
                JSONObject(String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)))
            }.getOrNull() ?: run { toast("读取本地数据失败"); return@evaluateJavascript }
            val p = AccountStore.all(this).find { it.id == id }
            if (p == null) { toast("账号不存在"); return@evaluateJavascript }
            refreshProfileSession(p, ls)
            toast("已更新「${p.name}」快照")
        }
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
            // 先清空所有环境的 cookie：否则目标账号的 cookie 和当前账号的混在一起，
            // 雨课堂可能仍按旧 cookie 识别身份（表现为「切了但没切」）
            for (e in Env.entries) cm.setCookie(e.origin, "")
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

    private data class DlInfo(val status: Int, val soFar: Long, val total: Long, val reason: Int)

    private fun queryDownload(id: Long): DlInfo? {
        return try {
            val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            dm.query(DownloadManager.Query().setFilterById(id))?.use { c ->
                if (!c.moveToFirst()) return@use null
                DlInfo(
                    c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),
                    c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
                    c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)),
                    c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)),
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "查询下载状态失败", e)
            null
        }
    }

    private fun sectionTitle(parent: LinearLayout, text: String) {
        parent.addView(TextView(this).apply {
            this.text = text
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(TEXT_SEC)
            setPadding(dp(16), dp(10), dp(16), dp(4))
        })
    }

    private fun emptyHint(parent: LinearLayout, text: String) {
        parent.addView(TextView(this).apply {
            this.text = text
            textSize = 13f
            setTextColor(TEXT_SEC)
            setPadding(dp(16), dp(6), dp(16), dp(12))
        })
    }

    /** 下载管理：只分「正在下载」和「已下载」两个区域 */
    private fun showDownloads() {
        updateSheet?.dismiss()
        val apkId = prefs.getLong("apkDl.id", -1L)
        val apkName = prefs.getString("apkDl.name", "") ?: ""
        val apkPath = apkDownloadPath(apkName)
        val info = if (apkId > 0) queryDownload(apkId) else null
        // 下载中/失败时 DownloadManager 可能已经建了目标文件，别让它同时出现在「已下载」
        val hidePartial = info != null && info.status != DownloadManager.STATUS_SUCCESSFUL
        val files = listDownloadedFiles().filter { !(hidePartial && it.name == apkName) }

        var progressBar: ProgressBar? = null
        var tvPercent: TextView? = null
        var tvStatus: TextView? = null
        var actionBtn: Button? = null

        val sheet = showSheet("下载管理") { layout ->
            // ===== 正在下载 =====
            sectionTitle(layout, "正在下载")
            if (info == null || info.status == DownloadManager.STATUS_SUCCESSFUL) {
                emptyHint(layout, "暂无进行中的下载")
            } else {
                layout.addView(TextView(this).apply {
                    text = apkName.ifBlank { "更新包" }
                    textSize = 14f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(TXT)
                    setPadding(dp(16), dp(2), dp(16), dp(2))
                })
                progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 100
                    progress = 0
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { setMargins(dp(16), dp(8), dp(16), dp(2)) }
                }
                layout.addView(progressBar)
                tvPercent = TextView(this).apply {
                    text = "—"
                    textSize = 12f
                    setTextColor(TEXT_SEC)
                    setPadding(dp(16), dp(2), dp(16), dp(2))
                }
                layout.addView(tvPercent)
                tvStatus = TextView(this).apply {
                    text = if (info.status == DownloadManager.STATUS_FAILED) {
                        "下载失败：${downloadFailReason(info.reason)}"
                    } else {
                        "准备中…"
                    }
                    textSize = 13f
                    setTextColor(TXT)
                    setPadding(dp(16), dp(2), dp(16), dp(6))
                }
                layout.addView(tvStatus)

                actionBtn = Button(this).apply {
                    text = if (info.status == DownloadManager.STATUS_FAILED) "重试" else "取消"
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { setMargins(dp(16), dp(2), dp(16), dp(8)) }
                }
                if (info.status == DownloadManager.STATUS_FAILED) {
                    actionBtn?.setOnClickListener { retryApkDownload() }
                } else {
                    actionBtn?.setOnClickListener {
                        runCatching {
                            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).remove(apkId)
                        }
                        stopUpdatePoll()
                        toast("已取消下载")
                        showDownloads()
                    }
                }
                layout.addView(actionBtn)
            }
            sheetDivider(layout)

            // ===== 已下载 =====
            sectionTitle(layout, "已下载")
            if (files.isEmpty()) {
                emptyHint(layout, "暂无已下载文件")
            } else {
                files.forEach { f ->
                    val isApk = f.name.endsWith(".apk", true)
                    val date = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(f.lastModified()))
                    val sub = "${fmtSize(f.length())} · $date" + if (isApk) " · 点击安装" else ""
                    sheetRow(layout, if (isApk) "📦" else "📄", f.name, sub) { openDownloadedFile(f) }
                }
            }

            // 安装包目录：安装失败时方便去文件管理器手动找
            if (apkPath.isNotBlank() && files.any { it.name.endsWith(".apk", true) }) {
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(16), dp(8), dp(16), dp(4))
                }
                row.addView(TextView(this).apply {
                    text = "安装包目录：$apkPath"
                    textSize = 11f
                    setTextColor(TEXT_SEC)
                    setTextIsSelectable(true)
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                row.addView(Button(this).apply {
                    text = "复制"
                    textSize = 11f
                    setPadding(dp(6), 0, dp(6), 0)
                    setOnClickListener {
                        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                            .setPrimaryClip(ClipData.newPlainText("apk-path", apkPath))
                        toast("已复制安装包目录")
                    }
                })
                layout.addView(row)
            }
        }

        updateSheet = sheet
        sheet.setOnDismissListener {
            stopUpdatePoll()
            if (activeSheet === sheet) activeSheet = null
            updateSheet = null
        }
        if (info != null && info.status != DownloadManager.STATUS_SUCCESSFUL
            && info.status != DownloadManager.STATUS_FAILED) {
            startUpdatePoll(progressBar, tvPercent, tvStatus, actionBtn)
        }
    }

    private fun listDownloadedFiles(): List<java.io.File> {
        val dirs = listOfNotNull(
            android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
                ?.let { java.io.File(it, "YuketangStudio") },
            getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS),
        )
        return dirs.flatMap { it.listFiles()?.toList() ?: emptyList() }
            .filter { it.isFile }.sortedByDescending { it.lastModified() }
    }

    private fun openDownloadedFile(f: java.io.File) {
        try {
            val uri = androidx.core.content.FileProvider.getUriForFile(this, "${packageName}.fileprovider", f)
            if (f.name.endsWith(".apk", ignoreCase = true)) {
                launchInstaller(uri, f.absolutePath)
                return
            }
            startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, guessMime(f.name))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
        } catch (e: Exception) {
            Log.e(TAG, "打开下载文件失败", e)
            toast("没有能打开此文件的应用")
        }
    }

    private fun guessMime(name: String) = when {
        name.endsWith(".pdf", true) -> "application/pdf"
        name.endsWith(".pptx", true) -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        name.endsWith(".png", true) -> "image/png"
        name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
        name.endsWith(".apk", true) -> "application/vnd.android.package-archive"
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
            .put("envIndex", envIndex)
            .put("updateChannel", updateChannel)
            .put("update.autoCheck", updateAutoCheck)
            .put("update.snoozeUntil", updateSnoozeUntil())
            .put("update.skipRemaining", updateSkipRemaining)
            .put("update.lastSkippedVersion", updateLastSkippedVersion)
        val runtime = RuntimeState.read(this)
        val background = JSONObject()
            .put("enabled", runtime.optBoolean("enabled", false))
            .put("strong", runtime.optBoolean("strong", false))
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
            .put("background", background)
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
                        is Long -> e.putLong(k, v)
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
            // env / 桌面模式 / 更新策略同步到当前 UI
            env = Env.entries[envIndex.coerceIn(0, Env.entries.size - 1)]
            tabs.forEach { applyDesktopMode(it.webView.settings) }
            syncUpdateChannelToScript()
            syncUpdatePolicyToScript()
            doc.optJSONObject("background")?.let { bg ->
                val enabled = bg.optBoolean("enabled", false)
                val strong = bg.optBoolean("strong", false)
                if (enabled) {
                    if (!BackgroundRuntimeService.start(this, strong)) {
                        toast("后台监听恢复失败，请到设置检查")
                    }
                } else {
                    BackgroundRuntimeService.stop(this)
                }
            }
        }
        // cookies + localStorage
        doRestore(doc.optJSONObject("cookies") ?: JSONObject(),
                  doc.optJSONObject("localStorage") ?: JSONObject())
        if (settingsSheet?.isShowing == true) refreshSettingsUi()
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
                activeWebView?.loadUrl(if (desktopMode) "$targetOrigin/web/" else "$targetOrigin/m/v2")
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
    // ============================================================
    // 收集页 / 桥接
    // ============================================================

    fun isIgnoringBatteryOptimizations(): Boolean {
        return try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            pm.isIgnoringBatteryOptimizations(packageName)
        } catch (_: Throwable) {
            false
        }
    }

    fun requestIgnoreBatteryOptimizations(): Boolean {
        if (isIgnoringBatteryOptimizations()) {
            toast("已允许后台运行")
            return true
        }
        return try {
            startActivity(Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"),
            ))
            true
        } catch (_: Throwable) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                true
            } catch (_: Throwable) {
                toast("无法打开电池优化设置")
                false
            }
        }
    }

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

    private val statusHandler = Handler(Looper.getMainLooper())
    private var statusHideTask: Runnable? = null

    /** 底部浮动提示：显示 2.2s 自动消失（不再占用 header 空间） */
    fun status(msg: String) = runOnUiThread {
        val v = binding.tvStatus
        v.text = msg.take(40)
        v.visibility = View.VISIBLE
        statusHideTask?.let { statusHandler.removeCallbacks(it) }
        val task = Runnable { v.visibility = View.GONE }
        statusHideTask = task
        statusHandler.postDelayed(task, 2200)
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
