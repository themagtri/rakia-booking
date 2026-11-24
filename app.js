(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const TZ = CFG.timezone || "Asia/Jerusalem";
  // מצב הדגמה: כשעדיין לא הוגדר שרת, האתר עובד בלי שמירה אמיתית
  const DEMO = !CFG.apiUrl;

  const state = {
    duration: 50,
    slots: {},          // { "YYYY-MM-DD": ["HH:mm", ...] }
    taken: new Set(),   // "YYYY-MM-DD HH:mm"
    user: null,         // { email, name, picture, token }
    mine: [],           // [{ date, time, meetLink }]
    profile: null,      // { fullName, phone } — נשמר אחרי ההרשמה הראשונה
    isOwner: false,     // תצוגת בעלים (לורן): שעון ישראל + שעון מקומי
    all: [],            // כל המפגשים הקרובים (רק לבעלים)
    view: null,         // { y, m } (m = 0..11)
    selected: null,     // "YYYY-MM-DD"
    busy: false
  };

  const $ = (id) => document.getElementById(id);

  /* ---------- זמן בשעון ישראל ---------- */

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

  function slotInstant(dateStr, timeStr) {
    const [y, mo, d] = dateStr.split("-").map(Number);
    const [h, mi] = timeStr.split(":").map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    return new Date(guess - tzOffsetMinutes(guess) * 60000);
  }

  function todayStr() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  }

  function ymd(y, m, d) {
    const dt = new Date(Date.UTC(y, m, d));
    return dt.toISOString().slice(0, 10);
  }

  function monthKey(dateStr) { return dateStr.slice(0, 7); }

  function isFuture(dateStr, timeStr) {
    return slotInstant(dateStr, timeStr).getTime() > Date.now();
  }

  function fmtLongDate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Intl.DateTimeFormat("he-IL", {
      weekday: "long", day: "numeric", month: "long", timeZone: "UTC"
    }).format(new Date(Date.UTC(y, m - 1, d)));
  }

  /* שעון מקומי — לפי אזור הזמן שמוגדר במחשב עצמו (לא לפי הרשת/IP, ולכן VPN לא משפיע) */
  function deviceZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
  }

  function deviceZoneLabel() {
    const z = deviceZone();
    const city = z.split("/").pop().replace(/_/g, " ");
    const off = -new Date().getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const a = Math.abs(off);
    return city + " (GMT" + sign + Math.floor(a / 60) + (a % 60 ? ":" + String(a % 60).padStart(2, "0") : "") + ")";
  }

  function localTime(dateStr, timeStr) {
    const d = slotInstant(dateStr, timeStr);
    const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    const localDay = new Intl.DateTimeFormat("en-CA").format(d); // YYYY-MM-DD מקומי
    if (localDay === dateStr) return hm;
    return hm + (localDay > dateStr ? " (למחרת)" : " (יום קודם)");
  }

  function sameZoneAsIsrael() {
    const now = Date.now();
    return -new Date(now).getTimezoneOffset() === tzOffsetMinutes(now);
  }

  function fmtMonth(y, m) {
    return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(y, m, 1)));
  }

  /* ---------- נתונים ---------- */

  function freeTimes(dateStr) {
    const times = state.slots[dateStr] || [];
    return times.filter((t) => isFuture(dateStr, t));
  }

  function hasFree(dateStr) {
    return freeTimes(dateStr).some((t) => !state.taken.has(dateStr + " " + t));
  }

  function bookedThisMonth(dateStr) {
    const mk = monthKey(dateStr);
    return state.mine.find((b) => monthKey(b.date) === mk) || null;
  }

  async function loadAvailability() {
    const res = await fetch("availability.json?t=" + Date.now(), { cache: "no-store" });
    const data = await res.json();
    state.duration = data.durationMinutes || 50;
    state.slots = data.slots || {};
  }

  async function api(payload) {
    const res = await fetch(CFG.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // נמנע מבקשת preflight
      body: JSON.stringify(payload)
    });
    return res.json();
  }

  async function loadTaken() {
    if (DEMO) return;
    try {
      const data = await api({ action: "taken" });
      if (data.ok) state.taken = new Set(data.taken);
    } catch (e) {
      toast("לא הצלחנו לטעון את המועדים התפוסים. נסו לרענן את הדף.");
    }
  }

  async function loadMine() {
    if (!state.user) { state.mine = []; return; }
    if (DEMO) return;
    try {
      const data = await api({ action: "mine", idToken: state.user.token });
      if (data.ok) {
        state.mine = data.bookings;
        state.profile = data.profile || null;
        state.isOwner = !!data.isOwner;
        state.all = data.all || [];
      }
    } catch (e) { /* לא קריטי */ }
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
    await loadMine();
    renderAll();
  }

  function initGoogle() {
    if (!CFG.googleClientId) {
      // הדגמה: כפתור התחברות מדומה
      const b = document.createElement("button");
      b.className = "btn"; b.type = "button"; b.textContent = "התחברות עם Google (הדגמה)";
      b.onclick = () => {
        state.user = { email: "demo@example.com", name: "משתמש לדוגמה", picture: "", token: "" };
        // הדגמה של תצוגת הבעלים: להוסיף ?owner לכתובת
        if (/[?&]owner/.test(location.search)) {
          state.isOwner = true;
          state.all = demoOwnerList();
        }
        renderAccount(); renderAll();
      };
      $("gsiButton").appendChild(b);
      return;
    }
    const start = () => {
      google.accounts.id.initialize({
        client_id: CFG.googleClientId,
        callback: onCredential,
        auto_select: true,
        ux_mode: "popup"
      });
      google.accounts.id.renderButton($("gsiButton"), {
        theme: "outline", size: "large", text: "signin_with", shape: "pill", locale: "he"
      });
      google.accounts.id.prompt();
    };
    if (window.google && google.accounts) start();
    else window.addEventListener("load", start);
  }

  function signOut() {
    if (window.google && google.accounts && CFG.googleClientId) google.accounts.id.disableAutoSelect();
    state.user = null; state.mine = []; state.isOwner = false; state.all = []; state.profile = null;
    renderAccount(); renderAll();
  }

  function demoOwnerList() {
    const out = [];
    Object.keys(state.slots).sort().forEach((d) => {
      if (out.length < 3 && state.slots[d].length && isFuture(d, state.slots[d][0])) {
        out.push({ name: "נרשם/ת לדוגמה " + (out.length + 1), email: "example" + (out.length + 1) + "@gmail.com",
          date: d, time: state.slots[d][0], meetLink: "https://meet.google.com/abc-defg-hij" });
      }
    });
    return out;
  }

  function renderOwner() {
    const box = $("ownerPanel");
    if (!state.isOwner) { box.hidden = true; return; }
    box.hidden = false;
    const same = sameZoneAsIsrael();
    let html = "<h3>המפגשים הקרובים</h3>" +
      '<p class="meta">התצוגה הזו מופיעה רק לך. ' +
      (same ? "אזור הזמן במחשב כרגע זהה לישראל." : "שעון מקומי לפי המחשב: " + escapeHtml(deviceZoneLabel())) + "</p>";
    if (!state.all.length) {
      html += '<p class="muted" style="margin:0">אין עדיין מפגשים קרובים.</p>';
    } else {
      html += "<ul>" + state.all.map((b) =>
        "<li><strong>" + escapeHtml(b.name) + "</strong> · " + escapeHtml(b.email) +
        (b.phone ? ' · <a href="tel:' + escapeHtml(b.phone.replace(/[^\d+]/g, "")) + '" dir="ltr">' + escapeHtml(b.phone) + "</a>" : "") + "<br>" +
        fmtLongDate(b.date) + " · " + b.time + " שעון ישראל" +
        (same ? "" : ' · <span class="local">' + localTime(b.date, b.time) + " אצלך</span>") +
        (b.meetLink ? '<br><a href="' + escapeHtml(b.meetLink) + '" target="_blank" rel="noopener">קישור ל-Meet</a>' : "") +
        "</li>").join("") + "</ul>";
    }
    box.innerHTML = html;
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

  function renderMine() {
    const box = $("myBookings");
    const upcoming = state.mine.filter((b) => isFuture(b.date, b.time));
    if (!state.user || upcoming.length === 0) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = "<h3>המפגשים שלך</h3><ul>" + upcoming.map((b) =>
      "<li>" + fmtLongDate(b.date) + " בשעה " + b.time +
      (b.meetLink ? ' · <a href="' + escapeHtml(b.meetLink) + '" target="_blank" rel="noopener">קישור ל-Meet</a>' : "") +
      "</li>").join("") + "</ul>";
  }

  function monthBounds() {
    const t = todayStr();
    const min = { y: +t.slice(0, 4), m: +t.slice(5, 7) - 1 };
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

    const grid = $("grid");
    grid.innerHTML = "";
    const first = new Date(Date.UTC(y, m, 1));
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const lead = first.getUTCDay();                                   // ראשון = 0
    const trail = 6 - new Date(Date.UTC(y, m, lastDay)).getUTCDay();  // השלמת השבוע האחרון
    const today = todayStr();

    for (let i = -lead; i < lastDay + trail; i++) {
      const ds = ymd(y, m, 1 + i);
      const inMonth = i >= 0 && i < lastDay;
      const avail = hasFree(ds);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "day" + (inMonth ? "" : " other") + (ds === today ? " today" : "") +
        (avail ? " available" : "") + (ds === state.selected ? " selected" : "");
      btn.disabled = !avail;
      btn.innerHTML = '<span class="num">' + +ds.slice(8) + "</span>" + (avail ? '<i class="dot"></i>' : "");
      btn.setAttribute("aria-label", fmtLongDate(ds) + (avail ? " – יש מועדים פנויים" : ""));
      if (avail) btn.onclick = () => { state.selected = ds; renderCalendar(); renderSlots(); };
      grid.appendChild(btn);
    }
  }

  function renderSlots() {
    const box = $("slots");
    const ds = state.selected;
    if (!ds || !hasFree(ds)) {
      box.innerHTML = '<p class="muted center">בחרו יום מסומן בלוח כדי לראות את השעות הפנויות.</p>';
      return;
    }
    const existing = state.user ? bookedThisMonth(ds) : null;
    let html = "<h3>" + fmtLongDate(ds) + "</h3>" +
      '<p class="meta">מפגש של ' + state.duration + " דקות · שעון ישראל</p>" +
      '<div class="times">';
    freeTimes(ds).forEach((t) => {
      const taken = state.taken.has(ds + " " + t);
      html += '<button type="button" class="time" data-t="' + t + '"' + (taken || existing ? " disabled" : "") +
        (taken ? ' aria-label="' + t + ' תפוס"' : "") + ">" + t +
        (state.isOwner && !sameZoneAsIsrael() ? '<span class="local">' + localTime(ds, t) + " אצלך</span>" : "") +
        "</button>";
    });
    html += "</div>";
    if (existing) {
      html += '<p class="hint">כבר נרשמתם למפגש החודש (' + fmtLongDate(existing.date) + " בשעה " + existing.time +
        "). אפשר להירשם למפגש אחד בכל חודש.</p>";
    } else if (!state.user) {
      html += '<p class="hint">כדי להירשם, צריך להתחבר עם חשבון Google.</p>';
    }
    box.innerHTML = html;
    box.querySelectorAll(".time:not(:disabled)").forEach((b) => {
      b.onclick = () => confirmBooking(ds, b.dataset.t);
    });
  }

  function renderAll() {
    renderOwner();
    renderMine();
    renderCalendar();
    renderSlots();
  }

  /* ---------- קביעת פגישה ---------- */

  function modal(title, bodyHtml, actions) {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = bodyHtml;
    const wrap = $("modalActions");
    wrap.innerHTML = "";
    actions.forEach((a) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn" + (a.primary ? " primary" : ""); b.textContent = a.label;
      b.onclick = a.onClick;
      wrap.appendChild(b);
    });
    $("modal").hidden = false;
    const p = wrap.querySelector(".primary") || wrap.firstChild;
    if (p) p.focus();
  }
  function closeModal() { $("modal").hidden = true; }

  function confirmBooking(ds, t) {
    if (!state.user) {
      modal("צריך להתחבר", "<p>כדי להירשם למפגש, התחברו קודם עם חשבון Google בראש הדף.</p>",
        [{ label: "הבנתי", primary: true, onClick: () => { closeModal(); $("account").scrollIntoView({ behavior: "smooth" }); } }]);
      return;
    }
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
    body += '<p class="muted">אישור יישלח אל ' + escapeHtml(state.user.email) +
      " והמפגש יתווסף ליומן Google שלכם עם קישור ל-Google Meet. אי אפשר לבטל דרך האתר.</p>";
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
        await loadTaken(); await loadMine(); renderAll();
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

  async function init() {
    $("signOut").onclick = signOut;
    $("prevMonth").onclick = () => shiftMonth(-1);
    $("nextMonth").onclick = () => shiftMonth(1);
    $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

    const t = todayStr();
    state.view = { y: +t.slice(0, 4), m: +t.slice(5, 7) - 1 };

    initGoogle();
    try {
      await Promise.all([loadAvailability(), loadTaken()]);
    } catch (e) {
      toast("לא הצלחנו לטעון את לוח המועדים.");
    }
    renderAll();
  }

  function shiftMonth(delta) {
    let { y, m } = state.view;
    m += delta;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    state.view = { y, m };
    state.selected = null;
    renderCalendar(); renderSlots();
  }

  init();
})();
