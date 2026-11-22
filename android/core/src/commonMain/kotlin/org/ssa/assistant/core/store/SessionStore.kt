@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)

package org.ssa.assistant.core.store

import kotlin.io.encoding.Base64
import org.ssa.assistant.core.Sensitive
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.turn.TurnController

/*
 * Port of src/store.js (Step 2 item 2): the saved-session format, written and
 * read the same way on the web, Android and iOS, so a session file means the
 * same thing everywhere. Pinned by the `store` golden (SessionStoreGoldenTest),
 * which includes a test vector encrypted with WebCrypto in Node.
 *
 * The three rules of store.js hold here too:
 *   1. Social Security and bank numbers are never written, encrypted or not
 *      (Sensitive.redact). A save records only that one was given (withheld).
 *   2. Everything else is written only encrypted, with a key derived from the
 *      user's PIN: PBKDF2-SHA256 at 600,000 iterations, then AES-256-GCM. No
 *      PIN, no saving.
 *   3. A session not touched for 7 days is deleted the next time it is looked
 *      for.
 *
 * The platform supplies only [Crypto] and [FileStore]. Everything that
 * decides something is here. The web's unencrypted v1/v2 sessions never
 * existed on a phone, so there is no legacy path.
 */

/** The cryptography a platform supplies: javax.crypto on the JVM and Android; CommonCrypto and CryptoKit in the iOS shell's Swift code (Run 4). */
interface Crypto {
    /** [size] bytes from the platform's secure random source. */
    fun randomBytes(size: Int): ByteArray

    /**
     * PBKDF2-HMAC-SHA256 over the UTF-8 bytes of the NFC form of [pin], 32
     * bytes of output, used as an AES-256-GCM key: exactly what
     * deriveSessionKey() in store.js asks WebCrypto for. The platform does the
     * NFC step, because common Kotlin has no Unicode normalizer.
     */
    fun deriveKey(pin: String, salt: ByteArray, iterations: Int): SessionKey

    /** AES-256-GCM with a 128-bit tag, the tag appended to the ciphertext, as WebCrypto returns it. */
    fun encrypt(key: SessionKey, iv: ByteArray, plaintext: ByteArray): ByteArray

    /**
     * The inverse of [encrypt], or null for a wrong key or changed bytes. Null
     * rather than an exception because the iOS implementation is Swift, and a
     * Swift method cannot throw a Kotlin exception across the Objective-C
     * boundary (Run 4).
     */
    fun decrypt(key: SessionKey, iv: ByteArray, ciphertext: ByteArray): ByteArray?
}

/** A derived key. Opaque: the platform keeps the key material and never hands it back. */
interface SessionKey

/** Where the session file lives: private, excluded from backup (noBackupFilesDir on Android). */
interface FileStore {
    fun read(name: String): String?
    /** Replaces the file whole, or leaves the old one. */
    fun write(name: String, text: String)
    fun delete(name: String)
}

/** store.js's StoreError: `kind` is "pin", "none" or "unsupported". */
class StoreException(message: String, val kind: String) : Exception(message)

/** A session as unlock() hands it back. */
data class OpenedSession(
    val savedAt: Json,
    val state: Json.Obj,
    val withheld: List<Json.Obj>,
    val translations: List<Json>,
    val inputLangs: List<Json>,
)

/** The format, as pure functions: each mirrors its namesake in store.js. */
object StoreFormat {
    const val STATE_FILE = "ssa-prep.state.v3"
    const val STORE_VERSION = 3
    const val KDF_ITERATIONS = 600_000
    const val MAX_AGE_MS = 7.0 * 24 * 60 * 60 * 1000
    const val MIN_PIN_LENGTH = 4
    const val SALT_BYTES = 16
    const val IV_BYTES = 12

    private fun num(v: Json?): Double? = (v as? Json.Num)?.value

    /** fieldKey() in store.js: id, loopId (or null), loopIndex (or 0). */
    fun fieldKey(w: Json.Obj): Triple<String?, String?, Double> =
        Triple(w["id"]?.asString(), w["loopId"]?.asString(), num(w["loopIndex"]) ?: 0.0)

    /** Lists of withheld fields joined in order, each field once. */
    fun mergeWithheld(vararg lists: List<Json.Obj>): List<Json.Obj> {
        val out = mutableListOf<Json.Obj>()
        val seen = mutableSetOf<Triple<String?, String?, Double>>()
        for (list in lists) for (w in list) if (seen.add(fieldKey(w))) out.add(w)
        return out
    }

    /** The plaintext a save encrypts (sessionPayload() in store.js). */
    fun sessionPayload(
        schema: Schema,
        state: Json.Obj,
        savedAt: Double,
        carried: List<Json.Obj> = emptyList(),
        translations: List<Json> = emptyList(),
        inputLangs: List<Json> = emptyList(),
    ): Json.Obj {
        val (safe, withheld) = Sensitive.redact(schema, state)
        return Json.Obj().also { o ->
            o["savedAt"] = Json.Num(savedAt)
            o["state"] = safe
            o["withheld"] = Json.Arr(mergeWithheld(withheld, carried).toMutableList())
            if (translations.isNotEmpty()) o["translations"] = Json.Arr(translations.toMutableList())
            if (inputLangs.isNotEmpty()) o["inputLangs"] = Json.Arr(inputLangs.toMutableList())
        }
    }

    /** The envelope written around the ciphertext. Byte fields are base64. */
    fun sessionEnvelope(savedAt: Double, salt: String, iv: String, data: String, iterations: Int = KDF_ITERATIONS): Json.Obj =
        Json.Obj().also { o ->
            o["v"] = Json.Num(STORE_VERSION.toDouble())
            o["savedAt"] = Json.Num(savedAt)
            o["kdf"] = Json.Obj().also { k ->
                k["name"] = Json.Str("PBKDF2-SHA256")
                k["iterations"] = Json.Num(iterations.toDouble())
                k["salt"] = Json.Str(salt)
            }
            o["iv"] = Json.Str(iv)
            o["data"] = Json.Str(data)
        }

    /** isExpired() in store.js: older than 7 days. A missing savedAt counts as 0. */
    fun isExpired(savedAt: Double?, now: Double): Boolean = now - (savedAt ?: 0.0) > MAX_AGE_MS

    /** openedSession() in store.js: redacted again, withheld from the file then from the state. */
    fun openedSession(schema: Schema, parsed: Json.Obj, envelopeSavedAt: Json? = null): OpenedSession {
        val state = parsed["state"]?.asObject() ?: Json.Obj()
        val (safe, withheld) = Sensitive.redact(schema, state.also { if (it["answers"] == null) it["answers"] = Json.Obj() })
        val fromFile = parsed["withheld"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()
        val savedAt = parsed["savedAt"]?.takeIf { it !== Json.Null } ?: envelopeSavedAt ?: Json.Null
        return OpenedSession(
            savedAt = savedAt,
            state = safe,
            withheld = fromFile + withheld,
            translations = parsed["translations"]?.asArray()?.items?.toList() ?: emptyList(),
            inputLangs = parsed["inputLangs"]?.asArray()?.items?.toList() ?: emptyList(),
        )
    }

    fun toB64(bytes: ByteArray): String = Base64.Default.encode(bytes)
    fun fromB64(text: String): ByteArray = Base64.Default.decode(text)
}

/**
 * repairWithheldList() in store.js: after item [removedIndex] of [loopId] is
 * deleted, its entries go and every later entry of that loop moves down one.
 * The TODO.md *Known quirks* fix, shared by the controller's live list and
 * the store's carried list.
 */
fun repairWithheldList(list: List<Json.Obj>, loopId: String, removedIndex: Int): List<Json.Obj> {
    val out = mutableListOf<Json.Obj>()
    for (w in list) {
        if (w["loopId"]?.asString() != loopId) { out.add(w); continue }
        val index = ((w["loopIndex"] as? Json.Num)?.value ?: 0.0).toInt()
        if (index == removedIndex) continue
        out.add(
            if (index > removedIndex) Json.Obj(LinkedHashMap(w.entries)).also { it["loopIndex"] = Json.Num((index - 1).toDouble()) }
            else w
        )
    }
    return out
}

/**
 * The store itself, as the turn controller's StorePort. Every call is
 * synchronous and runs on the caller's thread; the app calls [usePin] and
 * [unlock] off the main thread, because key derivation takes about half a
 * second (plan, Architecture: one thread).
 */
class SessionStore(
    private val schema: Schema,
    private val crypto: Crypto,
    private val files: FileStore,
    private val clock: () -> Double,
) : TurnController.StorePort {
    private var key: SessionKey? = null
    private var salt: ByteArray? = null
    private var iterations = StoreFormat.KDF_ITERATIONS
    // Withheld by the session this one resumed, or dropped from memory by the
    // idle lock (markWithheld): withheld in every later save.
    private var carried: List<Json.Obj> = emptyList()
    private var translations: List<Json> = emptyList()
    private var inputLangs: List<Json> = emptyList()

    /** Protect a new session's saves with this PIN. */
    fun usePin(pin: String) {
        if (pin.length < StoreFormat.MIN_PIN_LENGTH) {
            throw StoreException("A PIN needs at least ${StoreFormat.MIN_PIN_LENGTH} characters.", "pin")
        }
        val s = crypto.randomBytes(StoreFormat.SALT_BYTES)
        key = crypto.deriveKey(pin, s, StoreFormat.KDF_ITERATIONS)
        salt = s
        iterations = StoreFormat.KDF_ITERATIONS
    }

    override fun forgetKey() {
        key = null
        salt = null
        carried = emptyList()
        translations = emptyList()
        inputLangs = emptyList()
    }

    override fun isPersisting(): Boolean = key != null

    override fun markWithheld(fields: List<Json.Obj>) {
        carried = StoreFormat.mergeWithheld(carried, fields)
    }

    override fun repairWithheld(loopId: String, removedIndex: Int) {
        carried = repairWithheldList(carried, loopId, removedIndex)
    }

    override fun sensitiveAnswers(state: Json.Obj): List<Json.Obj> = Sensitive.sensitiveAnswers(schema, state)

    /** The translations and input-language tags saved with the session from now on (plan 4.4, 4.8). */
    fun setSessionData(translations: List<Json>? = null, inputLangs: List<Json>? = null) {
        if (translations != null) this.translations = translations
        if (inputLangs != null) this.inputLangs = inputLangs
    }

    override fun saveState(state: Json.Obj): Boolean = save(state)

    /** saveState() in store.js; [replace] drops what a resumed session carried. */
    fun save(state: Json.Obj, replace: Boolean = false): Boolean {
        val k = key ?: return false
        val s = salt ?: return false
        if (replace) forgetCarried()
        val savedAt = clock()
        val payload = StoreFormat.sessionPayload(schema, state, savedAt, carried, translations, inputLangs)
        val iv = crypto.randomBytes(StoreFormat.IV_BYTES)
        val data = crypto.encrypt(k, iv, payload.writeJson().encodeToByteArray())
        files.write(
            StoreFormat.STATE_FILE,
            StoreFormat.sessionEnvelope(savedAt, StoreFormat.toB64(s), StoreFormat.toB64(iv), StoreFormat.toB64(data), iterations).writeJson(),
        )
        return true
    }

    private fun forgetCarried() {
        carried = emptyList()
        translations = emptyList()
        inputLangs = emptyList()
    }

    /** Writes are synchronous here, so there is nothing to wait for. */
    override suspend fun flush() {}

    private fun envelope(): Json.Obj? = try {
        files.read(StoreFormat.STATE_FILE)?.let { JsonParser.parse(it).asObject() }
    } catch (_: IllegalArgumentException) {
        null
    }

    /**
     * savedSessionInfo() in store.js: the saved time, without decrypting, or
     * null. A session older than 7 days is deleted here.
     */
    fun savedSessionInfo(now: Double = clock()): Double? {
        val enc = envelope() ?: return null
        if ((enc["v"] as? Json.Num)?.value != StoreFormat.STORE_VERSION.toDouble() || enc["data"] == null) return null
        val savedAt = (enc["savedAt"] as? Json.Num)?.value
        if (StoreFormat.isExpired(savedAt, now)) {
            files.delete(StoreFormat.STATE_FILE)
            return null
        }
        return savedAt ?: 0.0
    }

    /** unlock() in store.js. On success the same key protects every later save. */
    fun unlock(pin: String): OpenedSession {
        val enc = envelope()
        val data = enc?.get("data")?.asString() ?: throw StoreException("There is no saved session.", "none")
        val kdf = enc["kdf"]?.asObject() ?: throw StoreException("There is no saved session.", "none")
        val saltBytes = StoreFormat.fromB64(kdf["salt"]?.asString() ?: "")
        val rounds = ((kdf["iterations"] as? Json.Num)?.value ?: StoreFormat.KDF_ITERATIONS.toDouble()).toInt()
        val candidate = crypto.deriveKey(pin, saltBytes, rounds)
        val plain = crypto.decrypt(candidate, StoreFormat.fromB64(enc["iv"]?.asString() ?: ""), StoreFormat.fromB64(data))
            ?: throw StoreException("That PIN does not open the saved answers.", "pin")
        val parsed = JsonParser.parse(plain.decodeToString()).asObject() ?: Json.Obj()
        key = candidate
        salt = saltBytes
        iterations = rounds
        val opened = StoreFormat.openedSession(schema, parsed, enc["savedAt"])
        carried = opened.withheld
        translations = opened.translations
        inputLangs = opened.inputLangs
        return opened
    }

    /** Delete the saved session. The key, if any, keeps protecting new saves. */
    override fun clearState() {
        forgetCarried()
        files.delete(StoreFormat.STATE_FILE)
    }
}
