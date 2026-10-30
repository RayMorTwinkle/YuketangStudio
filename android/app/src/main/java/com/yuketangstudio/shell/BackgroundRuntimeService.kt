package com.yuketangstudio.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 后台课堂监听的前台服务。
 *
 * 它只负责 Android 生命周期、常驻通知、WakeLock/WiFiLock、心跳状态和故障提示。
 * 课堂业务仍然由 Activity 里的 WebView / 用户脚本执行；服务不会创建第二个 WebView，
 * 避免重复监听、重复通知和重复提交。
 */
class BackgroundRuntimeService : Service() {

    companion object {
        private const val TAG = "YktRuntime"
        private const val CHANNEL_ID = "ykt_background_runtime"
        private const val NOTIFICATION_ID = 0x594B
        private const val ACTION_START = "com.yuketangstudio.shell.RUNTIME_START"
        private const val ACTION_STOP = "com.yuketangstudio.shell.RUNTIME_STOP"
        private const val ACTION_STRONG = "com.yuketangstudio.shell.RUNTIME_STRONG"
        const val ACTION_PING = "com.yuketangstudio.shell.RUNTIME_PING"
        private const val EXTRA_STRONG = "strong"
        private const val HEARTBEAT_STALE_MS = 30_000L

        @Volatile
        private var live: BackgroundRuntimeService? = null

        fun start(context: Context, strong: Boolean): Boolean {
            Log.i(TAG, "start requested strong=$strong")
            RuntimeState.setEnabled(context, true)
            RuntimeState.setStrong(context, strong)
            return try {
                val intent = Intent(context, BackgroundRuntimeService::class.java).apply {
                    action = ACTION_START
                    putExtra(EXTRA_STRONG, strong)
                }
                ContextCompat.startForegroundService(context.applicationContext, intent)
                true
            } catch (e: Throwable) {
                RuntimeState.setEnabled(context, false)
                RuntimeState.markError(context, "后台服务启动失败：${e.message ?: e.javaClass.simpleName}")
                Log.e(TAG, "start failed", e)
                false
            }
        }

        fun stop(context: Context) {
            RuntimeState.setEnabled(context, false)
            try {
                context.applicationContext.stopService(
                    Intent(context.applicationContext, BackgroundRuntimeService::class.java),
                )
            } catch (e: Throwable) {
                Log.w(TAG, "stop failed", e)
            }
        }

        fun setStrong(context: Context, strong: Boolean) {
            RuntimeState.setStrong(context, strong)
            live?.applyStrong(strong)
        }

        fun update(context: Context, json: String) {
            try {
                val patch = JSONObject(json)
                // enabled/strong 是外壳设置的所有权字段，JS 心跳不能覆盖。
                // 否则用户刚关闭服务，脚本的旧 heartbeat 又会把 enabled 写回 true。
                patch.remove("enabled")
                patch.remove("strong")
                // JS 用 heartbeatAt / ts；服务统一存 heartbeatAt。
                if (!patch.has("heartbeatAt") && patch.has("ts")) patch.put("heartbeatAt", patch.optLong("ts"))
                RuntimeState.update(context, patch)
                live?.refreshNotification()
            } catch (e: Throwable) {
                Log.w(TAG, "update state failed", e)
            }
        }

        fun reportRendererState(context: Context, state: String) {
            RuntimeState.update(context, JSONObject().put("rendererState", state))
            live?.refreshNotification()
        }

        fun snapshot(context: Context): String {
            val state = RuntimeState.read(context)
            val now = System.currentTimeMillis()
            val last = state.optLong("heartbeatAt", 0L)
            state.put("running", live != null)
            state.put("heartbeatAgeMs", if (last > 0) now - last else -1L)
            return state.toString()
        }

        fun isRunning(): Boolean = live != null
    }

    private var strong = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private val ticker = object : Runnable {
        override fun run() {
            // Native → JS 心跳：Activity 收到广播后调用页面的 __yktRuntimePing。
            try {
                sendBroadcast(Intent(ACTION_PING).setPackage(packageName))
            } catch (_: Throwable) { /* ignore */ }
            refreshNotification()
            handler.postDelayed(this, 15_000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        live = this
        Log.i(TAG, "service onCreate")
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand action=${intent?.action} startId=$startId")
        when (intent?.action) {
            ACTION_STOP -> {
                RuntimeState.setEnabled(this, false)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_STRONG -> {
                val next = intent.getBooleanExtra(EXTRA_STRONG, false)
                strong = next
                RuntimeState.setStrong(this, next)
                updateLocks()
                refreshNotification()
                return START_STICKY
            }
            ACTION_START -> {
                strong = intent.getBooleanExtra(EXTRA_STRONG, RuntimeState.read(this).optBoolean("strong", false))
                RuntimeState.setEnabled(this, true)
                RuntimeState.setStrong(this, strong)
            }
            null -> {
                if (!RuntimeState.read(this).optBoolean("enabled", false)) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                strong = RuntimeState.read(this).optBoolean("strong", false)
            }
        }

        RuntimeState.update(this, JSONObject().put("foregroundSince", System.currentTimeMillis()))
        startForegroundCompat()
        updateLocks()
        handler.removeCallbacks(ticker)
        handler.post(ticker)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.i(TAG, "service onDestroy")
        handler.removeCallbacks(ticker)
        releaseLocks()
        if (live === this) live = null
        // 这里不把 enabled 改成 false：系统回收服务后，下次冷启动仍应恢复用户开启的后台监听。
        // 只有用户主动停止（ACTION_STOP / stop()）才清除 enabled。
        super.onDestroy()
    }

    private fun applyStrong(next: Boolean) {
        strong = next
        updateLocks()
        refreshNotification()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                "后台课堂监听",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "保持 YuketangStudio 课堂监听在后台运行"
                setShowBadge(false)
            }
            mgr.createNotificationChannel(channel)
        }
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            Log.i(TAG, "startForeground ok")
        } catch (e: Throwable) {
            RuntimeState.markError(this, "前台服务启动失败：${e.message ?: e.javaClass.simpleName}")
            Log.e(TAG, "startForeground failed", e)
        }
    }

    private fun refreshNotification() {
        try {
            val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            mgr.notify(NOTIFICATION_ID, buildNotification())
        } catch (e: Throwable) {
            Log.w(TAG, "notify failed", e)
        }
    }

    private fun buildNotification(): Notification {
        val state = RuntimeState.read(this)
        val now = System.currentTimeMillis()
        val last = state.optLong("heartbeatAt", 0L)
        val age = if (last > 0) now - last else -1L
        val scriptState = when {
            last <= 0 -> "等待脚本心跳…"
            age > HEARTBEAT_STALE_MS -> "脚本可能已停止（最后心跳 ${timeText(last)}）"
            else -> "监听中 · 最后心跳 ${timeText(last)}"
        }
        val renderer = state.optString("rendererState", "")
        val detail = when {
            renderer == "gone" -> "页面渲染进程已回收，请打开 App 恢复页面"
            renderer == "unresponsive" -> "页面无响应，请打开 App 检查"
            else -> scriptState
        }
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            this,
            1001,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopPending = PendingIntent.getService(
            this,
            1002,
            Intent(this, BackgroundRuntimeService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_feed)
            .setContentTitle("YuketangStudio 后台监听")
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openPending)
            .addAction(0, "停止", stopPending)
            .build()
    }

    private fun updateLocks() {
        if (!strong) {
            releaseLocks()
            return
        }
        try {
            if (wakeLock == null) {
                val pm = getSystemService(POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "YuketangStudio:background")
                wakeLock?.setReferenceCounted(false)
            }
            if (wakeLock?.isHeld != true) wakeLock?.acquire()
        } catch (e: Throwable) {
            Log.w(TAG, "wake lock failed", e)
        }
        try {
            if (wifiLock == null) {
                val wm = applicationContext.getSystemService(WIFI_SERVICE) as android.net.wifi.WifiManager
                wifiLock = wm.createWifiLock(
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                    "YuketangStudio:background-wifi",
                )
                wifiLock?.setReferenceCounted(false)
            }
            if (wifiLock?.isHeld != true) wifiLock?.acquire()
        } catch (e: Throwable) {
            Log.w(TAG, "wifi lock failed", e)
        }
    }

    private fun releaseLocks() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Throwable) {}
        wakeLock = null
        try { if (wifiLock?.isHeld == true) wifiLock?.release() } catch (_: Throwable) {}
        wifiLock = null
    }

    private fun timeText(ms: Long): String =
        SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(ms))
}
