package org.ssa.assistant.core.js

import org.junit.Assert.assertEquals
import org.junit.Test
import org.ssa.assistant.core.json.Json
import org.ssa.assistant.core.json.writeJson

/** Every expected string below is `String(x)` in Node. */
class JsValuesTest {
    private val cases = listOf(
        0.0 to "0",
        -0.0 to "0",
        1.0 to "1",
        15.0 to "15",
        1200.0 to "1200",
        0.5 to "0.5",
        0.1 + 0.2 to "0.30000000000000004",
        0.000001 to "0.000001",
        0.0000015 to "0.0000015",
        1e-7 to "1e-7",
        0.0001 to "0.0001",
        0.0005 to "0.0005",
        123.456 to "123.456",
        12345678.5 to "12345678.5",
        1e20 to "100000000000000000000",
        1e21 to "1e+21",
        1.5e21 to "1.5e+21",
        9007199254740992.0 to "9007199254740992",
        5e-324 to "5e-324",
        1.7976931348623157e308 to "1.7976931348623157e+308",
        -2.5 to "-2.5",
        100.0 to "100",
        1.0 / 3 to "0.3333333333333333",
        2.0 / 3 to "0.6666666666666666",
        1e-300 to "1e-300",
        4.35 to "4.35",
        0.1 to "0.1",
        12345678000000.0 to "12345678000000",
    )

    @Test
    fun numbersPrintAsJsPrintsThem() {
        for ((x, expected) in cases) assertEquals("String($x)", expected, jsNumberToString(x))
    }

    @Test
    fun jsonWritesNonFiniteNumbersAsNull() {
        assertEquals("[null,null,1.5]", Json.Arr(mutableListOf(Json.Num(Double.NaN), Json.Num(Double.POSITIVE_INFINITY), Json.Num(1.5))).writeJson())
    }

    @Test
    fun stringOfValueForWhatNormalizeSees() {
        assertEquals("4101", jsString(4101.0))
        assertEquals("true", jsString(true))
        assertEquals("null", jsString(null))
        assertEquals("abc", jsString("abc"))
    }
}
