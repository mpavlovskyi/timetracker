# Clock-Out Notes + Admin Weekly Notes Calendar — Design

**Date:** 2026-07-02
**Status:** Approved design, pending implementation

## Goal

1. Require every employee to write a short note describing what they did that day
   before their clock-out is accepted. Notes are stored in Firestore so admins can
   review them.
2. Give admins a weekly calendar board on each user's detail page showing the
   note(s) for each day of the week.

## Feature 1: Required clock-out notes

### UX flow

- Clicking **Clock Out** no longer clocks the user out directly. It opens a modal
  (`ClockOutNotesModal`) with a `<textarea>` prompting: "What did you work on today?"
- The **Confirm Clock Out** button is disabled until the trimmed note is at least
  3 characters. A character counter shows current length (max 2,000).
- **Cancel** closes the modal; the user stays clocked in.
- On confirm, the client calls the existing `runPunchCall('clockOut', { extendedTime, notes })`.
  Loading and error states render inside the modal so a failed call does not lose
  the typed note.
- The modal reuses the existing `.modal-overlay` / `.modal` / `.form-group` /
  `.form-input` CSS and follows the `PasswordChangeModal` component pattern
  (`index.html:1595`).

### Server enforcement (`functions/index.js`, `clockOut` callable)

- At the top of the handler, validate `notes`:
  - must be a string;
  - trimmed length ≥ 3 and ≤ 2,000;
  - otherwise throw `HttpsError('invalid-argument', 'Please describe what you did today before clocking out.')`.
- The trimmed note is stored as a `notes` field on the `timeEntries` document(s)
  written by the batch. When a capped/extended shift produces two entries, **both
  entries get the same note**.
- Enforcement must live in the Cloud Function because it writes via the Admin SDK,
  which bypasses Firestore security rules. The UI gate alone is not sufficient.

### Data model

- `timeEntries` documents gain an optional string field `notes`.
- Existing documents have no `notes` field; all display code treats a missing
  field as blank. No migration.
- Admin-created manual entries are unaffected (notes optional there).

### Edge cases

- Old cached clients or direct callable invocations without notes are rejected by
  the server with a clear error message.
- Shifts under 1 minute are still rejected before notes validation matters
  (existing behavior preserved).
- If an automatic clock-out is ever added (the rules reserve `autoClockOut`), that
  path should write a fixed placeholder such as "Auto clock-out — no notes".
  Out of scope now; noted as a seam.

### Rollout

Deploy the client UI and the updated Cloud Function together (or client first).
Once the function enforces notes, clients without the modal cannot clock out.

## Feature 2: Admin weekly notes calendar

### Location

Inside `UserDetailView` (`index.html:3259`) — the admin page shown when clicking a
user. This component already:

- subscribes live to all of that user's `timeEntries`;
- holds `currentWeek` state (Monday-start, via `getCurrentWeek()` at `index.html:1255`)
  with existing prev/next week navigation.

The calendar consumes the already-loaded entries — **no new Firestore queries**.

### UI

- A new card, "Daily Notes", rendered above the existing weekly entries table,
  controlled by the same week navigation.
- A 7-column grid, Monday through Sunday. Each day cell shows:
  - day name + date (e.g. "Mon 6/29");
  - the note text from each time entry on that date. Multiple entries on one day
    each show their note, prefixed with the entry's start–end time so admins can
    tell punches apart. Duplicate notes from a split (capped/extended) shift on
    the same date are shown once;
  - a muted "No notes" placeholder for days with entries but no notes (legacy
    entries), and an empty/muted cell for days with no entries;
  - the current day highlighted, consistent with existing styles.
- Long notes are clamped to a few lines with expand-on-click.
- Responsive: the grid collapses to fewer columns / stacked days on narrow
  screens, matching the app's existing responsive approach.

### Notes elsewhere in the UI

- The main time-entries table (`index.html:2071`) shows a truncated note snippet
  (full text on click) rather than a new wide column.
- The admin edit modal in `UserDetailView` may display the note read-only;
  editing notes is out of scope for this iteration.

### Access control

- No `firestore.rules` changes needed: admins already have full read access to
  `timeEntries`, and notes ride along on those documents. Regular users can read
  their own entries (and therefore their own notes), which is acceptable.

## Testing / verification

- Cloud Function unit checks (or manual invocation): clock-out rejected with
  missing / empty / whitespace / 2-char notes; accepted with valid note; note
  present on written entry docs, including the two-doc capped path.
- UI: confirm button disabled state, cancel keeps active punch, error inside
  modal preserves note text.
- Calendar: entries appear under the correct Monday-start day; multiple punches
  in one day; week navigation; legacy entries without notes.
- End-to-end: clock in → clock out with note → note visible in admin
  `UserDetailView` calendar for that day.

## Out of scope

- Editing notes after clock-out.
- Notes on admin manual entries.
- Automatic clock-out behavior.
- Notifications/digests of notes.
