package com.yuketangstudio.shell

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 账号档案库：每个 profile = {id, name, env, origin, cookies, localStorage, savedAt}
 * 存 SharedPreferences "accounts"；账号切换 = 存当前 session → 注入目标 profile。
 * profile 的 localStorage 含 Authorization 等登录凭证，仅本机存储。
 */
object AccountStore {

    data class Profile(
        val id: String,
        var name: String,
        var env: String,           // Env.name
        var origin: String,        // localStorage 所属 origin
        var cookies: JSONObject = JSONObject(),   // origin→cookie 串
        var localStorage: JSONObject = JSONObject(), // k→v
        var savedAt: Long = 0L,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("id", id).put("name", name).put("env", env)
            .put("origin", origin).put("cookies", cookies)
            .put("localStorage", localStorage).put("savedAt", savedAt)

        /** 登录凭证摘要（比较两个 session 是否同账号） */
        fun authFingerprint(): String = fingerprint(localStorage)
    }

    private const val PREF = "accounts"
    private const val KEY = "list"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun all(ctx: Context): MutableList<Profile> {
        val arr = JSONArray(prefs(ctx).getString(KEY, "[]"))
        val out = mutableListOf<Profile>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out += Profile(
                id = o.optString("id"),
                name = o.optString("name"),
                env = o.optString("env"),
                origin = o.optString("origin"),
                cookies = o.optJSONObject("cookies") ?: JSONObject(),
                localStorage = o.optJSONObject("localStorage") ?: JSONObject(),
                savedAt = o.optLong("savedAt"),
            )
        }
        return out
    }

    fun save(ctx: Context, list: List<Profile>) {
        val arr = JSONArray()
        list.forEach { arr.put(it.toJson()) }
        prefs(ctx).edit().putString(KEY, arr.toString()).apply()
    }

    fun upsert(ctx: Context, p: Profile) {
        val list = all(ctx)
        val idx = list.indexOfFirst { it.id == p.id }
        if (idx >= 0) list[idx] = p else list.add(p)
        save(ctx, list)
    }

    fun remove(ctx: Context, id: String) {
        save(ctx, all(ctx).filter { it.id != id })
    }

    fun rename(ctx: Context, id: String, name: String) {
        val list = all(ctx)
        list.find { it.id == id }?.name = name
        save(ctx, list)
    }

    /** 从 localStorage JSON 提取登录凭证指纹（Authorization/token 系） */
    fun fingerprint(ls: JSONObject): String {
        // ① 雨课堂把登录态放 Cookie（HttpOnly），localStorage 里只有 user_profile
        //    之前只扫 authorization/token 键，导致永远判定「未登录」——账号功能实际不可用
        val rawProfile = ls.optString("user_profile")
        if (rawProfile.startsWith("{")) {
            runCatching {
                val o = JSONObject(rawProfile)
                val uid = o.optString("user_id")
                if (uid.isNotBlank() && uid != "0") return "uid:$uid"
            }
        }
        // ② 通用 token 扫描（兼容其它站点/旧版本）
        for (k in ls.keys()) {
            val kl = k.lowercase()
            if (kl.contains("authorization") || kl.contains("token")) {
                val v = ls.optString(k)
                if (v.length > 8) return v.takeLast(16)
            }
        }
        return ""
    }

    /** 从 localStorage JSON 猜显示名 */
    fun guessName(ls: JSONObject, fallback: String): String {
        // 雨课堂：user_profile.name（如「陈益博」）
        val rawProfile = ls.optString("user_profile")
        if (rawProfile.startsWith("{")) {
            runCatching {
                val o = JSONObject(rawProfile)
                val n = o.optString("name").ifBlank { o.optString("nickname") }
                if (n.isNotBlank() && !n.startsWith("{")) return n
            }
        }
        for (k in ls.keys()) {
            val kl = k.lowercase()
            if (kl.contains("realname") || kl.contains("username") ||
                (kl == "name" && ls.optString(k).length in 2..20)) {
                val v = ls.optString(k)
                if (v.isNotBlank() && !v.startsWith("{")) return v
            }
        }
        // userInfo/user 类对象里再找
        for (k in ls.keys()) {
            val v = ls.optString(k)
            if (v.startsWith("{")) {
                runCatching {
                    val inner = JSONObject(v)
                    for (ik in inner.keys()) {
                        if (ik.lowercase().let { it.contains("realname") || it.contains("username") })
                            return inner.optString(ik).ifBlank { fallback }
                    }
                }
            }
        }
        return fallback
    }
}
