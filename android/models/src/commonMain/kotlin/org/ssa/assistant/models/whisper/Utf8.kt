package org.ssa.assistant.models.whisper

/**
 * The WHATWG Encoding Standard's UTF-8 decoder, with U+FFFD replacement and a
 * kept BOM (TextDecoder('utf-8', {fatal:false, ignoreBOM:true}) in
 * transformers.js's ByteLevelDecoder, tokenizers.js:2108-2171).
 *
 * Decision 3: `decodeToString()` is not used, because the JVM and Kotlin/Native
 * may place a replacement character differently from the reference's decoder.
 */
internal fun decodeUtf8Whatwg(bytes: ByteArray): String {
    val out = StringBuilder(bytes.size)
    var cp = 0
    var needed = 0
    var seen = 0
    var lower = 0x80
    var upper = 0xBF
    var i = 0

    fun emit(codePoint: Int) {
        if (codePoint >= 0x10000) {
            val v = codePoint - 0x10000
            out.append(((v shr 10) + 0xD800).toChar())
            out.append(((v and 0x3FF) + 0xDC00).toChar())
        } else {
            out.append(codePoint.toChar())
        }
    }

    while (i < bytes.size) {
        val b = bytes[i].toInt() and 0xFF
        if (needed == 0) {
            when {
                b <= 0x7F -> emit(b)
                b in 0xC2..0xDF -> {
                    needed = 1
                    cp = b and 0x1F
                }
                b in 0xE0..0xEF -> {
                    if (b == 0xE0) lower = 0xA0
                    if (b == 0xED) upper = 0x9F
                    needed = 2
                    cp = b and 0xF
                }
                b in 0xF0..0xF4 -> {
                    if (b == 0xF0) lower = 0x90
                    if (b == 0xF4) upper = 0x8F
                    needed = 3
                    cp = b and 0x7
                }
                else -> emit(0xFFFD)
            }
            i++
        } else if (b < lower || b > upper) {
            // The byte does not belong to this sequence: replace what was read,
            // reset, and read this byte again in the starting state.
            cp = 0
            needed = 0
            seen = 0
            lower = 0x80
            upper = 0xBF
            emit(0xFFFD)
        } else {
            lower = 0x80
            upper = 0xBF
            cp = (cp shl 6) or (b and 0x3F)
            seen++
            if (seen == needed) {
                emit(cp)
                cp = 0
                needed = 0
                seen = 0
            }
            i++
        }
    }

    if (needed != 0) emit(0xFFFD)
    return out.toString()
}
