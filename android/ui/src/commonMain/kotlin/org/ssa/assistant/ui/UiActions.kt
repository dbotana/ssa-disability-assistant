package org.ssa.assistant.ui

import androidx.compose.runtime.State
import org.ssa.assistant.core.app.ExportJob
import org.ssa.assistant.core.turn.TurnController

/**
 * What the shared UI asks the shell to do (plan, Phase B2). Everything here
 * is a platform action: reading and writing files, the key derivation, the PDF
 * fill and share sheet. The decisions stay in `core` and `AppController`.
 */
interface UiActions {

    /** Incremented by the shell after every `onState` snapshot, so the screen redraws. */
    val stateRevision: State<Int>

    /** The last export run's finished files. */
    val exported: State<List<ExportJob.Ready>>

    /** The last export run's failures, each a self-check string that names no answer. */
    val exportFailed: State<List<ExportJob.Failed>>

    /**
     * Open or start the session from Setup. On iOS this runs off the UI thread
     * while PBKDF2 derives the key; [onProgress] and [done] are called on the
     * UI thread. [done] receives the session to continue, or a message to show.
     */
    fun openSession(
        resume: Boolean,
        pin: String,
        onProgress: (String) -> Unit,
        done: (TurnController.SavedSession?, String?) -> Unit,
    )

    /** Save (document picker) or share (share sheet) one finished PDF. */
    fun share(file: ExportJob.Ready)

    /** Delete the saved session and forget the key. */
    fun eraseEverything()

    /** When the saved session was written, in epoch milliseconds, or null. */
    fun savedSessionAt(): Double?
}
