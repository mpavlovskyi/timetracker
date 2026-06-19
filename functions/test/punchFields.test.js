'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { punchLocationFields, entryAuditFields } = require('../lib/punchFields');

test('punchLocationFields keeps valid strings', () => {
  const out = punchLocationFields({ clientTimeZone: 'Asia/Baghdad', country: 'Iraq', city: 'Baghdad' });
  assert.deepStrictEqual(out, {
    clockInTimeZone: 'Asia/Baghdad',
    clockInCountry: 'Iraq',
    clockInCity: 'Baghdad'
  });
});

test('punchLocationFields nulls out missing/blank/non-string values', () => {
  const out = punchLocationFields({ clientTimeZone: '', country: 123 });
  assert.deepStrictEqual(out, {
    clockInTimeZone: null,
    clockInCountry: null,
    clockInCity: null
  });
});

test('punchLocationFields tolerates undefined input', () => {
  assert.deepStrictEqual(punchLocationFields(undefined), {
    clockInTimeZone: null,
    clockInCountry: null,
    clockInCity: null
  });
});

test('entryAuditFields carries punch location and both timestamps', () => {
  const punch = { clockInTimeZone: 'Asia/Baghdad', clockInCountry: 'Iraq', clockInCity: 'Baghdad' };
  const inAt = { _t: 'in' };
  const outAt = { _t: 'out' };
  const out = entryAuditFields(punch, inAt, outAt, { clientTimeZone: 'Asia/Baghdad' });
  assert.deepStrictEqual(out, {
    clockInAt: inAt,
    clockOutAt: outAt,
    clockInTimeZone: 'Asia/Baghdad',
    clockOutTimeZone: 'Asia/Baghdad',
    clockInCountry: 'Iraq',
    clockInCity: 'Baghdad'
  });
});

test('entryAuditFields falls back to punch zone when clock-out zone missing', () => {
  const punch = { clockInTimeZone: 'America/Chicago' };
  const out = entryAuditFields(punch, {}, {}, {});
  assert.strictEqual(out.clockOutTimeZone, 'America/Chicago');
  assert.strictEqual(out.clockInCountry, null);
});
