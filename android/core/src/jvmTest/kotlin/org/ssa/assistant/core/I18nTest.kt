package org.ssa.assistant.core

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.JsonParser
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * The `i18n` golden: the four channels resolve independently, every dynamic
 * template renders exactly as the web app renders it, and the two catalogues
 * are complete for every English source in the corpus.
 *
 * The Kotlin port reads the same exported tables as `src/i18n/`, so this test
 * mostly proves the lookup and formatting code did not drift from the JS.
 */
class I18nTest {

    private val schema = SchemaLoader.load()
    private val i18n = I18n(schema)
    private val golden = Golden.load("i18n").asObject()!!

    private fun strings(lang: String): Json.Obj =
        golden["strings"]!!.asObject()!![lang]!!.asObject()!!

    private fun placeholders(text: String): List<String> =
        Regex("\\{(\\w+)\\}").findAll(text).map { it.groupValues[1] }.sorted().toList()

    @Test
    fun channelsAndDefaults() {
        val channels = golden["channels"]!!.asArray()!!.items.map { it.asString() }
        assertEquals(listOf("input", "output", "screen", "fill"), channels)
        assertEquals(CHANNELS, channels)
        assertEquals(listOf("en", "fr", "ln"), LANGUAGE_ORDER)

        assertEquals(LanguageSettings(), LanguageSettings.fromJson(golden["defaults"]))
        for (channel in CHANNELS) {
            assertEquals("en", LanguageSettings().langFor(channel), "default $channel")
        }
    }

    @Test
    fun eachChannelResolvesIndependently() {
        val resolutions = golden["resolution"]!!.asArray()!!.items
        assertTrue(resolutions.isNotEmpty(), "no resolution cases")
        for (raw in resolutions) {
            val entry = raw.asObject()!!
            val settings = LanguageSettings.fromJson(entry["settings"])
            val channel = entry["channel"]!!.asString()!!
            assertEquals(entry["lang"]!!.asString(), settings.langFor(channel), "resolution $channel")
        }
    }

    @Test
    fun settingsRoundTripAndValidatePerChannel() {
        val mixed = LanguageSettings(input = "en", output = "fr", screen = "en", fill = "ln")
        assertEquals(mixed, LanguageSettings.fromJson(mixed.toJson()))

        // An unknown or non-string value falls back on its own channel only.
        val garbage = JsonParser.parse("""{"input":"de","output":"fr","screen":null,"fill":7}""")
        assertEquals(
            LanguageSettings(input = "en", output = "fr", screen = "en", fill = "en"),
            LanguageSettings.fromJson(garbage),
        )
        assertEquals(LanguageSettings(), LanguageSettings.fromJson(null))
        assertEquals(LanguageSettings(fill = "ln"), LanguageSettings(fill = "ln").normalize())
    }

    @Test
    fun messageTemplatesMatchTheGolden() {
        for (raw in golden["samples"]!!.asArray()!!.items) {
            val sample = raw.asObject()!!
            val vars = sample["vars"]?.asObject()?.entries
                ?.map { it.key to Golden.kotlinValue(it.value) }
                ?.toMap()
                ?: emptyMap<String, Any?>()
            val text = i18n.message(
                sample["key"]!!.asString()!!,
                vars,
                sample["lang"]!!.asString()!!,
            )
            assertEquals(sample["text"]!!.asString(), text, "sample ${sample["key"]} (${sample["lang"]})")
        }
    }

    @Test
    fun formattingMatchesTheGolden() {
        for (raw in golden["formats"]!!.asArray()!!.items) {
            val format = raw.asObject()!!
            val lang = format["lang"]!!.asString()!!
            val value = Golden.kotlinValue(format["value"])
            val fn = format["fn"]!!.asString()!!
            val text = when (fn) {
                "formatDate" -> i18n.formatDate(value, lang)
                "formatMonthYear" -> i18n.formatMonthYear(value, lang)
                "formatMoney" -> i18n.formatMoney(value, lang)
                "formatTimeRemaining" -> i18n.formatTimeRemaining((value as Double).toInt(), lang)
                "fold" -> i18n.fold(value as String, lang)
                "translate" -> i18n.translate(value as String, lang)
                else -> error("unknown format function $fn")
            }
            assertEquals(format["text"]!!.asString(), text, "$fn $value ($lang)")
        }
    }

    @Test
    fun cataloguesAreCompleteForTheCorpus() {
        val corpus = golden["corpus"]!!.asArray()!!.items.map { it.asString()!! }
        assertTrue(corpus.size > 700, "corpus is suspiciously small: ${corpus.size}")
        val corpusSet = corpus.toSet()

        for (lang in listOf("fr", "ln")) {
            val table = strings(lang)
            for (source in corpus) {
                val translated = table[source]?.asString()
                assertTrue(!translated.isNullOrBlank(), "$lang is missing \"$source\"")
                assertEquals(
                    placeholders(source),
                    placeholders(translated!!),
                    "$lang placeholders for \"$source\"",
                )
            }
            val extra = table.entries.keys.filter { it !in corpusSet }
            assertEquals(emptyList<String>(), extra, "$lang translations outside the corpus")
            val remote = table.entries.values.mapNotNull { it.asString() }.filter { "://" in it }
            assertEquals(emptyList<String>(), remote, "$lang catalogue contains a URL")
        }
    }

    @Test
    fun noLookupMissesOnceTheCatalogueIsWarm() {
        // A fresh instance per test, so order cannot hide a miss.
        val table = I18n(schema)
        val corpus = golden["corpus"]!!.asArray()!!.items.map { it.asString()!! }
        for (source in corpus) {
            for (lang in listOf("fr", "ln")) table.translate(source, lang)
        }
        assertEquals(emptyList<String>(), table.missingKeys(), "missing translations")

        // Missing text falls back to its English source, never to blank.
        assertEquals("no such key", table.translate("no such key", "fr"))
        assertEquals("Housing", table.translate("Housing", "en"))
    }

    @Test
    fun lexiconsCarryTheLocalizedRecognitionTables() {
        val fr = i18n.lexicon("fr")
        val ln = i18n.lexicon("ln")

        assertTrue(fr["yes"]!!.asArray()!!.items.any { it.asString() == "oui" }, "fr yes")
        assertTrue(fr["no"]!!.asArray()!!.items.any { it.asString() == "non" }, "fr no")
        assertEquals("0", fr["digits"]!!.asObject()!!["zero"]!!.asString())
        assertEquals(3.0, fr["months"]!!.asObject()!!["mars"]!!.let { (it as Json.Num).value }, 0.0)

        assertTrue(ln["yes"]!!.asArray()!!.items.any { it.asString() == "ɛɛ" }, "ln yes")
        assertTrue(ln["no"]!!.asArray()!!.items.any { it.asString() == "te" }, "ln no")
        assertEquals("1", ln["digits"]!!.asObject()!!["moko"]!!.asString())
        assertEquals(3.0, ln["months"]!!.asObject()!!["sanza ya misato"]!!.let { (it as Json.Num).value }, 0.0)

        // An unknown language reads the English tables, as the web app does.
        assertEquals(i18n.lexicon("en"), i18n.lexicon("de"))
    }

    @Test
    fun localizedCommandsFoldPunctuation() {
        // The lexicon stores the words without apostrophes or hyphens; the
        // transcript keeps them, so command matching normalizes both sides.
        assertEquals("finish", localCommand("c'est tout", "fr", i18n))
        assertEquals("finish", localCommand("j'ai fini", "fr", i18n))
        assertEquals("where", localCommand("où en suis-je ?", "fr", i18n))
        assertEquals("repeat", localCommand("répète s'il vous plaît", "fr", i18n))

        // "encore" is a still-ongoing marker for a date, so it must reach the
        // parser instead of replaying the question.
        assertNull(localCommand("encore", "fr", i18n), "encore is not a command")
    }

    @Test
    fun speechPacksAndVoicesAreData() {
        assertTrue(i18n.sttInstalled("en"), "English speech is installed")
        assertTrue(i18n.sttInstalled("fr"), "French speech is installed")
        assertTrue(i18n.sttInstalled("ln"), "Lingala speech is installed")

        val languages = golden["languages"]!!.asObject()!!
        assertEquals("whisper-base.en", languages["en"]!!.asObject()!!["stt"]!!.asObject()!!["model"]!!.asString())
        assertEquals("whisper-base", languages["fr"]!!.asObject()!!["stt"]!!.asObject()!!["model"]!!.asString())
        assertEquals("whisper-base", languages["ln"]!!.asObject()!!["stt"]!!.asObject()!!["model"]!!.asString())
        assertEquals("fr", languages["fr"]!!.asObject()!!["stt"]!!.asObject()!!["language"]!!.asString())
        assertEquals("ln", languages["ln"]!!.asObject()!!["stt"]!!.asObject()!!["language"]!!.asString())
        assertTrue(languages["en"]!!.asObject()!!["stt"]!!.asObject()!!["language"] === Json.Null, "English names no language")
        assertTrue(languages["fr"]!!.asObject()!!["clips"] === Json.Null, "French clips are absent")
        assertTrue(languages["ln"]!!.asObject()!!["clips"] === Json.Null, "Lingala clips are absent")
        assertTrue(languages["en"]!!.asObject()!!["clips"] is Json.Obj, "English clips are present")
    }

    @Test
    fun englishReadbacksAreUnchanged() {
        assertEquals("yes", i18n.speakable(true, "yesno", lang = "en"))
        assertEquals("not answered", i18n.speakable(null, "text", lang = "en"))
        assertEquals("March 14, 1979", i18n.speakable("1979-03-14", "date", lang = "en"))
        assertEquals("1,200 dollars", i18n.speakable(1200.0, "money", lang = "en"))
    }

    /**
     * Every English literal passed straight to `translate()` in the fill
     * channel exists in both catalogues. The labels that come from the schema
     * are covered by [cataloguesAreCompleteForTheCorpus]; this pins the few
     * literals the port keeps at the call site.
     */
    @Test
    fun fillChannelLiteralsAreTranslated() {
        val roots = listOf(
            File("src/commonMain/kotlin/org/ssa/assistant/core"),
            File("android/core/src/commonMain/kotlin/org/ssa/assistant/core"),
        )
        val root = roots.firstOrNull { it.isDirectory } ?: return
        val files = listOf(
            "forms/Common.kt",
            "forms/Summary.kt",
            "forms/SsaStarterKit.kt",
            "forms/DsIntake.kt",
            "pdf/FormDocument.kt",
        )
        val literals = files
            .map { File(root, it) }
            .filter { it.isFile }
            .flatMap { file ->
                Regex("translate\\(\\s*\"([^\"]*)\"").findAll(file.readText())
                    .map { it.groupValues[1] }
            }
            .filter { it.isNotBlank() && '$' !in it }
            .toSet()
        assertTrue(literals.size >= 5, "fill-channel scan found only ${literals.size} literals")

        for (lang in listOf("fr", "ln")) {
            val table = strings(lang)
            for (literal in literals) {
                assertTrue(
                    !table[literal]?.asString().isNullOrBlank(),
                    "$lang is missing the fill label \"$literal\"",
                )
            }
        }
    }
}
