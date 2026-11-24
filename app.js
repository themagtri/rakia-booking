(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const TZ = CFG.timezone || "Asia/Jerusalem";
  // מצב הדגמה: כשעדיין לא הוגדר שרת, האתר עובד בלי שמירה אמיתית
  const DEMO = !CFG.apiUrl;
  const WEEKDAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
  const WA_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z"/></svg>';

  const state = {
    duration: 50,
    slots: {},          // { "YYYY-MM-DD": ["HH:mm", ...] } — שעון ישראל
    taken: new Set(),   // "YYYY-MM-DD HH:mm"
    user: null,         // { email, name, picture, token }
    mine: [],           // [{ date, time, meetLink }]
    profile: null,      // { fullName, phone } — נשמר אחרי ההרשמה הראשונה
    isOwner: false,     // מצב ניהול (לורן)
    all: [],            // כל המפגשים הקרובים (רק לבעלים)
    view: null,         // { y, m } (m = 0..11)
    selected: null,     // "YYYY-MM-DD"
    busy: false,
    // טופס פתיחת מועדים (רק לבעלים)
    admin: { zone: "il", times: [], repeat: "none", days: new Set(), until: "month", untilDate: "" }
  };

  const $ = (id) => document.getElementById(id);

  /* ---------- תאריכים ושעות ---------- */

  function tzOffsetMinutes(ts) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).formatToParts(new Date(ts));
    const p = {};
    parts.forEach((x) => (p[x.type] = x.value));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    return Math.round((asUTC - ts) / 60000);
  }

  /** שעה בשעון ישראל → רגע בזמן */
  function slotInstant(dateStr, timeStr) {
    const [y, mo, d] = dateStr.split("-").map(Number);
    const [h, mi] = timeStr.split(":").map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    return new Date(guess - tzOffsetMinutes(guess) * 60000);
  }

  /** שעה בשעון המחשב → רגע בזמן */
  function localInstant(dateStr, timeStr) {
    const [y, mo, d] = dateStr.split("-").map(Number);
    const [h, mi] = timeStr.split(":").map(Number);
    return new Date(y, mo - 1, d, h, mi);
  }

  /** רגע בזמן → { date, time } בשעון ישראל */
  function israelParts(dt) {
    return {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(dt),
      time: new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(dt)
    };
  }

  /** רגע בזמן → { date, time } בשעון המחשב */
  function localParts(dt) {
    return {
      date: new Intl.DateTimeFormat("en-CA").format(dt),
      time: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(dt)
    };
  }

  function todayStr() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); }
  function ymd(y, m, d) { return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10); }
  function addDays(ds, n) { const [y, m, d] = ds.split("-").map(Number); return ymd(y, m - 1, d + n); }
  function weekday(ds) { const [y, m, d] = ds.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  function endOfMonth(ds, plus) { const [y, m] = ds.split("-").map(Number); return ymd(y, m + (plus || 0), 0); }
  function monthKey(dateStr) { return dateStr.slice(0, 7); }
  function isFuture(dateStr, timeStr) { return slotInstant(dateStr, timeStr).getTime() > Date.now(); }
  function shortDate(ds) { return +ds.slice(8) + "." + +ds.slice(5, 7); }

  function fmtLongDate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
      .format(new Date(Date.UTC(y, m - 1, d)));
  }

  function fmtMonth(y, m) {
    return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(y, m, 1)));
  }

  /* שעון מקומי — לפי אזור הזמן שמוגדר במחשב עצמו (לא לפי הרשת/IP, ולכן VPN לא משפיע) */
  function deviceZoneLabel() {
    let z = "";
    try { z = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* */ }
    const city = z.split("/").pop().replace(/_/g, " ");
    const off = -new Date().getTimezoneOffset();
    const a = Math.abs(off);
    return city + " (GMT" + (off >= 0 ? "+" : "-") + Math.floor(a / 60) + (a % 60 ? ":" + String(a % 60).padStart(2, "0") : "") + ")";
  }

  function sameZoneAsIsrael() {
    const now = Date.now();
    return -new Date(now).getTimezoneOffset() === tzOffsetMinutes(now);
  }

  function dayShiftLabel(fromDate, toDate) {
    if (toDate === fromDate) return "";
    return toDate > fromDate ? " (למחרת)" : " (יום קודם)";
  }

  /** שעה בישראל → איך היא נראית אצלך */
  function localTime(dateStr, timeStr) {
    const p = localParts(slotInstant(dateStr, timeStr));
    return p.time + dayShiftLabel(dateStr, p.date);
  }

  /* ---------- נתונים ---------- */

  function freeTimes(dateStr) {
    return (state.slots[dateStr] || []).filter((t) => isFuture(dateStr, t));
  }

  /** כל השעות שמוצגות ביום: מועדים פתוחים, ולבעלים גם כל מפגש שנקבע (גם אם המועד שלו כבר לא ברשימת הפתוחים) */
  function dayTimes(dateStr) {
    const set = new Set(freeTimes(dateStr));
    if (state.isOwner) state.all.forEach((b) => { if (b.date === dateStr && isFuture(b.date, b.time)) set.add(b.time); });
    return Array.from(set).sort();
  }

  function hasFree(dateStr) {
    return freeTimes(dateStr).some((t) => !state.taken.has(dateStr + " " + t));
  }

  function hasBooked(dateStr) {
    return freeTimes(dateStr).some((t) => state.taken.has(dateStr + " " + t));
  }

  function bookedThisMonth(dateStr) {
    const mk = monthKey(dateStr);
    return state.mine.find((b) => monthKey(b.date) === mk) || null;
  }

  function bookingAt(ds, t) {
    return state.all.find((b) => b.date === ds && b.time === t) || null;
  }

  async function api(payload) {
    const res = await fetch(CFG.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // נמנע מבקשת preflight
      body: JSON.stringify(payload)
    });
    return res.json();
  }

  /* זיכרון מקומי: הנתונים מהביקור הקודם מוצגים מיד, ומתעדכנים ברקע מהשרת.
     ההרשמה עצמה תמיד נבדקת מול השרת, כך שמועד שנתפס בינתיים לא יירשם פעמיים. */
  const CACHE_KEY = (email) => "rakia-init:" + String(email).toLowerCase();

  function applyInit(data) {
    state.duration = data.duration || 50;
    state.slots = data.slots || {};
    state.taken = new Set(data.taken || []);
    state.mine = data.bookings || [];
    state.profile = data.profile || null;
    state.isOwner = !!data.isOwner;
    state.all = data.all || [];
  }

  function readCache(email) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY(email)) || "null");
      if (c && Date.now() - c.at < 7 * 24 * 3600 * 1000) return c.data;
    } catch (e) { /* אין זיכרון זמין */ }
    return null;
  }

  function writeCache(email, data) {
    try { localStorage.setItem(CACHE_KEY(email), JSON.stringify({ at: Date.now(), data })); } catch (e) { /* */ }
  }

  function setSyncing(on) {
    const el = $("syncing");
    if (el) el.hidden = !on;
  }

  /** טוען הכול אחרי התחברות: מועדים, תפוסים, המפגשים שלי, ואם זה הבעלים — גם ניהול */
  async function loadInit() {
    if (!state.user) return;
    if (DEMO) return;
    setSyncing(true);
    try {
      const data = await api({ action: "init", idToken: state.user.token });
      if (data.ok) {
        applyInit(data);
        writeCache(state.user.email, data);
      } else if (data.error === "auth") {
        toast("פג תוקף ההתחברות. התנתקו והתחברו שוב.");
      }
    } catch (e) {
      toast("לא הצלחנו לטעון את לוח המועדים. נסו לרענן את הדף.");
    } finally {
      setSyncing(false);
    }
  }

  /* ---------- התחברות עם Google ---------- */

  function decodeJwt(token) {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(atob(b64).split("").map((c) =>
      "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
    return JSON.parse(json);
  }

  async function onCredential(resp) {
    const info = decodeJwt(resp.credential);
    state.user = { email: info.email, name: info.name || info.email, picture: info.picture || "", token: resp.credential };
    renderAccount();
    // מציגים מיד את מה שנשמר מהביקור הקודם, ובמקביל מביאים מהשרת את המצב העדכני
    const cached = DEMO ? null : readCache(info.email);
    if (cached) { applyInit(cached); renderAll(); }
    else { $("slots").innerHTML = '<p class="muted center">טוענים את המועדים...</p>'; }
    await loadInit();
    renderAll();
  }

  function initGoogle() {
    if (!CFG.googleClientId) {
      // הדגמה: כפתור התחברות מדומה. להוסיף ?owner לכתובת כדי לראות את מצב הניהול
      const b = document.createElement("button");
      b.className = "btn"; b.type = "button"; b.textContent = "התחברות עם Google (הדגמה)";
      b.onclick = () => {
        state.user = { email: "demo@example.com", name: "משתמש לדוגמה", picture: "", token: "" };
        state.slots = demoSlots();
        if (/[?&]owner/.test(location.search)) {
          state.isOwner = true;
          const ds = Object.keys(state.slots).sort()[0];
          state.all = [{ name: "דנה כהן", email: "dana@example.com", phone: "050-1234567", date: ds,
            time: state.slots[ds][0], meetLink: "https://meet.google.com/abc-defg-hij" }];
          state.taken.add(ds + " " + state.slots[ds][0]);
        }
        renderAccount(); renderAll();
      };
      $("gsiButton").appendChild(b);
      return;
    }
    const start = () => {
      google.accounts.id.initialize({ client_id: CFG.googleClientId, callback: onCredential, auto_select: true, ux_mode: "popup" });
      google.accounts.id.renderButton($("gsiButton"), { theme: "outline", size: "large", text: "signin_with", shape: "pill", locale: "he" });
      google.accounts.id.prompt();
    };
    if (window.google && google.accounts) start();
    else window.addEventListener("load", start);
  }

  function demoSlots() {
    const out = {};
    const t = todayStr();
    [2, 3, 7, 9, 14].forEach((n, i) => { out[addDays(t, n)] = i % 2 ? ["17:00", "18:00"] : ["10:00", "11:00"]; });
    return out;
  }

  function signOut() {
    if (window.google && google.accounts && CFG.googleClientId) google.accounts.id.disableAutoSelect();
    state.user = null; state.mine = []; state.isOwner = false; state.all = []; state.profile = null;
    state.slots = {}; state.taken = new Set(); state.selected = null;
    renderAccount(); renderAll();
  }

  /* ---------- תצוגה ---------- */

  function renderAccount() {
    const u = state.user;
    $("signedOut").hidden = !!u;
    $("signedIn").hidden = !u;
    // המועדים מוצגים רק אחרי התחברות
    $("gate").hidden = !!u;
    $("calCard").hidden = !u;
    $("slots").hidden = !u;
    if (u) {
      $("userName").textContent = u.name;
      $("userEmail").textContent = u.email;
      $("userPic").hidden = !u.picture;
      if (u.picture) $("userPic").src = u.picture;
    }
  }

  function fixPhone(p) {
    const v = String(p || "").trim();
    return /^5\d{8}$/.test(v) ? "0" + v : v;   // ה-0 שנעלם כש-Sheets שמר את המספר כמספר
  }

  /* ---------- תזכורת בוואטסאפ (נפתחת בוואטסאפ של לורן עם הודעה מוכנה) ---------- */

  function intlPhone(p) {
    const d = String(p || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.startsWith("972")) return d;
    if (d.startsWith("0")) return "972" + d.slice(1);
    if (/^5\d{8}$/.test(d)) return "972" + d;
    return d;   // מספר בינלאומי אחר
  }

  function relativeDay(ds) {
    const t = todayStr();
    if (ds === t) return "היום";
    if (ds === addDays(t, 1)) return "מחר";
    return "ב" + fmtLongDate(ds);
  }

  function waReminderLink(b) {
    const phone = intlPhone(b.phone);
    if (!phone) return "";
    const first = String(b.name || "").trim().split(/\s+/)[0] || "";
    const msg = "היי " + first + ", תזכורת קטנה למפגש שלנו " + relativeDay(b.date) + " בשעה " + b.time + " (שעון ישראל) 🌿" +
      (b.meetLink ? "\nקישור למפגש ב-Google Meet:\n" + b.meetLink : "") +
      "\nנתראה!\nלורן";
    return "https://wa.me/" + phone + "?text=" + encodeURIComponent(msg);
  }

  /** "המפגשים שלי" ליום אחד, עם חצים למעבר בין ימים (רק לבעלים) */
  function renderOwner() {
    const box = $("ownerPanel");
    if (!state.isOwner) { box.hidden = true; return; }
    box.hidden = false;
    const today = todayStr();
    if (!state.agendaDay) state.agendaDay = today;
    const ds = state.agendaDay;
    const same = sameZoneAsIsrael();
    const dayList = state.all.filter((b) => b.date === ds).sort((a, b) => a.time.localeCompare(b.time));
    const next = state.all.filter((b) => b.date > ds).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
    const prev = state.all.filter((b) => b.date < ds && b.date >= today).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))[0];
    const arrowR = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const arrowL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    let html = '<div class="agenda-head">' +
      '<button type="button" class="nav" id="agPrev" aria-label="היום הקודם"' + (ds <= today ? " disabled" : "") + ">" + arrowR + "</button>" +
      '<div class="agenda-title"><h3>' + (ds === today ? "היום · " : ds === addDays(today, 1) ? "מחר · " : "") + fmtLongDate(ds) +
      (dayList.length ? ' <span class="count">' + dayList.length + "</span>" : "") + "</h3>" +
      '<p class="meta">המפגשים שלי · מופיע רק לך' + (same ? "" : " · שעון מקומי: " + escapeHtml(deviceZoneLabel())) + "</p></div>" +
      '<button type="button" class="nav" id="agNext" aria-label="היום הבא">' + arrowL + "</button></div>";

    if (!dayList.length) {
      html += '<p class="muted agenda-empty">אין מפגשים ביום הזה.</p>';
    } else {
      html += '<ul class="agenda">' + dayList.map((b) => {
        const phone = fixPhone(b.phone);
        return '<li class="upcoming" data-d="' + b.date + '" data-t="' + b.time + '" tabindex="0" role="button" title="פרטים וביטול">' +
          '<span class="ag-time"><b>' + b.time + "</b>" + (same ? "" : "<small>" + localTime(b.date, b.time) + " אצלך</small>") + "</span>" +
          '<span class="ag-who"><strong>' + escapeHtml(b.name) + "</strong>" +
          "<small>" + escapeHtml(b.email) + (phone ? ' · <a href="tel:' + escapeHtml(phone.replace(/[^\d+]/g, "")) + '" dir="ltr">' + escapeHtml(phone) + "</a>" : "") + "</small></span>" +
          '<span class="ag-actions">' +
          (waReminderLink(b) ? '<a class="ag-wa" href="' + escapeHtml(waReminderLink(b)) + '" target="_blank" rel="noopener" title="תזכורת בוואטסאפ">' +
            WA_ICON + "<span>תזכורת</span></a>" : "") +
          (b.meetLink ? '<a class="ag-meet" href="' + escapeHtml(b.meetLink) + '" target="_blank" rel="noopener">Meet</a>' : "") +
          "</span></li>";
      }).join("") + "</ul>";
    }
    const links = [];
    if (ds !== today) links.push('<button type="button" class="link small" id="agToday">חזרה להיום</button>');
    if (prev) links.push('<button type="button" class="link small" data-jump="' + prev.date + '">המפגש הקודם: ' + fmtLongDate(prev.date) + "</button>");
    if (next) links.push('<button type="button" class="link small" data-jump="' + next.date + '">המפגש הבא: ' + fmtLongDate(next.date) + "</button>");
    if (links.length) html += '<div class="agenda-links">' + links.join("") + "</div>";
    box.innerHTML = html;

    const go = (d) => { state.agendaDay = d < today ? today : d; renderOwner(); };
    $("agPrev").onclick = () => go(addDays(ds, -1));
    $("agNext").onclick = () => go(addDays(ds, 1));
    if ($("agToday")) $("agToday").onclick = () => go(today);
    box.querySelectorAll("[data-jump]").forEach((b) => (b.onclick = () => go(b.dataset.jump)));
    box.querySelectorAll("li.upcoming").forEach((li) => {
      const open = (e) => { if (e.target.closest("a")) return; showBooking(li.dataset.d, li.dataset.t); };
      li.onclick = open;
      li.onkeydown = (e) => { if (e.key === "Enter") open(e); };
    });
  }

  function renderMine() {
    const box = $("myBookings");
    const upcoming = state.mine.filter((b) => isFuture(b.date, b.time));
    if (!state.user || state.isOwner || upcoming.length === 0) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = "<h3>המפגשים שלך</h3><ul>" + upcoming.map((b) =>
      "<li>" + fmtLongDate(b.date) + " בשעה " + b.time +
      (b.meetLink ? ' · <a href="' + escapeHtml(b.meetLink) + '" target="_blank" rel="noopener">קישור ל-Meet</a>' : "") +
      "</li>").join("") + "</ul>";
  }

  function monthBounds() {
    const t = todayStr();
    const min = { y: +t.slice(0, 4), m: +t.slice(5, 7) - 1 };
    if (state.isOwner) {
      const mm = min.m + 12;
      return { min, max: { y: min.y + Math.floor(mm / 12), m: mm % 12 } };
    }
    let max = { ...min };
    Object.keys(state.slots).forEach((d) => {
      if (!state.slots[d].length) return;
      const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1;
      if (y * 12 + m > max.y * 12 + max.m) max = { y, m };
    });
    return { min, max };
  }

  function renderCalendar() {
    const { y, m } = state.view;
    const { min, max } = monthBounds();
    $("monthTitle").textContent = fmtMonth(y, m);
    $("prevMonth").disabled = y * 12 + m <= min.y * 12 + min.m;
    $("nextMonth").disabled = y * 12 + m >= max.y * 12 + max.m;
    $("ownerHint").hidden = !state.isOwner;
    renderOwnerTools();   // הכפתורים תלויים בחודש המוצג ובמועדים
    $("legendBooked").hidden = !state.isOwner;

    const grid = $("grid");
    grid.innerHTML = "";
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();             // ראשון = 0
    const trail = 6 - new Date(Date.UTC(y, m, lastDay)).getUTCDay();  // השלמת השבוע האחרון
    const today = todayStr();

    const MAX_CHIPS = window.innerWidth < 560 ? 2 : 4;

    for (let i = -lead; i < lastDay + trail; i++) {
      const ds = ymd(y, m, 1 + i);
      const inMonth = i >= 0 && i < lastDay;
      const avail = hasFree(ds);
      const clickable = state.isOwner ? ds >= today : avail;

      // קוביות בתוך היום: פנוי (ירוק), ולבעלים גם מפגש שנקבע (זהוב, עם שם)
      const chips = [];
      dayTimes(ds).forEach((t) => {
        const isTaken = state.taken.has(ds + " " + t) || !!(state.isOwner && bookingAt(ds, t));
        if (!isTaken) chips.push({ t, kind: "free" });
        else if (state.isOwner) chips.push({ t, kind: "booked", b: bookingAt(ds, t) });
      });

      const cell = document.createElement("div");
      cell.className = "day" + (inMonth ? "" : " other") + (ds === today ? " today" : "") +
        (avail ? " available" : "") + (clickable ? " clickable" : " disabled") + (ds === state.selected ? " selected" : "");
      cell.setAttribute("role", "button");
      cell.setAttribute("aria-disabled", String(!clickable));
      cell.setAttribute("aria-label", fmtLongDate(ds) + (avail ? " – יש מועדים פנויים" : ""));
      if (clickable) {
        cell.tabIndex = 0;
        cell.onclick = () => selectDay(ds);
        cell.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectDay(ds); } };
      }

      let html = '<span class="num">' + +ds.slice(8) + '</span><span class="cchips">';
      chips.slice(0, MAX_CHIPS).forEach((c) => {
        if (c.kind === "free") {
          html += '<button type="button" class="cchip free" data-t="' + c.t + '" tabindex="-1">' + c.t + "</button>";
        } else {
          const name = c.b ? escapeHtml(c.b.name.split(" ")[0]) : "";
          html += '<button type="button" class="cchip booked" data-t="' + c.t + '" tabindex="-1" title="' +
            (c.b ? escapeHtml(c.b.name) : "") + '">' + c.t + (name ? " <b>" + name + "</b>" : "") + "</button>";
        }
      });
      if (chips.length > MAX_CHIPS) html += '<span class="more">+' + (chips.length - MAX_CHIPS) + "</span>";
      html += "</span>";
      cell.innerHTML = html;

      // לחיצה על קובייה: נרשם → ישר לאישור; בעלים → פרטי המפגש / ניהול היום
      cell.querySelectorAll(".cchip").forEach((chip) => {
        chip.onclick = (e) => {
          e.stopPropagation();
          const t = chip.dataset.t;
          if (chip.classList.contains("booked")) return showBooking(ds, t);
          if (state.isOwner) return selectDay(ds);
          state.selected = ds; renderCalendar(); renderSlots();
          if (!bookedThisMonth(ds)) confirmBooking(ds, t);
        };
      });
      grid.appendChild(cell);
    }
  }

  /** פרטי מפגש שנקבע (רק לבעלים) */
  function showBooking(ds, t) {
    const b = bookingAt(ds, t);
    const same = sameZoneAsIsrael();
    let body = "<p><strong>" + fmtLongDate(ds) + "</strong> · " + t + " שעון ישראל" +
      (same ? "" : '<br><span class="muted">' + localTime(ds, t) + " אצלך</span>") + "</p>";
    if (b) {
      body += '<dl class="info">' +
        "<dt>שם</dt><dd>" + escapeHtml(b.name) + "</dd>" +
        '<dt>אימייל</dt><dd><a href="mailto:' + escapeHtml(b.email) + '">' + escapeHtml(b.email) + "</a></dd>" +
        (b.phone ? '<dt>טלפון</dt><dd><a dir="ltr" href="tel:' + escapeHtml(fixPhone(b.phone).replace(/[^\d+]/g, "")) + '">' + escapeHtml(fixPhone(b.phone)) + "</a></dd>" : "") +
        "</dl>";
    }
    const actions = [];
    if (b && b.meetLink) actions.push({ label: "כניסה ל-Meet", primary: true, onClick: () => window.open(b.meetLink, "_blank", "noopener") });
    if (b && waReminderLink(b)) actions.push({ label: "תזכורת בוואטסאפ", onClick: () => window.open(waReminderLink(b), "_blank", "noopener") });
    actions.push({ label: "ביטול המפגש", danger: true, onClick: () => confirmCancel(ds, t, b) });
    actions.push({ label: "סגירה", onClick: closeModal });
    modal(b ? b.name : "מפגש שנקבע", body, actions);
  }

  function confirmCancel(ds, t, b) {
    const who = b ? escapeHtml(b.name) : "המשתתף/ת";
    modal("לבטל את המפגש?",
      "<p>המפגש של <strong>" + who + "</strong> ב" + fmtLongDate(ds) + " בשעה " + t + " יבוטל.</p>" +
      '<p class="muted">יישלח אימייל ביטול, האירוע יימחק מהיומנים, והמועד ייפתח מחדש להרשמה.</p>',
      [
        { label: "כן, לבטל את המפגש", danger: true, onClick: (e) => cancelMeeting(ds, t, e.target) },
        { label: "חזרה", onClick: () => showBooking(ds, t) }
      ]);
  }

  async function cancelMeeting(ds, t, btn) {
    if (state.busy) return;
    state.busy = true;
    btn.disabled = true; btn.textContent = "מבטלים...";
    try {
      let res;
      if (DEMO) {
        state.all = state.all.filter((x) => !(x.date === ds && x.time === t));
        state.taken.delete(ds + " " + t);
        res = { ok: true };
      } else {
        res = await api({ action: "cancelBooking", idToken: state.user.token, date: ds, time: t });
        if (res.ok) await loadInit();
      }
      closeModal();
      if (res.ok) { renderAll(); toast("המפגש בוטל, ונשלח אימייל ביטול"); }
      else toast(errorText(res.error));
    } catch (e) {
      closeModal();
      toast("משהו השתבש בחיבור. נסו שוב.");
    } finally {
      state.busy = false;
    }
  }

  function selectDay(ds) {
    state.selected = ds;
    if (state.isOwner && state.admin.repeat === "none") state.admin.days = new Set([weekday(ds)]);
    renderCalendar(); renderSlots();
    if (window.innerWidth < 700) $("slots").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderSlots() {
    if (state.isOwner) return renderAdminDay();
    const box = $("slots");
    const ds = state.selected;
    if (!ds || !hasFree(ds)) {
      box.innerHTML = '<p class="muted center">' + (Object.keys(state.slots).length
        ? "בחרו יום מסומן בלוח כדי לראות את השעות הפנויות."
        : "כרגע אין מועדים פתוחים. כדאי לחזור לבדוק בהמשך.") + "</p>";
      return;
    }
    const existing = bookedThisMonth(ds);
    let html = "<h3>" + fmtLongDate(ds) + "</h3>" +
      '<p class="meta">מפגש של ' + state.duration + " דקות · שעון ישראל</p>" +
      '<div class="times">';
    freeTimes(ds).forEach((t) => {
      const taken = state.taken.has(ds + " " + t);
      html += '<button type="button" class="time" data-t="' + t + '"' + (taken || existing ? " disabled" : "") +
        (taken ? ' aria-label="' + t + ' תפוס"' : "") + ">" + t + "</button>";
    });
    html += "</div>";
    if (existing) {
      html += '<p class="hint">כבר נרשמתם למפגש החודש (' + fmtLongDate(existing.date) + " בשעה " + existing.time +
        "). אפשר להירשם למפגש אחד בכל חודש.</p>";
    }
    box.innerHTML = html;
    box.querySelectorAll(".time:not(:disabled)").forEach((b) => {
      b.onclick = () => confirmBooking(ds, b.dataset.t);
    });
  }

  /* ---------- ניקוי מועדים בבת אחת (רק לבעלים) ---------- */

  function freeSlotList(filterMonth) {
    const out = [];
    Object.keys(state.slots).forEach((d) => {
      if (filterMonth && monthKey(d) !== filterMonth) return;
      freeTimes(d).forEach((t) => { if (!state.taken.has(d + " " + t)) out.push([d, t]); });
    });
    return out;
  }

  /* ---------- דו"ח חודשי (רק לבעלים) ---------- */

  function prevMonthStr() {
    const t = todayStr();
    let y = +t.slice(0, 4), m = +t.slice(5, 7) - 1;
    if (m === 0) { m = 12; y--; }
    return y + "-" + String(m).padStart(2, "0");
  }

  function renderReportBox() {
    const box = $("ownerReport");
    box.hidden = !state.isOwner;
    if (!state.isOwner) return;
    const inp = $("reportMonth");
    if (!inp.value) inp.value = prevMonthStr();
    inp.max = todayStr().slice(0, 7);
    $("makeReport").onclick = () => makeReport(inp.value);
  }

  async function makeReport(mk) {
    if (!/^\d{4}-\d{2}$/.test(mk) || state.busy) return;
    const [y, m] = mk.split("-").map(Number);
    const monthName = fmtMonth(y, m - 1);
    const btn = $("makeReport");
    state.busy = true;
    btn.disabled = true; btn.textContent = "מפיקים דו\"ח... (עד חצי דקה)";
    try {
      let res;
      if (DEMO) {
        await new Promise((r) => setTimeout(r, 800));
        res = { ok: true, url: "https://docs.google.com/spreadsheets/", count: 3, total: 540, excluded: ["06/11/2026 11:00 · לדוגמה (בוטל ביומן)"],
          message: "שלום,\n\nמצורף דו\"ח פגישות הייעוץ (1:1, Google Meet) לתקופה מ-01/11/2026 עד 30/11/2026.\nסה\"כ 3 פגישות / 3 שעות לחיוב, לפי תעריף של 180 ₪ לשעה.\nסה\"כ לתשלום: 540 ₪.\n\nאשמח לאישורכם לדו\"ח, כדי שאוכל להפיק חשבונית/קבלה.\n\nתודה,\nלורן זילברשטין" };
      } else {
        res = await api({ action: "report", idToken: state.user.token, month: mk });
      }
      if (!res.ok) { toast(errorText(res.error)); return; }
      const body =
        '<dl class="info"><dt>חודש</dt><dd>' + monthName + "</dd>" +
        "<dt>שעות לחיוב</dt><dd>" + res.count + "</dd>" +
        "<dt>סה\"כ לתשלום</dt><dd>" + res.total.toLocaleString("en-US") + " ₪</dd></dl>" +
        (res.excluded && res.excluded.length
          ? '<p class="muted small" style="margin-top:12px">לא נכללו: ' + res.excluded.map(escapeHtml).join(" · ") + "</p>" : "") +
        '<p class="label" style="margin:16px 0 6px">נוסח הודעה לשליחה לחברה</p>' +
        '<pre class="msg" id="reportMsg">' + escapeHtml(res.message || "") + "</pre>" +
        '<p class="muted small">הדו"ח נשלח גם לאימייל שלך.</p>';
      modal('הדו"ח של ' + monthName + " מוכן", body, [
        { label: "פתיחת הדו\"ח", primary: true, onClick: () => window.open(res.url, "_blank", "noopener") },
        { label: "העתקת ההודעה", onClick: async (e) => {
          try { await navigator.clipboard.writeText(res.message || ""); e.target.textContent = "הועתק ✓"; }
          catch (err) { const r = document.createRange(); r.selectNodeContents($("reportMsg")); getSelection().removeAllRanges(); getSelection().addRange(r); }
        } },
        { label: "סגירה", onClick: closeModal }
      ]);
    } catch (e) {
      toast("משהו השתבש בחיבור. נסו שוב.");
    } finally {
      state.busy = false;
      btn.disabled = false; btn.textContent = "הפקת דו\"ח";
    }
  }

  function renderOwnerTools() {
    renderReportBox();
    const box = $("ownerTools");
    box.hidden = !state.isOwner;
    if (!state.isOwner) return;
    const { y, m } = state.view;
    const mk = ymd(y, m, 1).slice(0, 7);
    const monthName = fmtMonth(y, m);
    const inMonth = freeSlotList(mk);
    const all = freeSlotList(null);
    const bm = $("clearMonth"), ba = $("clearAll");
    bm.textContent = "ריקון המועדים של " + monthName + (inMonth.length ? " (" + inMonth.length + ")" : "");
    ba.textContent = "ריקון כל המועדים" + (all.length ? " (" + all.length + ")" : "");
    bm.disabled = !inMonth.length;
    ba.disabled = !all.length;
    bm.onclick = () => confirmClear(inMonth, "כל " + inMonth.length + " המועדים הפנויים של " + monthName);
    ba.onclick = () => confirmClear(all, "כל " + all.length + " המועדים הפנויים, בכל החודשים");
  }

  function confirmClear(list, what) {
    if (!list.length) return;
    modal("למחוק את המועדים?",
      "<p>עומדים להימחק <strong>" + what + "</strong>.</p>" +
      '<p class="muted">מפגשים שכבר נקבעו לא יימחקו. אי אפשר לבטל את המחיקה, אבל אפשר תמיד לפתוח מועדים מחדש.</p>' +
      "<p><strong>האם למחוק?</strong></p>",
      [
        { label: "כן, למחוק", danger: true, onClick: async (e) => {
          e.target.disabled = true; e.target.textContent = "מוחקים...";
          await removeSlots(list);
          closeModal();
        } },
        { label: "לא", primary: true, onClick: closeModal }
      ]);
  }

  function renderAll() {
    renderOwnerTools();
    renderOwner();
    renderMine();
    renderCalendar();
    renderSlots();
  }

  /* ---------- מצב ניהול: פתיחה וסגירה של מועדים ---------- */

  function renderAdminDay() {
    const box = $("slots");
    const ds = state.selected;
    if (!ds) {
      box.innerHTML = '<p class="muted center">לחצו על יום בלוח כדי לפתוח בו מועדים, או לראות ולסגור את המועדים שכבר פתוחים בו.</p>';
      return;
    }
    const A = state.admin;
    const same = sameZoneAsIsrael();
    if (same) A.zone = "il";
    const times = dayTimes(ds);

    let html = '<div class="admin">' +
      "<h3>" + fmtLongDate(ds) + "</h3>" +
      '<p class="meta">ניהול מועדים · מפגש של ' + state.duration + " דקות</p>";

    // מועדים קיימים ביום הזה
    html += '<div class="admin-sec"><h4>מועדים פתוחים ביום הזה</h4>';
    if (!times.length) {
      html += '<p class="muted small">עדיין אין מועדים ביום הזה.</p>';
    } else {
      html += '<ul class="slot-list">' + times.map((t) => {
        const b = bookingAt(ds, t);
        const isTaken = state.taken.has(ds + " " + t) || !!b;
        return '<li><span class="t">' + t + '</span><span class="tz">ישראל' +
          (same ? "" : ' · <span class="local-inline">' + localTime(ds, t) + " אצלך</span>") + "</span>" +
          (isTaken
            ? '<button type="button" class="booked-by" data-info="' + t + '">נקבע' + (b ? ": " + escapeHtml(b.name) : "") + " · פרטים</button>"
            : '<button type="button" class="x" data-del="' + t + '" aria-label="סגירת המועד ' + t + '">סגירה</button>') +
          "</li>";
      }).join("") + "</ul>";
      if (times.some((t) => !state.taken.has(ds + " " + t))) {
        html += '<button type="button" class="link small" id="delDay">סגירת כל המועדים הפנויים ביום הזה</button>';
      }
    }
    html += "</div>";

    // פתיחת מועדים חדשים
    html += '<div class="admin-sec"><h4>פתיחת מועדים חדשים</h4>';
    if (!same) {
      html += '<p class="label">השעה שאני מזין היא לפי</p><div class="seg" role="radiogroup">' +
        '<button type="button" role="radio" data-zone="il" aria-checked="' + (A.zone === "il") + '">שעון ישראל</button>' +
        '<button type="button" role="radio" data-zone="local" aria-checked="' + (A.zone === "local") + '">השעה אצלי · ' +
        escapeHtml(deviceZoneLabel()) + "</button></div>";
    }
    html += '<p class="label">שעות</p><div class="time-add">' +
      '<input type="time" id="aTime" step="300" aria-label="שעה">' +
      '<button type="button" class="btn" id="aAdd">הוספה</button></div>' +
      '<p class="conv" id="aConv"></p>' +
      '<div class="chips" id="aChips"></div>';

    html += '<p class="label">חזרה</p><div class="seg" role="radiogroup">' +
      '<button type="button" role="radio" data-repeat="none" aria-checked="' + (A.repeat === "none") + '">רק ביום הזה</button>' +
      '<button type="button" role="radio" data-repeat="weekly" aria-checked="' + (A.repeat === "weekly") + '">חזרה שבועית</button></div>';

    html += '<div id="aRepeat"' + (A.repeat === "weekly" ? "" : " hidden") + ">" +
      '<p class="label">בימים</p><div class="wd">' +
      WEEKDAYS.map((w, i) => '<button type="button" data-wd="' + i + '" aria-pressed="' + A.days.has(i) + '">' + w + "</button>").join("") +
      '</div><div class="quick"><button type="button" class="link small" data-preset="weekdays">ימים א׳–ה׳</button>' +
      '<button type="button" class="link small" data-preset="all">כל השבוע</button></div>' +
      '<p class="label">עד</p><select id="aUntil">' +
      [["month", "סוף החודש הזה"], ["nextMonth", "סוף החודש הבא"], ["w4", "4 שבועות"], ["w8", "8 שבועות"], ["w12", "12 שבועות"], ["date", "תאריך מסוים..."]]
        .map(([v, l]) => '<option value="' + v + '"' + (A.until === v ? " selected" : "") + ">" + l + "</option>").join("") +
      '</select><input type="date" id="aUntilDate" value="' + A.untilDate + '" min="' + ds + '"' + (A.until === "date" ? "" : " hidden") + ">" +
      "</div>";

    html += '<div class="preview" id="aPreview"></div>' +
      '<button type="button" class="btn primary wide" id="aSave">פתיחת המועדים</button>' +
      "</div></div>";

    box.innerHTML = html;
    wireAdmin(ds);
    updateAdminPreview(ds);
  }

  function wireAdmin(ds) {
    const A = state.admin;
    const box = $("slots");

    box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => removeSlots([[ds, b.dataset.del]])));
    box.querySelectorAll("[data-info]").forEach((b) => (b.onclick = () => showBooking(ds, b.dataset.info)));
    if ($("delDay")) $("delDay").onclick = () => {
      const free = freeTimes(ds).filter((t) => !state.taken.has(ds + " " + t));
      if (confirm("לסגור " + free.length + " מועדים פנויים ב" + fmtLongDate(ds) + "?")) removeSlots(free.map((t) => [ds, t]));
    };

    box.querySelectorAll("[data-zone]").forEach((b) => (b.onclick = () => { A.zone = b.dataset.zone; renderAdminDay(); }));
    box.querySelectorAll("[data-repeat]").forEach((b) => (b.onclick = () => {
      A.repeat = b.dataset.repeat;
      if (!A.days.size) A.days = new Set([weekday(ds)]);
      renderAdminDay();
    }));
    box.querySelectorAll("[data-wd]").forEach((b) => (b.onclick = () => {
      const i = +b.dataset.wd;
      if (A.days.has(i)) A.days.delete(i); else A.days.add(i);
      b.setAttribute("aria-pressed", A.days.has(i));
      updateAdminPreview(ds);
    }));
    box.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => {
      A.days = new Set(b.dataset.preset === "all" ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4]);
      box.querySelectorAll("[data-wd]").forEach((x) => x.setAttribute("aria-pressed", A.days.has(+x.dataset.wd)));
      updateAdminPreview(ds);
    }));
    if ($("aUntil")) $("aUntil").onchange = (e) => {
      A.until = e.target.value;
      $("aUntilDate").hidden = A.until !== "date";
      updateAdminPreview(ds);
    };
    if ($("aUntilDate")) $("aUntilDate").oninput = (e) => { A.untilDate = e.target.value; updateAdminPreview(ds); };

    const timeInput = $("aTime");
    const addTime = () => {
      const v = timeInput.value;
      if (!/^\d{2}:\d{2}$/.test(v)) { timeInput.focus(); return; }
      if (!A.times.includes(v)) A.times.push(v);
      A.times.sort();
      timeInput.value = "";
      updateAdminPreview(ds);
      timeInput.focus();
    };
    $("aAdd").onclick = addTime;
    timeInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addTime(); } };
    timeInput.oninput = timeInput.onchange = () => updateAdminPreview(ds);
    $("aSave").onclick = () => saveSlots(ds);
  }

  /** המרה בין השעונים לשעה אחת, ביום שנבחר */
  function convert(ds, t) {
    if (state.admin.zone === "local") {
      const p = israelParts(localInstant(ds, t));
      return { il: p, text: p.time + " בישראל" + dayShiftLabel(ds, p.date) };
    }
    const lp = localParts(slotInstant(ds, t));
    return { il: { date: ds, time: t }, text: sameZoneAsIsrael() ? "" : lp.time + " אצלך" + dayShiftLabel(ds, lp.date) };
  }

  function updateConv(ds) {
    const v = $("aTime").value;
    const el = $("aConv");
    if (!/^\d{2}:\d{2}$/.test(v)) { el.textContent = ""; return; }
    const c = convert(ds, v);
    el.textContent = c.text ? "= " + c.text : "";
  }

  /** השעות שנבחרו: הרשימה + שעה שמוזנת כרגע בשדה (גם בלי ללחוץ "הוספה") */
  function currentTimes() {
    const list = state.admin.times.slice();
    const v = $("aTime") ? $("aTime").value : "";
    if (/^\d{2}:\d{2}$/.test(v) && !list.includes(v)) list.push(v);
    return list.sort();
  }

  /** כל המועדים (בשעון ישראל) שייפתחו לפי ההגדרות */
  function plannedSlots(ds) {
    const A = { ...state.admin, times: currentTimes() };
    let dates = [ds];
    if (A.repeat === "weekly") {
      let end;
      if (A.until === "month") end = endOfMonth(ds);
      else if (A.until === "nextMonth") end = endOfMonth(ds, 1);
      else if (A.until === "date") end = A.untilDate && A.untilDate >= ds ? A.untilDate : ds;
      else end = addDays(ds, 7 * +A.until.slice(1) - 1);
      dates = [];
      for (let d = ds; d <= end && dates.length < 400; d = addDays(d, 1)) if (A.days.has(weekday(d))) dates.push(d);
    }
    const out = [], seen = new Set();
    let past = 0, exists = 0;
    dates.forEach((d) => A.times.forEach((t) => {
      const c = convert(d, t).il;
      const key = c.date + " " + c.time;
      if (seen.has(key)) return;
      seen.add(key);
      if (!isFuture(c.date, c.time)) { past++; return; }
      if ((state.slots[c.date] || []).includes(c.time)) { exists++; return; }
      out.push([c.date, c.time]);
    }));
    out.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    return { list: out, past, exists, dates };
  }

  function updateAdminPreview(ds) {
    const A = state.admin;
    $("aChips").innerHTML = A.times.map((t) => {
      const c = convert(ds, t);
      return '<span class="chip">' + t + (c.text ? ' <small>→ ' + c.text + "</small>" : "") +
        '<button type="button" data-rm="' + t + '" aria-label="הסרת ' + t + '">×</button></span>';
    }).join("");
    $("aChips").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => {
      A.times = A.times.filter((x) => x !== b.dataset.rm);
      updateAdminPreview(ds);
    }));
    updateConv(ds);

    const p = plannedSlots(ds);
    const el = $("aPreview");
    const save = $("aSave");
    if (!currentTimes().length) {
      el.innerHTML = '<p class="muted small">בחרו שעה בשדה "שעות" למעלה. כדי לפתוח כמה שעות באותו יום, לחצו "הוספה" אחרי כל שעה.</p>';
      save.disabled = true;
      return;
    }
    if (A.repeat === "weekly" && !A.days.size) {
      el.innerHTML = '<p class="muted small">בחרו לפחות יום אחד בשבוע.</p>';
      save.disabled = true;
      return;
    }
    const n = p.list.length;
    let html = "<p><strong>" + (n === 1 ? "ייפתח מועד אחד" : n ? "ייפתחו " + n + " מועדים" : "אין מועדים חדשים לפתוח") + "</strong>" +
      (n ? " · " + (p.list[0][0] === p.list[n - 1][0] ? "ב-" + shortDate(p.list[0][0])
        : "מ-" + shortDate(p.list[0][0]) + " עד " + shortDate(p.list[n - 1][0])) : "") + "</p>";
    const notes = [];
    if (p.exists) notes.push(p.exists + " כבר פתוחים");
    if (p.past) notes.push(p.past + " כבר עברו");
    if (notes.length) html += '<p class="muted small">' + notes.join(" · ") + " ולכן לא ייפתחו שוב.</p>";
    if (n) {
      html += "<details><summary>הצגת הרשימה</summary><ul>" + p.list.map(([d, t]) =>
        "<li>" + fmtLongDate(d) + " · " + t + "</li>").join("") + "</ul></details>";
    }
    el.innerHTML = html;
    save.disabled = !n;
    save.textContent = n === 1 ? "פתיחת המועד" : n ? "פתיחת " + n + " מועדים" : "פתיחת המועדים";
  }

  async function saveSlots(ds) {
    const p = plannedSlots(ds);
    if (!p.list.length || state.busy) return;
    state.busy = true;
    const save = $("aSave");
    save.disabled = true; save.textContent = "פותחים...";
    try {
      let res;
      if (DEMO) {
        const slots = JSON.parse(JSON.stringify(state.slots));
        p.list.forEach(([d, t]) => { slots[d] = Array.from(new Set((slots[d] || []).concat(t))).sort(); });
        res = { ok: true, added: p.list.length, slots };
      } else {
        res = await api({ action: "addSlots", idToken: state.user.token, slots: p.list });
      }
      if (res.ok) {
        state.slots = res.slots;
        state.admin.times = [];
        renderCalendar(); renderAdminDay();   // מצייר מחדש, כך שגם שדה השעה מתאפס
        toast(res.added === 1 ? "המועד נפתח" : "נפתחו " + res.added + " מועדים");
      } else {
        toast(errorText(res.error));
        save.disabled = false; save.textContent = "פתיחת המועדים";
      }
    } catch (e) {
      toast("משהו השתבש בחיבור. נסו שוב.");
      save.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  async function removeSlots(list) {
    if (!list.length || state.busy) return;
    state.busy = true;
    try {
      let res;
      if (DEMO) {
        const slots = JSON.parse(JSON.stringify(state.slots));
        list.forEach(([d, t]) => { slots[d] = (slots[d] || []).filter((x) => x !== t); if (!slots[d].length) delete slots[d]; });
        res = { ok: true, removed: list.length, slots };
      } else {
        res = await api({ action: "removeSlots", idToken: state.user.token, slots: list });
      }
      if (res.ok) {
        state.slots = res.slots;
        renderCalendar(); renderAdminDay();
        toast(res.removed === 1 ? "המועד נסגר" : "נסגרו " + res.removed + " מועדים");
      } else {
        toast(errorText(res.error));
      }
    } catch (e) {
      toast("משהו השתבש בחיבור. נסו שוב.");
    } finally {
      state.busy = false;
    }
  }

  /* ---------- קביעת מפגש ---------- */

  function modal(title, bodyHtml, actions) {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = bodyHtml;
    const wrap = $("modalActions");
    wrap.innerHTML = "";
    actions.forEach((a) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn" + (a.primary ? " primary" : "") + (a.danger ? " danger" : ""); b.textContent = a.label;
      b.onclick = a.onClick;
      wrap.appendChild(b);
    });
    $("modal").hidden = false;
    const p = wrap.querySelector(".primary") || wrap.firstChild;
    if (p) p.focus();
  }
  function closeModal() { $("modal").hidden = true; }

  function confirmBooking(ds, t) {
    const firstTime = !state.profile;   // פרטים אישיים נאספים רק בהרשמה הראשונה
    let body = "<p><strong>" + fmtLongDate(ds) + "</strong> בשעה <strong>" + t + "</strong></p>";
    if (firstTime) {
      body +=
        '<p class="muted">זו ההרשמה הראשונה שלכם, אז נבקש פעם אחת שם מלא ומספר טלפון.</p>' +
        '<label class="field">שם מלא<input id="fFullName" type="text" autocomplete="name" maxlength="80" value="' +
        escapeHtml(state.user.name || "") + '"></label>' +
        '<label class="field">מספר טלפון<input id="fPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" dir="ltr" placeholder="050-0000000"></label>' +
        '<p class="field-error" id="fError" hidden></p>';
    }
    body += '<ul class="confirm-list">' +
      '<li><span class="ic">✉</span><span>אישור יישלח לאימייל<br><bdi class="em">' + escapeHtml(state.user.email) + "</bdi></span></li>" +
      '<li><span class="ic">📅</span><span>המפגש יתווסף ליומן Google שלכם, עם קישור ל-Google Meet</span></li>' +
      '<li><span class="ic">💬</span><span>לשינוי או ביטול יש לפנות ללורן בוואטסאפ, לפחות 24 שעות מראש</span></li>' +
      "</ul>";
    modal(firstTime ? "הרשמה ראשונה" : "אישור מפגש", body, [
      { label: "אישור ההרשמה", primary: true, onClick: (e) => book(ds, t, e.target, firstTime) },
      { label: "חזרה", onClick: closeModal }
    ]);
    if (firstTime) $("fFullName").focus();
  }

  function readProfileForm() {
    const fullName = $("fFullName").value.trim().replace(/\s+/g, " ");
    const phone = $("fPhone").value.trim();
    const err = $("fError");
    let msg = "";
    if (fullName.split(" ").filter(Boolean).length < 2) msg = "נא לכתוב שם מלא (שם פרטי ושם משפחה).";
    else if (!/^[+\d][\d\s\-()]*$/.test(phone) || phone.replace(/\D/g, "").length < 9) msg = "נא לכתוב מספר טלפון תקין.";
    err.textContent = msg; err.hidden = !msg;
    return msg ? null : { fullName, phone };
  }

  async function book(ds, t, btn, firstTime) {
    if (state.busy) return;
    let profile = null;
    if (firstTime) {
      profile = readProfileForm();
      if (!profile) return;
    }
    state.busy = true;
    btn.disabled = true; btn.textContent = "רושמים...";
    try {
      let res;
      if (DEMO) {
        await new Promise((r) => setTimeout(r, 500));
        res = { ok: true, booking: { date: ds, time: t } };
      } else {
        const payload = { action: "book", idToken: state.user.token, date: ds, time: t };
        if (profile) { payload.fullName = profile.fullName; payload.phone = profile.phone; }
        res = await api(payload);
      }
      if (res.ok) {
        state.taken.add(ds + " " + t);
        state.mine.push(res.booking);
        if (profile) state.profile = profile;
        renderAll();
        modal("המפגש נקבע בהצלחה",
          "<p>" + fmtLongDate(ds) + " בשעה " + t + "</p>" +
          '<p class="muted">שלחנו אישור לאימייל שלכם, והמפגש נוסף ליומן Google עם קישור ל-Google Meet. תזכורת תישלח יום לפני ושוב שעתיים לפני.' +
          (DEMO ? "<br>(מצב הדגמה: לא נשלח אימייל)" : "") + "</p>",
          [{ label: "סגירה", primary: true, onClick: closeModal }]);
      } else {
        await loadInit(); renderAll();
        modal("לא הצלחנו לקבוע", "<p>" + errorText(res.error) + "</p>",
          [{ label: "סגירה", primary: true, onClick: closeModal }]);
      }
    } catch (e) {
      modal("שגיאה", "<p>משהו השתבש בחיבור. נסו שוב בעוד רגע.</p>",
        [{ label: "סגירה", primary: true, onClick: closeModal }]);
    } finally {
      state.busy = false;
    }
  }

  function errorText(code) {
    return ({
      auth: "פג תוקף ההתחברות. התנתקו והתחברו שוב, ואז נסו שוב.",
      forbidden: "הפעולה הזו זמינה רק לבעלים.",
      taken: "מישהו אחר נרשם למועד הזה ממש עכשיו. בחרו מועד אחר.",
      limit: "כבר נרשמתם למפגש בחודש הזה. אפשר להירשם למפגש אחד בכל חודש.",
      invalid: "המועד הזה כבר לא זמין.",
      past: "המועד הזה כבר עבר.",
      profile: "חסרים שם מלא או מספר טלפון. נסו שוב."
    })[code] || "משהו השתבש. נסו שוב בעוד רגע.";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4000);
  }

  /* ---------- הפעלה ---------- */

  function shiftMonth(delta) {
    let { y, m } = state.view;
    m += delta;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    state.view = { y, m };
    state.selected = null;
    renderCalendar(); renderSlots();
  }

  function init() {
    $("signOut").onclick = signOut;
    $("prevMonth").onclick = () => shiftMonth(-1);
    $("nextMonth").onclick = () => shiftMonth(1);
    $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

    const t = todayStr();
    state.view = { y: +t.slice(0, 4), m: +t.slice(5, 7) - 1 };
    initGoogle();
    renderAll();
    // מספר הקוביות בכל יום תלוי ברוחב המסך
    let lastNarrow = window.innerWidth < 560;
    window.addEventListener("resize", () => {
      const narrow = window.innerWidth < 560;
      if (narrow !== lastNarrow) { lastNarrow = narrow; renderCalendar(); }
    });
  }

  init();
})();
