'use strict';

// Returns null for anything that is not a non-empty string, so a clock-in
// never fails because the browser withheld location/timezone.
function cleanString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Fields recorded on an activePunches doc at clock-in, derived from the client
 * payload. All optional — absent/invalid values become null.
 */
function punchLocationFields(data) {
  const d = data || {};
  return {
    clockInTimeZone: cleanString(d.clientTimeZone),
    clockInCountry: cleanString(d.country),
    clockInCity: cleanString(d.city)
  };
}

/**
 * Audit fields copied onto every timeEntry at clock-out: the raw UTC instants
 * and the captured timezones/location, so any view can render the event in
 * both local and office time.
 */
function entryAuditFields(punch, clockInAt, clockOutAt, data) {
  const p = punch || {};
  const d = data || {};
  return {
    clockInAt,
    clockOutAt,
    clockInTimeZone: p.clockInTimeZone || null,
    clockOutTimeZone: cleanString(d.clientTimeZone) || p.clockInTimeZone || null,
    clockInCountry: p.clockInCountry || null,
    clockInCity: p.clockInCity || null
  };
}

module.exports = { punchLocationFields, entryAuditFields };
