package org.ssa.assistant.core.store

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.writeJson
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The `store` golden's test vector: a session encrypted with WebCrypto in
 * Node (crypto.subtle, PBKDF2-SHA256 at 600,000 iterations, AES-256-GCM)
 * decrypts with JvmCrypto, through the same SessionStore.unlock() the app
 * calls. The PIN is typed in NFD and the key derived from its NFC form, as
 * store.js does. iOS runs the same vector once X1b has a simulator.
 */
class JvmCryptoVectorTest {
    private val v = Golden.load("store").asObject()!!["vector"]!!.asObject()!!
    private fun s(k: String) = v[k]!!.asString()!!

    private class OneFile(var text: String?) : FileStore {
        override fun read(name: String) = if (name == StoreFormat.STATE_FILE) text else null
        override fun write(name: String, text: String) { this.text = text }
        override fun delete(name: String) { text = null }
    }

    @Test
    fun theKeyIsWebCryptosKey() {
        val iterations = (v["iterations"] as Json.Num).value.toInt()
        assertEquals(600_000, iterations)
        val key = JvmCrypto().deriveKey(s("pin"), StoreFormat.fromB64(s("salt")), iterations)
        // Encrypting the plaintext with our key and the vector's iv gives the vector's bytes.
        val data = JvmCrypto().encrypt(key, StoreFormat.fromB64(s("iv")), s("plaintext").encodeToByteArray())
        assertContentEquals(StoreFormat.fromB64(v["envelope"]!!.asObject()!!["data"]!!.asString()!!), data)
    }

    @Test
    fun theWebCryptoVectorOpens() {
        val files = OneFile(v["envelope"]!!.writeJson())
        val store = SessionStore(SchemaLoader.load(), JvmCrypto(), files, { 0.0 })
        val savedAt = (v["envelope"]!!.asObject()!!["savedAt"] as Json.Num).value
        assertEquals(savedAt, store.savedSessionInfo(savedAt + 1000))

        val opened = store.unlock(s("pin"))
        val payload = v["payload"]!!.asObject()!!
        Golden.assertTree("store", "vector state", opened.state, payload["state"]!!)
        Golden.assertTree("store", "vector withheld", Json.Arr(opened.withheld.toMutableList()), payload["withheld"]!!)
        Golden.assertTree("store", "vector translations", Json.Arr(opened.translations.toMutableList()), payload["translations"]!!)
        Golden.assertTree("store", "vector inputLangs", Json.Arr(opened.inputLangs.toMutableList()), payload["inputLangs"]!!)
        assertTrue(store.isPersisting())

        // A save under the unlocked key is still readable by the same PIN.
        assertTrue(store.save(opened.state))
        val again = SessionStore(SchemaLoader.load(), JvmCrypto(), files, { 0.0 }).unlock(s("pinNfc"))
        Golden.assertTree("store", "vector resaved", again.state, payload["state"]!!)
    }

    @Test
    fun aWrongPinOrAChangedByteOpensNothing() {
        val store = SessionStore(SchemaLoader.load(), JvmCrypto(), OneFile(v["envelope"]!!.writeJson()), { 0.0 })
        assertEquals("pin", assertFailsWith<StoreException> { store.unlock(s("wrongPin")) }.kind)

        val tampered = JsonParser.parse(v["envelope"]!!.writeJson()).asObject()!!.also { it["data"] = Json.Str(s("tamperedData")) }
        val other = SessionStore(SchemaLoader.load(), JvmCrypto(), OneFile(tampered.writeJson()), { 0.0 })
        assertEquals("pin", assertFailsWith<StoreException> { other.unlock(s("pin")) }.kind)
    }
}
