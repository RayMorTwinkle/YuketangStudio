package com.yuketangstudio.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * 注入页面的 Kotlin 桥：window.YktBridge。
 * - sharedSet/Get/Delete：跨 WebView 的键值共享（收集页写 → 主页面 GM_getValue 读/监听回调）
 * - openCollect/closeCollect：隐藏收集页 WebView 生命周期
 * - downloadStart/Chunk/End：blob/data 下载 → base64 分块 → MediaStore Downloads
 * - fetchBinary：GM_xmlhttpRequest 的 CORS 兜底（不带页面 cookie 的原生 GET）
 * - notify：系统通知（Android 13+ 需要 POST_NOTIFICATIONS，MainActivity 里申请）
 */
class YktBridge(private val activity: MainActivity) {

    private val io = Executors.newCachedThreadPool()
    private val shared = ConcurrentHashMap<String, String>()
    private val downloads = ConcurrentHashMap<String, FileOutputStream>()

    // ---------- 共享键值 ----------
    @JavascriptInterface
    fun sharedSet(name: String, json: String) {
        shared[name] = json
        activity.broadcastValue(name, json)
    }

    @JavascriptInterface
    fun sharedGet(name: String): String? = shared[name]

    @JavascriptInterface
    fun sharedDelete(name: String) {
        shared.remove(name)
        activity.broadcastValue(name, null)
    }

    // ---------- 收集页 ----------
    @JavascriptInterface
    fun openCollect(url: String) = activity.openCollectPage(url)

    @JavascriptInterface
    fun closeCollect() = activity.closeCollectPage()

    // ---------- 剪贴板 ----------
    // WebView 里 navigator.clipboard / execCommand 在部分机型不可用；
    // 诊断 ID 需要可靠复制，直接走原生剪贴板。
    @JavascriptInterface
    fun copyText(text: String) {
        try {
            activity.runOnUiThread {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("YuketangStudio", text))
                Toast.makeText(activity, "已复制", Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            activity.log("copyText 失败: ${e.message}")
        }
    }

    // ---------- 通知 ----------
    @JavascriptInterface
    fun notify(title: String, text: String, image: String, action: String) {
        // 自动检查策略：彻底关闭 / 暂停期 / 跳过版本期间，更新通知直接丢弃（其它通知不受影响）
        if (action == "check_update") {
            if (!activity.isUpdateAutoCheckEnabled()) return
            if (activity.isUpdateSnoozed()) return
            if (activity.consumeUpdateSkip(title, text)) return
        }
        val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            mgr.createNotificationChannel(
                NotificationChannel("ykt", "雨课堂提醒", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED) {
            activity.runOnUiThread { Toast.makeText(activity, "$title $text", Toast.LENGTH_LONG).show() }
            return
        }
        // action 非空（如 check_update）→ 点击通知时让 MainActivity 执行对应动作
        val target = Intent(activity, MainActivity::class.java).apply {
            if (action.isNotBlank()) {
                putExtra("ykt_action", action)
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
        }
        val reqCode = if (action.isBlank()) 0 else action.hashCode()
        val intent = PendingIntent.getActivity(
            activity, reqCode, target,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // 同标题覆盖（原先用时间戳，同类通知会无限堆叠）
        mgr.notify(
            ("n:" + title).hashCode() and 0x7fffffff,
            NotificationCompat.Builder(activity, "ykt")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(intent)
                .setAutoCancel(true)
                .build(),
        )
    }

    // ---------- 分块下载 ----------
    // downloadStart 必须同步开流：JS 侧紧接着就发 downloadChunk，@JavascriptInterface
    // 在 JS 线程上按序执行，同步 open 才能保证首 chunk 不会因「流还没建好」被静默丢弃
    @JavascriptInterface
    fun downloadStart(job: String, filename: String) {
        try {
            val safe = filename.replace(Regex("[\\\\/:*?\"<>|]"), "_")
            val file = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "$job.part")
            downloads[job] = FileOutputStream(file)
            fileJobNames[job] = safe
        } catch (e: Exception) {
            activity.log("downloadStart 失败: ${e.message}")
        }
    }

    private val fileJobNames = ConcurrentHashMap<String, String>()

    @JavascriptInterface
    fun downloadChunk(job: String, base64: String) {
        try {
            downloads[job]?.write(Base64.decode(base64, Base64.DEFAULT))
        } catch (e: Exception) {
            activity.log("downloadChunk 失败: ${e.message}")
        }
    }

    @JavascriptInterface
    fun downloadEnd(job: String) {
        io.execute {
            try {
                downloads.remove(job)?.close()
                val name = fileJobNames.remove(job) ?: "download"
                val part = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "$job.part")
                if (Build.VERSION.SDK_INT >= 29) {
                    val values = android.content.ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, name)
                        put(MediaStore.Downloads.MIME_TYPE, guessMime(name))
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/YuketangStudio")
                    }
                    val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    if (uri != null) {
                        activity.contentResolver.openOutputStream(uri)?.use { out -> part.inputStream().use { it.copyTo(out) } }
                        part.delete()
                        activity.runOnUiThread {
                            Toast.makeText(activity, "已保存到 下载/YuketangStudio/$name", Toast.LENGTH_LONG).show()
                            notifyDownloadDone(name, uri)
                        }
                    } else {
                        // MediaStore 失败 → 留在应用私有目录，至少文件不丢
                        val dest = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name)
                        part.renameTo(dest)
                        activity.runOnUiThread {
                            Toast.makeText(activity, "已保存到应用目录/$name", Toast.LENGTH_LONG).show()
                            notifyDownloadDone(name, null)
                        }
                    }
                } else {
                    @Suppress("DEPRECATION")
                    val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "YuketangStudio")
                    dir.mkdirs()
                    val dest = File(dir, name)
                    part.renameTo(dest)
                    activity.runOnUiThread {
                        Toast.makeText(activity, "已保存到 $dest", Toast.LENGTH_LONG).show()
                        notifyDownloadDone(name, null)
                    }
                }
            } catch (e: Exception) {
                activity.log("downloadEnd 失败: ${e.message}")
            }
        }
    }

    /**
     * 下载完成通知：Toast 只在当前界面可见，用户切走或锁屏就完全无感。
     * 这里补一条系统通知，点击直接打开刚保存的文件。
     */
    private fun notifyDownloadDone(name: String, uri: android.net.Uri?) {
        try {
            val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                mgr.createNotificationChannel(
                    NotificationChannel("ykt_download", "下载完成", NotificationManager.IMPORTANCE_DEFAULT)
                )
            }
            if (Build.VERSION.SDK_INT >= 33 &&
                activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED) {
                return   // 没授权就只留 Toast（前面已经弹过）
            }
            val open = if (uri != null) {
                Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, guessMime(name))
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            } else {
                Intent(activity, MainActivity::class.java)
            }
            val pi = PendingIntent.getActivity(
                activity, name.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            // 用文件名哈希作 id：同名文件覆盖通知，不同文件各自保留
            // （原先用时间戳，每下载一次就多一条，通知栏很快堆满）
            mgr.notify(
                ("dl:" + name).hashCode() and 0x7fffffff,
                NotificationCompat.Builder(activity, "ykt_download")
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("下载完成")
                    .setContentText(name)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build(),
            )
        } catch (e: Exception) {
            activity.log("下载通知失败: ${e.message}")
        }
    }

    private fun guessMime(name: String): String = when {
        name.endsWith(".pdf", true) -> "application/pdf"
        name.endsWith(".pptx", true) -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        name.endsWith(".png", true) -> "image/png"
        name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
        else -> "application/octet-stream"
    }

    // ---------- 原生网络兜底 ----------
    @JavascriptInterface
    fun fetchBinary(url: String, callbackId: String) {
        io.execute {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15000
                    readTimeout = 30000
                    instanceFollowRedirects = true
                }
                val code = conn.responseCode
                val bytes = (if (code in 200..299) conn.inputStream else conn.errorStream)?.readBytes() ?: ByteArray(0)
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val ok = code in 200..299
                activity.evalOnAll(
                    "window['$callbackId']($ok,$code,${JSONObject.quote(b64)},${JSONObject.quote("")})"
                )
            } catch (e: Exception) {
                activity.evalOnAll(
                    "window['$callbackId'](false,0,null,${JSONObject.quote(e.message ?: "error")})"
                )
            } finally {
                conn?.disconnect()
            }
        }
    }

    /**
     * GM_xmlhttpRequest 的 CORS 兜底（支持任意 method / headers / body）：
     * Ark 等上游的预检不允许 Authorization 头，页面 fetch 会被拦截，
     * 这里走原生 HttpURLConnection，返回文本或 base64（binary=true）。
     */
    @JavascriptInterface
    fun fetchRequest(method: String, url: String, headersJson: String, body: String, binary: Boolean, callbackId: String) {
        io.execute {
            var conn: HttpURLConnection? = null
            try {
                val m = method.uppercase()
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = m
                    connectTimeout = 15000
                    readTimeout = 180000
                    instanceFollowRedirects = true
                    doInput = true
                }
                runCatching {
                    val headers = JSONObject(headersJson)
                    for (k in headers.keys()) conn.setRequestProperty(k, headers.optString(k))
                }
                if (body.isNotEmpty() && m != "GET" && m != "HEAD") {
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val code = conn.responseCode
                val bytes = (if (code in 200..299) conn.inputStream else conn.errorStream)?.readBytes() ?: ByteArray(0)
                if (binary) {
                    val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    activity.evalOnAll("window['$callbackId'] && window['$callbackId'](true,$code,${JSONObject.quote(b64)},'')")
                } else {
                    val text = String(bytes, Charsets.UTF_8)
                    activity.evalOnAll("window['$callbackId'] && window['$callbackId'](true,$code,${JSONObject.quote(text)},'')")
                }
            } catch (e: Exception) {
                activity.evalOnAll("window['$callbackId'] && window['$callbackId'](false,0,'',${JSONObject.quote(e.message ?: "error")})")
            } finally {
                conn?.disconnect()
            }
        }
    }

    @JavascriptInterface
    fun log(msg: String) = activity.log(msg)
}
