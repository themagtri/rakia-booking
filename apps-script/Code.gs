/**
 * שרת ההרשמה למפגשי אימון אישי – תוכנית רקיע
 * מודבק בתוך Google Sheet (Extensions → Apps Script). ראו README.md.
 *
 * דרוש: Services → "+" → Google Calendar API (שירות מתקדם, בשם Calendar).
 *
 * ביטול מפגש: מסמנים שורה בגיליון Bookings → תפריט "מפגשים" → "ביטול המפגש בשורה המסומנת".
 * (גם מחיקת האירוע מהיומן עובדת – הסנכרון ישחרר את המועד תוך 15 דקות.)
 */

const CONFIG = {
  CLIENT_ID: 'PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com',
  AVAILABILITY_URL: 'https://USERNAME.github.io/REPO/availability.json',
  SITE_URL: 'https://USERNAME.github.io/REPO/',
  CALENDAR_ID: 'primary',
  TIMEZONE: 'Asia/Jerusalem',
  MEETING_TITLE: 'מפגש אימון אישי – תוכנית רקיע',
  OWNER_NAME: 'לורן זילברשטין',
  WHATSAPP: '972500000000',
  MIN_MINUTES_AHEAD: 60,      // עד כמה דקות לפני מועד עוד אפשר להירשם
  NOTIFY_OWNER: true          // אימייל אליך על כל הרשמה חדשה
};

const SHEET_NAME = 'Bookings';
const HEADERS = ['id', 'createdAt', 'email', 'name', 'date', 'time', 'eventId', 'meetLink',
  'status', 'reminder24', 'reminder2', 'cancelledAt'];
const COL = {};
HEADERS.forEach((h, i) => (COL[h] = i + 1));

/* ================= Web App ================= */

function doGet() {
  return json_({ ok: true, service: 'booking' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }

  try {
    switch (body.action) {
      case 'taken':
        return json_({ ok: true, taken: takenSlots_() });
      case 'mine': {
        const user = verify_(body.idToken);
        if (!user) return json_({ ok: false, error: 'auth' });
        const active = activeBookings_();
        const res = {
          ok: true,
          bookings: active.filter(b => b.email === user.email)
            .map(b => ({ date: b.date, time: b.time, meetLink: b.meetLink }))
        };
        if (user.email === ownerEmail_()) {
          // תצוגת בעלים: כל המפגשים הקרובים
          const now = Date.now();
          res.isOwner = true;
          res.all = active.filter(b => slotStart_(b.date, b.time).getTime() > now - 3600000)
            .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
            .map(b => ({ name: b.name, email: b.email, date: b.date, time: b.time, meetLink: b.meetLink }));
        }
        return json_(res);
      }
      case 'book':
        return json_(book_(body));
      default:
        return json_({ ok: false, error: 'bad_request' });
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server' });
  }
}

function book_(body) {
  const user = verify_(body.idToken);
  if (!user) return { ok: false, error: 'auth' };

  const date = String(body.date || '');
  const time = String(body.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: 'invalid' };

  const avail = availability_();
  if (!(avail.slots[date] || []).includes(time)) return { ok: false, error: 'invalid' };

  const start = slotStart_(date, time);
  const minutesAhead = (start.getTime() - Date.now()) / 60000;
  if (minutesAhead < CONFIG.MIN_MINUTES_AHEAD) return { ok: false, error: 'past' };
  const end = new Date(start.getTime() + (avail.durationMinutes || 50) * 60000);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const active = activeBookings_();
    if (active.some(b => b.date === date && b.time === time)) return { ok: false, error: 'taken' };
    const month = date.slice(0, 7);
    if (active.some(b => b.email === user.email && b.date.slice(0, 7) === month)) return { ok: false, error: 'limit' };

    const id = Utilities.getUuid();
    // אירוע ביומן שלך + הזמנה ליומן של המשתמש + קישור Google Meet
    const event = Calendar.Events.insert({
      summary: CONFIG.MEETING_TITLE + ' – ' + user.name,
      description: 'מפגש שנקבע דרך אתר ההרשמה.\nלשינוי או ביטול: וואטסאפ https://wa.me/' + CONFIG.WHATSAPP +
        ' (לפחות 24 שעות מראש).',
      start: { dateTime: start.toISOString(), timeZone: CONFIG.TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: CONFIG.TIMEZONE },
      attendees: [{ email: user.email, displayName: user.name }],
      conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true }
    }, CONFIG.CALENDAR_ID, { conferenceDataVersion: 1, sendUpdates: 'all' });

    const meetLink = event.hangoutLink || '';
    sheet_().appendRow([
      id, new Date(), user.email, user.name, date, time, event.id, meetLink, 'active',
      minutesAhead <= 24 * 60 ? 'skip' : '',   // נרשם פחות מיום מראש – בלי תזכורת של 24 שעות
      minutesAhead <= 2 * 60 ? 'skip' : '',    // פחות משעתיים מראש – בלי תזכורת של שעתיים
      ''
    ]);
    SpreadsheetApp.flush();

    const b = { email: user.email, name: user.name, date: date, time: time, meetLink: meetLink };
    sendConfirmation_(b);
    if (CONFIG.NOTIFY_OWNER) {
      MailApp.sendEmail(ownerEmail_(),
        'הרשמה חדשה: ' + user.name + ' – ' + hebDate_(date) + ' ' + time,
        user.name + ' (' + user.email + ') נרשם/ה למפגש ב' + hebDate_(date) + ' בשעה ' + time + ' (שעון ישראל).\n' +
        'Meet: ' + meetLink);
    }
    return { ok: true, booking: { date: date, time: time, meetLink: meetLink } };
  } finally {
    lock.releaseLock();
  }
}

/* ================= אימות משתמש Google ================= */

function verify_(idToken) {
  if (!idToken) return null;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const info = JSON.parse(res.getContentText());
  if (info.aud !== CONFIG.CLIENT_ID) return null;
  if (String(info.email_verified) !== 'true') return null;
  if (Number(info.exp) * 1000 < Date.now()) return null;
  return { email: String(info.email).toLowerCase(), name: info.name || info.email };
}

function ownerEmail_() { return String(Session.getEffectiveUser().getEmail()).toLowerCase(); }

/* ================= נתונים ================= */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('E:F').setNumberFormat('@');
  }
  return sh;
}

function allBookings_() {
  const values = sheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[0]) continue;
    out.push({
      row: i + 1, id: r[0], email: String(r[COL.email - 1]).toLowerCase(), name: r[COL.name - 1],
      date: normDate_(r[COL.date - 1]), time: normTime_(r[COL.time - 1]),
      eventId: r[COL.eventId - 1], meetLink: r[COL.meetLink - 1], status: r[COL.status - 1],
      reminder24: r[COL.reminder24 - 1], reminder2: r[COL.reminder2 - 1]
    });
  }
  return out;
}

function activeBookings_() { return allBookings_().filter(b => b.status === 'active'); }

function takenSlots_() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return activeBookings_().filter(b => b.date >= today).map(b => b.date + ' ' + b.time);
}

function availability_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('avail');
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch(CONFIG.AVAILABILITY_URL + '?t=' + Date.now());
  const data = JSON.parse(res.getContentText());
  cache.put('avail', JSON.stringify(data), 120);
  return data;
}

function normDate_(v) { return v instanceof Date ? Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd') : String(v); }
function normTime_(v) { return v instanceof Date ? Utilities.formatDate(v, CONFIG.TIMEZONE, 'HH:mm') : String(v); }
function slotStart_(date, time) { return Utilities.parseDate(date + ' ' + time, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'); }

function hebDate_(date) {
  const d = slotStart_(date, '12:00');
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const dow = Number(Utilities.formatDate(d, CONFIG.TIMEZONE, 'u')) % 7; // u: 1=שני ... 7=ראשון
  return 'יום ' + days[dow] + ', ' + Utilities.formatDate(d, CONFIG.TIMEZONE, 'd.M.yyyy');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= אימיילים ================= */

function emailHtml_(title, lines, meetLink) {
  const btn = meetLink
    ? '<p style="margin:18px 0 6px"><a href="' + meetLink + '" style="background:#6e8f80;color:#fff;text-decoration:none;' +
      'padding:10px 22px;border-radius:10px;display:inline-block">כניסה למפגש ב-Google Meet</a></p>' +
      '<p style="margin:0;font-size:13px;color:#7d8681">' + meetLink + '</p>'
    : '';
  return '<div dir="rtl" style="font-family:Arial,sans-serif;color:#2f3a36;background:#f5f3ee;padding:24px">' +
    '<div style="max-width:480px;margin:auto;background:#fffdf9;border:1px solid #e7e3da;border-radius:14px;padding:24px">' +
    '<p style="margin:0 0 4px;color:#567365">תוכנית רקיע</p>' +
    '<h2 style="font-weight:normal;margin:0 0 14px">' + title + '</h2>' +
    lines.map(l => '<p style="margin:0 0 10px;line-height:1.6">' + l + '</p>').join('') + btn +
    '<p style="margin:20px 0 0;color:#7d8681">' + CONFIG.OWNER_NAME + '</p>' +
    '</div></div>';
}

const WA_LINE_ = () => 'לשינוי או ביטול יש לכתוב לי <a href="https://wa.me/' + CONFIG.WHATSAPP +
  '">בוואטסאפ</a> כמה שיותר מוקדם, ולפחות 24 שעות לפני המפגש.';

function sendConfirmation_(b) {
  MailApp.sendEmail({
    to: b.email,
    subject: 'נרשמת למפגש – ' + hebDate_(b.date) + ' בשעה ' + b.time,
    htmlBody: emailHtml_('המפגש נקבע', [
      'שלום ' + b.name + ',',
      'המפגש שלנו נקבע ל<strong>' + hebDate_(b.date) + '</strong> בשעה <strong>' + b.time + '</strong> (שעון ישראל).',
      'המפגש נוסף ליומן Google שלך. תזכורת תישלח יום לפני ושוב שעתיים לפני.',
      WA_LINE_()
    ], b.meetLink)
  });
}

function sendReminder_(b, kind) {
  const when = kind === '24' ? 'מחר' : 'בעוד שעתיים';
  MailApp.sendEmail({
    to: b.email,
    subject: 'תזכורת: המפגש שלנו ' + when + ', בשעה ' + b.time,
    htmlBody: emailHtml_('תזכורת למפגש', [
      'שלום ' + b.name + ',',
      'תזכורת קטנה: המפגש שלנו ' + when + ' – ' + hebDate_(b.date) + ' בשעה <strong>' + b.time + '</strong>.',
      kind === '24' ? WA_LINE_() : 'מחכה לך!'
    ], b.meetLink)
  });
}

function sendCancellation_(b) {
  MailApp.sendEmail({
    to: b.email,
    subject: 'המפגש בוטל – ' + hebDate_(b.date) + ' ' + b.time,
    htmlBody: emailHtml_('המפגש בוטל', [
      'שלום ' + b.name + ',',
      'המפגש שנקבע ל' + hebDate_(b.date) + ' בשעה ' + b.time + ' בוטל.',
      'אפשר לבחור מועד חדש כאן: <a href="' + CONFIG.SITE_URL + '">' + CONFIG.SITE_URL + '</a>'
    ])
  });
}

/* ================= ביטול (רק על ידך) ================= */

function cancelBooking_(b, notify) {
  try {
    Calendar.Events.remove(CONFIG.CALENDAR_ID, b.eventId, { sendUpdates: 'all' });
  } catch (err) { /* האירוע כבר נמחק */ }
  const sh = sheet_();
  sh.getRange(b.row, COL.status).setValue('cancelled');
  sh.getRange(b.row, COL.cancelledAt).setValue(new Date());
  if (notify) sendCancellation_(b);
}

function cancelSelected() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEET_NAME) { ui.alert('יש לסמן שורה בגיליון ' + SHEET_NAME); return; }
  const row = sh.getActiveRange().getRow();
  const b = activeBookings_().find(x => x.row === row);
  if (!b) { ui.alert('בשורה הזו אין מפגש פעיל.'); return; }
  const ans = ui.alert('ביטול מפגש',
    'לבטל את המפגש של ' + b.name + ' (' + b.email + ') ב' + hebDate_(b.date) + ' ' + b.time + '?\n' +
    'יישלח אימייל ביטול, והמועד ייפתח מחדש.', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  cancelBooking_(b, true);
  ui.alert('המפגש בוטל.');
}

/* ================= כל 15 דקות: תזכורות + סנכרון ================= */

function reminderJob() {
  const sh = sheet_();
  const now = Date.now();
  activeBookings_().forEach(b => {
    const start = slotStart_(b.date, b.time).getTime();
    if (start < now) return;

    // אם מחקת את האירוע ישירות מהיומן – משחררים את המועד
    let gone = false;
    try {
      const ev = Calendar.Events.get(CONFIG.CALENDAR_ID, b.eventId);
      gone = ev.status === 'cancelled';
    } catch (err) { gone = true; }
    if (gone) {
      sh.getRange(b.row, COL.status).setValue('cancelled');
      sh.getRange(b.row, COL.cancelledAt).setValue(new Date());
      sendCancellation_(b);
      return;
    }

    const left = start - now;
    if (!b.reminder24 && left <= 24 * 3600000 && left > 2 * 3600000) {
      sendReminder_(b, '24');
      sh.getRange(b.row, COL.reminder24).setValue(new Date());
    }
    if (!b.reminder2 && left <= 2 * 3600000) {
      sendReminder_(b, '2');
      sh.getRange(b.row, COL.reminder2).setValue(new Date());
    }
  });
}

/* ================= התקנה ================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('מפגשים')
    .addItem('ביטול המפגש בשורה המסומנת', 'cancelSelected')
    .addItem('הרצת תזכורות וסנכרון עכשיו', 'reminderJob')
    .addToUi();
}

/** להריץ פעם אחת מהעורך: יוצר את הגיליון ואת הטריגר שרץ כל 15 דקות */
function setup() {
  sheet_();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('reminderJob').timeBased().everyMinutes(15).create();
}
