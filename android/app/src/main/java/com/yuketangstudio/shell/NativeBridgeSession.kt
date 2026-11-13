package com.yuketangstudio.shell

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Origin-checked messages and replies tied to the initiating frame, including after tab switches. */
internal object NativeBridgeSession {
    fun install(activity: MainActivity, view: WebView, bridge: YktBridge, documentId: () -> Long) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Do not fall back to an interface exposed to every origin/frame.
            activity.log("当前 WebView 不支持安全原生通道，请更新 Android System WebView")
            return
        }
        val prefix = UUID.randomUUID().toString() + ":"
        WebViewCompat.addWebMessageListener(view, "__yktNativeChannel", BridgePolicy.origins) {
                _, message, sourceOrigin, isMainFrame, replyProxy ->
            if (!BridgePolicy.allows(sourceOrigin.toString(), isMainFrame)) return@addWebMessageListener
            val ownerDocument = documentId()
            activity.registerNativeReply(view) { response ->
                if (documentId() == ownerDocument) replyProxy.postMessage(response)
            }
            val request = runCatching { JSONObject(message.data ?: "") }.getOrNull()
                ?: return@addWebMessageListener
            val id = request.optString("id")
            if (!Regex("^[A-Za-z0-9_]{1,64}$").matches(id)) return@addWebMessageListener
            val args = request.optJSONArray("args") ?: JSONArray()
            val reply: (Any?) -> Unit = { result ->
                val response = JSONObject().put("id", id).put("result", result ?: JSONObject.NULL).toString()
                activity.runOnUiThread {
                    if (documentId() == ownerDocument) runCatching { replyProxy.postMessage(response) }
                }
            }
            try {
                when (request.optString("method")) {
                    "fetchRequest" -> {
                        bridge.fetchRequest(args.getString(0), args.getString(1), args.getString(2),
                            args.getString(3), args.getBoolean(4), prefix + id, reply)
                        return@addWebMessageListener
                    }
                    "cancelRequest" -> bridge.cancelRequest(prefix + args.getString(0))
                    "sharedSnapshot" -> { reply(bridge.sharedSnapshot()); return@addWebMessageListener }
                    "sharedSet" -> bridge.sharedSet(args.getString(0), args.getString(1))
                    "sharedDelete" -> bridge.sharedDelete(args.getString(0))
                    "startBackgroundRuntime" -> { reply(bridge.startBackgroundRuntime(args.getBoolean(0))); return@addWebMessageListener }
                    "stopBackgroundRuntime" -> bridge.stopBackgroundRuntime()
                    "setBackgroundRuntimeStrong" -> bridge.setBackgroundRuntimeStrong(args.getBoolean(0))
                    "getBackgroundRuntimeState" -> { reply(bridge.getBackgroundRuntimeState()); return@addWebMessageListener }
                    "reportRuntime" -> bridge.reportRuntime(args.getString(0))
                    "isBatteryOptimizationIgnored" -> { reply(bridge.isBatteryOptimizationIgnored()); return@addWebMessageListener }
                    "requestBatteryOptimization" -> { reply(bridge.requestBatteryOptimization()); return@addWebMessageListener }
                    "openCollect" -> bridge.openCollect(args.getString(0))
                    "closeCollect" -> bridge.closeCollect()
                    "openAboutAndUpdate" -> bridge.openAboutAndUpdate()
                    "copyText" -> bridge.copyText(args.getString(0))
                    "notify" -> bridge.notify(args.getString(0), args.getString(1), args.getString(2), args.getString(3))
                    "downloadStart" -> bridge.downloadStart(args.getString(0), args.getString(1))
                    "downloadChunk" -> bridge.downloadChunk(args.getString(0), args.getString(1))
                    "downloadEnd" -> bridge.downloadEnd(args.getString(0))
                    "log" -> bridge.log(args.getString(0))
                    else -> return@addWebMessageListener
                }
                reply(null)
            } catch (e: Exception) {
                activity.runOnUiThread {
                    if (documentId() == ownerDocument) runCatching {
                        replyProxy.postMessage(JSONObject().put("id", id)
                            .put("error", e.message ?: "Native request failed").toString())
                    }
                }
            }
        }
    }
}
