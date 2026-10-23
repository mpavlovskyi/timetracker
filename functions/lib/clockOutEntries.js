'use strict';

/**
 * Decides which timeEntries a clock-out produces. Pure: no Firestore.
 * Returns { entries: [{ role: 'primary'|'extra', data }], capped, extraLogged, loggedHours }.
 * loggedHours is the sum of the entries' hours (after any clamp), not raw elapsed time.
 */
function buildClockOutEntries({ startDecimal, endDecimal, totalHours, capDecimal, extendedTime: rawExtended, entryBase }) {
  // Strict boolean: a truthy non-boolean must not take the split branch or leak into flags.
  const extendedTime = rawExtended === true;
  const pastCap = capDecimal !== null && capDecimal !== undefined && endDecimal > capDecimal;
  const entries = [];

  if (pastCap && extendedTime) {
    // Split: normal portion up to cap, plus an EXTRA TIME entry for the overflow.
    if (startDecimal < capDecimal) {
      entries.push({
        role: 'primary',
        data: { ...entryBase, startTime: startDecimal, endTime: capDecimal, hours: capDecimal - startDecimal }
      });
    }
    const extraStart = Math.max(startDecimal, capDecimal);
    entries.push({
      role: 'extra',
      data: { ...entryBase, startTime: extraStart, endTime: endDecimal, hours: endDecimal - extraStart, isExtraTime: true }
    });
  } else if (pastCap) {
    // Silent clamp to cap.
    const cappedEnd = Math.max(capDecimal, startDecimal);
    entries.push({
      role: 'primary',
      data: { ...entryBase, startTime: startDecimal, endTime: cappedEnd, hours: Math.max(0, cappedEnd - startDecimal), capped: true }
    });
  } else {
    entries.push({
      role: 'primary',
      data: { ...entryBase, startTime: startDecimal, endTime: endDecimal, hours: totalHours }
    });
  }

  const loggedHours = entries.reduce((sum, e) => sum + e.data.hours, 0);
  return { entries, capped: pastCap && !extendedTime, extraLogged: pastCap && extendedTime, loggedHours };
}

module.exports = { buildClockOutEntries };
