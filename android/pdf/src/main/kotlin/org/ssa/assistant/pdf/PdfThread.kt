package org.ssa.assistant.pdf

import android.content.Context
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext

/**
 * Every PDFBox call runs here: one thread, after PDFBoxResourceLoader.init.
 * PDFBox is not thread-safe, and its standard-font metrics are loaded through
 * the resource loader, so nothing in :pdf touches a document anywhere else.
 */
object PdfThread {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "pdf").apply { isDaemon = true } }
    private val dispatcher = executor.asCoroutineDispatcher()

    @Volatile private var initialized = false

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (!initialized) {
                PDFBoxResourceLoader.init(context.applicationContext)
                initialized = true
            }
        }
    }

    /** Runs [block] on the PDF thread and waits for it, rethrowing its own exception. */
    fun <T> run(block: () -> T): T {
        check(initialized) { "PdfThread.init(context) has not been called" }
        if (Thread.currentThread().name == "pdf") return block()
        try {
            return executor.submit(Callable(block)).get()
        } catch (e: ExecutionException) {
            throw e.cause ?: e
        }
    }

    suspend fun <T> async(block: () -> T): T = withContext(dispatcher) {
        check(initialized) { "PdfThread.init(context) has not been called" }
        block()
    }
}
