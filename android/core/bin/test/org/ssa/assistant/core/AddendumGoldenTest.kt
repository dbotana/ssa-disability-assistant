package org.ssa.assistant.core

import org.junit.Test
import org.ssa.assistant.core.golden.Golden
import org.ssa.assistant.core.golden.opTree
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.pdf.AddendumLayout
import org.ssa.assistant.core.pdf.HelveticaMetrics
import org.ssa.assistant.core.pdf.Op

/**
 * The `addendum` golden: the draw lists both replayers must produce
 * identically — every text op and rule with its coordinates. The content
 * layoutAddendum was called with is recorded alongside, so this replays the
 * same input and compares op for op.
 */
class AddendumGoldenTest {

    private val golden = Golden.load("addendum")

    @Test
    fun addendum() {
        var totalOps = 0
        var rulesSeen = 0
        for (form in listOf("ssa", "ds")) {
            val entry = golden.asObject()!![form]!!.asObject()!!
            val content = AddendumLayout.Content.fromJson(entry["content"]!!)
            val pages = AddendumLayout.layout(
                content,
                WrappedMetrics(HelveticaMetrics.HELVETICA),
                WrappedMetrics(HelveticaMetrics.HELVETICA_BOLD)
            )
            val expectedPages = entry["pages"]!!.asArray()!!.items
            check(pages.size == expectedPages.size) {
                "$form: ${pages.size} pages, golden has ${expectedPages.size}"
            }
            for ((i, page) in pages.withIndex()) {
                val expected = expectedPages[i].asArray()!!.items
                check(page.size == expected.size) {
                    "$form page ${i + 1}: ${page.size} ops, golden has ${expected.size}"
                }
                for ((j, op) in page.withIndex()) {
                    Golden.assertTree("addendum", "$form page ${i + 1} op $j",
                        opTree(op), expected[j])
                }
                totalOps += page.size
                rulesSeen += page.count { it is Op.Rule }
            }
        }
        check(totalOps > 150) { "only $totalOps addendum ops" }
        check(rulesSeen > 0) { "no rules drawn; the table path is untested" }
    }

    @Test
    fun bothFormsDiffer() {
        // The DS form's overflow (14 diagnoses) differs from the Starter
        // Kit's, so a port that planned one form's addendum for both would
        // still fail the comparison above — but assert the goldens are
        // genuinely distinct inputs, not two copies.
        val ssa = golden.asObject()!!["ssa"]!!.asObject()!!["pages"]!!.asArray()!!.items
        val ds = golden.asObject()!!["ds"]!!.asObject()!!["pages"]!!.asArray()!!.items
        check(ssa.size != ds.size ||
            ssa.zip(ds).any { (a, b) -> a.asArray()!!.items.size != b.asArray()!!.items.size })
    }
}
