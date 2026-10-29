package com.yuketangstudio.shell

import android.content.Context
import org.json.JSONObject

/**
 * 后台运行状态的唯一持久化入口。
 *
 * JS 心跳、前台服务、通知、诊断都读写同一份 JSON，避免“通知显示运行中，
 * 但脚本其实已经停止”这种状态分裂。这里只保存运行元数据，不保存题目/答案。
 */
object RuntimeState {
    private const val PREFS = "background_runtime"
    private const val KEY = "state"

    private val ALLOWED = setOf(
        "enabled", "strong", "startedAt", "foregroundSince",
        "heartbeatAt", "lastWsState", "lastWsMessageAt", "lastUnlockAt",
        "lastEventAt", "lessonId", "page", "scriptVersion", "lastError",
        "rendererState",
    )

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun read(context: Context): JSONObject {
        val raw = prefs(context).getString(KEY, "{}") ?: "{}"
        return try { JSONObject(raw) } catch (_: Throwable) { JSONObject() }
    }

    @Synchronized
    fun update(context: Context, patch: JSONObject) {
        if (patch.length() == 0) return
        val state = read(context)
        for (key in ALLOWED) {
            if (patch.has(key)) state.put(key, patch.get(key))
        }
        prefs(context).edit().putString(KEY, state.toString()).apply()
    }

    fun setEnabled(context: Context, enabled: Boolean) {
        val patch = JSONObject().put("enabled", enabled)
        if (enabled) patch.put("startedAt", System.currentTimeMillis())
        update(context, patch)
    }

    fun setStrong(context: Context, strong: Boolean) {
        update(context, JSONObject().put("strong", strong))
    }

    fun markError(context: Context, error: String) {
        update(context, JSONObject().put("lastError", error.take(300)))
    }
}
