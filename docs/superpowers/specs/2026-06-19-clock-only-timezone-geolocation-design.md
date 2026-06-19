# Clock-Only Punching, Per-Event Timezone Display & Geolocation

**Date:** 2026-06-19
**Author:** joao (via Claude Code)
**Status:** Approved design — pending implementation plan

## Background

The time tracker currently supports two ways to record hours:

1. **Live clock in/out** (`ClockInOut` → `clockIn`/`clockOut` Cloud Functions), gated by an
   office-location check (`locationCheck()` enforces an office-IP allowlist **and** a GPS
   radius around `OFFICE_LAT/LNG`).
2. **Manual hour logging** — a `TimeClock` form for regular users and an `AdminLogTime` form
   for admins, where start/end times are typed in.

All displayed clock times are rendered in the office timezone (`OFFICE_TIMEZONE`, default
`America/Chicago`). A teammate clocking in from Iraq sees their times silently converted to
Central Time, with no indication of their actual local time, and the office gate blocks them
from clocking in at all.

This change set, requested by the supervisor, does four things:

1. Remove manual hour logging for regular users — clock in/out only.
2. Remove the office-location requirement so staff can clock in from anywhere.
3. Show each clock event in the user's **local** time, with **CT** alongside.
4. Record the **country and city** a user clocked in from, when available.

## Goals

- Regular users can record time **only** via clock in/out.
- Clocking in/out succeeds from any location, any network.
- Every clock event displays local time prominently with CT as a secondary label.
- Each shift records the country/city it was logged from, when location is granted.
- Admins retain their existing "Log Time for Users" and edit capabilities unchanged.

## Non-Goals

- Admins are **not** given a personal clock in/out widget (they keep log-for-users + edit only).
- No change to how total **hours/durations** are computed (already timezone-independent).
- No per-user "home timezone" setting — zone is auto-detected per clock event.
- No backfill of timezone/location data onto historical entries (graceful fallback instead).
- No reverse-geocoding provider with a billed API key (BigDataCloud free endpoint only).

## Decisions (confirmed with user)

| Decision | Choice |
| --- | --- |
| Manual logging | Removed for users; admins keep **log + edit** |
| Office-location gate | **Removed**; GPS still collected but optional/non-blocking |
| Timezone display | **Auto-detect per clock event**; show local + CT |
| Country/city source | **GPS reverse-geocode** |
| Geocoding provider | **BigDataCloud** free client-side endpoint (no API key) |
| Admin clock in/out | **No** — admins unchanged |

## Design

### 1. Remove manual logging for regular users

- Remove the `{ id: 'clock', label: 'Log Time', icon: 'edit' }` entry from `userNavItems`
  (`index.html:1685`).
- In the page router (`index.html:4546`), the `currentPage === 'clock'` branch keeps rendering
  `AdminLogTime` for admins, but no longer renders `TimeClock` for users.
- Delete the now-unused `TimeClock` component (`index.html:2330`–~`2505`) to keep the file clean.
- Users are left with `dashboard`, `punch` (Clock In/Out), `profile`, and `schedule` nav items.
- Admin nav (`adminNavItems`) and `AdminLogTime` are untouched.

### 2. Remove the office-location requirement

- In `functions/index.js`, `clockIn` and `clockOut` currently `await locationCheck(...)`, which
  throws `LOCATION_REQUIRED` / `LOCATION_OUTSIDE_RADIUS`. **Remove these gate calls** so clock
  in/out always proceeds regardless of IP or distance.
- `locationCheck()` and the office config (`OFFICE_PUBLIC_IPS`, `OFFICE_LAT`, `OFFICE_LNG`) are
  no longer used for gating. Retain `OFFICE_TIMEZONE` (still needed for the CT label).
  The office geo constants/helpers can be left in place (harmless, possibly useful later) but the
  gating call sites are removed; the implementation plan will decide whether to delete the now-dead
  `locationCheck` body.
- Client side: `runLocationGatedCall` (`index.html:2155`) still attempts to fetch GPS coords, but
  a denial or failure is **non-blocking** — the callable is invoked either way. Coords are now
  collected purely to support geolocation display (#4), not gating.
- Remove the office-specific error messaging (`LOCATION_REQUIRED` / `LOCATION_OUTSIDE_RADIUS`
  branches in `index.html:2172`–`2179`), since those errors can no longer occur. Rename
  `runLocationGatedCall` to something accurate (e.g. `runPunchCall`).

### 3. Local time + CT side-by-side (auto-detect per event)

**Capture.** At clock in and clock out, the browser sends:

- `clientTimeZone` — IANA zone from `Intl.DateTimeFormat().resolvedOptions().timeZone`
  (e.g. `"Asia/Baghdad"`).

**Store.** The server already records `clockInAt` (UTC `Timestamp`) on `activePunches`. Extend the
data model so the final `timeEntry` written at clock-out carries enough to render either zone:

- `clockInAt` — UTC `Timestamp` (carried over from the punch)
- `clockOutAt` — UTC `Timestamp` (the clock-out instant)
- `clockInTimeZone` — IANA zone captured at clock in
- `clockOutTimeZone` — IANA zone captured at clock out (usually identical)

The existing `startTime` / `endTime` **CT decimals** and `hours` are **kept** for backward
compatibility and for any logic that already reads them.

**Display.** A shared helper formats a UTC instant in a given IANA zone:

```
formatInZone(utcInstant, ianaZone) -> "3:00 PM"   // via Intl.DateTimeFormat with timeZone
```

Each clock time renders as **local prominent, CT muted**, e.g.:

> **3:00 PM** Baghdad · 7:00 AM CT

A short zone label (city/abbreviation derived from the IANA zone) accompanies the local time.
This applies to the views that show clock times: the user dashboard/entries
(`index.html:2037`–`2038`) and the admin review/approve panels
(`index.html:2978`, `:3591`, `:3913`).

**Fallback.** Legacy entries (and admin-created/manual entries) without `clockInAt`/`clockOutAt`
or without a stored zone fall back to the current CT-decimal display via `formatTimeDisplay`. The
display helper detects which data is present and chooses accordingly, so no historical entry breaks.

### 4. Country / city via GPS reverse-geocode (BigDataCloud)

- When GPS coords are obtained at clock in, the client calls BigDataCloud's free
  client-side reverse-geocoding endpoint to resolve **country** and **city**
  (e.g. `countryName`, `city` / `locality`, `principalSubdivision`).
- The resolved `country` and `city` strings (and optionally the raw coords already sent) are
  passed to `clockIn` and stored on the punch, then carried onto the final `timeEntry`:
  - `clockInCountry`, `clockInCity`
- If location is denied, the lookup fails, or the network call errors, these fields are simply
  omitted — clock-in still succeeds and the UI shows no location chip for that entry.
- Display: a small location chip (e.g. *"Iraq · Baghdad"*) shown alongside the shift in the user
  and admin entry views, only when present.
- Provider note: BigDataCloud's client-side endpoint requires no API key and is CORS-enabled.
  A single lookup happens per clock-in (not clock-out).

## Data Model Changes

`timeEntries` documents gain (all optional / additive — no migration of existing docs):

| Field | Type | Source |
| --- | --- | --- |
| `clockInAt` | UTC Timestamp | carried from `activePunches` |
| `clockOutAt` | UTC Timestamp | clock-out instant |
| `clockInTimeZone` | string (IANA) | client at clock in |
| `clockOutTimeZone` | string (IANA) | client at clock out |
| `clockInCountry` | string | BigDataCloud reverse-geocode |
| `clockInCity` | string | BigDataCloud reverse-geocode |

`activePunches` documents gain `clockInTimeZone`, `clockInCountry`, `clockInCity` so they survive
until clock-out, when they are copied to the `timeEntry`.

Existing fields (`date`, `startTime`, `endTime`, `hours`, `status`, etc.) are unchanged.

## Error Handling

- **Location denied / unavailable:** clock in/out proceeds; no country/city/coords stored; UI omits
  the location chip. No error shown to the user for the missing location.
- **Reverse-geocode failure (network/API):** treated like denial — coords may still be stored, but
  country/city are omitted. The clock-in callable is never blocked on the geocode result.
- **Missing timezone data on an entry:** display falls back to CT-decimal formatting.
- **Clock-out without a matching active punch:** unchanged (`NOT_CLOCKED_IN`).

## Testing

- Clock in/out from a simulated non-office network/location succeeds (gate removed).
- Clock in with browser zone `Asia/Baghdad` → entry shows local Baghdad time with CT label;
  total hours unchanged vs. the same shift logged in CT.
- Clock in with location denied → entry created, no country/city chip, no error.
- Reverse-geocode returns country/city → chip shows "Iraq · Baghdad".
- Legacy entry with only CT decimals → still renders via fallback, no crash.
- Regular user no longer sees a "Log Time" nav item or route; admin "Log Time for Users" and edit
  still work.

## Open Questions

None — all decisions confirmed.
