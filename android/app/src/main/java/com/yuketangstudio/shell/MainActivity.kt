package com.yuketangstudio.shell

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.yuketangstudio.shell.databinding.ActivityMainBinding
import org.json.JSONObject
import java.net.URI

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var bridge: YktBridge
    private var collectView: WebView? = null
    private var scriptAsset: String? = null
    private var shimAsset: String? = null
    private var docStartInjected = false   // addDocumentStartJavaScript 是否成功注册
    private var injectedFallbackUrls = mutableSetOf<String>()

    enum class Env(val label: String, val origin: String) {
        CHANGJIANG("长江雨课堂", "https://changjiang.yuketang.cn"),
        STANDARD("雨课堂", "https://www.yuketang.cn"),
        PRO("荷塘雨课堂", "https://pro.yuketang.cn"),
    }
    private var env = Env.CHANGJIANG

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        bridge = YktBridge(this)

        shimAsset = assets.open("gm-shim.js").bufferedReader().use { it.readText() }
        scriptAsset = assets.open("yuketangstudio.user.js").bufferedReader().use { it.readText() }

        configureWebView(binding.webView, isCollect = false)
        configureToolbar()
        askNotificationPermission()
        binding.webView.loadUrl("${env.origin}/web/")
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView, isCollect: Boolean) {
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
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        wv.addJavascriptInterface(bridge, "YktBridge")

        // document-start 注入（需要 WebView 支持 DOCUMENT_START_SCRIPT 特性）。
        // allowedOriginRules 只接受到 host 为止的模式，不能带路径——列三个已知域名
        val combined = (shimAsset ?: "") + "\n;\n" + (scriptAsset ?: "")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                WebViewCompat.addDocumentStartJavaScript(
                    wv, combined,
                    setOf(
                        "https://changjiang.yuketang.cn",
                        "https://www.yuketang.cn",
                        "https://pro.yuketang.cn",
                    ),
                )
                docStartInjected = true
            } catch (e: Exception) {
                log("document-start 注入失败，降级 evaluateJavascript: ${e.message}")
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
                // 降级路径：document-start 注入没成功时，在页面脚本执行前用 evaluateJavascript 注入
                if (!docStartInjected &&
                    url != null && isYuketang(url) && !injectedFallbackUrls.contains(url)) {
                    injectedFallbackUrls.add(url)
                    view.evaluateJavascript(combined, null)
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                CookieManager.getInstance().flush()
                if (view === binding.webView) updateNav()
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (view === binding.webView) {
                    binding.pageProgress.progress = newProgress
                    binding.pageProgress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
                }
            }
        }
        wv.setDownloadListener { url, _, contentDisposition, mime, _ ->
            // 普通 http(s) 下载走系统 DownloadManager；blob/data 已被 shim 拦截
            if (url.startsWith("http")) {
                runCatching {
                    val req = android.app.DownloadManager.Request(Uri.parse(url)).apply {
                        val name = URLUtilGuess.guessFileName(url, contentDisposition, mime)
                        setTitle(name)
                        setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, "YuketangStudio/$name")
                        addRequestHeader("cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    }
                    (getSystemService(DOWNLOAD_SERVICE) as android.app.DownloadManager).enqueue(req)
                    Toast.makeText(this, "开始下载", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private object URLUtilGuess {
        fun guessFileName(url: String, contentDisposition: String?, mime: String?): String =
            android.webkit.URLUtil.guessFileName(url, contentDisposition, mime)
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
                binding.webView.loadUrl("${env.origin}/web/")
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        binding.btnBack.setOnClickListener { if (binding.webView.canGoBack()) binding.webView.goBack() }
        binding.btnForward.setOnClickListener { if (binding.webView.canGoForward()) binding.webView.goForward() }
        binding.btnReload.setOnClickListener { injectedFallbackUrls.clear(); binding.webView.reload() }
    }

    private fun updateNav() {
        binding.btnBack.isEnabled = binding.webView.canGoBack()
        binding.btnForward.isEnabled = binding.webView.canGoForward()
    }

    // ---------- 收集页（隐藏 WebView，跑历史课件收集脚本） ----------
    fun openCollectPage(url: String) {
        runOnUiThread {
            if (collectView == null) {
                val wv = WebView(this)
                configureWebView(wv, isCollect = true)
                wv.layoutParams = android.widget.FrameLayout.LayoutParams(1, 1)
                binding.collectContainer.addView(wv)
                binding.collectContainer.visibility = View.VISIBLE
                collectView = wv
            }
            collectView?.loadUrl(url)
            log("收集页打开: $url")
        }
    }

    fun closeCollectPage() {
        runOnUiThread {
            collectView?.let {
                it.stopLoading()
                it.destroy()
            }
            binding.collectContainer.removeAllViews()
            binding.collectContainer.visibility = View.GONE
            collectView = null
        }
    }

    // ---------- 共享值广播（给两个 WebView 都发，存在哪边哪边生效） ----------
    fun broadcastValue(name: String, json: String?) {
        evalOnCollectAndMain("window.__yktBridgeValue && window.__yktBridgeValue(${JSONObject.quote(name)}, ${JSONObject.quote(json)})")
    }

    fun evalOnCollectAndMain(js: String) {
        runOnUiThread {
            runCatching { binding.webView.evaluateJavascript(js, null) }
            runCatching { collectView?.evaluateJavascript(js, null) }
        }
    }

    fun log(msg: String) = runOnUiThread {
        binding.tvStatus.text = msg.take(30)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        closeCollectPage()
        binding.webView.apply { stopLoading(); clearHistory(); removeAllViews(); destroy() }
        super.onDestroy()
    }

    @Deprecated("deprecated")
    override fun onBackPressed() {
        when {
            binding.webView.canGoBack() -> binding.webView.goBack()
            else -> super.onBackPressed()
        }
    }
}
