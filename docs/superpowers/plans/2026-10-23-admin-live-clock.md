# Admin Live Clock + Admin Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins see every clocked-in user with a live running timer on a new "Live Now" page and can stop any user's clock; the stopped shift is saved as a pending time entry ending "now".

**Architecture:** Pure hours/cap math is extracted from `clockOut` into `functions/lib/` (unit-tested with `node:test`). Both `clockOut` and a new admin-only `adminClockOut` callable write entries through one shared, transactional writer, so a user clock-out racing an admin stop yields exactly one entry. The frontend (single-file React-via-Babel `index.html`) adds a `LiveNow` page that listens to `activePunches` in real time.

**Tech Stack:** Firebase Cloud Functions v2 (Node 22, firebase-admin), Firestore, React 18 + `@babel/standalone` in `index.html`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-23-admin-live-clock-design.md`

**Conventions to match:**
- Functions: CommonJS, `'use strict'` in `lib/` files, `HttpsError` with `details.code`, `getUserDoc`, `logAdminAction` (never throws).
- Frontend: components are `const X = () => {...}` inside the single `<script type="text/babel">`; modals use `.modal-overlay` / `.modal` / `.modal-actions`; alerts use `.alert success|error|info`; **never** `window.confirm/alert`.
- Tests: `cd functions && node --test test/` (no npm test script exists; do not add deps).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `functions/lib/time.js` | Create | Pure tz/schedule helpers moved out of `index.js` + new `shiftDecimals` |
| `functions/lib/clockOutEntries.js` | Create | Pure: given decimals/cap/extendedTime/entryBase → entry docs + flags |
| `functions/test/time.test.js` | Create | Tests for `time.js` |
| `functions/test/clockOutEntries.test.js` | Create | Tests for `clockOutEntries.js` |
| `functions/index.js` | Modify | Import lib helpers; add `writeClockOut` (transaction writer); refactor `clockOut`; add `adminClockOut` |
| `index.html` | Modify | Module-scope `formatElapsed`; `StoppedByAdminBadge`; `AdminStopModal`; `LiveNow`; sidebar + route; employee notice in `ClockInOut` |

---

### Task 0: Precondition — pending work committed

- [ ] **Step 1:** Run `git status --short`. If `functions/index.js` or `firestore.rules` show as modified (the password-reset / `logAdminAction` work), **stop and ask the user** to commit it first. Do not commit it yourself and do not discard it. `adminClockOut` depends on `logAdminAction` existing.

---

### Task 1: Extract pure time helpers to `functions/lib/time.js`

**Files:**
- Create: `functions/lib/time.js`
- Create: `functions/test/time.test.js`
- Modify: `functions/index.js` (remove the moved helper definitions, import them instead)

- [ ] **Step 1: Write the failing test** — `functions/test/time.test.js`

```js
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

test('shiftDecimals computes start/end/total for a same-day shift', () => {
  const out = shiftDecimals(new Date('2026-07-01T14:00:00Z'), new Date('2026-07-01T22:30:00Z'), TZ);
  assert.deepStrictEqual(out, { startDecimal: 9, endDecimal: 17.5, totalHours: 8.5 });
});

test('shiftDecimals extends endDecimal past midnight instead of wrapping', () => {
  // 22:00 CDT -> 01:00 CDT next day = 3h
  const out = shiftDecimals(new Date('2026-07-02T03:00:00Z'), new Date('2026-07-02T06:00:00Z'), TZ);
  assert.deepStrictEqual(out, { startDecimal: 22, endDecimal: 25, totalHours: 3 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd functions && node --test test/time.test.js`
Expected: FAIL — `Cannot find module '../lib/time'`.

- [ ] **Step 3: Create `functions/lib/time.js`** — move these definitions verbatim from `functions/index.js` (`timeDecimalInTz`, `localDateStringInTz`, `DAY_NAMES`, `parseHHMMToDecimal`, `getScheduleEndForDate`, including their comments) and add `shiftDecimals`:

```js
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
```

Then in `functions/index.js`: delete the moved definitions (the block from the `timeDecimalInTz` comment through the end of `getScheduleEndForDate`) and add after the `punchFields` require:

```js
const { timeDecimalInTz, localDateStringInTz, getScheduleEndForDate, shiftDecimals } = require('./lib/time');
```

- [ ] **Step 4: Run tests + load check**

Run: `cd functions && node --test test/ && node -e "require('./lib/time')"`
Expected: all tests PASS (including existing `punchFields.test.js`).
Also run: `cd functions && node --check index.js` → no output (syntax OK).

- [ ] **Step 5: Commit**

```bash
git add functions/lib/time.js functions/test/time.test.js functions/index.js
git commit -m "refactor(functions): move tz/schedule helpers to lib/time"
```

---

### Task 2: Pure entry builder `functions/lib/clockOutEntries.js`

**Files:**
- Create: `functions/lib/clockOutEntries.js`
- Create: `functions/test/clockOutEntries.test.js`

Behaviour must equal the three branches in today's `clockOut` (split / clamp / normal).

- [ ] **Step 1: Write the failing test** — `functions/test/clockOutEntries.test.js`

```js
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
  assert.deepStrictEqual(out.entries[0].data.hours, 7);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd functions && node --test test/clockOutEntries.test.js`
Expected: FAIL — `Cannot find module '../lib/clockOutEntries'`.

- [ ] **Step 3: Implement `functions/lib/clockOutEntries.js`**

```js
'use strict';

/**
 * Decides which timeEntries a clock-out produces. Pure: no Firestore.
 * Returns { entries: [{ role: 'primary'|'extra', data }], capped, extraLogged }.
 */
function buildClockOutEntries({ startDecimal, endDecimal, totalHours, capDecimal, extendedTime, entryBase }) {
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

  return { entries, capped: pastCap && !extendedTime, extraLogged: pastCap && extendedTime };
}

module.exports = { buildClockOutEntries };
```

- [ ] **Step 4: Run tests**

Run: `cd functions && node --test test/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/lib/clockOutEntries.js functions/test/clockOutEntries.test.js
git commit -m "feat(functions): pure clock-out entry builder with tests"
```

---

### Task 3: Shared transactional writer + refactor `clockOut`

**Files:**
- Modify: `functions/index.js` (`clockOut`, add `writeClockOut` helper above the Callables section)

Why a transaction: `clockOut` currently reads the punch then commits a batch; an admin stop between read and commit would produce two entries. Both paths now read+delete the punch inside `db.runTransaction`, so the loser sees `NOT_CLOCKED_IN`.

- [ ] **Step 1: Add the import** next to the other lib requires:

```js
const { buildClockOutEntries } = require('./lib/clockOutEntries');
```

- [ ] **Step 2: Add `writeClockOut`** just above the `// Callables` banner:

```js
/**
 * Turns an active punch into timeEntries and deletes the punch, using the given
 * transaction. Caller must have read punchRef in the same transaction.
 * Returns { hours, entryId, extraEntryId, capped, extraLogged }.
 */
function writeClockOut(tx, { punchRef, punch, user, now, notes, extendedTime, extraFields, data }) {
  const clockIn = punch.clockInAt.toDate();
  const tz = OFFICE_TIMEZONE.value();
  const { startDecimal, endDecimal, totalHours } = shiftDecimals(clockIn, now, tz);

  const capDecimal = user.scheduleCapEnabled === true
    ? getScheduleEndForDate(user.schedule, punch.clockInDate)
    : null;

  const clockOutAt = admin.firestore.Timestamp.fromDate(now);
  const entryBase = {
    userId: punch.userId,
    userEmail: user.email,
    userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    date: punch.clockInDate,
    status: 'pending',
    source: 'clock',
    notes,
    ...(typeof punch.plan === 'string' && punch.plan ? { plan: punch.plan } : {}),
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...entryAuditFields(punch, punch.clockInAt, clockOutAt, data),
    ...(extraFields || {})
  };

  const { entries, capped, extraLogged } = buildClockOutEntries({
    startDecimal, endDecimal, totalHours, capDecimal, extendedTime, entryBase
  });

  let entryId = null;
  let extraEntryId = null;
  for (const { role, data: entryData } of entries) {
    const ref = db.collection('timeEntries').doc();
    tx.set(ref, entryData);
    if (role === 'extra') extraEntryId = ref.id;
    else entryId = ref.id;
  }
  tx.delete(punchRef);

  return { hours: totalHours, entryId, extraEntryId, capped, extraLogged };
}
```

- [ ] **Step 3: Replace the body of `clockOut`** from `const punchRef = ...` to the end of the function with:

```js
  const notes = typeof data.notes === 'string' ? data.notes.trim() : null;
  if (notes === null || notes.length < 3 || notes.length > 2000) {
    throw new HttpsError('invalid-argument', 'Please describe what you did today before clocking out.');
  }

  const punchRef = db.collection('activePunches').doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const punchSnap = await tx.get(punchRef);
    if (!punchSnap.exists) {
      throw new HttpsError('failed-precondition', 'No active punch found.', { code: 'NOT_CLOCKED_IN' });
    }
    const punch = punchSnap.data();
    const now = new Date();
    if (now.getTime() - punch.clockInAt.toDate().getTime() < 60 * 1000) {
      throw new HttpsError('failed-precondition', 'Shift too short to log (under 1 minute).', { code: 'SHIFT_TOO_SHORT' });
    }
    return writeClockOut(tx, { punchRef, punch, user, now, notes, extendedTime, extraFields: null, data });
  });

  return { ok: true, ...result };
```

Note: notes validation now runs before the punch read (previously after). Error messages/codes are unchanged; a request with both a missing punch and empty notes now gets `invalid-argument` instead of `NOT_CLOCKED_IN` — acceptable. Remove now-unused locals (`coords`, `clockIn`, `elapsedMs`, `tz`, etc.) from `clockOut`; keep `const user = await getUserDoc(uid);` and `const extendedTime = data.extendedTime === true;`. If `timeDecimalInTz` is no longer referenced in `index.js`, drop it from the require.

Return shape check: previous return was `{ ok, hours, entryId, extraEntryId, capped, extraLogged }` — identical.

- [ ] **Step 4: Verify**

Run: `cd functions && node --check index.js && node --test test/`
Expected: no syntax error; all tests PASS.
Run: `grep -n "batch" functions/index.js` → expected: no remaining `db.batch()` in `clockOut`.

- [ ] **Step 5: Commit**

```bash
git add functions/index.js
git commit -m "refactor(functions): clockOut uses shared transactional writer"
```

---

### Task 4: `adminClockOut` callable

**Files:**
- Modify: `functions/index.js` (add after `clockOut`)

- [ ] **Step 1: Add the callable**

```js
// ---------------------------------------------------------------------------
// Admin-only: stops another user's running clock. The shift is saved as a
// normal pending entry ending now, tagged stoppedByAdmin. Shares writeClockOut
// with clockOut so cap behaviour is identical (extendedTime is never applied).
// ---------------------------------------------------------------------------

exports.adminClockOut = onCall({ cors: ALLOWED_ORIGINS }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const caller = await getUserDoc(request.auth.uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }

  const data = request.data || {};
  const targetUid = typeof data.targetUid === 'string' ? data.targetUid.trim() : '';
  if (!targetUid) {
    throw new HttpsError('invalid-argument', 'A target user id is required.');
  }
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (reason.length < 3 || reason.length > 2000) {
    throw new HttpsError('invalid-argument', 'Please give a reason (3–2000 characters).');
  }

  const target = await getUserDoc(targetUid);
  const callerName = `${caller.firstName || ''} ${caller.lastName || ''}`.trim() || caller.email || 'admin';
  const punchRef = db.collection('activePunches').doc(targetUid);

  const result = await db.runTransaction(async (tx) => {
    const punchSnap = await tx.get(punchRef);
    if (!punchSnap.exists) {
      throw new HttpsError('failed-precondition', 'That user is not clocked in.', { code: 'NOT_CLOCKED_IN' });
    }
    const punch = punchSnap.data();
    const now = new Date();

    // Under the 1-minute minimum: clear the punch, log nothing.
    if (now.getTime() - punch.clockInAt.toDate().getTime() < 60 * 1000) {
      tx.delete(punchRef);
      return { discarded: true, hours: 0, entryId: null, extraEntryId: null, capped: false };
    }

    const written = writeClockOut(tx, {
      punchRef, punch, user: target, now,
      notes: `[Stopped by admin ${callerName}] ${reason}`,
      extendedTime: false,
      extraFields: {
        stoppedByAdmin: true,
        stoppedByUid: request.auth.uid,
        stoppedByName: callerName,
        stoppedAt: admin.firestore.Timestamp.fromDate(now)
      },
      // No client payload: clock-out timezone falls back to the punch's.
      data: {}
    });
    return { discarded: false, ...written };
  });

  await logAdminAction({
    action: 'adminClockOut',
    callerUid: request.auth.uid,
    callerEmail: caller.email || null,
    targetUid,
    targetEmail: target.email || null,
    hours: result.hours,
    entryId: result.entryId,
    extraEntryId: result.extraEntryId,
    discarded: result.discarded,
    reason
  });

  return {
    ok: true,
    discarded: result.discarded,
    hours: result.hours,
    entryId: result.entryId,
    capped: result.capped
  };
});
```

- [ ] **Step 2: Verify**

Run: `cd functions && node --check index.js && node --test test/`
Expected: no error; all PASS.
Run: `cd functions && node -e "process.env.GCLOUD_PROJECT='x'; const m=require('./index.js'); console.log(Object.keys(m))"`
Expected: printed keys include `clockIn`, `clockOut`, `adminClockOut`, `adminGeneratePasswordResetLink` (if `admin.initializeApp` errors without credentials, skip this check and note it).

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "feat(functions): adminClockOut callable to stop a user's clock"
```

---

### Task 5: Frontend shared pieces — `formatElapsed`, `StoppedByAdminBadge`

**Files:**
- Modify: `index.html` (module helpers near `ExtraTimeBadge` ~line 1497; `ClockInOut` ~line 2452; four badge render sites)

- [ ] **Step 1: Lift `formatElapsed` to module scope.** Cut the `const formatElapsed = (ms) => {...}` block out of `ClockInOut` (~line 2452) and paste it unchanged directly above `const ExtraTimeBadge`. `ClockInOut` keeps calling `formatElapsed(...)` — now resolving to the module-level one.

- [ ] **Step 2: Add the badge** directly below `ExtraTimeBadge`:

```jsx
        const StoppedByAdminBadge = () => (
            <span style={{ marginLeft: '0.5rem', padding: '2px 8px', borderRadius: '999px', background: 'var(--danger-light, #fee2e2)', color: 'var(--danger, #b91c1c)', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.5px' }}>STOPPED BY ADMIN</span>
        );
```

- [ ] **Step 3: Render it next to every `ExtraTimeBadge`.** Run `grep -n "{entry.isExtraTime && <ExtraTimeBadge />}" index.html` (expected 4 hits, ~2190, ~3150, ~3960, ~4380). After each, add on the next line with matching indentation:

```jsx
{entry.stoppedByAdmin && <StoppedByAdminBadge />}
```

- [ ] **Step 4: Verify JSX still compiles.** Extract and compile the Babel script:

```bash
cd /Users/joao_project/Documents/PROJECTS/timetracker
SCRATCH=$(mktemp -d)
awk '/<script type="text\/babel"/{f=1;next} /<\/script>/{if(f){f=0}} f' index.html > "$SCRATCH/app.jsx"
npx --yes @babel/cli@7.26.4 --presets @babel/preset-react "$SCRATCH/app.jsx" -o "$SCRATCH/out.js" 2>&1 | tail -5 || \
  (cd "$SCRATCH" && npm i --silent @babel/core@7.26.0 @babel/preset-react@7.26.3 && node -e "require('@babel/core').transformFileSync('app.jsx',{presets:['@babel/preset-react']});console.log('OK')")
```

Expected: no syntax errors (prints `OK` or completes silently). Use this same check after every `index.html` task.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(ui): shared formatElapsed and Stopped-by-admin badge"
```

---

### Task 6: `AdminStopModal` + `LiveNow` page + sidebar/route

**Files:**
- Modify: `index.html` — new components placed just before the `// ADMIN LOG TIME FOR USERS COMPONENT` banner; sidebar `adminNavItems` (~line 1828); route block in `App` (~line 5040).

- [ ] **Step 1: Add `AdminStopModal`**

```jsx
        // ============================================
        // ADMIN STOP CLOCK MODAL
        // ============================================
        const AdminStopModal = ({ punch, elapsedText, onCancel, onConfirm, loading, error }) => {
            const [reason, setReason] = useState('');
            const canConfirm = reason.trim().length >= 3 && !loading;

            return (
                <div className="modal-overlay" style={{ zIndex: 10000 }}>
                    <div className="modal" style={{ maxWidth: '500px' }}>
                        <div className="modal-header">
                            <h2 className="modal-title">Stop {punch.userName || punch.userEmail}'s clock</h2>
                            <button className="close-btn" onClick={onCancel} disabled={loading}>
                                <Icon name="x" size={20} />
                            </button>
                        </div>

                        <p style={{ marginBottom: '1rem', color: 'var(--text-light)' }}>
                            Running for <strong>{elapsedText}</strong>. The shift will be saved as a pending entry ending now.
                        </p>

                        {error && (
                            <div className="alert error">
                                <Icon name="alertCircle" size={20} />
                                {error}
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label">Reason</label>
                            <textarea
                                className="form-input"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="e.g. Forgot to clock out"
                                maxLength={2000}
                                rows={4}
                                disabled={loading}
                                autoFocus
                                style={{ resize: 'vertical', minHeight: '100px' }}
                            />
                        </div>

                        <div className="modal-actions">
                            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={loading} style={{ flex: 1 }}>
                                Cancel
                            </button>
                            <button type="button" className="btn btn-danger" onClick={() => onConfirm(reason.trim())} disabled={!canConfirm} style={{ flex: 1 }}>
                                {loading ? (
                                    <><div className="spinner"></div>Stopping...</>
                                ) : (
                                    <><Icon name="clock" size={18} />Stop Clock</>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            );
        };
```

- [ ] **Step 2: Add `LiveNow`**

```jsx
        // ============================================
        // ADMIN LIVE NOW COMPONENT
        // ============================================
        const LIVE_LONG_SHIFT_HOURS = 10;

        const LiveNow = () => {
            const [punches, setPunches] = useState([]);
            const [usersById, setUsersById] = useState({});
            const [loading, setLoading] = useState(true);
            const [currentTime, setCurrentTime] = useState(new Date());
            const [stopTarget, setStopTarget] = useState(null);
            const [stopLoading, setStopLoading] = useState(false);
            const [stopError, setStopError] = useState('');
            const [message, setMessage] = useState(null);

            useEffect(() => {
                const timer = setInterval(() => setCurrentTime(new Date()), 1000);
                return () => clearInterval(timer);
            }, []);

            useEffect(() => {
                const unsubPunches = db.collection('activePunches').onSnapshot(snapshot => {
                    setPunches(snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() })));
                    setLoading(false);
                }, err => {
                    console.error('activePunches listener error:', err);
                    setLoading(false);
                });
                const unsubUsers = db.collection('users').onSnapshot(snapshot => {
                    const map = {};
                    snapshot.docs.forEach(doc => { map[doc.id] = doc.data(); });
                    setUsersById(map);
                });
                return () => { unsubPunches(); unsubUsers(); };
            }, []);

            const clockInMs = (p) => toDateOrNull(p.clockInAt)?.getTime() ?? currentTime.getTime();
            const sorted = [...punches].sort((a, b) => clockInMs(a) - clockInMs(b));

            // Past today's scheduled end (if the user has one) or a long-shift fallback.
            const isOverdue = (p) => {
                const u = usersById[p.uid];
                const anchor = p.clockInDate ? new Date(p.clockInDate + 'T00:00:00') : currentTime;
                const shift = u && u.schedule ? getScheduleForToday(u.schedule, anchor) : null;
                if (shift) {
                    const nowDecimal = currentTime.getHours() + currentTime.getMinutes() / 60;
                    const sameDay = p.clockInDate === currentTime.toLocaleDateString('en-CA');
                    return !sameDay || nowDecimal > timeToDecimal(shift.end);
                }
                return currentTime.getTime() - clockInMs(p) > LIVE_LONG_SHIFT_HOURS * 3600 * 1000;
            };

            const handleStop = async (reason) => {
                if (!stopTarget || stopLoading) return;
                const name = stopTarget.userName || stopTarget.userEmail;
                setStopLoading(true);
                setStopError('');
                try {
                    const fn = functions.httpsCallable('adminClockOut');
                    const result = (await fn({ targetUid: stopTarget.uid, reason })).data;
                    setMessage({
                        type: 'success',
                        text: result.discarded
                            ? `Stopped ${name} — shift under 1 minute, nothing logged.`
                            : `Stopped ${name} — ${formatHoursWorked(result.hours)} logged (pending approval).`
                    });
                    setStopTarget(null);
                } catch (err) {
                    const detailCode = err && err.details && err.details.code;
                    if (detailCode === 'NOT_CLOCKED_IN') {
                        setMessage({ type: 'info', text: `${name} already clocked out.` });
                        setStopTarget(null);
                    } else {
                        console.error('adminClockOut failed:', err);
                        setStopError(err && err.message ? err.message : 'Failed to stop clock. Please try again.');
                    }
                } finally {
                    setStopLoading(false);
                }
            };

            return (
                <div className="main-content">
                    <div className="main-header">
                        <h1>Live Now</h1>
                        <p>Everyone currently clocked in, updating in real time</p>
                    </div>

                    <div className="main-body">
                        {message && (
                            <div className={`alert ${message.type}`} style={{ marginBottom: '1rem' }}>
                                <Icon name={message.type === 'success' ? 'checkCircle' : 'info'} size={20} />
                                {message.text}
                            </div>
                        )}

                        <div className="content-card">
                            {loading ? (
                                <div style={{ padding: '2rem', textAlign: 'center' }}><div className="spinner"></div></div>
                            ) : sorted.length === 0 ? (
                                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-light)' }}>
                                    No one is clocked in right now.
                                </div>
                            ) : (
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th>Employee</th>
                                            <th>Clocked in</th>
                                            <th>Elapsed</th>
                                            <th>Plan</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {sorted.map(p => {
                                            const inDate = toDateOrNull(p.clockInAt);
                                            const overdue = isOverdue(p);
                                            const localZone = p.clockInTimeZone;
                                            return (
                                                <tr key={p.uid} style={overdue ? { background: 'var(--warning-light, #fef3c7)' } : undefined}>
                                                    <td>
                                                        <div style={{ fontWeight: '600' }}>{p.userName || p.userEmail}</div>
                                                        <div style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>{p.userEmail}</div>
                                                    </td>
                                                    <td>
                                                        {inDate ? (
                                                            <>
                                                                <div>{formatInZone(inDate, OFFICE_TZ_DISPLAY)} CT</div>
                                                                {localZone && localZone !== OFFICE_TZ_DISPLAY && (
                                                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>
                                                                        {formatInZone(inDate, localZone)} {zoneLabel(localZone)}
                                                                    </div>
                                                                )}
                                                            </>
                                                        ) : '—'}
                                                    </td>
                                                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                                                        {formatElapsed(currentTime.getTime() - clockInMs(p))}
                                                        {overdue && (
                                                            <div style={{ fontSize: '0.75rem', color: 'var(--warning, #b45309)', fontWeight: 600 }}>Past scheduled end</div>
                                                        )}
                                                    </td>
                                                    <td style={{ maxWidth: '280px' }}>
                                                        <div title={p.plan || ''} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                            {p.plan || '—'}
                                                        </div>
                                                    </td>
                                                    <td>
                                                        <button
                                                            type="button"
                                                            className="btn btn-danger"
                                                            onClick={() => { setMessage(null); setStopError(''); setStopTarget(p); }}
                                                        >
                                                            Stop
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>

                    {stopTarget && (
                        <AdminStopModal
                            punch={stopTarget}
                            elapsedText={formatElapsed(currentTime.getTime() - clockInMs(stopTarget))}
                            loading={stopLoading}
                            error={stopError}
                            onCancel={() => { if (!stopLoading) { setStopTarget(null); setStopError(''); } }}
                            onConfirm={handleStop}
                        />
                    )}
                </div>
            );
        };
```

Before relying on them, confirm these module-level names exist with `grep -n "const toDateOrNull\|const formatInZone\|const zoneLabel\|const OFFICE_TZ_DISPLAY\|const getScheduleForToday\|const timeToDecimal = (timeString)\|const formatHoursWorked" index.html` — all 7 must be at module scope (indentation of 8 spaces). If any is missing, stop and report.

- [ ] **Step 3: Sidebar entry with live count.** In `Sidebar`, add to `adminNavItems` right after `dashboard`:

```js
                { id: 'live-now', label: 'Live Now', icon: 'clock' },
```

Add a live count inside `Sidebar` (above `const navItems = ...`):

```js
            const [liveCount, setLiveCount] = useState(0);
            useEffect(() => {
                if (currentUser.role !== 'admin') return;
                const unsub = db.collection('activePunches').onSnapshot(
                    snap => setLiveCount(snap.size),
                    err => console.error('liveCount listener error:', err)
                );
                return () => unsub();
            }, [currentUser.role]);
```

And in the nav item render, after `<span>{item.label}</span>`:

```jsx
                                    {item.id === 'live-now' && liveCount > 0 && (
                                        <span style={{ marginLeft: 'auto', minWidth: '22px', padding: '0 6px', borderRadius: '999px', background: 'var(--success, #16a34a)', color: '#fff', fontSize: '0.75rem', fontWeight: 700, textAlign: 'center' }}>{liveCount}</span>
                                    )}
```

- [ ] **Step 4: Route.** In `App`, after the `approve-time` route block, add:

```jsx
                    {currentPage === 'live-now' && currentUser.role === 'admin' && (
                        <LiveNow />
                    )}
```

- [ ] **Step 5: Verify** — run the Babel compile check from Task 5 Step 4. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(ui): admin Live Now page with live timers and stop"
```

---

### Task 7: Employee notice when an admin stops their shift

**Files:**
- Modify: `index.html` — `ClockInOut` (~lines 2380–2560)

- [ ] **Step 1: Track self-initiated clock-outs and the previous punch.** Near the other `useState`s in `ClockInOut` add:

```js
            const selfClockOutRef = useRef(false);
            const hadPunchRef = useRef(false);
```

Confirm `useRef` is destructured from React at the top of the script (`grep -n "useRef" index.html | head -3`); if not, add it to the existing `const { useState, useEffect, ... } = React;` line.

- [ ] **Step 2: Replace the `activePunches` listener effect** (the one calling `setActivePunch(doc.exists ? doc.data() : null)`) with:

```js
            useEffect(() => {
                const unsub = db.collection('activePunches').doc(currentUser.uid)
                    .onSnapshot(doc => {
                        const present = doc.exists;
                        // Punch vanished without this tab clocking out → an admin stopped it.
                        if (hadPunchRef.current && !present && !selfClockOutRef.current) {
                            setShowClockOutModal(false);
                            setClockOutError('');
                            setPunchMessage({ type: 'info', text: 'Your shift was stopped by an admin.' });
                        }
                        hadPunchRef.current = present;
                        setActivePunch(present ? doc.data() : null);
                    }, err => {
                        console.error('activePunch listener error:', err);
                    });
                return () => unsub();
            }, [currentUser.uid]);
```

- [ ] **Step 3: Mark self clock-outs and handle the race in `handleClockOut`.** Set the flag before the call and clear it in `finally`; map `NOT_CLOCKED_IN`:

```js
            const handleClockOut = async (extendedTime = false, notes = '') => {
                if (punchLoading || !activePunch) return;
                setPunchLoading(true);
                setClockOutError('');
                selfClockOutRef.current = true;
                try {
                    const result = await runPunchCall('clockOut', { extendedTime, notes });
                    let text;
                    if (result && result.extraLogged) {
                        text = `Clocked out. Logged your shift plus extra time — both pending review.`;
                    } else if (result && result.capped) {
                        text = `Clocked out at your scheduled end time. If you worked past that, use Extended Time next time.`;
                    } else {
                        const hoursStr = result && typeof result.hours === 'number' ? formatHoursWorked(result.hours) : 'your shift';
                        text = `Clocked out. Logged ${hoursStr} for review.`;
                    }
                    setPunchMessage({ type: 'success', text });
                    setShowClockOutModal(false);
                } catch (err) {
                    console.error('Clock out failed:', err);
                    if (err.detailCode === 'NOT_CLOCKED_IN') {
                        setShowClockOutModal(false);
                        setPunchMessage({ type: 'info', text: 'Your shift was already stopped by an admin.' });
                    } else {
                        // Error renders inside the modal so the typed note is preserved.
                        setClockOutError(err.userMessage || 'Failed to clock out. Please try again.');
                    }
                } finally {
                    selfClockOutRef.current = false;
                    setPunchLoading(false);
                }
            };
```

Ordering note: the snapshot for the user's own successful clock-out arrives while `selfClockOutRef.current` is still true (the callable resolves after the commit), so no false "stopped by admin" notice. If testing shows the snapshot can land after `finally`, defer the reset: `setTimeout(() => { selfClockOutRef.current = false; }, 3000)`.

- [ ] **Step 4: Fix the punch message icon** so `info` doesn't show the warning glyph. In the `punchMessage` render, change the icon expression to:

```jsx
<Icon name={punchMessage.type === 'success' ? 'checkCircle' : punchMessage.type === 'info' ? 'info' : 'alertCircle'} size={20} />
```

- [ ] **Step 5: Verify** — Babel compile check (Task 5 Step 4). Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(ui): notify employee when an admin stops their shift"
```

---

### Task 8: End-to-end verification (requires user go-ahead to deploy)

Deploying functions is outward-facing — **ask the user before running any deploy**. There is no emulator config in `firebase.json`.

- [ ] **Step 1:** Unit tests: `cd functions && node --test test/` → all PASS. Record output.
- [ ] **Step 2:** With user approval: `firebase deploy --only functions:clockOut,functions:adminClockOut`. Serve the UI locally (`npx serve .` or Live Server on localhost — allowed origin).
- [ ] **Step 3:** Manual checks (two browsers: admin + test employee):
  1. Employee clocks in → admin's Live Now shows the row within ~1s, timer ticks, sidebar badge = 1.
  2. Admin Stop with reason "test stop" → row disappears; success toast with hours; employee page flips to Not Clocked In and shows "Your shift was stopped by an admin."
  3. Approve Time shows the new pending entry with STOPPED BY ADMIN badge and notes `[Stopped by admin <name>] test stop`.
  4. Stop within 1 minute of clock-in → "nothing logged" toast; no entry created.
  5. Employee opens Clock Out modal, admin stops → modal closes, notice shown.
  6. Employee with cap enabled, past scheduled end → admin stop entry is clamped (`capped: true`).
  7. Normal employee clock-out (regular / capped / extended) still produces the same entries as before.
  8. Non-admin calling `adminClockOut` from devtools → `permission-denied`.
  9. `adminAuditLogs` has an `adminClockOut` doc.
- [ ] **Step 4:** Report results per check (pass/fail with what was observed).
