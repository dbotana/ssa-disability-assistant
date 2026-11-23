package org.ssa.assistant.core

/**
 * Directories readResource() searches before the main bundle, in order.
 * Empty in an app. The ios/CoreCrypto SwiftPM tests set it, because an
 * XCTest bundle has no app main bundle; X6 decides the app's own layout.
 */
object IosResources {
    var roots: List<String> = emptyList()
}
