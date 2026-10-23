'use strict';

// Returns hours+minutes/60 for a Date as observed in the given IANA timezone.
// Cloud Functions run in UTC, so date.getHours() would give UTC hours — which
// is 5 (CDT) or 6 (CST) off for a Chicago office. Using Intl.DateTimeFormat
// handles DST automatically.
function timeDecimalInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit'
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60;
}

// Returns YYYY-MM-DD for a Date as observed in the given IANA timezone.
function localDateStringInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(date);
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseHHMMToDecimal(str) {
  if (!str || typeof str !== 'string') return null;
  const [h, m] = str.split(':').map(Number);
  if (!isFinite(h) || !isFinite(m)) return null;
  return h + m / 60;
}

// Looks up the user's scheduled end time (decimal hours) for the given YYYY-MM-DD.
// Returns null if no schedule applies to that weekday.
function getScheduleEndForDate(schedule, isoDate) {
  if (!schedule || !isoDate) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dayIdx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const cfg = schedule[DAY_NAMES[dayIdx]];
  if (!cfg || !cfg.end) return null;
  return parseHHMMToDecimal(cfg.end);
}

// Office-time decimals for a shift. A shift crossing midnight gets an end past
// 24 rather than wrapping below the start.
function shiftDecimals(clockIn, now, timeZone) {
  const totalHours = (now.getTime() - clockIn.getTime()) / (1000 * 60 * 60);
  const startDecimal = timeDecimalInTz(clockIn, timeZone);
  let endDecimal = timeDecimalInTz(now, timeZone);
  if (endDecimal <= startDecimal) endDecimal = startDecimal + totalHours;
  return { startDecimal, endDecimal, totalHours };
}

module.exports = {
  timeDecimalInTz, localDateStringInTz, parseHHMMToDecimal,
  getScheduleEndForDate, shiftDecimals
};
