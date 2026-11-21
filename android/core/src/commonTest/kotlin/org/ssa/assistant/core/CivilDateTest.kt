package org.ssa.assistant.core

import kotlin.test.Test
import kotlin.test.assertEquals

class CivilDateTest {
    // Records such as the PDF spike's `today` are read back by JS as
    // `${today}T12:00:00Z`, so the string form must be the ISO date that
    // LocalDate printed before the port.
    @Test
    fun printsAsIsoDate() {
        assertEquals("2026-09-19", CivilDate(2026, 9, 19).toString())
        assertEquals("2026-09-19", "${CivilDate(2026, 9, 19)}")
        assertEquals("0987-01-02", CivilDate(987, 1, 2).toString())
    }
}
