// KWTM_LOGIN_MAILER_VERSION: 2026-10-30.1
// KWTM_LOGIN_MAILER_UPDATED_AT: 2026-10-30
// Purpose: emails a one-time sign-in code for the Karl Weekly Task Manager and checks it.

/*
 * Karl Weekly Task Manager -- sign-in code mailer.
 *
 * This is its OWN standalone Apps Script project. Do not paste it into the sync script
 * (apps-script/Code.gs). Sending mail needs the MailApp permission, and adding a new Google
 * service to the sync script changes its permissions and breaks every save until it is
 * re-authorized and redeployed. Keeping the mailer separate means the sync script never
 * changes.
 *
 * Setup:
 * 1. script.google.com > New project. Rename it "KWTM Login Mailer". Select all of the
 *    starter code, paste this whole file over it, and save.
 * 2. Project Settings (gear icon) > Script Properties > Add script property:
 *    - KWTM_LOGIN_TOKEN: the same value as LOGIN_MAILER_TOKEN in Netlify.
 *    - KWTM_LOGIN_EMAIL: optional. Where codes are sent. Defaults to this Google account.
 * 3. Back in the editor, pick KWTM_testLoginEmail in the function menu and press Run.
 *    Google asks for permission the first time; allow it. A test email should arrive.
 * 4. Deploy > New deployment > type "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    Copy the Web app URL into Netlify as LOGIN_MAILER_URL.
 *
 * Services used: ContentService, LockService, Logger, MailApp, PropertiesService, Session,
 * Utilities. Adding another one later means re-running step 3 and creating a new version
 * of the deployment, or the web app stops answering.
 *
 * How it works: the Netlify sign-in page asks this script to "send" a code. The script
 * makes a random 6-digit code, stores only a hash of it, and emails it. When a code is
 * typed in, Netlify asks the script to "verify" it. Each code works once, expires after
 * 10 minutes, and dies after 5 wrong tries. There are also hourly and daily caps so the
 * page cannot be used to flood the inbox or to guess codes.
 */

var KWTM_LOGIN_MAILER_VERSION = '2026-10-30.1';
var KWTM_LOGIN_STATE_KEY = 'KWTM_LOGIN_STATE';
var KWTM_LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
var KWTM_LOGIN_MAX_TRIES_PER_CODE = 5;
// A second tap within this window re-uses the code already in the inbox.
var KWTM_LOGIN_RESEND_GAP_MS = 20 * 1000;
var KWTM_LOGIN_MAX_SENDS_PER_HOUR = 10;
var KWTM_LOGIN_MAX_FAILS_PER_DAY = 30;

function doGet() {
  return KWTM_loginJson_({ ok: true, service: 'kwtm-login-mailer', version: KWTM_LOGIN_MAILER_VERSION });
}

function doPost(e) {
  return KWTM_loginJson_(KWTM_loginHandle_(e, Date.now()));
}

/** Run this once from the editor: it grants the mail permission and sends a test email. */
function KWTM_testLoginEmail() {
  var to = KWTM_loginRecipient_(PropertiesService.getScriptProperties());
  MailApp.sendEmail({
    to: to,
    name: 'Karl Tasks',
    subject: 'Test from the task manager sign-in mailer',
    body: 'If you are reading this, the sign-in mailer can send to ' + to + '.',
  });
  Logger.log('Test email sent to ' + to);
}

function KWTM_loginJson_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function KWTM_loginHandle_(e, now) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return { ok: false, error: 'Invalid JSON.' };
  }

  var props = PropertiesService.getScriptProperties();
  var expectedToken = props.getProperty('KWTM_LOGIN_TOKEN') || '';
  if (!expectedToken || body.token !== expectedToken) {
    return { ok: false, reason: 'unauthorized', error: 'The sign-in mailer rejected the request (token mismatch).' };
  }

  // One request at a time, so two quick taps cannot race the try counters.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return { ok: false, retryable: true, error: 'The sign-in mailer is busy. Try again.' };
  }

  try {
    if (body.action === 'send') return KWTM_loginSend_(props, now);
    if (body.action === 'verify') return KWTM_loginVerify_(props, body.code, now);
    return { ok: false, error: 'Unknown action.' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    lock.releaseLock();
  }
}

function KWTM_loginSend_(props, now) {
  var state = KWTM_loginReadState_(props);
  var to = KWTM_loginRecipient_(props);
  var masked = KWTM_loginMaskEmail_(to);

  if (state.code && now < state.code.expiresAt && now - state.code.sentAt < KWTM_LOGIN_RESEND_GAP_MS) {
    return { ok: true, to: masked, alreadySent: true };
  }

  var hour = Math.floor(now / 3600000);
  if (!state.sends || state.sends.hour !== hour) state.sends = { hour: hour, count: 0 };
  if (state.sends.count >= KWTM_LOGIN_MAX_SENDS_PER_HOUR) {
    return { ok: false, reason: 'rate-limited', error: 'Too many codes were requested this hour. Try again later.' };
  }

  var code = KWTM_loginNewCode_();
  MailApp.sendEmail({
    to: to,
    name: 'Karl Tasks',
    subject: 'Your sign-in code: ' + code,
    body: [
      'Your sign-in code for the Karl Weekly Task Manager is:',
      '',
      code,
      '',
      'It works once and expires in 10 minutes.',
      '',
      'If you did not just ask for this, someone pressed "Email me a code" on the sign-in page.',
      'They cannot get in without this code, so you can ignore this email.',
    ].join('\n'),
  });

  // Saved only after the email went out, so a failed send leaves no phantom code behind.
  state.code = {
    hash: KWTM_loginHash_(code, props),
    expiresAt: now + KWTM_LOGIN_CODE_TTL_MS,
    sentAt: now,
    tries: 0,
  };
  state.sends.count += 1;
  KWTM_loginWriteState_(props, state);
  return { ok: true, to: masked };
}

function KWTM_loginVerify_(props, rawCode, now) {
  var state = KWTM_loginReadState_(props);
  var day = Math.floor(now / 86400000);
  if (!state.fails || state.fails.day !== day) state.fails = { day: day, count: 0 };
  if (state.fails.count >= KWTM_LOGIN_MAX_FAILS_PER_DAY) {
    return { ok: false, reason: 'locked', error: 'Too many wrong codes today, so code sign-in is paused until tomorrow.' };
  }

  var current = state.code;
  if (!current || now >= current.expiresAt) {
    if (current) {
      state.code = null;
      KWTM_loginWriteState_(props, state);
    }
    return { ok: false, reason: 'expired', error: 'That code has expired. Send yourself a new one.' };
  }

  var code = String(rawCode || '').replace(/\D/g, '');
  if (code.length === 6 && KWTM_loginHash_(code, props) === current.hash) {
    state.code = null; // single use
    KWTM_loginWriteState_(props, state);
    return { ok: true };
  }

  current.tries += 1;
  state.fails.count += 1;
  if (current.tries >= KWTM_LOGIN_MAX_TRIES_PER_CODE) {
    state.code = null;
    KWTM_loginWriteState_(props, state);
    return { ok: false, reason: 'too-many-tries', error: 'Too many wrong tries for that code. Send yourself a new one.' };
  }
  KWTM_loginWriteState_(props, state);
  return { ok: false, reason: 'wrong', error: 'That code is not right. Check the email and try again.' };
}

function KWTM_loginReadState_(props) {
  try {
    var parsed = JSON.parse(props.getProperty(KWTM_LOGIN_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function KWTM_loginWriteState_(props, state) {
  props.setProperty(KWTM_LOGIN_STATE_KEY, JSON.stringify(state));
}

function KWTM_loginRecipient_(props) {
  var configured = String(props.getProperty('KWTM_LOGIN_EMAIL') || '').trim();
  return configured || Session.getEffectiveUser().getEmail();
}

/** "sturgeonspirits@gmail.com" -> "s***@gmail.com": enough to recognize, not to harvest. */
function KWTM_loginMaskEmail_(email) {
  var at = String(email).indexOf('@');
  if (at < 1) return 'your email';
  return email.charAt(0) + '***' + email.slice(at);
}

/** 6 digits from a random UUID (48 random bits, so the modulo bias is negligible). */
function KWTM_loginNewCode_() {
  var hex = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  var n = parseInt(hex, 16) % 1000000;
  return ('000000' + n).slice(-6);
}

function KWTM_loginHash_(code, props) {
  var salt = props.getProperty('KWTM_LOGIN_TOKEN') || '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + code);
  return bytes
    .map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    })
    .join('');
}
