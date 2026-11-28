package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import org.ssa.assistant.core.golden.runTestBlocking
import org.ssa.assistant.core.schema.SchemaLoader

/**
 * Plan A1: `AppPorts` is the production wiring, and the pure ports behave as
 * the reference does. The turn goldens (TurnGoldenTest, AppControllerGoldenTest
 * and the scenarios) also run through `AppPorts` now, via TurnHarness, and are
 * unchanged — that is the real proof.
 */
class AppPortsTest {

    @Test
    fun thePurePortsAreTheSharedOnes() = runTestBlocking {
        val schema = SchemaLoader.load()
        val ports = TurnHarness(schema, this).ports

        assertEquals("9 8 7, 6 5, 4 3 2 1", ports.speakable("987654321", "ssn", null, "en"))
        assertEquals("March 3, 2020", ports.speakable("2020-03-03", "date", null, "en"))
        assertEquals("yes", ports.speakable(true, "yesno", null, "en"))
        assertEquals("less than a minute", ports.formatTimeRemaining(30, "en"))
        assertEquals("about two minutes", ports.formatTimeRemaining(120, "en"))
        assertEquals("about 25 minutes", ports.formatTimeRemaining(1500, "en"))

        assertEquals(
            "Your saved answers are protected. Enter your PIN, then select Resume.",
            ports.i18n.message("saved_protected"),
        )
        assertNotNull(ports.say.table("INTRO"))
        assertNotNull(ports.correct)
        assertNotNull(ports.createEngine(null) { 0.0 })
    }
}
