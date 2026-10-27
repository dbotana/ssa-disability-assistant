package org.ssa.assistant.core

import org.junit.Assert.assertEquals
import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.SchemaLoader

class PhrasesTest {
    private val schema = SchemaLoader.load()
    private val phrases = Phrases(schema)

    @Test
    fun phrasesComeFromTheExportInAllPhrasesOrder() {
        assertEquals(29, phrases.allPhrases().size)
        assertEquals("Go ahead. Say your answer again, or type it instead.", phrases.text("ANSWER_AGAIN"))
        assertEquals(setOf("text", "handsfree", "voice"), phrases.intro.keys)
    }

    @Test
    fun frenchPhrasesComeFromTheSharedCatalogue() {
        val strings = schema.i18n["strings"]!!.asObject()!!["fr"]!!.asObject()!!
        val french = Phrases(schema.phrases, I18n(schema), "fr")
        for (name in listOf("ANSWER_AGAIN", "SAVED", "ALL_DONE")) {
            val english = phrases.text(name)
            assertEquals("$name translation", strings[english]!!.asString(), french.text(name))
        }
    }

    @Test
    fun everyFixedPhraseIsInTheTtsCorpus() {
        val texts = Golden.load("tts").asObject()!!["hashes"]!!.asArray()!!.items
            .map { it.asObject()!!["text"]!!.asString()!! }
            .toSet()
        val missing = phrases.allPhrases().filter { it !in texts }
        assertEquals("phrases with no tts entry", emptyList<String>(), missing)
    }
}
