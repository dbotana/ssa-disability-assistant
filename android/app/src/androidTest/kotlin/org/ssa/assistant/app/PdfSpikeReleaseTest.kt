package org.ssa.assistant.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith

/**
 * M1a's R8 gate: run the PDF path inside the minified staging app, not just
 * compile it. The test references only the kept entry point, JUnit and
 * InstrumentationRegistry — no :core or :pdf types — so R8 renaming cannot
 * break the test's linkage to the code under test.
 */
@RunWith(AndroidJUnit4::class)
class PdfSpikeReleaseTest {
    @Test
    fun theMinifiedBuildFillsBothForms() {
        val result = PdfSpikeEntry.run(InstrumentationRegistry.getInstrumentation().targetContext)
        check(result.startsWith("ok ")) { result }
        check(result.contains("ssa=") && result.contains("ds=")) { result }
    }
}
