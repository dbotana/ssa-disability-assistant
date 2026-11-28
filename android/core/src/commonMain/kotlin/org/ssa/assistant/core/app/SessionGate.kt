package org.ssa.assistant.core.app

import org.ssa.assistant.core.I18n
import org.ssa.assistant.core.schema.Schema
import org.ssa.assistant.core.store.SessionStore
import org.ssa.assistant.core.store.StoreException
import org.ssa.assistant.core.store.StoreFormat
import org.ssa.assistant.core.turn.TurnController

/** A failed open whose message is meant for the user. `kind` is "pin" when a PIN would help. */
class SessionException(message: String, val kind: String) : Exception(message)

/**
 * Setup's session rules (plan, Phase A3): the port of `openSession()` and the
 * part of `start()` around it in `src/main.js` (lines 256–360).
 *
 * The web has a legacy unencrypted path and an imported session; a phone has
 * neither, so "resume" means exactly one thing: there is an encrypted file,
 * and its PIN opens it. It returns the session the interview continues, or
 * throws; it never touches a UI.
 *
 * `SessionStore.usePin` and `unlock` derive the key synchronously (PBKDF2 at
 * 600,000 rounds). The shell calls [open] off the main thread for that reason
 * and shows [progress] while it runs.
 */
class SessionGate(
    private val schema: Schema,
    private val store: SessionStore,
    private val i18n: I18n = I18n(schema),
) {
    /** The session to continue, or null for a fresh interview. */
    class Opened(val saved: TurnController.SavedSession?)

    /**
     * Open the session this interview continues, and set up how it is saved.
     *
     * @param resume the user chose Resume rather than Start.
     * @param pin the PIN field, possibly empty.
     * @param importedSession a session handed over in memory (the web's
     *   import path; unused on the phone, kept so the branch matches).
     * @param lang the screen language for the messages.
     * @param onProgress a status line for the Setup panel while a slow step runs.
     */
    fun open(
        resume: Boolean,
        pin: String,
        importedSession: TurnController.SavedSession? = null,
        lang: String = "en",
        onProgress: (String) -> Unit = {},
    ): Opened {
        if (pin.isNotEmpty() && pin.length < MIN_PIN_LENGTH) {
            throw SessionException(
                i18n.message("pin_too_short", mapOf("count" to MIN_PIN_LENGTH), lang),
                "pin",
            )
        }
        store.forgetKey()
        var saved: TurnController.SavedSession? = null
        if (resume && importedSession != null) {
            saved = importedSession
            store.clearState()
        } else if (resume) {
            val info = store.savedSessionInfo()
            if (info != null) {
                if (pin.isEmpty()) {
                    throw SessionException(i18n.message("saved_protected", emptyMap(), lang), "pin")
                }
                onProgress(i18n.message("opening_saved", emptyMap(), lang))
                // Throws StoreException(kind = "pin") for a wrong PIN.
                val opened = store.unlock(pin)
                return Opened(TurnController.SavedSession(opened.state, opened.withheld))
            }
            // No file, no legacy format on a phone: fall through and start fresh.
        } else {
            store.clearState()
        }
        if (pin.isNotEmpty()) {
            onProgress(i18n.message("protecting_answers", emptyMap(), lang))
            store.usePin(pin)
        }
        return Opened(saved)
    }

    companion object {
        /** The shortest PIN a new session may use (store.js's MIN_PIN_LENGTH). */
        val MIN_PIN_LENGTH: Int = StoreFormat.MIN_PIN_LENGTH

        /**
         * The message `start()` shows for a failed open, as the web's catch
         * block decides it: the store's own words for a PIN problem, and a
         * generic line for anything else.
         */
        fun messageFor(error: Throwable, i18n: I18n, lang: String = "en"): String = when (error) {
            is SessionException -> error.message ?: ""
            is StoreException -> error.message ?: ""
            else -> i18n.message("session_open_failed", emptyMap(), lang)
        }
    }
}
