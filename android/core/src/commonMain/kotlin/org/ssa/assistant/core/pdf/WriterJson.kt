package org.ssa.assistant.core.pdf

import org.ssa.assistant.core.json.Json

/**
 * The two JSON documents the JS writer reads, built from `core`'s data
 * (plan, Phase A2).
 *
 * `SsaPdf`'s `PdfWriter` calls `SsaPdfWriter.fillForHost(template, planJSON,
 * drawListJSON, title, creator, updateMetadata)`; the shapes below are what
 * `src/pdf-writer.js` reads (`writeFilledPdf` for the plan,
 * `renderAddendum` for the draw list), and the `fillplans` golden already
 * records both for every version case.
 */
object WriterJson {

    /** The `plan` argument: one object per text field, plus missing, overflow, radios, checks, tables and sections. */
    fun plan(plan: FillPlan): Json.Obj = Json.Obj().also { o ->
        o["fields"] = Json.Arr(plan.fields.mapTo(mutableListOf()) { f ->
            Json.Obj().also { e ->
                e["name"] = Json.Str(f.name)
                e["value"] = Json.Str(f.value)
                e["fit"] = Json.Obj().also { fit ->
                    fit["size"] = Json.Num(f.fit.size)
                    fit["text"] = Json.Str(f.fit.text)
                    fit["cut"] = Json.bool(f.fit.cut)
                    fit["lines"] = Json.Arr(f.fit.lines.mapTo(mutableListOf()) { Json.Str(it) })
                }
                e["label"] = Json.Str(f.label)
            }
        })
        o["missing"] = Json.Arr(plan.missing.mapTo(mutableListOf()) { Json.Str(it) })
        o["overflowText"] = Json.Arr(plan.overflowText.mapTo(mutableListOf()) { (label, value) ->
            Json.Obj().also { e -> e["label"] = Json.Str(label); e["value"] = Json.Str(value) }
        })
        o["radios"] = Json.Obj().also { r -> plan.radios.forEach { (k, v) -> r[k] = Json.Str(v) } }
        o["checks"] = Json.Arr(plan.checks.mapTo(mutableListOf()) { Json.Str(it) })
        o["tables"] = Json.Arr(plan.tables.toMutableList())
        o["sections"] = Json.Arr(plan.sections.toMutableList())
    }

    /**
     * The `drawList` argument: `{"pages": [[op, ...], ...]}` exactly as
     * `renderAddendum` reads it. Null when the document has no addendum,
     * because the JS writer skips the call entirely for an empty list
     * (`if (drawList && drawList.pages.length)`).
     */
    fun drawList(document: FormDocument): Json? {
        if (document.addendum.isEmpty()) return null
        return Json.Obj().also { o ->
            o["pages"] = Json.Arr(document.addendum.mapTo(mutableListOf()) { page ->
                Json.Arr(page.mapTo(mutableListOf()) { op ->
                    when (op) {
                        is Op.Text -> Json.Obj().also { t ->
                            t["op"] = Json.Str("text")
                            t["x"] = Json.Num(op.x)
                            t["y"] = Json.Num(op.y)
                            t["text"] = Json.Str(op.text)
                            t["size"] = Json.Num(op.size)
                            t["font"] = Json.Str(op.font)
                            t["color"] = Json.Str(op.color)
                        }
                        is Op.Rule -> Json.Obj().also { r ->
                            r["op"] = Json.Str("rule")
                            r["x"] = Json.Num(op.x)
                            r["y"] = Json.Num(op.y)
                            r["width"] = Json.Num(op.width)
                            r["thickness"] = Json.Num(op.thickness)
                        }
                    }
                })
            })
        }
    }
}
