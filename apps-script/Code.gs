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
  CLIENT_ID: '534010978875-ruq19hl5k9tgfi2rc678gm4qrrnv7989.apps.googleusercontent.com',
  SITE_URL: 'https://themagtri.github.io/rakia-booking/',
  CALENDAR_ID: 'primary',
  TIMEZONE: 'Asia/Jerusalem',
  MEETING_TITLE: 'מפגש אימון אישי – תוכנית רקיע',
  OWNER_NAME: 'לורן זילברשטין',
  DURATION_MINUTES: 50,       // אורך מפגש
  MIN_MINUTES_AHEAD: 60,      // עד כמה דקות לפני מועד עוד אפשר להירשם
  NOTIFY_OWNER: true          // אימייל אליך על כל הרשמה חדשה
};

const SHEET_NAME = 'Bookings';
const HEADERS = ['id', 'createdAt', 'email', 'name', 'date', 'time', 'eventId', 'meetLink',
  'status', 'reminder24', 'reminder2', 'cancelledAt'];
const COL = {};
HEADERS.forEach((h, i) => (COL[h] = i + 1));

// טבלת המשתתפים: נמלאת פעם אחת לכל אימייל, בהרשמה הראשונה
const PEOPLE_SHEET = 'Participants';
const PEOPLE_HEADERS = ['email', 'fullName', 'phone', 'googleName', 'createdAt'];

// המועדים הפתוחים: נפתחים ונסגרים מהאתר במצב ניהול (שעון ישראל)
const SLOTS_SHEET = 'Slots';
const SLOTS_HEADERS = ['date', 'time', 'createdAt'];

/* ================= Web App ================= */

function doGet() {
  return json_({ ok: true, service: 'booking' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }

  try {
    switch (body.action) {
      case 'init':
      case 'mine': {
        const user = verify_(body.idToken);
        if (!user) return json_({ ok: false, error: 'auth' });
        const active = activeBookings_();
        const people = participants_();
        const me = people[user.email];
        const res = {
          ok: true,
          duration: CONFIG.DURATION_MINUTES,
          slots: futureSlots_(),
          taken: takenSlots_(),
          profile: me ? { fullName: me.fullName, phone: me.phone } : null,
          bookings: active.filter(b => b.email === user.email)
            .map(b => ({ date: b.date, time: b.time, meetLink: b.meetLink }))
        };
        if (user.email === ownerEmail_()) {
          // תצוגת בעלים: כל המפגשים הקרובים
          const now = Date.now();
          res.isOwner = true;
          res.all = active.filter(b => slotStart_(b.date, b.time).getTime() > now - 3600000)
            .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
            .map(b => ({
              name: b.name, email: b.email, phone: people[b.email] ? people[b.email].phone : '',
              date: b.date, time: b.time, meetLink: b.meetLink
            }));
        }
        return json_(res);
      }
      case 'book':
        return json_(book_(body));
      case 'addSlots':
        return json_(addSlots_(body));
      case 'removeSlots':
        return json_(removeSlots_(body));
      case 'cancelBooking':
        return json_(ownerCancel_(body));
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
  const end = new Date(start.getTime() + CONFIG.DURATION_MINUTES * 60000);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const active = activeBookings_();
    if (active.some(b => b.date === date && b.time === time)) return { ok: false, error: 'taken' };
    const month = date.slice(0, 7);
    if (active.some(b => b.email === user.email && b.date.slice(0, 7) === month)) return { ok: false, error: 'limit' };

    // הרשמה ראשונה: חובה שם מלא וטלפון, ונשמרים בטבלת המשתתפים
    let person = participants_()[user.email];
    const isNew = !person;
    if (!person) {
      const fullName = String(body.fullName || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const phone = String(body.phone || '').trim().slice(0, 30);
      if (fullName.split(' ').length < 2 || !/^[+\d][\d\s\-()]*$/.test(phone) || phone.replace(/\D/g, '').length < 9) {
        return { ok: false, error: 'profile' };
      }
      appendRow_(peopleSheet_(), [user.email, fullName, phone, user.name, new Date()], [0, 1, 2, 3]);
      person = { fullName: fullName, phone: phone };
    }
    user.name = person.fullName;   // מכאן והלאה משתמשים בשם המלא שנמסר

    const id = Utilities.getUuid();
    // אירוע ביומן שלך + הזמנה ליומן של המשתמש + קישור Google Meet
    const event = Calendar.Events.insert({
      summary: CONFIG.MEETING_TITLE + ' – ' + user.name,
      description: 'מפגש שנקבע דרך אתר ההרשמה.\nלשינוי או ביטול: לכתוב לי בוואטסאפ, לפחות 24 שעות מראש.',
      start: { dateTime: start.toISOString(), timeZone: CONFIG.TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: CONFIG.TIMEZONE },
      attendees: [
        { email: user.email, displayName: user.name },
        // גם את/ה ברשימת המשתתפים, ממתין/ה לאישור ידני ("כן") ביומן
        { email: ownerEmail_(), displayName: CONFIG.OWNER_NAME, responseStatus: 'needsAction' }
      ],
      conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true }
    }, CONFIG.CALENDAR_ID, { conferenceDataVersion: 1, sendUpdates: 'all' });

    const meetLink = event.hangoutLink || '';
    appendRow_(sheet_(), [
      id, new Date(), user.email, user.name, date, time, event.id, meetLink, 'active',
      minutesAhead <= 24 * 60 ? 'skip' : '',   // נרשם פחות מיום מראש – בלי תזכורת של 24 שעות
      minutesAhead <= 2 * 60 ? 'skip' : '',    // פחות משעתיים מראש – בלי תזכורת של שעתיים
      ''
    ], [0, 2, 3, 4, 5, 6, 7, 8]);
    SpreadsheetApp.flush();

    const b = {
      email: user.email, name: user.name, phone: person.phone, date: date, time: time,
      meetLink: meetLink, duration: CONFIG.DURATION_MINUTES
    };
    sendConfirmation_(b);
    if (CONFIG.NOTIFY_OWNER) {
      b.isNew = isNew;
      b.eventLink = event.htmlLink || '';
      b.sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
      sendOwnerNotice_(b);
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

function peopleSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PEOPLE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PEOPLE_SHEET);
    sh.appendRow(PEOPLE_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('C:C').setNumberFormat('@');   // שומר את ה-0 בתחילת מספר הטלפון
  }
  return sh;
}

/** מחזיר { email: { fullName, phone } } */
function participants_() {
  const values = peopleSheet_().getDataRange().getValues();
  const out = {};
  for (let i = 1; i < values.length; i++) {
    const email = String(values[i][0]).toLowerCase();
    let phone = String(values[i][2]).trim();
    if (/^5\d{8}$/.test(phone)) phone = '0' + phone;   // ה-0 שנעלם כש-Sheets שמר את המספר כמספר
    if (email) out[email] = { fullName: String(values[i][1]), phone: phone };
  }
  return out;
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
  return { durationMinutes: CONFIG.DURATION_MINUTES, slots: readSlots_() };
}

/* ---------- מועדים פתוחים (גיליון Slots) ---------- */

function slotsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SLOTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SLOTS_SHEET);
    sh.appendRow(SLOTS_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('A:B').setNumberFormat('@');
  }
  return sh;
}

/** { "YYYY-MM-DD": ["HH:mm", ...] } */
function readSlots_() {
  const values = slotsSheet_().getDataRange().getValues();
  const out = {};
  for (let i = 1; i < values.length; i++) {
    const d = normDate_(values[i][0]), t = normTime_(values[i][1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) continue;
    (out[d] = out[d] || []).push(t);
  }
  Object.keys(out).forEach(d => { out[d] = Array.from(new Set(out[d])).sort(); });
  return out;
}

function futureSlots_() {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const all = readSlots_(), out = {};
  Object.keys(all).forEach(d => { if (d >= today) out[d] = all[d]; });
  return out;
}

function requireOwner_(body) {
  const user = verify_(body.idToken);
  if (!user) return { error: 'auth' };
  if (user.email !== ownerEmail_()) return { error: 'forbidden' };
  return { user: user };
}

function cleanSlotList_(list) {
  const out = [];
  (Array.isArray(list) ? list : []).slice(0, 1000).forEach(x => {
    const d = String((x || [])[0] || ''), t = String((x || [])[1] || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) out.push([d, t]);
  });
  return out;
}

/** פתיחת מועדים (רק לבעלים). slots: [["YYYY-MM-DD","HH:mm"], ...] בשעון ישראל */
function addSlots_(body) {
  const auth = requireOwner_(body);
  if (auth.error) return { ok: false, error: auth.error };
  const list = cleanSlotList_(body.slots);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const existing = readSlots_();
    const now = Date.now();
    const seen = {};
    const rows = [];
    let skipped = 0;
    list.forEach(([d, t]) => {
      const key = d + ' ' + t;
      if (seen[key] || (existing[d] || []).includes(t) || slotStart_(d, t).getTime() <= now) { skipped++; return; }
      seen[key] = true;
      rows.push([d, t, new Date()]);
    });
    if (rows.length) {
      const sh = slotsSheet_();
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setNumberFormats(rows.map(() => ['@', '@', 'General'])).setValues(rows);
    }
    return { ok: true, added: rows.length, skipped: skipped, slots: futureSlots_() };
  } finally {
    lock.releaseLock();
  }
}

/** סגירת מועדים פנויים (רק לבעלים). מועד שכבר נקבע בו מפגש לא נמחק. */
function removeSlots_(body) {
  const auth = requireOwner_(body);
  if (auth.error) return { ok: false, error: auth.error };
  const remove = {};
  cleanSlotList_(body.slots).forEach(([d, t]) => (remove[d + ' ' + t] = true));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const booked = {};
    activeBookings_().forEach(b => (booked[b.date + ' ' + b.time] = true));
    const sh = slotsSheet_();
    const values = sh.getDataRange().getValues();
    const keep = [];
    let removed = 0, keptBooked = 0;
    for (let i = 1; i < values.length; i++) {
      const d = normDate_(values[i][0]), t = normTime_(values[i][1]);
      const key = d + ' ' + t;
      if (remove[key] && !booked[key]) { removed++; continue; }
      if (remove[key]) keptBooked++;
      keep.push([d, t, values[i][2]]);
    }
    if (values.length > 1) sh.getRange(2, 1, values.length - 1, 3).clearContent();
    if (keep.length) {
      sh.getRange(2, 1, keep.length, 3).setNumberFormats(keep.map(() => ['@', '@', 'General'])).setValues(keep);
    }
    return { ok: true, removed: removed, keptBooked: keptBooked, slots: futureSlots_() };
  } finally {
    lock.releaseLock();
  }
}

// Google Sheets לפעמים הופך טקסט כמו "2026-11-25" או "18:00" לערך תאריך/שעה.
// קוראים אותו בחזרה לפי אזור הזמן של הגיליון עצמו, כדי לקבל בדיוק את מה שנכתב.
let SHEET_TZ_ = null;
function sheetTz_() { return SHEET_TZ_ || (SHEET_TZ_ = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()); }
function normDate_(v) { return v instanceof Date ? Utilities.formatDate(v, sheetTz_(), 'yyyy-MM-dd') : String(v).trim(); }
function normTime_(v) { return v instanceof Date ? Utilities.formatDate(v, sheetTz_(), 'HH:mm') : String(v).trim(); }

/** הוספת שורה, כשהעמודות שב-textCols נשמרות כטקסט בלבד (בלי המרה אוטומטית לתאריך/מספר) */
function appendRow_(sh, row, textCols) {
  const r = sh.getLastRow() + 1;
  const fmts = row.map((_, i) => (textCols.indexOf(i) >= 0 ? '@' : 'General'));
  sh.getRange(r, 1, 1, row.length).setNumberFormats([fmts]).setValues([row]);
}
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

const SENDER_NAME = 'לורן זילברשטין · תוכנית רקיע';

const E_ = {
  bg: '#f2efe9', card: '#ffffff', ink: '#28322e', soft: '#4a5651', muted: '#8a928e', line: '#ebe6dd',
  accent: '#5d7d6f', accentDark: '#4b685b', tint: '#f1f5f2', sand: '#f7f2e8', sandLine: '#c9b98f',
  font: "'Assistant','Segoe UI','Helvetica Neue',Arial,sans-serif"
};

const HEB_DAYS_ = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HEB_MONTHS_ = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/** "יום חמישי, 3 בדצמבר 2026" */
function hebDateLong_(date) {
  const p = date.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return 'יום ' + HEB_DAYS_[d.getUTCDay()] + ', ' + p[2] + ' ב' + HEB_MONTHS_[p[1] - 1] + ' ' + p[0];
}

/** "3 בדצמבר" */
function hebDateShort_(date) {
  const p = date.split('-').map(Number);
  return p[2] + ' ב' + HEB_MONTHS_[p[1] - 1];
}

/** "10:00–10:50" */
function timeRange_(time, minutes) {
  const t = time.split(':').map(Number);
  const end = t[0] * 60 + t[1] + (minutes || 50);
  const pad = n => String(n).padStart(2, '0');
  return '<span dir="ltr">' + time + '–' + pad(Math.floor(end / 60) % 24) + ':' + pad(end % 60) + '</span>';
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function durationMin_() { return CONFIG.DURATION_MINUTES; }

/**
 * תבנית אחידה לכל האימיילים.
 * o: { preheader, eyebrow, title, paragraphs[], details[[label, html]], button{href,text}, buttonNote, note{title,html}, small[], signature }
 */
function emailLayout_(o) {
  const E = E_;
  const para = h => '<p style="margin:0 0 14px;font-size:16px;line-height:1.75;color:' + E.soft + '">' + h + '</p>';

  let details = '';
  if (o.details && o.details.length) {
    details = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;background:' +
      E.tint + ';border-radius:14px">' + '<tr><td style="padding:6px 22px">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      o.details.map((d, i) => {
        const bt = i ? 'border-top:1px solid #dfe8e2;' : '';
        return '<tr><td style="' + bt + 'padding:13px 0;width:96px;font-size:13px;color:' + E.muted +
          ';vertical-align:top;letter-spacing:.3px">' + d[0] + '</td><td style="' + bt + 'padding:13px 0;font-size:16px;color:' +
          E.ink + ';font-weight:600;line-height:1.5">' + d[1] + '</td></tr>';
      }).join('') + '</table></td></tr></table>';
  }

  let button = '';
  if (o.button) {
    button = '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px"><tr>' +
      '<td bgcolor="' + E.accent + '" style="border-radius:12px">' +
      '<a href="' + esc_(o.button.href) + '" style="display:inline-block;padding:14px 30px;font-family:' + E.font +
      ';font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px">' + o.button.text + '</a>' +
      '</td></tr></table>' +
      (o.buttonNote ? '<p style="margin:0 0 6px;font-size:12px;color:' + E.muted + ';direction:ltr;text-align:right">' + o.buttonNote + '</p>' : '');
  }

  const note = o.note
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 0"><tr>' +
      '<td style="background:' + E.sand + ';border-right:3px solid ' + E.sandLine + ';border-radius:10px;padding:16px 20px">' +
      '<p style="margin:0 0 6px;font-size:14px;font-weight:700;color:' + E.ink + '">' + o.note.title + '</p>' +
      '<p style="margin:0;font-size:14px;line-height:1.7;color:' + E.soft + '">' + o.note.html + '</p></td></tr></table>'
    : '';

  const small = (o.small || []).map(h =>
    '<p style="margin:14px 0 0;font-size:13px;line-height:1.7;color:' + E.muted + '">' + h + '</p>').join('');

  const signature = o.signature === false ? '' :
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:32px 0 0;border-top:1px solid ' +
    E.line + '"><tr><td style="padding-top:22px">' +
    '<p style="margin:0;font-size:15px;color:' + E.soft + '">בברכה,</p>' +
    '<p style="margin:4px 0 0;font-size:18px;color:' + E.ink + ';font-weight:600">' + CONFIG.OWNER_NAME + '</p>' +
    '<p style="margin:2px 0 0;font-size:13px;color:' + E.muted + ';letter-spacing:.4px">תוכנית רקיע · אימון אישי</p>' +
    '</td></tr></table>';

  return '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">' +
    '<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&display=swap" rel="stylesheet">' +
    '</head><body style="margin:0;padding:0;background:' + E.bg + '">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc_(o.preheader || '') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="background:' + E.bg + '">' +
    '<tr><td align="center" style="padding:36px 14px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:' + E.font + ';text-align:right">' +

    // כותרת עליונה
    '<tr><td align="center" style="padding:0 0 22px">' +
    '<p style="margin:0;font-size:12px;letter-spacing:4px;color:' + E.accentDark + ';font-weight:700">תוכנית רקיע</p>' +
    '<p style="margin:6px 0 0;font-size:13px;color:' + E.muted + ';letter-spacing:.5px">אימון אישי · ' + CONFIG.OWNER_NAME + '</p>' +
    '</td></tr>' +

    // כרטיס
    '<tr><td style="background:' + E.card + ';border:1px solid ' + E.line + ';border-radius:20px;overflow:hidden">' +
    '<div style="height:4px;background:' + E.accent + ';line-height:4px;font-size:0">&nbsp;</div>' +
    '<div style="padding:36px 36px 34px">' +
    (o.eyebrow ? '<p style="margin:0 0 10px;font-size:12px;letter-spacing:2px;color:' + E.accent + ';font-weight:700">' + o.eyebrow + '</p>' : '') +
    '<h1 style="margin:0 0 18px;font-size:28px;line-height:1.3;font-weight:400;color:' + E.ink + '">' + o.title + '</h1>' +
    (o.paragraphs || []).map(para).join('') + details + button + note + small + signature +
    '</div></td></tr>' +

    // תחתית
    '<tr><td align="center" style="padding:22px 10px 0">' +
    '<p style="margin:0;font-size:12px;line-height:1.7;color:' + E.muted + '">אימייל זה נשלח אוטומטית ממערכת ההרשמה של תוכנית רקיע.</p>' +
    '</td></tr></table></td></tr></table></body></html>';
}

function meetingDetails_(b) {
  return [
    ['תאריך', hebDateLong_(b.date)],
    ['שעה', timeRange_(b.time, b.duration) + ' <span style="font-weight:400;color:' + E_.muted + ';font-size:14px">· שעון ישראל</span>'],
    ['משך', (b.duration || 50) + ' דקות'],
    ['מיקום', 'מפגש מקוון ב-Google Meet']
  ];
}

const CHANGE_NOTE_ = {
  title: 'שינוי או ביטול',
  html: 'אי אפשר לבטל או לשנות מפגש דרך האתר. אם משהו משתנה, יש לכתוב לי בוואטסאפ כמה שיותר מוקדם, ' +
    '<strong>ולפחות 24 שעות לפני המפגש</strong>. אחרי הביטול אפשר לבחור באתר מועד חדש.'
};

function meetButton_(b) {
  return b.meetLink ? { href: b.meetLink, text: 'הצטרפות למפגש ב-Google Meet' } : null;
}

/* ---------- בניית התוכן (פונקציות טהורות, אפשר לבדוק בתצוגה מקדימה) ---------- */

function confirmationEmail_(b) {
  return {
    subject: 'אישור מפגש · ' + hebDateLong_(b.date) + ' · ' + b.time,
    html: emailLayout_({
      preheader: 'המפגש שלך נקבע ל' + hebDateLong_(b.date) + ' בשעה ' + b.time + '.',
      eyebrow: 'אישור הרשמה',
      title: 'המפגש שלך נקבע',
      paragraphs: [
        'שלום ' + esc_(b.name) + ',',
        'תודה על ההרשמה למפגש אימון אישי במסגרת תוכנית רקיע. אלו פרטי המפגש:'
      ],
      details: meetingDetails_(b),
      button: meetButton_(b),
      buttonNote: b.meetLink ? esc_(b.meetLink) : '',
      note: CHANGE_NOTE_,
      small: [
        'ההזמנה נשלחה גם ליומן Google שלך. אם היא מופיעה כ"הזמנה משולח לא מוכר", יש ללחוץ "כן" באישור ההשתתפות, והמפגש יתווסף ליומן.',
        'תזכורת תישלח יום לפני המפגש, ושוב שעתיים לפניו.'
      ]
    })
  };
}

function reminderEmail_(b, kind) {
  const soon = kind === '2';
  return {
    subject: soon ? 'בעוד שעתיים: המפגש שלנו ב-' + b.time : 'תזכורת: נתראה מחר ב-' + b.time,
    html: emailLayout_({
      preheader: soon ? 'המפגש מתחיל היום בשעה ' + b.time + '.' : 'המפגש שלנו מחר, ' + hebDateLong_(b.date) + ', בשעה ' + b.time + '.',
      eyebrow: 'תזכורת',
      title: soon ? 'נתראה בעוד שעתיים' : 'נתראה מחר',
      paragraphs: [
        'שלום ' + esc_(b.name) + ',',
        soon ? 'המפגש שלנו מתחיל בעוד כשעתיים. מומלץ להצטרף כמה דקות לפני, ממקום שקט ועם חיבור יציב לאינטרנט.'
             : 'רק תזכורת קטנה לקראת המפגש שלנו מחר:'
      ],
      details: meetingDetails_(b),
      button: meetButton_(b),
      buttonNote: b.meetLink ? esc_(b.meetLink) : '',
      note: soon ? null : CHANGE_NOTE_
    })
  };
}

function cancellationEmail_(b) {
  return {
    subject: 'המפגש ב-' + hebDateShort_(b.date) + ' בוטל',
    html: emailLayout_({
      preheader: 'המפגש שנקבע ל' + hebDateLong_(b.date) + ' בשעה ' + b.time + ' בוטל.',
      eyebrow: 'עדכון',
      title: 'המפגש בוטל',
      paragraphs: [
        'שלום ' + esc_(b.name) + ',',
        'המפגש שנקבע ל<strong>' + hebDateLong_(b.date) + '</strong> בשעה <strong>' + b.time + '</strong> בוטל, והוסר מהיומן.',
        'אפשר לבחור מועד חדש באתר ההרשמה:'
      ],
      button: { href: CONFIG.SITE_URL, text: 'בחירת מועד חדש' }
    })
  };
}

function ownerEmail_html_(b) {
  const phoneDigits = String(b.phone || '').replace(/[^\d+]/g, '');
  const link = (href, text) => '<a href="' + esc_(href) + '" style="color:' + E_.accentDark + ';text-decoration:none">' + text + '</a>';
  const details = [
    ['שם', esc_(b.name) + (b.isNew ? ' <span style="display:inline-block;margin-right:6px;padding:2px 10px;border-radius:20px;background:' +
      E_.sand + ';color:#8a6d2e;font-size:12px;font-weight:600">נרשם/ה לראשונה</span>' : '')],
    ['אימייל', link('mailto:' + b.email, esc_(b.email))],
    ['טלפון', b.phone ? link('tel:' + phoneDigits, '<span dir="ltr">' + esc_(b.phone) + '</span>') : '—'],
    ['תאריך', hebDateLong_(b.date)],
    ['שעה', timeRange_(b.time, b.duration) + ' <span style="font-weight:400;color:' + E_.muted + ';font-size:14px">· שעון ישראל</span>']
  ];
  return {
    subject: 'הרשמה חדשה · ' + b.name + ' · ' + hebDateShort_(b.date) + ', ' + b.time,
    html: emailLayout_({
      preheader: b.name + ' נרשם/ה למפגש ב' + hebDateLong_(b.date) + ' בשעה ' + b.time + '.',
      eyebrow: 'הרשמה חדשה',
      title: esc_(b.name),
      paragraphs: ['נקבע מפגש חדש דרך אתר ההרשמה. האירוע כבר ביומן שלך, עם קישור ל-Google Meet. ' +
        'כדי לאשר את ההגעה שלך, יש ללחוץ "כן" באירוע ביומן.'],
      details: details,
      button: b.meetLink ? { href: b.meetLink, text: 'קישור ל-Meet' } : null,
      small: [
        (b.eventLink ? link(b.eventLink, 'פתיחת האירוע ביומן') + ' · ' : '') +
        (b.sheetUrl ? link(b.sheetUrl, 'גיליון ההרשמות') : '')
      ],
      signature: false
    })
  };
}

/* ---------- שליחה ---------- */

function send_(to, mail) {
  MailApp.sendEmail({ to: to, subject: mail.subject, htmlBody: mail.html, name: SENDER_NAME });
}

function withDuration_(b) {
  if (!b.duration) b.duration = durationMin_();
  return b;
}

function sendConfirmation_(b) { send_(b.email, confirmationEmail_(withDuration_(b))); }
function sendReminder_(b, kind) { send_(b.email, reminderEmail_(withDuration_(b), kind)); }
function sendCancellation_(b) { send_(b.email, cancellationEmail_(withDuration_(b))); }
function sendOwnerNotice_(b) { send_(ownerEmail_(), ownerEmail_html_(withDuration_(b))); }

/* ================= ביטול (רק על ידך) ================= */

/** ביטול מפגש מהאתר (רק לבעלים). המועד נשאר פתוח, והנרשם/ת מקבל/ת אימייל ביטול. */
function ownerCancel_(body) {
  const auth = requireOwner_(body);
  if (auth.error) return { ok: false, error: auth.error };
  const date = String(body.date || ''), time = String(body.time || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const b = activeBookings_().find(x => x.date === date && x.time === time);
    if (!b) return { ok: false, error: 'notfound' };
    cancelBooking_(b, true);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

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
  peopleSheet_();
  slotsSheet_();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('reminderJob').timeBased().everyMinutes(15).create();
}
