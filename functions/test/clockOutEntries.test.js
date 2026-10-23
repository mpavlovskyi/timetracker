'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildClockOutEntries } = require('../lib/clockOutEntries');

const base = { userId: 'u1', status: 'pending', source: 'clock', notes: 'did stuff' };

test('no cap: single entry with raw hours', () => {
  const out = buildClockOutEntries({
    startDecimal: 9, endDecimal: 17.5, totalHours: 8.5,
    capDecimal: null, extendedTime: false, entryBase: base
  });
  assert.strictEqual(out.capped, false);
  assert.strictEqual(out.extraLogged, false);
  assert.deepStrictEqual(out.entries, [
    { role: 'primary', data: { ...base, startTime: 9, endTime: 17.5, hours: 8.5 } }
  ]);
});

test('within cap: single normal entry', () => {
  const out = buildClockOutEntries({
    startDecimal: 9, endDecimal: 16, totalHours: 7,
    capDecimal: 17, extendedTime: false, entryBase: base
  });
  assert.strictEqual(out.capped, false);
  assert.strictEqual(out.extraLogged, false);
  assert.deepStrictEqual(out.entries, [
    { role: 'primary', data: { ...base, startTime: 9, endTime: 16, hours: 7 } }
  ]);
});

test('end exactly at cap: not past cap, normal entry', () => {
  const out = buildClockOutEntries({
    startDecimal: 9, endDecimal: 17, totalHours: 8,
    capDecimal: 17, extendedTime: false, entryBase: base
  });
  assert.strictEqual(out.capped, false);
  assert.strictEqual(out.extraLogged, false);
  assert.deepStrictEqual(out.entries, [
    { role: 'primary', data: { ...base, startTime: 9, endTime: 17, hours: 8 } }
  ]);
});

test('capDecimal undefined: treated as no cap', () => {
  const out = buildClockOutEntries({
    startDecimal: 9, endDecimal: 21, totalHours: 12,
    capDecimal: undefined, extendedTime: false, entryBase: base
  });
  assert.strictEqual(out.capped, false);
  assert.strictEqual(out.extraLogged, false);
  assert.deepStrictEqual(out.entries, [
    { role: 'primary', data: { ...base, startTime: 9, endTime: 21, hours: 12 } }
  ]);
});

test('past cap, not extended: clamp to cap, capped flag', () => {
  const out = buildClockOutEntries({
    startDecimal: 9, endDecimal: 21, totalHours: 12,
    capDecimal: 17, extendedTime: false, entryBase: base
  });
  assert.strictEqual(out.capped, true);
  assert.strictEqual(out.extraLogged, false);
  assert.deepStrictEqual(out.entries, [
    { role: 'primary', data: { ...base, startTime: 9, endTime: 17, hours: 8, capped: true } }
  ]);
});

test('past cap, started after cap, not extended: zero hours', () => {
  const out = buildClockOutEntries({
    startDecimal: 18, endDecimal: 20, totalHours: 2,
    capDecimal: 17, extendedTime: false, entryBase: base
  });
  assert.deepStrictEqual(out.entries[0].data, { ...base, startTime: 18, endTime: 18, hours: 0, capped: true });
});

test('past cap, extended: normal portion + extra entry', () => {
  const out = buildClockOutEntries({
    startDecimal: 9, endDecimal: 19, totalHours: 10,
    capDecimal: 17, extendedTime: true, entryBase: base
  });
  assert.strictEqual(out.capped, false);
  assert.strictEqual(out.extraLogged, true);
  assert.deepStrictEqual(out.entries, [
    { role: 'primary', data: { ...base, startTime: 9, endTime: 17, hours: 8 } },
    { role: 'extra', data: { ...base, startTime: 17, endTime: 19, hours: 2, isExtraTime: true } }
  ]);
});

test('past cap, extended, started after cap: extra entry only', () => {
  const out = buildClockOutEntries({
    startDecimal: 18, endDecimal: 20, totalHours: 2,
    capDecimal: 17, extendedTime: true, entryBase: base
  });
  assert.deepStrictEqual(out.entries, [
    { role: 'extra', data: { ...base, startTime: 18, endTime: 20, hours: 2, isExtraTime: true } }
  ]);
});

test('capDecimal 0 (midnight) is a real cap: extended overnight shift is all extra', () => {
  const out = buildClockOutEntries({
    startDecimal: 23, endDecimal: 25, totalHours: 2,
    capDecimal: 0, extendedTime: true, entryBase: base
  });
  assert.strictEqual(out.capped, false);
  assert.strictEqual(out.extraLogged, true);
  assert.deepStrictEqual(out.entries, [
    { role: 'extra', data: { ...base, startTime: 23, endTime: 25, hours: 2, isExtraTime: true } }
  ]);
});

test('non-boolean truthy extendedTime is treated as not extended', () => {
  const out = buildClockOutEntries({
    startDecimal: 9, endDecimal: 21, totalHours: 12,
    capDecimal: 17, extendedTime: 'yes', entryBase: base
  });
  assert.strictEqual(out.capped, true);
  assert.strictEqual(out.extraLogged, false);
  assert.deepStrictEqual(out.entries, [
    { role: 'primary', data: { ...base, startTime: 9, endTime: 17, hours: 8, capped: true } }
  ]);
});

test('loggedHours sums entry hours, not raw elapsed time', () => {
  const capped = buildClockOutEntries({
    startDecimal: 9, endDecimal: 21, totalHours: 12,
    capDecimal: 17, extendedTime: false, entryBase: base
  });
  assert.strictEqual(capped.loggedHours, 8);

  const split = buildClockOutEntries({
    startDecimal: 9, endDecimal: 19, totalHours: 10,
    capDecimal: 17, extendedTime: true, entryBase: base
  });
  assert.strictEqual(split.loggedHours, 10);

  const normal = buildClockOutEntries({
    startDecimal: 9, endDecimal: 12.5, totalHours: 3.5,
    capDecimal: 17, extendedTime: false, entryBase: base
  });
  assert.strictEqual(normal.loggedHours, 3.5);
});
