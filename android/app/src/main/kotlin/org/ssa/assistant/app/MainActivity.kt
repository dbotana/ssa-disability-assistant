package org.ssa.assistant.app

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * The single activity. Screens: Setup -> Interview -> Review -> Export.
 * The skeleton ships the shell; the screens land with the TurnController in
 * milestone M5. Privacy: FLAG_SECURE, no recents screenshot, no window leaks.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        // Added in API 33 (Tiramisu). FLAG_SECURE already blanks the recents
        // thumbnail; this stops the system taking one at all.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false)
        }
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    SetupScreen()
                }
            }
        }
    }
}

@Composable
private fun SetupScreen() {
    Column(modifier = Modifier.padding(24.dp)) {
        Text(text = "Disability Forms", style = MaterialTheme.typography.headlineMedium)
        Text(
            text = "A voice-first interview for the SSA Adult Disability Starter Kit and Maine's " +
                "Developmental Services Intake Application. Everything runs on this device: " +
                "no network access, ever.",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(top = 12.dp)
        )
    }
}
