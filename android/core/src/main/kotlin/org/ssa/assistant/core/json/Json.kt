package org.ssa.assistant.core.json

import org.ssa.assistant.core.js.jsJsonNumber

/**
 * A tiny, dependency-free JSON model for the offline app.
 *
 * The schema export (tools/schema.json) and every golden fixture are parsed
 * with this, on the JVM now and on Android later. Goldens are compared as
 * parsed JSON trees — numbers by value, strings by value, arrays in order,
 * objects by key — never as raw strings.
 */

sealed interface Json {
    data class Obj(val entries: LinkedHashMap<String, Json> = LinkedHashMap()) : Json {
        operator fun get(key: String?): Json? = if (key == null) null else entries[key]
        operator fun set(key: String?, value: Json) {
            if (key != null) entries[key] = value
        }
    }

    data class Arr(val items: MutableList<Json> = mutableListOf()) : Json

    data class Str(val value: String) : Json

    /** A JSON number. Whole numbers and decimals share one representation. */
    data class Num(val value: Double) : Json

    object Null : Json
    object True : Json
    object False : Json

    companion object {
        fun bool(b: Boolean): Json = if (b) True else False
        fun num(n: Number): Json = Num(n.toDouble())
        fun of(value: Any?): Json = when (value) {
            null -> Null
            is Json -> value
            is Boolean -> bool(value)
            is String -> Str(value)
            is Int, is Long, is Double, is Float, is Short, is Byte -> Num(value.toString().toDouble())
            is Map<*, *> -> Obj(LinkedHashMap<String, Json>().also { map ->
                value.forEach { (k, v) -> map[k.toString()] = of(v) }
            })
            is List<*> -> Arr(value.mapTo(mutableListOf()) { of(it) })
            is Set<*> -> Arr(value.mapTo(mutableListOf()) { of(it) })
            else -> Str(value.toString())
        }
    }
}

/** Deep equality as parsed trees: numbers by value, objects by key set. */
fun Json.treeEquals(other: Json): Boolean = when (this) {
    is Json.Obj -> other is Json.Obj && entries.size == other.entries.size &&
        entries.all { (k, v) -> other.entries[k]?.treeEquals(v) == true }
    is Json.Arr -> other is Json.Arr && items.size == other.items.size &&
        items.indices.all { items[it].treeEquals(other.items[it]) }
    is Json.Str -> other is Json.Str && value == other.value
    is Json.Num -> other is Json.Num && java.lang.Double.doubleToLongBits(value) == java.lang.Double.doubleToLongBits(other.value)
    Json.Null -> other === Json.Null
    Json.True -> other === Json.True
    Json.False -> other === Json.False
}

fun Json.asString(): String? = (this as? Json.Str)?.value
fun Json.asDouble(): Double? = (this as? Json.Num)?.value
fun Json.asBoolean(): Boolean? = when (this) {
    Json.True -> true
    Json.False -> false
    else -> null
}
fun Json.asObject(): Json.Obj? = this as? Json.Obj
fun Json.asArray(): Json.Arr? = this as? Json.Arr

/** Write a tree as JSON the way JavaScript's JSON.stringify does: numbers as
 *  JS would print them ("15", not "15.0"; "0.0001"; "1e+21"), and NaN and the
 *  infinities as null. */
fun Json.writeJson(): String {
    val sb = StringBuilder()
    fun write(v: Json) {
        when (v) {
            is Json.Obj -> {
                sb.append('{')
                var first = true
                for ((k, child) in v.entries) {
                    if (!first) sb.append(',')
                    first = false
                    sb.append('"').append(escapeString(k)).append("\":")
                    write(child)
                }
                sb.append('}')
            }
            is Json.Arr -> {
                sb.append('[')
                v.items.forEachIndexed { i, child ->
                    if (i > 0) sb.append(',')
                    write(child)
                }
                sb.append(']')
            }
            is Json.Str -> sb.append('"').append(escapeString(v.value)).append('"')
            is Json.Num -> sb.append(jsJsonNumber(v.value))
            Json.Null -> sb.append("null")
            Json.True -> sb.append("true")
            Json.False -> sb.append("false")
        }
    }
    write(this)
    return sb.toString()
}

fun escapeString(s: String): String {
    val sb = StringBuilder()
    for (c in s) {
        when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            '\b' -> sb.append("\\b")
            '\u000C' -> sb.append("\\f")
            // Not String.format: its digits follow the device locale.
            else -> if (c < ' ') sb.append("\\u").append(c.code.toString(16).padStart(4, '0')) else sb.append(c)
        }
    }
    return sb.toString()
}

/** Deep copy by round-trip, exactly as structuredClone copies JSON state. */
fun Json.deepCopy(): Json = JsonParser.parse(writeJson())

/**
 * Parse one JSON document. Throws IllegalArgumentException on any bad input,
 * truncated input included — the importer reads files a person picked, and
 * catches exactly that.
 */
object JsonParser {
    fun parse(text: String): Json = try {
        Parser(text).parse()
    } catch (e: IllegalArgumentException) {
        throw e
    } catch (e: IndexOutOfBoundsException) {
        throw IllegalArgumentException("JSON: unexpected end of input", e)
    }

    private class Parser(private val s: String) {
        private var i = 0

        fun parse(): Json {
            val result = parseValue()
            skipWs()
            if (i != s.length) fail("trailing content")
            return result
        }

        private fun skipWs() {
            while (i < s.length && s[i] in " \t\n\r") i++
        }

        private fun fail(msg: String): Nothing = throw IllegalArgumentException("JSON: $msg at $i")

        private fun expect(word: String) {
            if (s.startsWith(word, i)) i += word.length else fail("expected $word")
        }

        private fun parseValue(): Json {
            skipWs()
            if (i >= s.length) fail("unexpected end")
            return when (s[i]) {
                '{' -> parseObj()
                '[' -> parseArr()
                '"' -> Json.Str(parseString())
                't' -> { expect("true"); Json.True }
                'f' -> { expect("false"); Json.False }
                'n' -> { expect("null"); Json.Null }
                else -> parseNumber()
            }
        }

        private fun parseString(): String {
            i++ // opening quote
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) fail("unterminated string")
                val c = s[i]
                when {
                    c == '"' -> { i++; return sb.toString() }
                    c == '\\' -> {
                        i++
                        when (val e = s[i]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 5 > s.length) fail("unterminated \\u escape")
                                val hex = s.substring(i + 1, i + 5)
                                val code = hex.toIntOrNull(16) ?: fail("bad \\u escape")
                                sb.append(code.toChar())
                                i += 4
                            }
                            else -> fail("bad escape \\$e")
                        }
                        i++
                    }
                    else -> { sb.append(c); i++ }
                }
            }
        }

        private fun parseNumber(): Json {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && (s[i] in '0'..'9' || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) i++
            val raw = s.substring(start, i)
            val v = raw.toDoubleOrNull() ?: fail("bad number $raw")
            return Json.Num(v)
        }

        private fun parseObj(): Json {
            i++ // {
            val obj = Json.Obj()
            skipWs()
            if (i < s.length && s[i] == '}') { i++; return obj }
            while (true) {
                skipWs()
                if (s[i] != '"') fail("expected string key")
                val key = parseString()
                skipWs()
                if (s[i] != ':') fail("expected :")
                i++
                obj[key] = parseValue()
                skipWs()
                when {
                    s[i] == ',' -> i++
                    s[i] == '}' -> { i++; return obj }
                    else -> fail("expected , or }")
                }
            }
        }

        private fun parseArr(): Json {
            i++ // [
            val arr = Json.Arr()
            skipWs()
            if (i < s.length && s[i] == ']') { i++; return arr }
            while (true) {
                arr.items.add(parseValue())
                skipWs()
                when {
                    s[i] == ',' -> i++
                    s[i] == ']' -> { i++; return arr }
                    else -> fail("expected , or ]")
                }
            }
        }
    }
}
