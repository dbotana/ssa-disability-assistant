package org.ssa.assistant.models.whisper

import kotlin.test.Test
import kotlin.test.assertEquals

class Utf8Test {
    @Test
    fun followsWhatwgReplacementRules() {
        val cases = listOf(
            byteArrayOf(0xC3.toByte()) to "\uFFFD",
            byteArrayOf(0xE2.toByte(), 0x82.toByte()) to "\uFFFD",
            byteArrayOf(0xE2.toByte(), 0x41.toByte()) to "\uFFFDA",
            byteArrayOf(0xF0.toByte(), 0x9F.toByte(), 0x91.toByte(), 0x8D.toByte()) to "👍",
            byteArrayOf(0xED.toByte(), 0xA0.toByte(), 0x80.toByte()) to "\uFFFD\uFFFD\uFFFD",
            byteArrayOf(0xC0.toByte(), 0x80.toByte()) to "\uFFFD\uFFFD",
            byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte(), 0x41.toByte()) to "\uFEFFA",
            " café".encodeToByteArray() to " café",
        )
        for ((bytes, expected) in cases) {
            assertEquals(expected, decodeUtf8Whatwg(bytes), "bytes ${bytes.toList()}")
        }
    }
}
