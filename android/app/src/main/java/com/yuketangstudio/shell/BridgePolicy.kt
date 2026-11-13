package com.yuketangstudio.shell

import java.net.URI

/** The native channel is available only to these HTTPS main documents. */
internal object BridgePolicy {
    val origins = setOf(
        "https://changjiang.yuketang.cn",
        "https://www.yuketang.cn",
        "https://pro.yuketang.cn",
        "https://changjiang-exam.yuketang.cn",
        "https://tsinghua-exam.yuketang.cn",
        "https://examination.xuetangx.com",
    )

    fun allows(raw: String, mainFrame: Boolean = true): Boolean = mainFrame && runCatching {
        val uri = URI(raw)
        uri.scheme == "https" && (uri.port == -1 || uri.port == 443) &&
            uri.rawUserInfo == null && "https://${uri.host?.lowercase()}" in origins
    }.getOrDefault(false)
}
