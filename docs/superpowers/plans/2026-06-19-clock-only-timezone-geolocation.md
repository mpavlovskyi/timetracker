# Clock-Only Punching, Per-Event Timezone & Geolocation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make regular users record time only via clock in/out (no manual logging), remove the office-location requirement, display each clock event in the user's local time alongside Central Time, and record the country/city a user clocked in from.

**Architecture:** Two surfaces change. (1) Firebase Functions (`functions/index.js`) stop gating clock in/out on location and store raw UTC timestamps + captured IANA timezone + reverse-geocoded country/city on each entry. (2) The single-file React app (`index.html`) makes geolocation optional, reverse-geocodes via BigDataCloud client-side, captures the browser timezone, removes the user manual-logging surface, and renders dual local/CT times plus a location chip. A small pure helper module (`functions/lib/punchFields.js`) holds the field-shaping logic so it can be unit-tested.

**Tech Stack:** Firebase Cloud Functions (Node 22, CommonJS), Firestore, React 18 via inline Babel (no build step), BigDataCloud free reverse-geocode endpoint, Node 22 built-in test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-06-19-clock-only-timezone-geolocation-design.md`

---

## Testing reality for this codebase

There is **no automated test harness** for the app: `index.html` is a single file with inline Babel/React loaded from CDNs, and there is no bundler or DOM test runner. Therefore:

- **Server pure logic** (`functions/lib/punchFields.js`) is unit-tested with Node 22's built-in `node --test` runner — zero new dependencies.
- **Server wiring** is verified with `node --check` (syntax/parse) plus a documented manual emulator/deploy smoke test.
- **Client changes** are verified manually in the browser against the running app (Firebase emulator or a deploy), with exact expected on-screen text given for each check.

Do not invent a Jest/Vitest setup — it is out of scope and not present.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `functions/lib/punchFields.js` | Pure functions shaping the timezone/location fields stored on punches and entries | **Create** |
| `functions/test/punchFields.test.js` | `node --test` unit tests for the above | **Create** |
| `functions/index.js` | Remove location gate; store new fields on punch + entry | **Modify** |
| `index.html` | Remove user manual logging; make geo optional + reverse-geocode + capture TZ; dual-time display + location chip | **Modify** |

---

## Task 1: Remove the office-location gate from clock in/out (server)

**Files:**
- Modify: `functions/index.js:258` (clockIn) and `functions/index.js:292` (clockOut)

- [ ] **Step 1: Remove the gate call in `clockIn`**

In `functions/index.js`, find this line inside `exports.clockIn` (currently line 258):

```js
  const user = await getUserDoc(uid);
  await locationCheck({ uid, user, coords, rawRequest: request.rawRequest, action: 'clockIn' });
```

Replace with (drop the `locationCheck` call; coords are still accepted for compatibility but no longer gate):

```js
  const user = await getUserDoc(uid);
  // Location gate removed: staff may clock in from anywhere. Coords/timezone are
  // collected for display/geolocation only (see punchLocationFields), never to block.
```

- [ ] **Step 2: Remove the gate call in `clockOut`**

In `exports.clockOut` (currently line 292), find:

```js
  const user = await getUserDoc(uid);
  await locationCheck({ uid, user, coords, rawRequest: request.rawRequest, action: 'clockOut' });
```

Replace with:

```js
  const user = await getUserDoc(uid);
  // Location gate removed: clock-out succeeds from anywhere.
```

Leave the now-unused `locationCheck` helper and the `OFFICE_PUBLIC_IPS`/`OFFICE_LAT`/`OFFICE_LNG` constants in place — they are harmless and out of scope to delete. Keep `OFFICE_TIMEZONE`; it is still used.

- [ ] **Step 3: Verify the file still parses**

Run: `cd functions && node --check index.js`
Expected: no output, exit code 0 (a parse error would print the location).

- [ ] **Step 4: Commit**

```bash
git add functions/index.js
git commit -m "feat: remove office-location gate from clock in/out"
```

---

## Task 2: Pure helper module for punch/entry fields (with tests)

**Files:**
- Create: `functions/lib/punchFields.js`
- Test: `functions/test/punchFields.test.js`

- [ ] **Step 1: Write the failing test**

Create `functions/test/punchFields.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd functions && node --test`
Expected: FAIL — `Cannot find module '../lib/punchFields'`.

- [ ] **Step 3: Implement the helper module**

Create `functions/lib/punchFields.js`:

```js
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
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd functions && node --test`
Expected: PASS — all 5 tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add functions/lib/punchFields.js functions/test/punchFields.test.js
git commit -m "feat: add pure punch/entry field helpers with tests"
```

---

## Task 3: Store timezone + location + clock-out timestamp (server wiring)

**Files:**
- Modify: `functions/index.js` (top require, `clockIn` punch write ~271, `clockOut` entryBase ~319)

- [ ] **Step 1: Require the helper at the top of `functions/index.js`**

Find the existing top-of-file requires (the block that includes `firebase-admin` / `firebase-functions`). Immediately after the last `require(...)` line in that block, add:

```js
const { punchLocationFields, entryAuditFields } = require('./lib/punchFields');
```

- [ ] **Step 2: Store location/timezone on the punch in `clockIn`**

In `exports.clockIn`, find the `punchRef.set` call (currently lines 271–277):

```js
  await punchRef.set({
    userId: uid,
    userEmail: user.email,
    userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    clockInAt: now,
    clockInDate
  });
```

Replace with:

```js
  await punchRef.set({
    userId: uid,
    userEmail: user.email,
    userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    clockInAt: now,
    clockInDate,
    ...punchLocationFields(data)
  });
```

- [ ] **Step 3: Add the clock-out timestamp + audit fields in `clockOut`**

In `exports.clockOut`, find the `entryBase` object (currently lines 319–327):

```js
  const entryBase = {
    userId: uid,
    userEmail: user.email,
    userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    date: punch.clockInDate,
    status: 'pending',
    source: 'clock',
    submittedAt: admin.firestore.FieldValue.serverTimestamp()
  };
```

Replace with (define `clockOutAt` from the existing `now` Date created at line 302, then spread the audit fields so every entry branch inherits them):

```js
  const clockOutAt = admin.firestore.Timestamp.fromDate(now);
  const entryBase = {
    userId: uid,
    userEmail: user.email,
    userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    date: punch.clockInDate,
    status: 'pending',
    source: 'clock',
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...entryAuditFields(punch, punch.clockInAt, clockOutAt, data)
  };
```

(`data` is already defined at the top of `clockOut` as `request.data || {}`. `punch.clockInAt` is the Firestore Timestamp stored at clock-in. `now` is the `new Date()` from line 302.)

- [ ] **Step 4: Verify the file still parses**

Run: `cd functions && node --check index.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add functions/index.js
git commit -m "feat: store timezone, country/city and clock-out timestamp on entries"
```

- [ ] **Step 6 (manual, do after Task 4 client work is deployed): emulator/deploy smoke test**

Deploy functions (`cd functions && npm run deploy`) or run the emulator (`npm run serve`). Clock in then out from the app. In the Firebase console (or emulator UI) open the new `timeEntries` doc and confirm it has: `clockInAt`, `clockOutAt`, `clockInTimeZone`, `clockOutTimeZone`, and (if location was granted) `clockInCountry`, `clockInCity`. Confirm `hours` is unchanged vs. before.

---

## Task 4: Client — optional geolocation, reverse-geocode, capture timezone, remove office errors

**Files:**
- Modify: `index.html` — `runLocationGatedCall` (2155–2192), `handleClockIn` (2194–2208), `handleClockOut` (2210–2232)

- [ ] **Step 1: Add a reverse-geocode helper next to the geolocation helper**

In `index.html`, find `getGeolocationCoords` (the block starting at line 4391). Immediately **after** that `const getGeolocationCoords = ...;` definition (after its closing `});` at line 4411), add:

```js
        // Reverse-geocode coords to { country, city } via BigDataCloud's free,
        // keyless, CORS-enabled client endpoint. Returns nulls on any failure —
        // location is best-effort and never blocks a punch.
        const reverseGeocode = async (coords) => {
            if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number') {
                return { country: null, city: null };
            }
            try {
                const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${coords.lat}&longitude=${coords.lng}&localityLanguage=en`;
                const res = await fetch(url);
                if (!res.ok) return { country: null, city: null };
                const j = await res.json();
                return {
                    country: j.countryName || null,
                    city: j.city || j.locality || j.principalSubdivision || null
                };
            } catch (e) {
                console.warn('reverseGeocode failed:', e);
                return { country: null, city: null };
            }
        };
```

- [ ] **Step 2: Rewrite `runLocationGatedCall` as a non-blocking `runPunchCall`**

Replace the entire `runLocationGatedCall` function (lines 2155–2192) with:

```js
            const runPunchCall = async (callableName, extraPayload) => {
                // Best-effort location: failures are non-blocking now that the
                // office gate is gone. We collect coords/timezone for display only.
                let coords = null;
                try {
                    coords = await getGeolocationCoords();
                } catch (geoErr) {
                    // denied / unavailable — proceed without coords
                }

                const clientTimeZone = (() => {
                    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
                    catch (e) { return null; }
                })();

                let country = null, city = null;
                if (coords) {
                    const geo = await reverseGeocode(coords);
                    country = geo.country;
                    city = geo.city;
                }

                try {
                    const fn = functions.httpsCallable(callableName);
                    const result = await fn({ coords, clientTimeZone, country, city, ...extraPayload });
                    return result.data;
                } catch (err) {
                    const detailCode = err && err.details && err.details.code;
                    let text = err && err.message ? err.message : 'Request failed. Please try again.';
                    if (detailCode === 'ALREADY_CLOCKED_IN') {
                        text = 'You are already clocked in.';
                    } else if (detailCode === 'NOT_CLOCKED_IN') {
                        text = 'No active punch to clock out of.';
                    } else if (detailCode === 'SHIFT_TOO_SHORT') {
                        text = 'Shift too short to log (under 1 minute).';
                    }
                    const richErr = new Error(text);
                    richErr.userMessage = text;
                    richErr.detailCode = detailCode || null;
                    throw richErr;
                }
            };
```

(The `LOCATION_REQUIRED` / `LOCATION_OUTSIDE_RADIUS` branches are removed because the server no longer throws them.)

- [ ] **Step 3: Update the two call sites to the new name**

In `handleClockIn` (line 2200), change:

```js
                    await runLocationGatedCall('clockIn', { clockInDate });
```
to
```js
                    await runPunchCall('clockIn', { clockInDate });
```

In `handleClockOut` (line 2215), change:

```js
                    const result = await runLocationGatedCall('clockOut', { extendedTime });
```
to
```js
                    const result = await runPunchCall('clockOut', { extendedTime });
```

- [ ] **Step 4: Confirm no stale references remain**

Run: `grep -n "runLocationGatedCall\|LOCATION_REQUIRED\|LOCATION_OUTSIDE_RADIUS" index.html`
Expected: no matches (all renamed/removed).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: make geolocation optional, reverse-geocode + capture timezone on punch"
```

- [ ] **Step 6 (manual): browser verification**

Load the app, clock in as a regular user with location **denied** → clock-in succeeds, timer runs, no "must be at the office" error. Clock in with location **granted** → after clock-out, the entry's `timeEntries` doc shows `clockInCountry`/`clockInCity` populated (verify in Firebase console). This shares the smoke test in Task 3 Step 6.

---

## Task 5: Remove the user manual-logging surface

**Files:**
- Modify: `index.html` — `userNavItems` (1682–1688), page router (4546–4550)
- Delete: `index.html` — `TimeClock` component (2330 through its closing `};`)

- [ ] **Step 1: Remove the "Log Time" nav item for users**

In `userNavItems` (lines 1682–1688), delete this line:

```js
                { id: 'clock', label: 'Log Time', icon: 'edit' },
```

The remaining user nav is `dashboard`, `punch`, `profile`, `schedule`. Leave `adminNavItems` untouched (admins keep their `Log Time`).

- [ ] **Step 2: Stop routing users to the manual form**

In the router, find (lines 4546–4550):

```js
                    {currentPage === 'clock' && (
                        currentUser.role === 'admin'
                            ? <AdminLogTime />
                            : <TimeClock currentUser={currentUser} onNavigate={setCurrentPage} />
                    )}
```

Replace with (only admins reach this page now):

```js
                    {currentPage === 'clock' && currentUser.role === 'admin' && (
                        <AdminLogTime />
                    )}
```

- [ ] **Step 3: Delete the now-unused `TimeClock` component**

Find the `TimeClock` component declaration at line 2330 (`const TimeClock = ({ currentUser, onNavigate }) => {`) and delete the entire component through its matching closing `};`. (It ends just before the next top-level `const ... = ...` component declaration — confirm by checking the brace/JSX balance; the component that follows is the next one defined after `TimeClock`.) Do not delete `AdminLogTime` or `ClockInOut`.

- [ ] **Step 4: Confirm `TimeClock` is fully gone**

Run: `grep -n "TimeClock" index.html`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: remove manual hour logging for regular users"
```

- [ ] **Step 6 (manual): browser verification**

Log in as a regular user → sidebar shows no "Log Time"; only Clock In/Out remains for time entry. Log in as admin → "Log Time" still present and "Log Time for Users" works.

---

## Task 6: Dual local/CT time display + location chip

**Files:**
- Modify: `index.html` — add display helpers near `formatTimeDisplay` (~1283); apply at entry-table cells: dashboard `2037–2038`, admin tables `2978–2979`, `3591–3592`, `3913–3914`

- [ ] **Step 1: Add the dual-time + chip helpers**

Find `formatTimeDisplay` (the `const formatTimeDisplay = (decimal) => {...}` block around line 1283). Immediately **after** that function, add:

```js
        // CT is shown as the office reference time. Hardcoded to match the
        // server OFFICE_TIMEZONE default; update both together if that changes.
        const OFFICE_TZ_DISPLAY = 'America/Chicago';

        const toDateOrNull = (ts) => {
            if (!ts) return null;
            if (typeof ts.toDate === 'function') return ts.toDate();
            const d = new Date(ts);
            return isNaN(d.getTime()) ? null : d;
        };

        const formatInZone = (date, ianaZone) => {
            try {
                return new Intl.DateTimeFormat('en-US', {
                    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: ianaZone
                }).format(date);
            } catch (e) {
                return null;
            }
        };

        // "Asia/Baghdad" -> "Baghdad"
        const zoneLabel = (zone) => zone ? zone.split('/').pop().replace(/_/g, ' ') : '';

        // Renders a clock time for an entry. Uses the raw UTC instant + captured
        // zone to show local + CT when available; otherwise falls back to the
        // legacy CT decimal. Capped/extra-time entries use the fallback because
        // their start/end decimals are schedule-derived, not the raw instants.
        const ClockTime = ({ entry, which }) => {
            const decimal = which === 'start' ? entry.startTime : entry.endTime;
            const at = toDateOrNull(which === 'start' ? entry.clockInAt : entry.clockOutAt);
            const zone = which === 'start' ? entry.clockInTimeZone : entry.clockOutTimeZone;
            const usable = at && zone && !entry.capped && !entry.isExtraTime;
            if (!usable) {
                return <span>{formatTimeDisplay(decimal)}</span>;
            }
            const ct = formatInZone(at, OFFICE_TZ_DISPLAY);
            if (zone === OFFICE_TZ_DISPLAY) {
                return <span>{ct} CT</span>;
            }
            const local = formatInZone(at, zone);
            if (!local) return <span>{ct} CT</span>;
            return (
                <span>
                    {local} <span style={{ color: 'var(--text-light)', fontSize: '0.8em' }}>{zoneLabel(zone)}</span>
                    {' · '}
                    <span style={{ color: 'var(--text-light)', fontSize: '0.8em' }}>{ct} CT</span>
                </span>
            );
        };

        // Small "Iraq · Baghdad" chip; renders nothing when no location captured.
        const LocationChip = ({ entry }) => {
            const parts = [entry.clockInCountry, entry.clockInCity].filter(Boolean);
            if (!parts.length) return null;
            return (
                <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--text-light)' }}>
                    <Icon name="mapPin" size={12} /> {parts.join(' · ')}
                </span>
            );
        };
```

Note: if `Icon` has no `mapPin` glyph, drop the `<Icon .../>` and keep the text (`{parts.join(' · ')}`). Confirm available icon names by checking the `Icon` component's `name` switch in `index.html` before committing.

- [ ] **Step 2: Apply to the dashboard entry table**

In the dashboard table, change the start/end cells (lines 2037–2038):

```js
                                                <td>{formatTimeDisplay(entry.startTime)}</td>
                                                <td>{formatTimeDisplay(entry.endTime)}</td>
```
to
```js
                                                <td><ClockTime entry={entry} which="start" /></td>
                                                <td><ClockTime entry={entry} which="end" /></td>
```

Then add the location chip to the date cell. Change (lines 2033–2036):

```js
                                                <td>
                                                    {new Date(entry.date + 'T00:00:00').toLocaleDateString()}
                                                    {entry.isExtraTime && <ExtraTimeBadge />}
                                                </td>
```
to
```js
                                                <td>
                                                    {new Date(entry.date + 'T00:00:00').toLocaleDateString()}
                                                    {entry.isExtraTime && <ExtraTimeBadge />}
                                                    <LocationChip entry={entry} />
                                                </td>
```

- [ ] **Step 3: Apply to the admin tables**

Repeat the start/end cell swap at each remaining display site. At lines 2978–2979, 3591–3592, and 3913–3914 the cells read:

```js
                                                        <td>{formatTimeDisplay(entry.startTime)}</td>
                                                        <td>{formatTimeDisplay(entry.endTime)}</td>
```
(indentation varies per site). Replace each pair with:

```js
                                                        <td><ClockTime entry={entry} which="start" /></td>
                                                        <td><ClockTime entry={entry} which="end" /></td>
```

For the location chip in the admin tables, add `<LocationChip entry={entry} />` inside the existing date `<td>` at each of those three tables (the cell that renders `entry.date`), mirroring Step 2. If a table has no date cell visible, skip the chip there — the start/end dual time is the priority.

- [ ] **Step 4: Confirm every display site was converted**

Run: `grep -n "formatTimeDisplay(entry.startTime)\|formatTimeDisplay(entry.endTime)" index.html`
Expected: no matches (all replaced by `<ClockTime>`). `formatTimeDisplay` itself still exists (used as the fallback inside `ClockTime` and for schedule/time-picker option labels).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: show local + CT time and location on time entries"
```

- [ ] **Step 6 (manual): browser verification**

1. **New remote entry:** With the browser timezone set to Baghdad (DevTools → Sensors → Location, or an OS timezone change), clock in and out. The entry shows e.g. `3:00 PM Baghdad · 7:00 AM CT` for start, and an "Iraq · Baghdad" chip. The `hours` total matches the same shift logged from CT.
2. **CT entry:** Clock in/out with the browser in `America/Chicago` → start/end show e.g. `9:00 AM CT` (no duplicate local label).
3. **Legacy entry:** An entry created before this change (no `clockInAt`/zone) still renders via `formatTimeDisplay` (CT decimal) with no crash and no chip.
4. **Capped/extra entry:** A schedule-capped or extra-time entry renders its decimal-based times (fallback), not the raw clock-out instant.

---

## Self-Review

**Spec coverage:**
- Remove manual logging for users, keep admin log+edit → Task 5 (nav + route + delete `TimeClock`; `AdminLogTime` untouched). ✓
- Remove office-location requirement, keep optional GPS → Task 1 (gate removed) + Task 4 (non-blocking geo). ✓
- Local + CT auto-detected per event, store UTC + IANA zone, fallback → Task 2/3 (store `clockInAt`/`clockOutAt`/zones) + Task 6 (`ClockTime` with fallback). ✓
- Country/city via BigDataCloud reverse-geocode → Task 4 (`reverseGeocode`) + Task 3 (store) + Task 6 (`LocationChip`). ✓
- Admins not given a personal clock widget → no task adds one. ✓
- Hours/duration unchanged → no task touches `totalHours` math; verified in Task 3/6 manual checks. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The two "confirm icon name" / "confirm brace balance" notes are concrete verification instructions, not deferred work.

**Type/name consistency:** `runPunchCall` defined in Task 4 Step 2 and used in Step 3. `punchLocationFields`/`entryAuditFields` defined in Task 2, required and used in Task 3 with matching signatures (`entryAuditFields(punch, clockInAt, clockOutAt, data)`). Field names (`clockInAt`, `clockOutAt`, `clockInTimeZone`, `clockOutTimeZone`, `clockInCountry`, `clockInCity`) are identical across the server helper (Task 2/3) and the client `ClockTime`/`LocationChip` readers (Task 6). `formatInZone`, `zoneLabel`, `toDateOrNull`, `ClockTime`, `LocationChip`, `OFFICE_TZ_DISPLAY` all defined once in Task 6 Step 1 and used within the same task.
