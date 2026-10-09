package org.ssa.assistant.core

import org.junit.Assert.assertEquals
import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The `tts` golden: every fixed spoken string → its ttshash, as the JS build
 * computed it (and the generator checked that audio/ has a clip for each).
 */
class TtsGoldenTest {
    private val entries = Golden.load("tts").asObject()!!["hashes"]!!.asArray()!!.items
        .map { it.asObject()!! }
        .map { it["text"]!!.asString()!! to it["hash"]!!.asString()!! }

    @Test
    fun everyHashMatchesTheJsBuild() {
        val wrong = entries.filter { (text, hash) -> TtsHash.hash(text) != hash }
        assertEquals("strings whose hash differs from the JS build", emptyList<Pair<String, String>>(), wrong)
        assert(entries.size > 500) { "the golden looks truncated: ${entries.size} entries" }
    }

    @Test
    fun theKotlinCorpusIsExactlyWhatWasSynthesized() {
        val corpus = TtsCorpus.collect(SchemaLoader.load())
        val golden = entries.map { it.first }.toSet()
        assertEquals("spoken by Kotlin, no clip", emptySet<String>(), corpus - golden)
        assertEquals("clipped, never spoken by Kotlin", emptySet<String>(), golden - corpus)
    }

    @Test
    fun whitespaceDifferencesDoNotChangeTheKey() {
        val text = entries.first().first
        assertEquals(TtsHash.hash(text), TtsHash.hash("  " + text.replace(" ", "  \t") + "\n"))
    }
}
