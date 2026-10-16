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

    // ---------- 通知 ----------
    @JavascriptInterface
    fun notify(title: String, text: String, image: String) {
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
        val intent = PendingIntent.getActivity(
            activity, 0, Intent(activity, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        mgr.notify(
            (System.currentTimeMillis() and 0x7fffffff).toInt(),
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
    @JavascriptInterface
    fun downloadStart(job: String, filename: String) {
        io.execute {
            try {
                val safe = filename.replace(Regex("[\\\\/:*?\"<>|]"), "_")
                val file = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "$job.part")
                downloads[job] = FileOutputStream(file)
                fileJobNames[job] = safe
            } catch (e: Exception) {
                activity.log("downloadStart 失败: ${e.message}")
            }
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
                        activity.runOnUiThread { Toast.makeText(activity, "已保存到 下载/YuketangStudio/$name", Toast.LENGTH_LONG).show() }
                    } else {
                        // MediaStore 失败 → 留在应用私有目录，至少文件不丢
                        val dest = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name)
                        part.renameTo(dest)
                        activity.runOnUiThread { Toast.makeText(activity, "已保存到应用目录/$name", Toast.LENGTH_LONG).show() }
                    }
                } else {
                    @Suppress("DEPRECATION")
                    val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "YuketangStudio")
                    dir.mkdirs()
                    val dest = File(dir, name)
                    part.renameTo(dest)
                    activity.runOnUiThread { Toast.makeText(activity, "已保存到 $dest", Toast.LENGTH_LONG).show() }
                }
            } catch (e: Exception) {
                activity.log("downloadEnd 失败: ${e.message}")
            }
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
                activity.evalOnCollectAndMain(
                    "window['$callbackId']($ok,$code,${JSONObject.quote(b64)},${JSONObject.quote("")})"
                )
            } catch (e: Exception) {
                activity.evalOnCollectAndMain(
                    "window['$callbackId'](false,0,null,${JSONObject.quote(e.message ?: "error")})"
                )
            } finally {
                conn?.disconnect()
            }
        }
    }

    @JavascriptInterface
    fun log(msg: String) = activity.log(msg)
}
