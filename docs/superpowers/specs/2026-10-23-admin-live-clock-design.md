# Admin Live Clock View + Admin Stop — Design

Date: 2026-10-23
Status: Approved (pending spec review)

## Goal

Admins can see, in real time, every user who is currently clocked in (with a live
running timer) and can stop any user's clock. A stopped shift is saved as a normal
pending time entry ending at the moment the admin pressed Stop.

## Decisions

- Stopped shift is **saved** as a pending `timeEntries` doc (not discarded).
- End time is **always "now"** (server time when the callable runs). Admins correct
  hours during approval if needed.
- Stop goes through a new **Cloud Function** (`adminClockOut`), not client writes —
  single source of truth for hours/cap math, atomic, audited.

## Existing state relied on

- `activePunches/{uid}` exists while a user is clocked in: `userId`, `userEmail`,
  `userName`, `clockInAt` (Timestamp), `clockInDate`, `plan`, location fields.
- Firestore rules already allow admins to read `activePunches`. **No rule changes.**
- `clockOut` (functions/index.js) builds the entry: cap clamp / extra-time split,
  `timeEntries` write + punch delete in one batch.
- `logAdminAction` + `adminAuditLogs` exist (currently uncommitted with the
  password-reset work — commit that first).

## 1. Backend — `functions/index.js`

### Shared helper

Extract the entry-building + commit portion of `clockOut` into
`finalizePunch({ punchRef, punch, user, now, notes, extendedTime, extraFields, rawData })`
returning `{ hours, entryId, extraEntryId, capped, extraLogged }`.

- Contains: elapsed/hours computation, tz decimals, schedule cap logic,
  entry creation (normal / capped / split), `delete(punchRef)`.
- Accepts an optional Firestore `transaction`; when provided, writes go through it
  instead of a batch.
- `clockOut` is refactored to call it with **no behaviour change** (same validation,
  same return shape).

### New callable `adminClockOut({ targetUid, reason })`

1. `unauthenticated` if no auth. Load caller via `getUserDoc`; `permission-denied`
   unless `role === 'admin'`.
2. `targetUid` must be a non-empty string → else `invalid-argument`.
3. `reason` trimmed, 3–2000 chars → else `invalid-argument`.
4. Load target user via `getUserDoc(targetUid)` (needed for schedule cap).
5. In a **transaction**: read `activePunches/{targetUid}`.
   - Missing → `failed-precondition`, `details.code = 'NOT_CLOCKED_IN'`
     (covers the race where the user clocked out first).
   - Elapsed < 1 minute → delete the punch, log nothing, return
     `{ ok: true, discarded: true }`.
   - Otherwise call `finalizePunch` with:
     - `notes: "[Stopped by admin <callerName>] <reason>"`
     - `extendedTime: false` (cap applies exactly like a normal clock-out)
     - `extraFields: { stoppedByAdmin: true, stoppedByUid, stoppedByName, stoppedAt }`
     - entry `status: 'pending'`, `source: 'clock'`.
   - Location/audit fields from `entryAuditFields`: clock-out side recorded as
     admin-stopped (no client coords); clock-in side copied from the punch as today.
6. After commit: `logAdminAction({ action: 'adminClockOut', callerUid, callerEmail,
   targetUid, targetEmail, hours, entryId, discarded })`.
7. Return `{ ok: true, hours, entryId, extraEntryId, capped, discarded: false }`.

## 2. Admin UI — new "Live Now" page (`index.html`)

- Sidebar: add `{ id: 'live-now', label: 'Live Now', icon: <existing clock-ish icon> }`
  to the admin nav (next to Users / Approve Time), with a count badge of active punches.
- Route: `currentPage === 'live-now' && currentUser.role === 'admin'` → `<LiveNow />`.
- `LiveNow` component:
  - `onSnapshot` on `db.collection('activePunches')`, ordered client-side by
    `clockInAt` ascending (longest-running first).
  - 1-second `setInterval` ticker (same pattern as `ClockInOut`) driving elapsed
    display; reuse/lift `formatElapsed` to module scope so both components share it.
  - Table (`data-table`): Name · Clocked in at (local time + CT, using existing
    time-display helpers) · Elapsed (live `HH:MM:SS`) · Plan (truncated, expandable) · **Stop**.
  - Row highlight when elapsed exceeds the user's scheduled end for today
    (if schedule exists) or 10 hours otherwise — visual hint for forgotten clock-outs.
  - Empty state: "No one is clocked in right now."
- Stop dialog (in-app modal, no `window.confirm`):
  - Shows name and current elapsed; required "Reason" textarea (3–2000 chars,
    button disabled until valid).
  - Calls `functions.httpsCallable('adminClockOut')({ targetUid, reason })`.
  - Success → toast "Stopped <name> — <h.hh> h logged (pending approval)"
    (or "Shift under 1 minute — discarded"). Row disappears via the listener.
  - `NOT_CLOCKED_IN` → toast "<name> already clocked out." and close.
  - Other errors → inline error in the modal; modal stays open.

## 3. Employee side

- `ClockInOut` already listens to its own `activePunches` doc, so the page flips to
  clocked-out automatically when an admin stops it.
- When an admin stops the clock, show a one-time notice: "Your shift was stopped
  by <admin name>." Detected via a server marker: `adminClockOut` writes
  `users/{uid}.lastAdminStop = { at, byName }` in the same transaction (only if
  the profile exists); `ClockInOut`'s own users-doc listener shows the notice when
  `lastAdminStop.at` becomes newer than the value seen on its first snapshot.
- If the user submits their clock-out modal after the punch is gone, `clockOut`
  returns `NOT_CLOCKED_IN`; show the neutral "You are already clocked out." and
  close the modal (the marker listener supplies the admin notice when applicable).

## 4. Approve Time / entry display

- Entries with `stoppedByAdmin: true` show a small "Stopped by admin" badge
  (styled like `ExtraTimeBadge`) wherever entries are listed for admins.

## Error handling summary

| Case | Result |
|---|---|
| Non-admin calls `adminClockOut` | `permission-denied` |
| Target not clocked in / race | `NOT_CLOCKED_IN`, UI toast |
| Shift < 1 min | punch deleted, nothing logged, `discarded: true` |
| Audit log write fails | logged to console, action still succeeds |

## Testing / verification

- Functions: exercise `adminClockOut` (emulator or deployed test project):
  admin happy path, non-admin denied, not-clocked-in, <1 min discard, cap clamp
  applied, concurrent user `clockOut` + admin stop → exactly one entry.
- Regression: user `clockOut` (normal, capped, extended split) produces identical
  entries to before the refactor.
- UI: Live Now updates within ~1s of a clock-in/out in another browser; timer ticks;
  stop flow end-to-end; employee page flips and shows notice.

## Out of scope

- Admin-chosen end time (decided: always "now").
- Push/email notifications to the employee.
- Admin starting someone's clock.
