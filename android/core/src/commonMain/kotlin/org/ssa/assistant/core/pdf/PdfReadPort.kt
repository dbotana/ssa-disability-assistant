package org.ssa.assistant.core.pdf

/**
 * Interface for reading PDF structures, used by PdfSelfCheck and other core
 * components. PdfBox-Android implementation lives in
 * PdfBoxPdfReadPort.kt.
 */
interface PdfReadPort {
    fun reader(bytes: ByteArray): PdfReader
}

interface PdfReader {
    fun hasAcroForm(): Boolean
    fun pageCount(): Int
    fun pageSize(index: Int): Pair<Double, Double> /* width, height */
    fun needAppearances(): Boolean
    fun hasXfa(): Boolean
    fun sigFlags(): Int? /* null when absent */
    fun hasWinAnsiHelvWaInDefaultResources(): Boolean
    fun terminalFieldNames(): Set<String>
    fun field(name: String): PdfFieldView?
    fun pageContent(index: Int): ByteArray /* decoded */
    fun close()
}

data class PdfFieldView(
    val type: String /* text|checkbox|radio|signature|other */,
    val value: String? /* /V string */,
    val readOnly: Boolean,
    val da: String?,
    val widgets: List<PdfWidgetView>,
    val rawValue: String? = null /* /V with its COS type: "s:"+string, "n:"+name, other toString(), null when absent */
)

data class PdfWidgetView(
    val da: String? /* null when inheriting */,
    val appearanceState: String? /* /AS */,
    val normalAppearance: PdfAppearanceView?,
    val normalAppearanceBytes: List<Pair<String, List<Byte>>> /* decoded, per state key ("" for a stream), sorted by key */
)

data class PdfAppearanceView(
    val isStream: Boolean,
    val bbox: Pair<Double, Double>? /* width, height */,
    val hasWinAnsiHelvWa: Boolean,
    val drawn: DrawnContent,
    val onStates: List<String> /* sub-dict keys other than /Off */
)

data class DrawnContent(
    val strings: List<List<Byte>>,
    val fonts: List<Pair<String, Double>>
)