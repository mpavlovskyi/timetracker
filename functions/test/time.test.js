'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  timeDecimalInTz, localDateStringInTz, parseHHMMToDecimal,
  getScheduleEndForDate, shiftDecimals
} = require('../lib/time');

const TZ = 'America/Chicago';

test('timeDecimalInTz converts UTC instant to Chicago decimal (CDT)', () => {
  // 2026-07-01T14:30:00Z = 09:30 CDT
  assert.strictEqual(timeDecimalInTz(new Date('2026-07-01T14:30:00Z'), TZ), 9.5);
});

test('timeDecimalInTz converts UTC instant to Chicago decimal (CST)', () => {
  // 2026-01-15T15:30:00Z = 09:30 CST (UTC-6)
  assert.strictEqual(timeDecimalInTz(new Date('2026-01-15T15:30:00Z'), TZ), 9.5);
});

test('localDateStringInTz returns Chicago date across UTC midnight', () => {
  // 2026-07-02T03:00:00Z = 2026-07-01 22:00 CDT
  assert.strictEqual(localDateStringInTz(new Date('2026-07-02T03:00:00Z'), TZ), '2026-07-01');
});

test('parseHHMMToDecimal parses and rejects garbage', () => {
  assert.strictEqual(parseHHMMToDecimal('17:30'), 17.5);
  assert.strictEqual(parseHHMMToDecimal(''), null);
  assert.strictEqual(parseHHMMToDecimal(null), null);
  assert.strictEqual(parseHHMMToDecimal('ab:cd'), null);
});

test('getScheduleEndForDate picks the weekday end', () => {
  const schedule = { wednesday: { start: '09:00', end: '17:00' } };
  assert.strictEqual(getScheduleEndForDate(schedule, '2026-07-01'), 17); // Wednesday
  assert.strictEqual(getScheduleEndForDate(schedule, '2026-07-02'), null); // Thursday
  assert.strictEqual(getScheduleEndForDate(null, '2026-07-01'), null);
});

test('getScheduleEndForDate returns null for missing or malformed end', () => {
  assert.strictEqual(getScheduleEndForDate({ wednesday: { start: '09:00' } }, '2026-07-01'), null);
  assert.strictEqual(getScheduleEndForDate({ wednesday: { start: '09:00', end: 'xx' } }, '2026-07-01'), null);
});

test('shiftDecimals computes start/end/total for a same-day shift', () => {
  const out = shiftDecimals(new Date('2026-07-01T14:00:00Z'), new Date('2026-07-01T22:30:00Z'), TZ);
  assert.deepStrictEqual(out, { startDecimal: 9, endDecimal: 17.5, totalHours: 8.5 });
});

test('shiftDecimals extends endDecimal past midnight instead of wrapping', () => {
  // 22:00 CDT -> 01:00 CDT next day = 3h
  const out = shiftDecimals(new Date('2026-07-02T03:00:00Z'), new Date('2026-07-02T06:00:00Z'), TZ);
  assert.deepStrictEqual(out, { startDecimal: 22, endDecimal: 25, totalHours: 3 });
});
