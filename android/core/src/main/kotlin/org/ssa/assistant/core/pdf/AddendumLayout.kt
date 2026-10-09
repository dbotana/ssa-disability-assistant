package org.ssa.assistant.core.pdf

import kotlin.math.max
import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString

/**
 * Port of src/addendum.js: addendum pages planned as a draw list.
 *
 * layoutAddendum() is pure: content plus two width-measuring metrics produce a
 * list of typed draw operations with explicit coordinates. The web app replays
 * the list through pdf-lib; Android replays it through PDPageContentStream.
 * Because the draw list is data, it is golden-pinned and both renderers must
 * produce it identically. All arithmetic is in the JS reference's order, so
 * the doubles agree exactly.
 */

object Page {
    const val W = 612.0   // US Letter
    const val H = 792.0
}

object Margin {
    const val TOP = 56.0
    const val BOTTOM = 56.0
    const val LEFT = 54.0
    const val RIGHT = 54.0
}

const val CONTENT_W = Page.W - Margin.LEFT - Margin.RIGHT

const val INK = "ink"
const val MUTED = "muted"
const val RULE = "rule"

sealed interface Op {
    data class Text(
        val x: Double, val y: Double, val text: String, val size: Double,
        val font: String, val color: String
    ) : Op

    data class Rule(val x: Double, val y: Double, val width: Double, val thickness: Double) : Op
}

/** The colors the replayers resolve 'ink', 'muted' and 'rule' to. */
data class Color(val r: Double, val g: Double, val b: Double)

val COLORS: Map<String, Color> = mapOf(
    INK to Color(0.07, 0.09, 0.12),
    MUTED to Color(0.42, 0.46, 0.52),
    RULE to Color(0.75, 0.79, 0.84)
)

object AddendumLayout {
    private fun titleCase(s: String): String =
        s.replaceFirst(js("^(.)"), s.firstOrNull()?.uppercase() ?: "")

    /**
     * Wrap a string to a width, returning the lines. Matches fitTextBox's
     * rules: words wrap at spaces, a long word sits on its own line.
     */
    private fun wrap(str: String, width: Double, metrics: Metrics, size: Double): List<String> {
        val words = str.split(js("\\s+")).filter { it.isNotEmpty() }
        val lines = mutableListOf<String>()
        var line = ""
        for (w in words) {
            val test = if (line.isNotEmpty()) "$line $w" else w
            if (metrics.widthOfTextAtSize(test, size) > width && line.isNotEmpty()) {
                lines.add(line)
                line = w
            } else {
                line = test
            }
        }
        if (line.isNotEmpty()) lines.add(line)
        return if (lines.isNotEmpty()) lines else listOf("")
    }

    /** The content layoutAddendum was called with, as the golden records it. */
    class Content private constructor(private val raw: Json.Obj) {
        val title: String? get() = raw["title"]?.asString()
        val intro: List<String> get() = raw["intro"]?.asArray()?.items?.mapNotNull { it.asString() } ?: emptyList()
        val prepared: String? get() = raw["prepared"]?.asString()
        val overflowText: List<Json.Obj> get() = raw["overflowText"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()
        val tables: List<Json.Obj> get() = raw["tables"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()
        val sections: List<Json.Obj> get() = raw["sections"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()
        val footer: List<String> get() = raw["footer"]?.asArray()?.items?.mapNotNull { it.asString() } ?: emptyList()

        companion object {
            fun fromJson(raw: Json): Content {
                val o = raw.asObject() ?: Json.Obj()
                return Content(o)
            }
        }
    }

    /**
     * Plan the addendum pages: content plus Helvetica and Helvetica-Bold
     * metrics produce the draw lists. Coordinates are PDF space, from the
     * bottom-left.
     */
    fun layout(content: Content, regular: Metrics, bold: Metrics): List<List<Op>> {
        val pages = mutableListOf<MutableList<Op>>()
        var page: MutableList<Op>? = null
        var y = 0.0

        fun newPage() {
            val p = mutableListOf<Op>()
            pages.add(p)
            page = p
            y = Page.H - Margin.TOP
        }
        fun need(h: Double) {
            if (page == null || y - h < Margin.BOTTOM) newPage()
        }
        fun gap(h: Double = 8.0) { y -= h }

        fun text(str: String, x: Double = Margin.LEFT, size: Double = 11.0, f: Metrics = regular, color: String = INK) {
            page!!.add(Op.Text(x, y, str, size, if (f === bold) "bold" else "regular", color))
        }

        fun paragraph(str: String, size: Double = 10.0, f: Metrics = regular, color: String = MUTED, gap: Double = 4.0) {
            for (line in wrap(str, CONTENT_W, f, size)) {
                need(size + gap)
                text(line, size = size, f = f, color = color)
                y -= size + gap
            }
        }

        fun title(str: String) {
            need(40.0)
            for (line in wrap(str, CONTENT_W, bold, 20.0)) {
                need(26.0)
                text(line, size = 20.0, f = bold)
                y -= 26.0
            }
            y -= 6.0
        }

        fun heading(str: String) {
            need(46.0)
            y -= 14.0
            text(str, size = 14.0, f = bold)
            y -= 6.0
            page!!.add(Op.Rule(Margin.LEFT, y, Page.W - Margin.RIGHT - Margin.LEFT, 1.0))
            y -= 16.0
        }

        /** Label/value row, wrapping long values under a fixed-width label column. */
        fun fieldRow(label: String, value: String) {
            val labelW = 190.0
            val valueW = CONTENT_W - labelW - 10.0
            val labelLines = wrap(label, labelW, bold, 11.0)
            // value || '—': an empty value renders as an em dash.
            val lines = wrap(value.ifEmpty { "—" }, valueW, regular, 11.0)
            val rows = max(lines.size, labelLines.size)
            need(max(rows * 15.0, 15.0) + 4.0)
            for (i in 0 until rows) {
                if (labelLines.getOrNull(i)?.isNotEmpty() == true) text(labelLines[i], size = 11.0, f = bold)
                if (lines.getOrNull(i) != null) {
                    page!!.add(Op.Text(
                        Margin.LEFT + labelW + 10.0, y, lines[i], 11.0, "regular",
                        if (value.isNotEmpty()) INK else MUTED
                    ))
                }
                if (i < rows - 1) { y -= 15.0; need(15.0) }
            }
            y -= 19.0
        }

        /** Stacked record rendering for wide loops (jobs, marriages). */
        fun records(columns: List<Json.Obj>, rows: List<Json>, label: String, startAt: Int = 1) {
            rows.forEachIndexed { idx, row ->
                need(34.0)
                text("${titleCase(label)} ${startAt + idx}", size = 11.0, f = bold)
                y -= 17.0
                val cells = row.asArray()?.items ?: emptyList()
                columns.forEachIndexed { i, col ->
                    fieldRow(col["label"]?.asString() ?: "", cells.getOrNull(i)?.asString() ?: "")
                }
                y -= 4.0
            }
        }

        /**
         * Tabular block. Wide loops (more columns than fit legibly across the
         * page) are rendered as stacked records instead.
         */
        fun table(columns: List<Json.Obj>, rows: List<Json>, label: String, startAt: Int = 1) {
            val colLabels = columns.map { it["label"]?.asString() ?: "" }
            if (colLabels.size > 4) {
                records(columns, rows, label, startAt)
                return
            }

            // Give each column a share of the width proportional to its content.
            val weights = colLabels.mapIndexed { i, col ->
                val longest = rows.maxOfOrNull { row ->
                    regular.widthOfTextAtSize(
                        (row.asArray()?.items?.getOrNull(i)?.asString() ?: "")?.ifEmpty { "—" } ?: "—",
                        10.0
                    )
                } ?: 0.0
                max(max(bold.widthOfTextAtSize(col, 9.0), longest), 60.0)
            }
            val totalW = weights.reduce { a, b -> a + b }
            val colW = weights.map { w -> max((w / totalW) * CONTENT_W, 70.0) }.toMutableList()
            val scale = CONTENT_W / colW.reduce { a, b -> a + b }
            for (i in colW.indices) colW[i] = colW[i] * scale

            fun drawHeader() {
                val headLines = colLabels.mapIndexed { i, col -> wrap(col, colW[i] - 8, bold, 9.0) }
                val headH = (headLines.maxOfOrNull { it.size } ?: 0) * 11.0 + 10.0
                need(headH + 20.0)
                var x = Margin.LEFT
                headLines.forEachIndexed { i, lines ->
                    lines.forEachIndexed { li, line ->
                        page!!.add(Op.Text(x, y - li * 11, line, 9.0, "bold", INK))
                    }
                    x += colW[i]
                }
                y -= headH
                page!!.add(Op.Rule(Margin.LEFT, y + 6, Page.W - Margin.RIGHT - Margin.LEFT, 0.75))
                y -= 4.0
            }

            drawHeader()

            for (row in rows) {
                val cells = row.asArray()?.items ?: emptyList()
                val cellLines = cells.mapIndexed { i, cell ->
                    wrap(cell.asString()?.ifEmpty { "—" } ?: "—", colW[i] - 8, regular, 10.0)
                }
                val rowH = (cellLines.maxOfOrNull { it.size } ?: 0) * 13.0 + 8.0
                if (y - rowH < Margin.BOTTOM) { newPage(); drawHeader() }
                var x = Margin.LEFT
                cellLines.forEachIndexed { i, lines ->
                    lines.forEachIndexed { li, line ->
                        val has = cells.getOrNull(i)?.asString()?.isNotEmpty() == true
                        page!!.add(Op.Text(x, y - li * 13, line, 10.0, "regular", if (has) INK else MUTED))
                    }
                    x += colW[i]
                }
                y -= rowH
                page!!.add(Op.Rule(Margin.LEFT, y + 6, Page.W - Margin.RIGHT - Margin.LEFT, 0.4))
                y -= 4.0
            }
            y -= 6.0
        }

        /** Sections shaped like buildReport()'s output. */
        fun report(sections: List<Json.Obj>) {
            for (section in sections) {
                heading(section["title"]?.asString() ?: "")
                for (block in section["blocks"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList()) {
                    if (block["kind"]?.asString() == "table") {
                        val rows = block["rows"]?.asArray()?.items ?: emptyList()
                        if ((block["empty"] as? Json)?.let { it !== Json.False && it !== Json.Null } ?: false) {
                            paragraph("No ${block["label"]?.asString() ?: ""} recorded.", size = 10.0)
                            y -= 4.0
                            continue
                        }
                        table(
                            block["columns"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList(),
                            rows,
                            block["label"]?.asString() ?: ""
                        )
                        continue
                    }
                    fieldRow(block["label"]?.asString() ?: "", block["value"]?.asString() ?: "")
                }
            }
        }

        content.title?.let { title(it) }
        for (line in content.intro) paragraph(line, size = 10.0)
        content.prepared?.let { paragraph(it, size = 9.0) }

        if (content.overflowText.isNotEmpty() || content.tables.isNotEmpty()) {
            heading("Continued from the form")
            for (t in content.overflowText) {
                fieldRow(t["label"]?.asString() ?: "", t["value"]?.asString() ?: "")
            }
            for (t in content.tables) {
                paragraph(t["title"]?.asString() ?: "", size = 11.0)
                gap(2.0)
                table(
                    t["columns"]?.asArray()?.items?.mapNotNull { it.asObject() } ?: emptyList(),
                    t["rows"]?.asArray()?.items ?: emptyList(),
                    t["itemLabel"]?.asString() ?: "row",
                    startAt = (t["startAt"]?.let { (it as? Json.Num)?.value?.toInt() } ?: 1)
                )
            }
        }
        if (content.sections.isNotEmpty()) report(content.sections)

        // Footers are stamped on pages this layout created, in the replayer:
        // the draw list records them so both renderers agree.
        finish(content.footer, pages)
        return pages
    }

    private fun finish(footerLines: List<String>, pages: List<MutableList<Op>>) {
        val first = footerLines.getOrNull(0)
        val second = footerLines.getOrNull(1)
        pages.forEachIndexed { i, page ->
            page.add(Op.Text(
                Margin.LEFT, 32.0,
                "${first ?: "Additional information"} — page ${i + 1} of ${pages.size}",
                8.0, "regular", MUTED
            ))
            if (second != null) {
                page.add(Op.Text(Margin.LEFT, 21.0, second, 8.0, "regular", MUTED))
            }
        }
    }
}
