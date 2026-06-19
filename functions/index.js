const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const ipaddr = require('ipaddr.js');
const { punchLocationFields, entryAuditFields } = require('./lib/punchFields');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

// Origins allowed to invoke the callable functions. Firebase Hosting domains
// (*.web.app, *.firebaseapp.com) are auto-allowed, but the localhost/127.0.0.1
// entries are needed for local development via VS Code Live Server, `firebase
// serve`, etc.
const ALLOWED_ORIGINS = [
  /^https:\/\/.*\.web\.app$/,
  /^https:\/\/.*\.firebaseapp\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

// ---------------------------------------------------------------------------
// Config. Override via a `.env` file in this directory or at deploy time:
//   OFFICE_PUBLIC_IPS="67.175.85.158/32,2603:300a:175f:d300::/64"
//   OFFICE_LAT="42.27892"
//   OFFICE_LNG="-87.84016"
//   RADIUS_METERS="200"
// ---------------------------------------------------------------------------
const OFFICE_PUBLIC_IPS = defineString('OFFICE_PUBLIC_IPS', {
  default: '67.175.85.158/32,2603:300a:175f:d300::/64'
});
const OFFICE_LAT = defineString('OFFICE_LAT', { default: '42.27892' });
const OFFICE_LNG = defineString('OFFICE_LNG', { default: '-87.84016' });
const RADIUS_METERS = defineString('RADIUS_METERS', { default: '200' });
const OFFICE_TIMEZONE = defineString('OFFICE_TIMEZONE', { default: 'America/Chicago' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIpAllowlist(csv) {
  const entries = String(csv || '').split(',').map(s => s.trim()).filter(Boolean);
  const parsed = [];
  for (const entry of entries) {
    try {
      if (entry.includes('/')) {
        parsed.push(ipaddr.parseCIDR(entry));
      } else {
        const addr = ipaddr.parse(entry);
        const bits = addr.kind() === 'ipv4' ? 32 : 128;
        parsed.push([addr, bits]);
      }
    } catch (err) {
      console.warn('Invalid IP allowlist entry, skipping:', entry, err.message);
    }
  }
  return parsed;
}

function getClientIp(rawRequest) {
  // Cloud Functions v2 run behind Google Front End, which always sets x-forwarded-for.
  // First entry is the original client; subsequent entries are GFE intermediaries.
  const xff = rawRequest && rawRequest.headers && rawRequest.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  if (rawRequest && rawRequest.ip) return rawRequest.ip;
  if (rawRequest && rawRequest.connection && rawRequest.connection.remoteAddress) {
    return rawRequest.connection.remoteAddress;
  }
  return null;
}

function ipAllowed(ip, cidrList) {
  if (!ip) return false;
  let addr;
  try {
    addr = ipaddr.parse(ip);
  } catch (err) {
    return false;
  }
  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:67.175.85.158) down to IPv4
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  for (const [prefix, bits] of cidrList) {
    if (addr.kind() === prefix.kind()) {
      try {
        if (addr.match(prefix, bits)) return true;
      } catch (err) {
        // Kind mismatch or other — skip
      }
    }
  }
  return false;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius, meters
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function getUserDoc(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'User profile not found.');
  }
  return { uid, ...snap.data() };
}

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

async function logAttempt(entry) {
  try {
    await db.collection('clockLogs').add({
      ...entry,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('Failed to write clockLog:', err);
  }
}

/**
 * Runs the two-layer location check.
 * Returns { ip, ipOk, distance } on success; throws HttpsError with `details.code`
 * on failure. Admins bypass all checks.
 */
async function locationCheck({ uid, user, coords, rawRequest, action }) {
  const ip = getClientIp(rawRequest);
  const cidrList = parseIpAllowlist(OFFICE_PUBLIC_IPS.value());
  const ipOk = ipAllowed(ip, cidrList);

  if (user.role === 'admin') {
    await logAttempt({
      userId: uid, action, ip, ipAllowed: ipOk,
      coords: coords || null, distanceMeters: null,
      allowed: true, reason: 'admin-bypass', errorCode: null
    });
    return { ip, ipOk, distance: null };
  }

  if (ipOk) {
    await logAttempt({
      userId: uid, action, ip, ipAllowed: true,
      coords: coords || null, distanceMeters: null,
      allowed: true, reason: 'ip-match', errorCode: null
    });
    return { ip, ipOk: true, distance: null };
  }

  // Fallback: require geolocation
  const validCoords = coords
    && typeof coords.lat === 'number' && isFinite(coords.lat)
    && typeof coords.lng === 'number' && isFinite(coords.lng);

  if (!validCoords) {
    await logAttempt({
      userId: uid, action, ip, ipAllowed: false,
      coords: coords || null, distanceMeters: null,
      allowed: false, reason: 'no-coords', errorCode: 'LOCATION_REQUIRED'
    });
    throw new HttpsError(
      'failed-precondition',
      'You must be at the office to clock in. Please enable location access or connect to the office network.',
      { code: 'LOCATION_REQUIRED' }
    );
  }

  const officeLat = parseFloat(OFFICE_LAT.value());
  const officeLng = parseFloat(OFFICE_LNG.value());
  const radius = parseFloat(RADIUS_METERS.value());
  const distance = haversineMeters(coords.lat, coords.lng, officeLat, officeLng);

  if (distance > radius) {
    await logAttempt({
      userId: uid, action, ip, ipAllowed: false,
      coords, distanceMeters: distance,
      allowed: false, reason: 'outside-radius', errorCode: 'LOCATION_OUTSIDE_RADIUS'
    });
    throw new HttpsError(
      'failed-precondition',
      `You are not at the Office! You must be there to clock in.`,
      { code: 'LOCATION_OUTSIDE_RADIUS', distanceMeters: Math.round(distance), radiusMeters: Math.round(radius) }
    );
  }

  await logAttempt({
    userId: uid, action, ip, ipAllowed: false,
    coords, distanceMeters: distance,
    allowed: true, reason: 'within-radius', errorCode: null
  });
  return { ip, ipOk: false, distance };
}

// ---------------------------------------------------------------------------
// Callables
// ---------------------------------------------------------------------------

exports.clockIn = onCall({ cors: ALLOWED_ORIGINS }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = request.auth.uid;
  const data = request.data || {};
  const coords = data.coords || null;
  const clientClockInDate = typeof data.clockInDate === 'string' ? data.clockInDate : null;

  const user = await getUserDoc(uid);
  // Location gate removed: staff may clock in from anywhere. Coords/timezone are
  // collected for display/geolocation only (see punchLocationFields), never to block.

  // Prevent double clock-in
  const punchRef = db.collection('activePunches').doc(uid);
  const existing = await punchRef.get();
  if (existing.exists) {
    throw new HttpsError('failed-precondition', 'You are already clocked in.', { code: 'ALREADY_CLOCKED_IN' });
  }

  const now = admin.firestore.Timestamp.now();
  const tz = OFFICE_TIMEZONE.value();
  const clockInDate = clientClockInDate || localDateStringInTz(now.toDate(), tz);

  await punchRef.set({
    userId: uid,
    userEmail: user.email,
    userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    clockInAt: now,
    clockInDate,
    ...punchLocationFields(data)
  });

  return { ok: true, clockInAt: now.toMillis(), clockInDate };
});

exports.clockOut = onCall({ cors: ALLOWED_ORIGINS }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = request.auth.uid;
  const data = request.data || {};
  const coords = data.coords || null;
  const extendedTime = data.extendedTime === true;

  const user = await getUserDoc(uid);
  // Location gate removed: clock-out succeeds from anywhere.

  const punchRef = db.collection('activePunches').doc(uid);
  const punchSnap = await punchRef.get();
  if (!punchSnap.exists) {
    throw new HttpsError('failed-precondition', 'No active punch found.', { code: 'NOT_CLOCKED_IN' });
  }

  const punch = punchSnap.data();
  const clockIn = punch.clockInAt.toDate();
  const now = new Date();
  const elapsedMs = now.getTime() - clockIn.getTime();

  if (elapsedMs < 60 * 1000) {
    throw new HttpsError('failed-precondition', 'Shift too short to log (under 1 minute).', { code: 'SHIFT_TOO_SHORT' });
  }

  const totalHours = elapsedMs / (1000 * 60 * 60);
  const tz = OFFICE_TIMEZONE.value();
  const startDecimal = timeDecimalInTz(clockIn, tz);
  let endDecimal = timeDecimalInTz(now, tz);
  if (endDecimal <= startDecimal) endDecimal = startDecimal + totalHours;

  const capEnabled = user.scheduleCapEnabled === true;
  const capDecimal = capEnabled ? getScheduleEndForDate(user.schedule, punch.clockInDate) : null;
  const pastCap = capDecimal !== null && endDecimal > capDecimal;

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

  const batch = db.batch();
  let primaryEntryId = null;
  let extraEntryId = null;

  if (pastCap && extendedTime) {
    // Split: normal portion up to cap, plus an EXTRA TIME entry for the overflow.
    if (startDecimal < capDecimal) {
      const normalRef = db.collection('timeEntries').doc();
      batch.set(normalRef, {
        ...entryBase,
        startTime: startDecimal,
        endTime: capDecimal,
        hours: capDecimal - startDecimal
      });
      primaryEntryId = normalRef.id;
    }
    const extraRef = db.collection('timeEntries').doc();
    const extraStart = Math.max(startDecimal, capDecimal);
    batch.set(extraRef, {
      ...entryBase,
      startTime: extraStart,
      endTime: endDecimal,
      hours: endDecimal - extraStart,
      isExtraTime: true
    });
    extraEntryId = extraRef.id;
  } else if (pastCap) {
    // Silent clamp to cap.
    const entryRef = db.collection('timeEntries').doc();
    const cappedEnd = Math.max(capDecimal, startDecimal);
    batch.set(entryRef, {
      ...entryBase,
      startTime: startDecimal,
      endTime: cappedEnd,
      hours: Math.max(0, cappedEnd - startDecimal),
      capped: true
    });
    primaryEntryId = entryRef.id;
  } else {
    const entryRef = db.collection('timeEntries').doc();
    batch.set(entryRef, {
      ...entryBase,
      startTime: startDecimal,
      endTime: endDecimal,
      hours: totalHours
    });
    primaryEntryId = entryRef.id;
  }

  batch.delete(punchRef);
  await batch.commit();

  return {
    ok: true,
    hours: totalHours,
    entryId: primaryEntryId,
    extraEntryId,
    capped: pastCap && !extendedTime,
    extraLogged: pastCap && extendedTime
  };
});

// ---------------------------------------------------------------------------
// TEMPORARY — remove after use.
// Creates (or refreshes) a throwaway admin account so a developer who lacks
// console access can sign in and smoke-test admin flows. Cleans up with the
// same call passing { cleanup: true }. Delete this block + the function from
// the project after you're done.
// ---------------------------------------------------------------------------
const DEV_RESET_SECRET = 'b4f1a9c0-7e2d-4836-9c51-08af3d6e7b29';
const DEV_ADMIN_EMAIL = 'temp-admin@timetracker.local';

exports.devCreateTempAdmin = onCall({ cors: ALLOWED_ORIGINS }, async (request) => {
  const { secret, cleanup } = request.data || {};
  if (secret !== DEV_RESET_SECRET) {
    throw new HttpsError('permission-denied', 'Invalid secret.');
  }

  if (cleanup) {
    try {
      const existing = await admin.auth().getUserByEmail(DEV_ADMIN_EMAIL);
      await admin.auth().deleteUser(existing.uid);
      await db.collection('users').doc(existing.uid).delete();
      return { ok: true, action: 'cleanup', uid: existing.uid };
    } catch (err) {
      if (err.code === 'auth/user-not-found') return { ok: true, action: 'cleanup', note: 'no temp admin found' };
      throw new HttpsError('internal', err.message);
    }
  }

  const password = 'Temp-' + Math.random().toString(36).slice(2, 10) + '-' + Math.random().toString(36).slice(2, 6);

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email: DEV_ADMIN_EMAIL, password });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      userRecord = await admin.auth().getUserByEmail(DEV_ADMIN_EMAIL);
      await admin.auth().updateUser(userRecord.uid, { password });
    } else {
      throw new HttpsError('internal', err.message);
    }
  }

  await db.collection('users').doc(userRecord.uid).set({
    email: DEV_ADMIN_EMAIL,
    username: 'tempadmin',
    firstName: 'Temp',
    lastName: 'Admin',
    role: 'admin'
  }, { merge: true });

  return { ok: true, action: 'created', email: DEV_ADMIN_EMAIL, password, uid: userRecord.uid };
});

