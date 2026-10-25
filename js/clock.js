/**
 * Clock-time helpers.
 *
 * The record is kept in minutes from the start of anaesthesia and shown as the
 * clock time on the wall. These functions convert between the two. They take the
 * start (a Date) as an argument and read no state, so they can be tested without
 * a page. A time typed as HH:MM is taken to be on the day of the start; one
 * earlier than the start is taken to be the following day, which is the only
 * reading that describes a case that runs past midnight.
 */

const MINUTES_PER_DAY = 1440;

const pad2 = (n) => String(n).padStart(2, '0');

/** "HH:MM" (24 h, local time, seconds dropped) for a Date. Midnight is 00:00, never 24:00. */
function formatClockTime(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Minutes from midnight for "HH:MM" or "H:MM"; null if the text is not a time of day. */
function parseClock(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** The clock time, "HH:MM", of an instant this many minutes after the start. */
function clockTimeAfter(startDate, minutesFromStart) {
    return formatClockTime(new Date(startDate.getTime() + minutesFromStart * 60000));
}

/**
 * How many whole minutes into the case an "HH:MM" on the day of the start is.
 * Earlier than the start means the next day; never negative. NaN if the text is
 * not a time of day, so the dose or assessment validation rejects it.
 * The start counts as the minute it fell in, so a time typed as the start's own
 * HH:MM is minute 0 whatever seconds the start carries.
 * @param {Date} startDate
 * @param {string} timeText "HH:MM"
 */
function minutesIntoCase(startDate, timeText) {
    const clock = parseClock(timeText);
    if (clock === null) return NaN;
    const startMinute = startDate.getHours() * 60 + startDate.getMinutes();
    let minutes = clock - startMinute;
    if (minutes < 0) minutes += MINUTES_PER_DAY;
    return minutes;
}

if (typeof window !== 'undefined') {
    window.formatClockTime = formatClockTime;
    window.parseClock = parseClock;
    window.clockTimeAfter = clockTimeAfter;
    window.minutesIntoCase = minutesIntoCase;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MINUTES_PER_DAY, formatClockTime, parseClock, clockTimeAfter, minutesIntoCase };
}
