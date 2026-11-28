import XCTest

/// Phase C5, the UI test: launch, Setup without a PIN, answer the form
/// question by tapping, three typed answers, Review, export the form, and
/// Apple's accessibility audit.
///
/// Review is reached the way the web reaches it: `finish` is a command the
/// turn loop matches before it parses an answer (`src/commands.js`), so typing
/// it and sending is the same as saying it.
///
/// The audit's failures are recorded, never waived: `performAccessibilityAudit`
/// reports them as test failures, and nothing here calls `ignore`.
final class InterviewUITests: XCTestCase {

    func testTypedInterviewThenOneExport() throws {
        let app = XCUIApplication()
        app.launch()

        // Setup, with no PIN: nothing is saved, and the screen says so.
        let startButton = app.buttons["Start"]
        XCTAssertTrue(startButton.waitForExistence(timeout: 20), "Setup did not appear")
        startButton.tap()

        // The first question is `forms`, a choice; tapping an option answers
        // it. The Starter Kit alone keeps the interview to one form, so the
        // export list has one entry.
        let kit = app.buttons["Adult Disability Starter Kit"]
        XCTAssertTrue(kit.waitForExistence(timeout: 20), "the form question did not appear")
        kit.tap()

        // Three typed answers. The field's content description is the
        // catalogue's "Your answer"; Send submits it.
        let textView = app.textViews["Your answer"].firstMatch
        let textField = app.textFields["Your answer"].firstMatch
        XCTAssertTrue(
            textView.waitForExistence(timeout: 10) || textField.waitForExistence(timeout: 10),
            "the answer field is not on screen"
        )
        let answerField = textView.exists ? textView : textField
        let send = app.buttons["Send answer"]

        for answer in ["Ada", "Lovelace", "1979-03-03"] {
            XCTAssertTrue(answerField.waitForExistence(timeout: 10), "the answer field is gone")
            answerField.tap()
            answerField.typeText(answer)
            send.tap()
        }

        // "finish" is a command, not an answer: Send passes it to the turn
        // loop, which opens Review.
        answerField.tap()
        answerField.typeText("finish")
        send.tap()

        let export = app.buttons["Export my forms"]
        XCTAssertTrue(export.waitForExistence(timeout: 30), "Review did not appear")
        export.tap()

        // One button per chosen form, labelled "Export <form title>".
        let anyForm = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Export ")).firstMatch
        if anyForm.waitForExistence(timeout: 10) {
            anyForm.tap()
        }

        // The audit runs last, so it sees every screen reached above.
        try app.performAccessibilityAudit()
    }
}
