package org.ssa.assistant.core

/**
 * A calendar date in the proleptic Gregorian calendar, with no time and no
 * zone: what the parser's century window and future-date check, the forms'
 * "prepared" date and the export file names need. The platform turns the
 * clock into the local date (TurnController.Ports.localDate); everything in
 * here is arithmetic on year, month and day.
 */
data class CivilDate(val year: Int, val month: Int, val day: Int) : Comparable<CivilDate> {
    init {
        require(month in 1..12 && day in 1..lengthOfMonth(year, month)) {
            "invalid date $year-$month-$day"
        }
    }

    override fun compareTo(other: CivilDate): Int = when {
        year != other.year -> year.compareTo(other.year)
        month != other.month -> month.compareTo(other.month)
        else -> day.compareTo(other.day)
    }

    fun isAfter(other: CivilDate): Boolean = this > other

    /** Days since 1970-01-01. */
    fun toEpochDay(): Long {
        // Howard Hinnant's days_from_civil.
        val y = (if (month <= 2) year - 1 else year).toLong()
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val mp = (month + 9) % 12
        val doy = (153 * mp + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    /** Whole days from this date to [other]: negative when [other] is earlier. */
    fun daysUntil(other: CivilDate): Long = other.toEpochDay() - toEpochDay()

    /** `YYYY-MM-DD`, in ASCII digits whatever the device locale. */
    fun iso(): String =
        "${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}"

    /** The ISO date, as java.time.LocalDate prints itself: records and string templates rely on it. */
    override fun toString(): String = iso()

    companion object {
        fun isLeapYear(year: Int): Boolean = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0

        fun lengthOfMonth(year: Int, month: Int): Int = when (month) {
            2 -> if (isLeapYear(year)) 29 else 28
            4, 6, 9, 11 -> 30
            in 1..12 -> 31
            else -> throw IllegalArgumentException("invalid month $month")
        }

        /** The date [epochDay] days after 1970-01-01. */
        fun ofEpochDay(epochDay: Long): CivilDate {
            // Howard Hinnant's civil_from_days.
            val z = epochDay + 719468
            val era = (if (z >= 0) z else z - 146096) / 146097
            val doe = z - era * 146097
            val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
            val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
            val mp = (5 * doy + 2) / 153
            val d = (doy - (153 * mp + 2) / 5 + 1).toInt()
            val m = (if (mp < 10) mp + 3 else mp - 9).toInt()
            val y = (yoe + era * 400 + (if (m <= 2) 1 else 0)).toInt()
            return CivilDate(y, m, d)
        }

        private const val MS_PER_DAY = 86_400_000L

        /**
         * The date at [epochMs] plus [offsetMs], the zone's offset from UTC at
         * that instant. With no offset, the UTC date.
         */
        fun ofEpochMillis(epochMs: Long, offsetMs: Long = 0): CivilDate =
            ofEpochDay((epochMs + offsetMs).floorDiv(MS_PER_DAY))
    }
}
