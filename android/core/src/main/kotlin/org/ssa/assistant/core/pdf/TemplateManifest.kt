package org.ssa.assistant.core.pdf

import org.ssa.assistant.core.js.js
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.asArray
import org.ssa.assistant.core.json.asBoolean
import org.ssa.assistant.core.json.asDouble
import org.ssa.assistant.core.json.asObject
import org.ssa.assistant.core.json.asString
import org.ssa.assistant.core.schema.loadResource

/**
 * The template manifest: everything planFill needs to know about a template's
 * fields. Port of src/manifest.js.
 *
 * The Android port never trusts PDFBox's 32-bit reals for box sizes; it reads
 * this manifest from the `templateManifest` golden, which ships as a :core
 * main resource. The shape is the contract between the JS reference and the
 * Android side, and the pdf module's TemplateContractTest fails if a template
 * revision adds comb fields, MaxLen or /Opt — none of which either form has
 * today.
 */

/** A parsed default-appearance string like "/Helv 10 Tf 0 g", or null. */
data class Da(val font: String, val size: Double?, val raw: String)

private val DA_RE = js("(/[\\w-]+)[\\s\\S]*?([\\d.]+)\\s+Tf")

fun parseDa(da: Any?): Da? {
    val s = da?.toString() ?: ""
    val m = DA_RE.find(s) ?: return null
    val size = m.groupValues[2].toDoubleOrNull()
    return Da(
        font = m.groupValues[1],
        size = if (size != null && size.isFinite()) size else null,
        raw = s
    )
}

/** One field of a template, in the manifest shape. */
data class ManifestEntry(
    val type: String,
    val width: Double,
    val height: Double,
    val multiline: Boolean,
    val quadding: Int?,
    val comb: Boolean,
    val maxLen: Double?,
    val da: Da?,
    val widgets: List<Da?>,
    val onStates: List<String?>?,
) {
    /** The box planFill fits text into — sizes from the golden, never PDFBox. */
    val box: Box get() = Box(width, height, multiline)

    companion object {
        fun fromJson(raw: Json?): ManifestEntry {
            val o = raw?.asObject() ?: throw IllegalStateException("manifest entry is not an object")
            val type = o["type"]?.asString() ?: throw IllegalStateException("manifest entry has no type")
            val da = o["da"]
            return ManifestEntry(
                type = type,
                width = o["width"]?.asDouble() ?: 0.0,
                height = o["height"]?.asDouble() ?: 0.0,
                multiline = o["multiline"]?.asBoolean() ?: false,
                quadding = o["quadding"]?.asDouble()?.toInt(),
                comb = o["comb"]?.asBoolean() ?: false,
                maxLen = o["maxLen"]?.asDouble(),
                da = if (da == null || da === Json.Null) null else parseDa(da.asString()),
                widgets = (o["widgets"]?.asArray()?.items ?: emptyList()).map { w ->
                    val wda = w.asObject()?.get("da")
                    if (wda == null || wda === Json.Null) null else parseDa(wda.asString())
                },
                onStates = o["onStates"]?.asArray()?.items?.map { it.asString() }
            )
        }
    }
}

class TemplateManifest private constructor(val fields: Map<String, ManifestEntry>) {
    fun field(name: String): ManifestEntry? = fields[name]

    companion object {
        private val GOLDEN: Json.Obj by lazy {
            loadResource("golden/templateManifest.json").asObject()
                ?: throw IllegalStateException("golden/templateManifest.json is not an object")
        }

        fun forForm(formId: String): TemplateManifest {
            val o = GOLDEN[formId]?.asObject()
                ?: throw IllegalStateException("templateManifest golden has no $formId")
            return TemplateManifest(
                (o["fields"]?.asObject() ?: Json.Obj()).entries
                    .mapValues { (_, v) -> ManifestEntry.fromJson(v) }
            )
        }
    }
}
