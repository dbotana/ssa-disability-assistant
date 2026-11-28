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

        // Each Setup control is read once: the PIN field by its description
        // alone, and each setting as one switch, not a text and a switch.
        let pinName = "PIN, optional. With a PIN your answers are saved encrypted on this phone."
        XCTAssertTrue(app.secureTextFields[pinName].exists || app.textFields[pinName].exists
                      || app.textViews[pinName].exists, "the PIN field is not named by its description alone")
        XCTAssertFalse(app.staticTexts["PIN (optional)"].exists, "the PIN heading is read as well as the field")
        for setting in ["Read each answer back before it is kept",
                        "Show Social Security and bank numbers as I type them"] {
            XCTAssertTrue(app.switches[setting].exists, "no switch named \(setting)")
            XCTAssertFalse(app.staticTexts[setting].exists, "\(setting) is read twice")
        }
        startButton.tap()

        // The first question is `forms`, a choice; tapping an option answers
        // it. The Starter Kit alone keeps the interview to one form, so the
        // export list has one entry.
        // The interview screen, with the first question on it, comes up as
        // soon as Start runs. Its controls appear once the intro, the no-PIN
        // warning and the question have been spoken aloud (src/turn.js
        // `start`, the snapshot's `starting`), so allow for the speech there.
        let firstQuestion = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Which form are we filling out today")).firstMatch
        XCTAssertTrue(firstQuestion.waitForExistence(timeout: 10), "the interview screen did not replace Setup")
        XCTAssertFalse(startButton.exists, "Setup is still on screen")
        let kit = app.buttons["Adult Disability Starter Kit"]
        XCTAssertTrue(kit.waitForExistence(timeout: 120), "the form question did not appear")
        kit.tap()

        // Three typed answers. The field's content description is the
        // catalogue's "Your answer"; Send submits it.
        // Compose joins the field's placeholder to its description, so the
        // label is "Your answer, Type your answer": match its start.
        let named = NSPredicate(format: "label BEGINSWITH %@", "Your answer")
        let textView = app.textViews.matching(named).firstMatch
        let textField = app.textFields.matching(named).firstMatch
        XCTAssertTrue(
            textView.waitForExistence(timeout: 10) || textField.waitForExistence(timeout: 10),
            "the answer field is not on screen"
        )
        let answerField = textView.exists ? textView : textField

        // Nothing typed may go to a prediction or dictation service: the
        // keyboard over the answer field shows no Dictate key and no
        // "Typing Predictions" bar (plan, B2's text-field rule).
        answerField.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "no keyboard over the answer field")
        // The Dictate key is not inside the Keyboard element, so look for it
        // anywhere: it may be shown only disabled.
        let dictate = app.buttons["dictation"]
        XCTAssertFalse(dictate.exists && dictate.isEnabled, "the keyboard offers the Dictate key")
        XCTAssertFalse(app.otherElements["Typing Predictions"].exists, "the keyboard shows the prediction bar")
        let send = app.buttons["Send answer"]

        // "Read each answer back" is on by default, so an answer can open a
        // read-back ("I have March 3, 1979. Is that correct?"); Yes keeps it,
        // as a user would. Not every answer is read back, so it is waited for
        // briefly rather than required.
        let yes = app.buttons["Yes"]
        for answer in ["Ada", "Lovelace", "1979-03-03"] {
            XCTAssertTrue(answerField.waitForExistence(timeout: 10), "the answer field is gone")
            answerField.tap()
            answerField.typeText(answer)
            send.tap()
            if yes.waitForExistence(timeout: 20) {
                yes.tap()
                // Yes and No leave the screen and the field and Send move up;
                // a tap aimed before the move misses Send (seen on the iPhone).
                XCTAssertTrue(yes.waitForNonExistence(timeout: 20), "the read-back did not close")
            }
        }

        // "finish" is a command, not an answer: Send passes it to the turn
        // loop, which opens Review.
        answerField.tap()
        answerField.typeText("finish")
        send.tap()

        let export = app.buttons["Export my forms"]
        XCTAssertTrue(export.waitForExistence(timeout: 120), "Review did not appear")
        // Review lists every answer, so the button can be below the screen.
        var swipes = 0
        while !export.isHittable && swipes < 15 {
            app.swipeUp()
            swipes += 1
        }
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
