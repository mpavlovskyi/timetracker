const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const ipaddr = require('ipaddr.js');
const { punchLocationFields, entryAuditFields } = require('./lib/punchFields');
const { localDateStringInTz, getScheduleEndForDate, shiftDecimals } = require('./lib/time');
const { buildClockOutEntries } = require('./lib/clockOutEntries');

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

// Audit trail for privileged admin actions (separate from clockLogs, which is
// clock-event shaped). Never throws: a logging failure must not abort the action.
async function logAdminAction(entry) {
  try {
    await db.collection('adminAuditLogs').add({
      ...entry,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('Failed to write adminAuditLog:', err);
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

/**
 * Turns an active punch into timeEntries and deletes the punch, using the given
 * transaction. Caller must have read punchRef in the same transaction.
 * Returns { hours, loggedHours, entryId, extraEntryId, capped, extraLogged }.
 * hours is raw elapsed time; loggedHours is what the entries actually record.
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

  const { entries, capped, extraLogged, loggedHours } = buildClockOutEntries({
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

  return { hours: totalHours, loggedHours, entryId, extraEntryId, capped, extraLogged };
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

  const plan = typeof data.plan === 'string' ? data.plan.trim() : null;
  if (plan === null || plan.length < 3 || plan.length > 2000) {
    throw new HttpsError('invalid-argument', 'Please describe your plan for the day before clocking in.');
  }

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
    plan,
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
  // Admin stop of another user's clock (see adminStopClock for why it lives here).
  if (Object.prototype.hasOwnProperty.call(data, 'targetUid')) {
    return adminStopClock(request);
  }
  const extendedTime = data.extendedTime === true;

  const user = await getUserDoc(uid);
  // Location gate removed: clock-out succeeds from anywhere.

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
    const notes = typeof data.notes === 'string' ? data.notes.trim() : null;
    if (notes === null || notes.length < 3 || notes.length > 2000) {
      throw new HttpsError('invalid-argument', 'Please describe what you did today before clocking out.');
    }
    return writeClockOut(tx, { punchRef, punch, user, now, notes, extendedTime, extraFields: null, data });
  });

  return { ok: true, ...result };
});

// ---------------------------------------------------------------------------
// Admin-only: stops another user's running clock. The shift is saved as a
// normal pending entry ending now, tagged stoppedByAdmin. Shares writeClockOut
// with clockOut so cap behaviour is identical (extendedTime is never applied).
//
// Not its own callable: it's reached via clockOut when the payload carries
// targetUid. New functions can't be made publicly invokable with the current
// deploy permissions (setting the Cloud Run invoker fails), while updating the
// existing clockOut works. Split this back into its own callable once the
// deployer has roles/functions.admin.
// ---------------------------------------------------------------------------

async function adminStopClock(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const caller = await getUserDoc(request.auth.uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }

  const data = request.data || {};
  const targetUid = typeof data.targetUid === 'string' ? data.targetUid.trim() : '';
  if (!targetUid || targetUid.includes('/') || targetUid.length > 128) {
    throw new HttpsError('invalid-argument', 'A valid target user id is required.');
  }
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (reason.length < 3 || reason.length > 2000) {
    throw new HttpsError('invalid-argument', 'Please give a reason (3–2000 characters).');
  }

  // Read the profile directly (not getUserDoc): a deleted profile must not block
  // stopping a still-running clock. The fallback is built from the punch below.
  const targetSnap = await db.collection('users').doc(targetUid).get();
  const targetProfile = targetSnap.exists ? { uid: targetUid, ...targetSnap.data() } : null;
  const callerName = `${caller.firstName || ''} ${caller.lastName || ''}`.trim() || caller.email || 'admin';
  const punchRef = db.collection('activePunches').doc(targetUid);

  const result = await db.runTransaction(async (tx) => {
    const punchSnap = await tx.get(punchRef);
    if (!punchSnap.exists) {
      throw new HttpsError('failed-precondition', 'That user is not clocked in.', { code: 'NOT_CLOCKED_IN' });
    }
    const punch = punchSnap.data();
    const now = new Date();

    // Marker the employee's client listens to for the "stopped by admin" notice.
    // Skipped when the profile is gone so no users doc is created.
    if (targetProfile) {
      tx.set(db.collection('users').doc(targetUid), {
        lastAdminStop: { at: admin.firestore.Timestamp.fromDate(now), byName: callerName }
      }, { merge: true });
    }

    // Under the 1-minute minimum: clear the punch, log nothing.
    if (now.getTime() - punch.clockInAt.toDate().getTime() < 60 * 1000) {
      tx.delete(punchRef);
      return { discarded: true, hours: 0, loggedHours: 0, entryId: null, extraEntryId: null, capped: false, punchEmail: punch.userEmail };
    }

    // Profile gone: identify the user from the punch. No schedule, so no cap.
    const target = targetProfile || {
      uid: targetUid, email: punch.userEmail, firstName: punch.userName, lastName: ''
    };

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
    return { discarded: false, ...written, punchEmail: punch.userEmail };
  });

  await logAdminAction({
    action: 'adminClockOut',
    callerUid: request.auth.uid,
    callerEmail: caller.email || null,
    targetUid,
    targetEmail: (targetProfile && targetProfile.email) || result.punchEmail || null,
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
    loggedHours: result.loggedHours,
    entryId: result.entryId,
    extraEntryId: result.extraEntryId,
    capped: result.capped
  };
}

// ---------------------------------------------------------------------------
// Admin-only: generates a Firebase password reset link for another user, so an
// admin can hand it to someone who can't reset their own password. The link is
// generated against the target's Firebase Auth email (the source of truth for
// sign-in), not the copy stored on their Firestore profile.
// ---------------------------------------------------------------------------

exports.adminGeneratePasswordResetLink = onCall({ cors: ALLOWED_ORIGINS }, async (request) => {
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
  // verifyOnly: confirm the Auth account and its canonical email without minting
  // an oobCode — generating a second reset code would invalidate the first.
  const verifyOnly = data.verifyOnly === true;

  // Confirms the profile exists (throws not-found otherwise) before hitting Auth.
  await getUserDoc(targetUid);

  try {
    const userRecord = await admin.auth().getUser(targetUid);
    const link = verifyOnly ? null : await admin.auth().generatePasswordResetLink(userRecord.email);

    await logAdminAction({
      action: verifyOnly ? 'adminVerifyPasswordResetTarget' : 'adminGeneratePasswordResetLink',
      callerUid: request.auth.uid,
      callerEmail: caller.email || null,
      targetUid,
      targetEmail: userRecord.email || null
    });

    // An admin-initiated reset supersedes the forced temp-password change: that
    // flag exists to push users off an admin-generated temp password, and leaving
    // it true would make the employee change their password twice in a row.
    try {
      await db.collection('users').doc(targetUid).set({ requirePasswordChange: false }, { merge: true });
    } catch (err) {
      console.error('Failed to clear requirePasswordChange:', err);
    }

    if (verifyOnly) {
      return { ok: true, email: userRecord.email };
    }
    return { ok: true, link, email: userRecord.email };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (err.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'No sign-in account found for that user.', { code: 'AUTH_ACCOUNT_MISSING' });
    }
    throw new HttpsError('internal', err.message);
  }
});
