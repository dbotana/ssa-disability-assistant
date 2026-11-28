package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.ssa.assistant.core.app.SessionException
import org.ssa.assistant.core.app.SessionGate
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.schema.SchemaLoader
import org.ssa.assistant.core.store.Crypto
import org.ssa.assistant.core.store.FileStore
import org.ssa.assistant.core.store.SessionKey
import org.ssa.assistant.core.store.SessionStore
import org.ssa.assistant.core.store.StoreException
import org.ssa.assistant.core.store.StoreFormat
import org.ssa.assistant.core.turn.TurnController

/**
 * Plan A3: Setup's session rules, branch for branch, with an in-memory
 * FileStore and the test Crypto the `store` golden uses. The WebCrypto test
 * vector is opened by JvmCryptoVectorTest, which this does not change.
 */
class SessionGateTest {
    private val schema = SchemaLoader.load()
    private val i18n = I18n(schema)
    private val now = 1_758_283_200_000.0

    private val state: Json.Obj =
        Golden.load("store").asObject()!!["payloads"]!!.asArray()!!.items.first()
            .asObject()!!["state"]!!.asObject()!!

    private class FakeCrypto : Crypto {
        private class K(val b: Byte) : SessionKey
        private var counter = 0
        override fun randomBytes(size: Int) = ByteArray(size) { (counter++ and 0xff).toByte() }
        override fun deriveKey(pin: String, salt: ByteArray, iterations: Int): SessionKey =
            K((pin.hashCode() xor salt.sum() xor iterations).toByte())
        override fun encrypt(key: SessionKey, iv: ByteArray, plaintext: ByteArray): ByteArray =
            byteArrayOf((key as K).b) + plaintext.map { (it.toInt() xor key.b.toInt()).toByte() }
        override fun decrypt(key: SessionKey, iv: ByteArray, ciphertext: ByteArray): ByteArray? {
            if (ciphertext.isEmpty() || ciphertext[0] != (key as K).b) return null
            return ciphertext.drop(1).map { (it.toInt() xor key.b.toInt()).toByte() }.toByteArray()
        }
    }

    private class MemoryFiles : FileStore {
        val files = mutableMapOf<String, String>()
        override fun read(name: String) = files[name]
        override fun write(name: String, text: String) { files[name] = text }
        override fun delete(name: String) { files.remove(name) }
    }

    private fun newStore(files: MemoryFiles) = SessionStore(schema, FakeCrypto(), files, { now })

    @Test
    fun aShortPinIsRefusedBeforeAnythingElse() {
        val files = MemoryFiles()
        val error = assertFailsWith<SessionException> { SessionGate(schema, newStore(files)).open(false, "123") }
        assertEquals("pin", error.kind)
        assertEquals(i18n.message("pin_too_short", mapOf("count" to SessionGate.MIN_PIN_LENGTH)), error.message)
        assertTrue(files.files.isEmpty())
    }

    @Test
    fun startingWithoutAPinSavesNothing() {
        val files = MemoryFiles()
        val store = newStore(files)
        val opened = SessionGate(schema, store).open(false, "")
        assertNull(opened.saved)
        assertFalse(store.isPersisting(), "no PIN, nothing saved")
        assertTrue(files.files.isEmpty())
    }

    @Test
    fun startingWithAPinProtectsANewSession() {
        val files = MemoryFiles()
        val store = newStore(files)
        val progress = mutableListOf<String>()
        val opened = SessionGate(schema, store).open(false, "2468") { progress.add(it) }
        assertNull(opened.saved)
        assertEquals(listOf(i18n.message("protecting_answers")), progress)
        assertTrue(store.isPersisting())
        assertTrue(store.saveState(state))
        assertEquals(StoreFormat.STATE_FILE, files.files.keys.single())
    }

    @Test
    fun resumingAProtectedSessionNeedsItsPin() {
        val files = MemoryFiles()
        val first = newStore(files)
        SessionGate(schema, first).open(false, "2468")
        assertTrue(first.saveState(state))

        // A new process: the file is there, the key is not.
        val second = newStore(files)
        val noPin = assertFailsWith<SessionException> { SessionGate(schema, second).open(true, "") }
        assertEquals("pin", noPin.kind)
        assertEquals(i18n.message("saved_protected"), noPin.message)
        assertFalse(second.isPersisting())

        val wrong = assertFailsWith<StoreException> { SessionGate(schema, second).open(true, "1357") }
        assertEquals("pin", wrong.kind)

        val progress = mutableListOf<String>()
        val third = newStore(files)
        val opened = SessionGate(schema, third).open(true, "2468") { progress.add(it) }
        assertEquals(listOf(i18n.message("opening_saved")), progress)
        assertTrue(third.isPersisting(), "the same PIN protects the resumed session")
        assertNull(opened.saved!!.state!!["answers"]!!.asObject()!!["ssn"])
    }

    @Test
    fun resumingWithNothingSavedStartsFresh() {
        val files = MemoryFiles()
        val store = newStore(files)
        val opened = SessionGate(schema, store).open(true, "")
        assertNull(opened.saved)
        assertFalse(store.isPersisting())
    }

    @Test
    fun startingOverDeletesTheSavedSession() {
        val files = MemoryFiles()
        val first = newStore(files)
        SessionGate(schema, first).open(false, "2468")
        assertTrue(first.saveState(state))
        assertTrue(files.files.containsKey(StoreFormat.STATE_FILE))

        assertNull(SessionGate(schema, newStore(files)).open(false, "").saved)
        assertTrue(files.files.isEmpty(), "a fresh interview forgets the saved file")
    }

    @Test
    fun anImportedSessionIsHandedStraightBackAndTheFileGoes() {
        val files = MemoryFiles()
        val first = newStore(files)
        SessionGate(schema, first).open(false, "2468")
        assertTrue(first.saveState(state))

        val imported = TurnController.SavedSession(state, emptyList())
        val opened = SessionGate(schema, newStore(files)).open(true, "", importedSession = imported)
        assertEquals(imported, opened.saved)
        assertTrue(files.files.isEmpty())
    }

    @Test
    fun messageForMatchesTheWebsCatchBlock() {
        val gate = SessionGate(schema, newStore(MemoryFiles()))
        assertEquals(
            i18n.message("session_open_failed"),
            SessionGate.messageFor(IllegalStateException("boom"), i18n),
        )
        assertEquals("That PIN does not open the saved answers.", SessionGate.messageFor(StoreException("That PIN does not open the saved answers.", "pin"), i18n))
        assertEquals(
            "A PIN needs at least 4 characters. Longer is safer.",
            SessionGate.messageFor(SessionException("A PIN needs at least 4 characters. Longer is safer.", "pin"), i18n),
        )
        // `gate` only proves the object can be built with the default catalogue.
        assertEquals(SessionGate.MIN_PIN_LENGTH, StoreFormat.MIN_PIN_LENGTH)
    }
}
