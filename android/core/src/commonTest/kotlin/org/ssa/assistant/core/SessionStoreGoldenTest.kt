package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.json.deepCopy
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.store.Crypto
import org.ssa.assistant.core.store.DecryptFailed
import org.ssa.assistant.core.store.FileStore
import org.ssa.assistant.core.store.SessionKey
import org.ssa.assistant.core.store.SessionStore
import org.ssa.assistant.core.store.StoreException
import org.ssa.assistant.core.store.StoreFormat
import org.ssa.assistant.core.store.repairWithheldList

/**
 * The `store` golden: src/store.js's saved-session format, as pure functions
 * (payload, envelope, expiry, the opened session, the withheld repair), and
 * SessionStore driven end to end over a scripted Crypto and an in-memory
 * FileStore. The WebCrypto test vector is decrypted in jvmTest
 * (JvmCryptoVectorTest), where a real Crypto exists.
 */
class SessionStoreGoldenTest {
    private val schema = SchemaLoader.load()
    private val golden = Golden.load("store").asObject()!!

    private fun objs(j: Json?): List<Json.Obj> = j?.asArray()?.items?.map { it.asObject()!! } ?: emptyList()
    private fun num(j: Json?): Double? = (j as? Json.Num)?.value

    @Test
    fun theConstantsMatch() {
        val c = golden["constants"]!!.asObject()!!
        assertEquals(num(c["version"]), StoreFormat.STORE_VERSION.toDouble())
        assertEquals(num(c["kdfIterations"]), StoreFormat.KDF_ITERATIONS.toDouble())
        assertEquals(num(c["maxAgeMs"]), StoreFormat.MAX_AGE_MS)
        assertEquals(num(c["minPinLength"]), StoreFormat.MIN_PIN_LENGTH.toDouble())
    }

    @Test
    fun payloadsAreWrittenAsInJs() {
        val cases = objs(golden["payloads"])
        assertTrue(cases.size >= 4)
        for (c in cases) {
            val actual = StoreFormat.sessionPayload(
                schema, c["state"]!!.asObject()!!, num(c["savedAt"])!!,
                carried = objs(c["carried"]),
                translations = c["translations"]!!.asArray()!!.items,
                inputLangs = c["inputLangs"]!!.asArray()!!.items,
            )
            Golden.assertTree("store", "payloads ${c["name"]!!.asString()}", actual, c["payload"]!!)
        }
    }

    @Test
    fun expiryAndOpenedSessionsMatch() {
        for (c in objs(golden["expiry"])) {
            assertEquals(c["expired"] === Json.True, StoreFormat.isExpired(num(c["savedAt"]), num(c["now"])!!), "expiry $c")
        }
        for ((i, c) in objs(golden["opened"]).withIndex()) {
            val parsed = c["parsed"]!!.deepCopy().asObject()!!
            val o = StoreFormat.openedSession(schema, parsed, c["envelopeSavedAt"])
            val tree = Json.Obj().also { t ->
                t["savedAt"] = o.savedAt
                t["state"] = o.state
                t["withheld"] = Json.Arr(o.withheld.toMutableList())
                t["translations"] = Json.Arr(o.translations.toMutableList())
                t["inputLangs"] = Json.Arr(o.inputLangs.toMutableList())
            }
            Golden.assertTree("store", "opened[$i]", tree, c["opened"]!!)
        }
    }

    @Test
    fun theWithheldRepairMatches() {
        val cases = objs(golden["repair"])
        assertTrue(cases.any { it["what"]!!.asString() == "deleting the middle marriage" })
        for (c in cases) {
            val out = repairWithheldList(objs(c["list"]), c["loopId"]!!.asString()!!, num(c["removedIndex"])!!.toInt())
            Golden.assertTree("store", "repair ${c["what"]!!.asString()}", Json.Arr(out.toMutableList()), c["out"]!!)
        }
        val m = golden["merge"]!!.asObject()!!
        val lists = m["lists"]!!.asArray()!!.items.map { objs(it) }
        Golden.assertTree("store", "merge", Json.Arr(StoreFormat.mergeWithheld(*lists.toTypedArray()).toMutableList()), m["out"]!!)
    }

    // -- the store, end to end, over fakes ----------------------------------------------

    /** Not cryptography: a keyed XOR with a check byte, enough to drive the store's logic. */
    private class FakeCrypto : Crypto {
        private class K(val b: Byte) : SessionKey
        var counter = 0
        override fun randomBytes(size: Int) = ByteArray(size) { (counter++ and 0xff).toByte() }
        override fun deriveKey(pin: String, salt: ByteArray, iterations: Int): SessionKey =
            K((pin.hashCode() xor salt.sum() xor iterations).toByte())
        override fun encrypt(key: SessionKey, iv: ByteArray, plaintext: ByteArray): ByteArray =
            byteArrayOf((key as K).b) + plaintext.map { (it.toInt() xor key.b.toInt()).toByte() }
        override fun decrypt(key: SessionKey, iv: ByteArray, ciphertext: ByteArray): ByteArray {
            if (ciphertext[0] != (key as K).b) throw DecryptFailed()
            return ciphertext.drop(1).map { (it.toInt() xor key.b.toInt()).toByte() }.toByteArray()
        }
    }

    private class MemoryFiles : FileStore {
        val files = mutableMapOf<String, String>()
        override fun read(name: String) = files[name]
        override fun write(name: String, text: String) { files[name] = text }
        override fun delete(name: String) { files.remove(name) }
    }

    @Test
    fun theStoreSavesRedactsCarriesRepairsAndExpires() {
        var now = 1_758_283_200_000.0
        val files = MemoryFiles()
        val store = SessionStore(schema, FakeCrypto(), files, { now })
        val state = objs(golden["payloads"]).first()["state"]!!.asObject()!!

        assertFalse(store.saveState(state), "no PIN, no saving")
        assertTrue(files.files.isEmpty())
        assertFailsWith<StoreException> { store.usePin("12") }

        store.usePin("2468")
        store.markWithheld(listOf(Json.Obj().also { it["id"] = Json.Str("routing_number") }))
        store.setSessionData(translations = listOf(Json.Str("t")), inputLangs = listOf(Json.Str("ln")))
        assertTrue(store.saveState(state))
        val text = files.files[StoreFormat.STATE_FILE]!!
        val envelope = JsonParser.parse(text).asObject()!!
        assertEquals(3.0, num(envelope["v"]))
        assertEquals("PBKDF2-SHA256", envelope["kdf"]!!.asObject()!!["name"]!!.asString())
        for (ssn in listOf("987654320", "987654322", "987654324")) assertFalse(text.contains(ssn))

        // A second process opens it with the PIN.
        val again = SessionStore(schema, FakeCrypto(), files, { now })
        assertEquals(now, again.savedSessionInfo())
        assertFailsWith<StoreException> { again.unlock("1357") }.also { assertEquals("pin", it.kind) }
        val opened = again.unlock("2468")
        assertTrue(again.isPersisting())
        val ids = opened.withheld.map { StoreFormat.fieldKey(it) }
        assertTrue(Triple("routing_number", null, 0.0) in ids, "carried fields stay withheld: $ids")
        assertTrue(Triple("spouse_ssn", "marriages", 2.0) in ids)
        assertEquals(listOf<Json>(Json.Str("t")), opened.translations)
        assertEquals(listOf<Json>(Json.Str("ln")), opened.inputLangs)
        assertNull(opened.state["answers"]!!.asObject()!!["ssn"])

        // Deleting the middle marriage moves the third spouse's entry to index 1.
        again.repairWithheld("marriages", 1)
        assertTrue(again.save(Json.Obj().also { it["answers"] = Json.Obj() }))
        val reopened = SessionStore(schema, FakeCrypto(), files, { now }).unlock("2468")
        val spouses = reopened.withheld.filter { it["loopId"]?.asString() == "marriages" }.map { num(it["loopIndex"]) }
        assertEquals(listOf(0.0, 1.0), spouses)

        // Seven days and a moment later it is gone.
        now += StoreFormat.MAX_AGE_MS + 1
        assertNull(SessionStore(schema, FakeCrypto(), files, { now }).savedSessionInfo())
        assertTrue(files.files.isEmpty())
    }
}
