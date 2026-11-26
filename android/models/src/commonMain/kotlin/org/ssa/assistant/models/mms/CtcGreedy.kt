package org.ssa.assistant.models.mms

/**
 * Greedy CTC over `logits` `[1, T, V]` (Decision 3). There is no beam search: without a
 * language model the reference has none.
 */
object CtcGreedy {
    /**
     * The per-frame argmax over [vocab] logits for each of [frames] frames, as the ASR pipeline's
     * `logits.argmax(dim=-1)` (pipelines/automatic_speech_recognition.py:542) and `np.argmax`
     * choose: the first index of the maximum on a tie, and the first NaN if a frame has one
     * (torch and numpy agree on both; checked in the export venv in Run 9). Equal values compare
     * equal, so `-0.0` and `0.0` tie and the first is kept.
     */
    fun argmax(logits: FloatArray, frames: Int, vocab: Int): IntArray {
        checkLogits(logits, frames, vocab)
        return IntArray(frames) { frame -> argmaxRow(logits, frame * vocab, vocab) }
    }

    /**
     * Merges runs of equal ids, then drops [blank]: the tokenizer's grouping before its pad filter
     * (tokenization_wav2vec2.py:298-306), so a repeat across a blank stays two tokens.
     */
    fun collapse(frameIds: IntArray, blank: Int): IntArray {
        val out = ArrayList<Int>(frameIds.size)
        var previous: Int? = null
        for (id in frameIds) {
            if (id == previous) continue
            previous = id
            if (id != blank) out += id
        }
        return out.toIntArray()
    }

    /**
     * For each frame, the largest logit minus the second largest (duplicates counted, so a tie
     * gives 0), as a float32 subtraction; NaN when the frame holds a NaN. Only for reporting how
     * close a differing frame was.
     */
    fun topGaps(logits: FloatArray, frames: Int, vocab: Int): FloatArray {
        checkLogits(logits, frames, vocab)
        require(vocab >= 2) { "a top-two gap needs at least two logits per frame, got $vocab" }
        return FloatArray(frames) { frame ->
            val base = frame * vocab
            var best = Float.NEGATIVE_INFINITY
            var second = Float.NEGATIVE_INFINITY
            var nan = false
            for (k in 0 until vocab) {
                val value = logits[base + k]
                if (value.isNaN()) {
                    nan = true
                    break
                }
                if (value > best) {
                    second = best
                    best = value
                } else if (value > second) {
                    second = value
                }
            }
            if (nan) Float.NaN else best - second
        }
    }

    private fun checkLogits(logits: FloatArray, frames: Int, vocab: Int) {
        require(frames >= 0 && vocab > 0) { "logits need frames >= 0 and vocab > 0, got $frames x $vocab" }
        require(logits.size.toLong() == frames.toLong() * vocab) {
            "logits hold ${logits.size} values, not $frames frames x $vocab"
        }
    }
}

/**
 * numpy's float argmax: keep the first value, and move only when `!(value <= best)`, which is a
 * strictly larger value or a NaN; stop at the first NaN.
 */
internal fun argmaxRow(values: FloatArray, offset: Int, count: Int): Int {
    var best = values[offset]
    var index = 0
    if (best.isNaN()) return 0
    for (k in 1 until count) {
        val value = values[offset + k]
        if (!(value <= best)) {
            best = value
            index = k
            if (value.isNaN()) break
        }
    }
    return index
}
