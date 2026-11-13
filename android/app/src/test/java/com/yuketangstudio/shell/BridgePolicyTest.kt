package com.yuketangstudio.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgePolicyTest {
    @Test fun approvedMainDocumentsCanUseNativeChannel() {
        BridgePolicy.origins.forEach { origin ->
            assertTrue(BridgePolicy.allows(origin))
            assertTrue(BridgePolicy.allows("$origin/path?x=1"))
        }
        assertTrue(BridgePolicy.allows("https://www.yuketang.cn:443/web/"))
    }

    @Test fun subframesAndUntrustedOriginsCannotUseNativeChannel() {
        BridgePolicy.origins.forEach { assertFalse(BridgePolicy.allows(it, false)) }
        listOf(
            "https://evil.example", "https://www.yuketang.cn.evil.example",
            "https://unlisted.yuketang.cn", "http://www.yuketang.cn",
            "https://www.yuketang.cn:444", "https://www.yuketang.cn@evil.example",
            "https://evil.example@www.yuketang.cn", "file:///tmp/page.html", "about:blank", "null",
        ).forEach { assertFalse(it, BridgePolicy.allows(it)) }
    }
}
