// Trip Planner: day plans with a leave-by timer, a ticket wallet and a booking
// tracker, shared between two phones through the CFA app's Firebase project.
// The itinerary itself is in plan.enc.json, encrypted with the trip passphrase
// (the repository is public). Everything the two of you add (tickets, refs,
// ticks, addresses) lives in Firestore under the shared trip account and is
// cached on the phone, so it still opens with no signal.
import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const USER_DOMAIN = "users.cfa-flashcards.app"; // same username scheme as the CFA app
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
const MAX_IMG_CHARS = 900000; // a Firestore document holds up to 1 MiB

/* ========================= helpers ========================= */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MIN = 60000;
const cnDate = (d, hm) => new Date(`${d}T${hm}:00+08:00`);
const fmtHM = (dt) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(dt);
const cnYMD = (dt) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);
const dayLabel = (ymd) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", weekday: "short", day: "numeric", month: "short" }).format(new Date(ymd + "T12:00:00+08:00"));
const wk = (ymd) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(ymd + "T12:00:00+08:00"));
const local = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
function rel(ms) {
  const m = Math.round(Math.abs(ms) / MIN);
  if (m < 60) return m + " min";
  if (m < 60 * 48) return (Math.floor(m / 60) + " h " + (m % 60 ? (m % 60) + " min" : "")).trim();
  return Math.round(m / 1440) + " days";
}
const ICON = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  qr: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h2v2M18 18h2v2M14 20h2"/></svg>',
};
let toastT;
function toast(msg) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 2600);
}

/* ========================= plan (decrypted) ========================= */
let PLAN, PLACES, DAYS, ROUTES, BOOKINGS, WARNINGS, CHECKLIST, IDEAS, LINKS;
const STATUSES = ["To book", "Booked", "Optional", "Skip"];
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decryptPlan(pass) {
  const res = await fetch("plan.enc.json", { cache: "no-cache" });
  const e = await res.json();
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass.trim()), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64d(e.salt), iterations: e.iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(e.iv) }, key, b64d(e.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
function applyPlan(p) {
  PLAN = p; PLACES = p.places; DAYS = p.days; ROUTES = p.routes; BOOKINGS = p.bookings;
  WARNINGS = p.warnings; CHECKLIST = p.checklist; IDEAS = p.ideas; LINKS = p.links;
  $("#brandTitle").textContent = p.title || "Trip";
  $("#brandWho").textContent = p.who || "";
  document.title = p.title || "Trip Planner";
}

/* ========================= state ========================= */
const S = {
  bookings: {}, checks: {}, ideas: {}, days: {}, places: {}, tickets: [], imgs: {}, ticketsReady: false,
  tab: "now", day: null, preview: null, adding: null, overlay: null, confirmDel: null, sync: ["", "Connecting…"],
};
const now = () => (S.preview ? new Date(S.preview) : new Date());
const bkData = (id) => { const b = BOOKINGS.find((x) => x.id === id); return b ? { ...b, ...(S.bookings[id] || {}) } : null; };
const place = (id) => (PLACES[id] ? { ...PLACES[id], ...(S.places[id] || {}), id } : null);
const delayFor = (date) => +(S.days[date]?.delay || 0);
const ticketsFor = (bk) => S.tickets.filter((t) => t.bk === bk);
const pagesOf = (t) => (t.pages || []).map((id) => S.imgs[id]).filter(Boolean);

function timeline() {
  const out = [];
  for (const day of DAYS) {
    const dl = delayFor(day.date);
    day.items.forEach((it, i) => {
      if (!it.at) return;
      const d = it.d || day.date;
      const base = cnDate(d, it.at);
      const start = new Date(+base + (it.fixed ? 0 : dl * MIN));
      let end = null;
      if (it.end) { end = cnDate(d, it.end); if (end < base) end = new Date(+end + 1440 * MIN); end = new Date(+end + (it.fixed ? 0 : dl * MIN)); }
      const leave = it.go ? new Date(+start - (it.go.mins + it.go.buf) * MIN) : null;
      out.push({ day, it, i, base, start, end, leave });
    });
  }
  return out;
}

/* ========================= Firebase ========================= */
let fb = null, uid = null, unsubs = [];
const ref = (c, id) => fb.doc(fb.db, "users", uid, c, id);
const coll = (c) => fb.collection(fb.db, "users", uid, c);
// Writes are not awaited: offline they wait in Firestore's queue and sync later.
const failed = (e) => { console.error(e); toast("Couldn't save. Check your connection."); };
const put = (c, id, data) => fb.setDoc(ref(c, id), data).catch(failed);

async function boot() {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
  ]);
  // A named app keeps this sign-in separate from the CFA Flashcards sign-in on the same site.
  const app = appMod.initializeApp(firebaseConfig, "trip");
  const auth = authMod.getAuth(app);
  let db;
  try { db = fsMod.initializeFirestore(app, { localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }) }); }
  catch { db = fsMod.getFirestore(app); }
  fb = { ...authMod, ...fsMod, auth, db };
  authMod.onAuthStateChanged(auth, (user) => {
    unsubs.forEach((u) => u()); unsubs = [];
    if (user) { uid = user.uid; unlock(); }
    else { uid = null; gate("signin"); }
  });
}
function gate(which) {
  $("#app").hidden = true; $("#gate").hidden = false;
  ["signin", "unlock", "loading"].forEach((id) => { $("#" + id).hidden = id !== which; });
}
async function unlock(typed) {
  let pass = typed || local.get("trip-pass-" + uid);
  if (!pass) {
    gate("loading"); $("#loadMsg").textContent = "Opening the plan…";
    try { const s = await fb.getDoc(ref("settings", "trip")); pass = s.exists() ? s.data().pass : null; } catch {}
  }
  if (!pass) { gate("unlock"); return; }
  try {
    applyPlan(await decryptPlan(pass));
  } catch (e) {
    console.error(e);
    gate("unlock");
    const msg = $("#unlockMsg");
    msg.className = "msg err";
    msg.textContent = e instanceof TypeError || e?.name === "SyntaxError" ? "Couldn't load the plan. Check your connection and try again." : "That passphrase doesn't open the plan. Check it and try again.";
    local.del("trip-pass-" + uid);
    return;
  }
  local.set("trip-pass-" + uid, pass);
  if (typed) put("settings", "trip", { pass });
  start();
}

function listen() {
  const sub = (c, key) => unsubs.push(fb.onSnapshot(coll(c), (snap) => {
    const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S[key] = m;
    if (S.overlay?.kind === "place") renderOverlay();
    render();
  }, onDbError));
  sub("bookings", "bookings"); sub("checks", "checks"); sub("ideas", "ideas"); sub("days", "days"); sub("places", "places");
  unsubs.push(fb.onSnapshot(coll("tickets"), { includeMetadataChanges: true }, (snap) => {
    const m = snap.metadata;
    S.sync = m.hasPendingWrites ? ["pending", "Saving…"] : m.fromCache ? ["pending", "Offline · changes sync when you reconnect"] : ["live", "Synced"];
    S.tickets = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.created || 0) - (b.created || 0));
    S.ticketsReady = true;
    if (S.overlay?.kind === "ticket") renderOverlay();
    render();
  }, onDbError));
  unsubs.push(fb.onSnapshot(coll("ticketImgs"), (snap) => {
    const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data().data; }); S.imgs = m;
    if (S.overlay?.kind === "ticket") renderOverlay();
    if (S.tab === "tickets") render();
  }, onDbError));
}
function onDbError(e) { console.error(e); S.sync = ["", "Not syncing (" + (e.code || "error") + ")"]; render(); }

/* ========================= map links ========================= */
function mapLinks(p) {
  if (p.gmap) return [["Google Maps", "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(p.en)]];
  const q = p.addr ? p.zh + " " + p.addr : p.zh;
  return [
    ["Open in AMap", `https://uri.amap.com/search?keyword=${encodeURIComponent(p.zh)}&city=${encodeURIComponent(p.city || "")}&callnative=1`],
    ["Apple Maps", "https://maps.apple.com/?q=" + encodeURIComponent(q)],
  ];
}

/* ========================= render: shared bits ========================= */
function chipsFor(it) {
  let h = "";
  if (it.place && PLACES[it.place]) { const p = place(it.place); h += `<button class="chip map" data-place="${it.place}">${ICON.pin}<span>${esc(p.gmap ? "Map" : p.zh)}</span></button>`; }
  if (it.bk) {
    const b = bkData(it.bk), tk = ticketsFor(it.bk);
    if (tk.length) h += `<button class="chip tix" data-ticket="${esc(tk[0].id)}">${ICON.qr}<span>Ticket${tk.length > 1 ? " ×" + tk.length : ""}</span></button>`;
    if (b) h += `<span class="pill st-${b.status.replace(/ /g, "-")}">${esc(b.status)}${b.ref ? " · " + esc(b.ref) : ""}</span>`;
  }
  if (it.fixed && it.at && !it.warn) h += `<span class="pill fixed-pill">Fixed time</span>`;
  if (it.cost) h += `<span class="cost">${esc(it.cost)}</span>`;
  return h;
}
function itemHTML(day, it, opts = {}) {
  const tl = opts.tl;
  const cls = ["it"]; if (it.warn) cls.push("warn"); if (it.loose) cls.push("loose");
  if (opts.past) cls.push("past"); if (opts.cur) cls.push("cur");
  const dl = delayFor(day.date);
  let tm = esc(it.t);
  if (tl && dl && !it.fixed && it.at) tm = `${fmtHM(tl.start)}<small><s>${esc(it.t)}</s> +${dl}m</small>`;
  const lb = tl && tl.leave ? `<div class="lb">Leave by ${fmtHM(tl.leave)}${it.go.how ? ` · ${esc(it.go.how)} ~${it.go.mins}m` : ""}</div>` : "";
  return `<div class="${cls.join(" ")}"><div class="tm">${tm}</div><div style="min-width:0">${lb}<div class="what">${esc(it.what)}</div>${it.info ? `<div class="info">${esc(it.info)}</div>` : ""}<div class="meta">${chipsFor(it)}</div></div></div>`;
}
function dayTimeline(day, tl, n) {
  const rows = []; let marked = false;
  day.items.forEach((it, i) => {
    const x = tl.find((t) => t.day === day && t.i === i);
    if (x && !marked && x.start > n && n >= cnDate(day.date, "00:00")) { rows.push(`<div class="nowmark">Now · ${fmtHM(n)}</div>`); marked = true; }
    const laterStarted = x && tl.some((t) => t.start > x.start && t.start <= n && !t.it.loose);
    const cur = x && x.start <= n && (x.end ? x.end > n : !laterStarted);
    const past = x && (x.end ? x.end < n : laterStarted);
    rows.push(itemHTML(day, it, { tl: x, past: !!past && !cur, cur: !!cur }));
  });
  return `<div class="tl">${rows.join("")}</div>`;
}
const toLocalInput = (ms) => { const d = new Date(ms); return cnYMD(d) + "T" + fmtHM(d); };

/* ========================= NOW ========================= */
function renderNow() {
  const n = now(), start = new Date(PLAN.start), end = new Date(PLAN.end);
  let h = "";
  if (n < start) {
    const ms = start - n, d = Math.floor(ms / 86400000), hh = Math.floor((ms % 86400000) / 3600000), mm = Math.floor((ms % 3600000) / MIN);
    const first = DAYS[0].items[0];
    h += `<section class="hero"><div class="band go"><div class="leave-k">Countdown · ${esc(first.what)} · ${esc(first.t)}</div>
      <div class="countdown"><div><b>${d}</b><span>days</span></div><div><b>${hh}</b><span>hours</span></div><div><b>${mm}</b><span>min</span></div></div></div>
      <div class="body"><p class="note" style="margin:0">Once you land, this screen shows what's happening now, what's next, and when to leave for it.</p></div></section>`;
    const todo = BOOKINGS.map((b) => bkData(b.id)).filter((b) => b.status === "To book").sort((a, b) => (a.opens || a.date).localeCompare(b.opens || b.date));
    h += `<section class="card" style="display:grid;gap:10px"><div class="sec-h"><h2>Book next</h2><a class="btn small" href="#bookings">All bookings</a></div>
      <div style="display:grid;gap:8px">${todo.slice(0, 6).map((b) => {
        const op = b.opens ? cnDate(b.opens, "08:00") : null;
        const tag = op ? (op > n ? `<span class="pill st-To-book">Sales open ${dayLabel(b.opens)} · in ${rel(op - n)}</span>` : `<span class="pill fixed-pill">On sale now</span>`) : `<span class="muted" style="font-size:12px">${esc(dayLabel(b.date))}</span>`;
        return `<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap"><span style="font-weight:600">${esc(b.name)}</span>${tag}</div>`;
      }).join("")}</div>
      ${todo.length > 6 ? `<div class="note">+ ${todo.length - 6} more to book</div>` : ""}</section>`;
  } else if (n > end) {
    h += `<section class="hero"><div class="band go"><div class="leave-k">Trip complete</div><h2 style="font-size:28px">Welcome home.</h2></div></section>`;
  } else {
    const tl = timeline();
    const day = DAYS.find((d) => d.date === cnYMD(n)) || DAYS[0];
    let curIdx = -1; tl.forEach((x, i) => { if (x.start <= n) curIdx = i; });
    const cur = tl[curIdx], next = tl.slice(curIdx + 1).find((x) => !x.it.loose) || tl[curIdx + 1];
    const nextGo = tl.slice(curIdx + 1).find((x) => x.leave && x.leave - n < 8 * 3600000);
    if (nextGo) {
      const ms = nextGo.leave - n;
      const cls = ms < 0 ? "late" : ms < 30 * MIN ? "soon" : "go";
      const relTxt = ms < 0 ? `You should have left ${rel(ms)} ago` : `Leave in ${rel(ms)}`;
      const tk = nextGo.it.bk ? ticketsFor(nextGo.it.bk) : [];
      h += `<section class="hero"><div class="band ${cls}"><div class="leave-k">Leave by</div><div class="leave-t">${fmtHM(nextGo.leave)}</div><div class="leave-rel">${relTxt}</div></div>
        <div class="body"><div class="label">For · ${fmtHM(nextGo.start)}${nextGo.it.fixed ? " · fixed time" : ""}</div><h2>${esc(nextGo.it.what)}</h2>
        <div class="note">Estimate: ${esc(nextGo.it.go.how || "travel")} ~${nextGo.it.go.mins} min + ${nextGo.it.go.buf} min buffer. Open AMap for live traffic before you go.</div>
        <div class="row">${nextGo.it.place ? `<button class="btn primary" data-place="${nextGo.it.place}">Map &amp; directions</button>` : ""}${tk.length ? `<button class="btn" data-ticket="${esc(tk[0].id)}">Show ticket</button>` : ""}</div></div></section>`;
    } else if (next) {
      h += `<section class="hero"><div class="band go"><div class="leave-k">Next · ${fmtHM(next.start)} · in ${rel(next.start - n)}</div><h2>${esc(next.it.what)}</h2></div>
        <div class="body"><div class="row">${next.it.place ? `<button class="btn primary" data-place="${next.it.place}">Map &amp; directions</button>` : ""}</div></div></section>`;
    }
    if (cur && (!cur.end || cur.end > n)) h += `<div class="card now-line"><span class="label">Now</span><span class="mono">${fmtHM(cur.start)}</span><span style="font-weight:600">${esc(cur.it.what)}</span></div>`;
    const dl = delayFor(day.date);
    h += `<section class="card" style="display:grid;gap:8px"><div class="sec-h"><h2 style="font-size:17px">Running late today?</h2><span class="mono" style="font-weight:700;color:${dl ? "var(--chili)" : "var(--muted)"}">${dl ? "+" + dl + " min" : "On time"}</span></div>
      <div class="late-ctl"><button class="btn small" data-late="15">+15 min</button><button class="btn small" data-late="30">+30 min</button><button class="btn small" data-late="60">+1 h</button><button class="btn small" data-late="0">Back on time</button></div>
      <div class="note">Shifts today's flexible items. Trains, buses and last-bus times stay put, so you'll see when the slack runs out.</div></section>`;
    h += `<div class="sec-h"><h2>Day ${day.n} · ${esc(day.where)}</h2><a class="btn small" href="#days" data-goday="${day.date}">Full day</a></div>`;
    h += dayTimeline(day, tl, n);
  }
  const lo = DAYS[0].items[0].d || DAYS[0].date, hi = DAYS[DAYS.length - 1].date;
  h += `<section class="card" style="display:grid;gap:8px"><label class="label" for="pv">Preview the timer at a China time</label>
    <div class="row"><input id="pv" type="datetime-local" min="${lo}T00:00" max="${hi}T23:59" value="${S.preview ? toLocalInput(S.preview) : ""}" style="border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:7px 10px;flex:1;min-width:0">
    <button class="btn small" data-pv="${DAYS[0].date}T06:15">Day 1 morning</button>${S.preview ? `<button class="btn small" data-pv="">Live time</button>` : ""}</div></section>`;
  return h;
}

/* ========================= DAYS ========================= */
function renderDays() {
  const n = now(), today = cnYMD(n);
  if (!S.day) S.day = DAYS.find((d) => d.date === today)?.date || DAYS[0].date;
  const day = DAYS.find((d) => d.date === S.day) || DAYS[0];
  const tl = timeline();
  let h = `<div class="daystrip" role="group" aria-label="Days">${DAYS.map((d) => `<button class="dchip${d.date === today ? " today" : ""}" aria-pressed="${d.date === day.date}" data-day="${d.date}"><span>${wk(d.date)}</span><b>${+d.date.slice(8)}</b><span>Day ${d.n}</span></button>`).join("")}</div>`;
  const sp = day.sleepPlace ? place(day.sleepPlace) : null;
  h += `<section class="dayhead"><div class="eyebrow">Day ${day.n} · ${dayLabel(day.date)} · ${esc(day.where)}</div><h1>${esc(day.title)}</h1>
    <dl class="facts"><dt>Sleep</dt><dd>${esc(day.sleep)} ${sp ? `<button class="chip map" data-place="${day.sleepPlace}" style="margin-left:4px">${ICON.pin}<span>${esc(sp.zh)}</span></button>` : ""}</dd><dt>Altitude</dt><dd class="alt">${esc(day.alt)}</dd></dl></section>`;
  const dl = delayFor(day.date);
  if (dl) h += `<div class="card" style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap"><span><b style="color:var(--chili)">Running +${dl} min</b> <span class="note">flexible items shifted</span></span><button class="btn small" data-late="0" data-lateday="${day.date}">Back on time</button></div>`;
  h += dayTimeline(day, tl, n);
  if (day.route && ROUTES[day.route]) {
    const r = ROUTES[day.route];
    h += `<details class="route"><summary>${esc(r.title)}</summary><div class="route-body"><p class="note" style="margin:0">${esc(r.strategy)}</p><div class="tbl"><table><thead><tr><th>#</th><th>Stop / section</th><th>How</th><th>Time</th><th>Notes</th></tr></thead><tbody>${r.rows.map((x, i) => `<tr><td class="n">${x[1] === "⚠" ? "⚠" : i + 1}</td><td>${esc(x[0])}</td><td class="how-${esc(x[1])}">${esc(x[1])}</td><td class="mono" style="white-space:nowrap">${esc(x[2])}</td><td class="muted">${esc(x[3])}</td></tr>`).join("")}</tbody></table></div></div></details>`;
  }
  if (day.tips?.length) h += `<section class="card" style="display:grid;gap:8px"><div class="label">Good to know</div><ul class="tips">${day.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>`;
  return h;
}

/* ========================= TICKETS ========================= */
function renderTickets() {
  let h = `<div class="sec-h"><h2>Tickets</h2>${!S.adding ? `<button class="btn primary" data-act="add">+ Add ticket</button>` : ""}</div>`;
  if (S.adding) h += addForm();
  if (!S.ticketsReady) h += `<div class="empty">Loading tickets…</div>`;
  else if (!S.tickets.length && !S.adding) h += `<div class="empty"><b style="color:var(--ink)">No tickets yet.</b><br>Tap <b>Add ticket</b> and pick a screenshot or PDF with the QR code or barcode. Link it to a booking and it shows up on that day's plan too.</div>`;
  else {
    const groups = {};
    S.tickets.forEach((t) => { const k = t.bk ? bkData(t.bk)?.date || "other" : "other"; (groups[k] ||= []).push(t); });
    Object.keys(groups).sort().forEach((k) => {
      h += `<div class="label">${k === "other" ? "Other" : esc(dayLabel(k))}</div><div class="tgrid">${groups[k].map((t) => {
        const img = pagesOf(t)[0];
        return `<button class="tk" data-ticket="${esc(t.id)}"><div class="thumb" style="${img ? `background-image:url(${img})` : ""}">${img ? "" : "Loading…"}</div><div class="cap"><b>${esc(t.title || "Ticket")}</b><span>${esc(t.bk ? bkData(t.bk)?.name || "" : "")}${(t.pages || []).length > 1 ? " · " + t.pages.length + " pages" : ""}</span></div></button>`;
      }).join("")}</div>`;
    });
  }
  h += `<p class="note">Tickets are kept on this phone too, so they open without signal. Opening one turns the screen white and keeps it awake for the scanner.</p>`;
  return h;
}
function addForm() {
  const a = S.adding;
  const opts = BOOKINGS.map((b) => `<option value="${b.id}"${a.bk === b.id ? " selected" : ""}>${esc(dayLabel(b.date))} · ${esc(b.name)}</option>`).join("");
  return `<section class="card form" id="addform"><h3 style="font-size:17px">New ticket</h3>
    <label class="drop" for="tfile">${a.files.length ? `${a.files.length} file${a.files.length > 1 ? "s" : ""} chosen · tap to change` : "Choose screenshot(s) or a PDF"}<input id="tfile" type="file" accept="image/*,application/pdf" multiple></label>
    ${a.files.length ? `<div class="previews">${a.files.map((f) => (f.isPdf ? `<div class="pdf">PDF</div>` : `<img src="${f.url}" alt="">`)).join("")}</div>` : ""}
    <label>Booking<select id="tbk"><option value="">— not linked —</option>${opts}</select></label>
    <label>Title<input id="ttitle" type="text" placeholder="e.g. D1 train · seat 05A" value="${esc(a.title)}"></label>
    <label>Note<input id="tnote" type="text" placeholder="Ref no., seat, gate…" value="${esc(a.note)}"></label>
    <div class="row"><button class="btn primary" data-act="save" ${a.busy || !a.files.length ? "disabled" : ""}>${a.busy ? esc(a.busy) : "Save ticket"}</button><button class="btn" data-act="cancel" ${a.busy ? "disabled" : ""}>Cancel</button></div>
    ${a.err ? `<div class="note" style="color:var(--chili)">${esc(a.err)}</div>` : ""}</section>`;
}

/* ========================= BOOKINGS ========================= */
function renderBookings() {
  const all = BOOKINGS.map((b) => bkData(b.id));
  const counted = all.filter((b) => b.status !== "Skip" && b.status !== "Optional"), done = counted.filter((b) => b.status === "Booked").length;
  const est = all.filter((b) => b.status !== "Skip").reduce((s, b) => s + (b.cny || 0), 0);
  let h = `<section class="card" style="display:grid;gap:10px"><div class="sec-h"><h2>Bookings</h2><span class="mono" style="font-weight:700">${done} / ${counted.length}</span></div>
    <div class="progress"><i style="width:${counted.length ? (done / counted.length) * 100 : 0}%"></i></div>
    <div class="note">Est. tickets &amp; transport for two: <b class="mono" style="color:var(--ink)">CNY ${est.toLocaleString()}</b> ≈ SGD ${Math.round(est / 5.5).toLocaleString()} (at 5.5). Flights, booked hotels, food and shopping not included.</div></section>`;
  const n = now(); let last = "";
  h += `<div class="tl">`;
  all.forEach((b) => {
    if (b.date !== last) { h += `<div class="nowmark" style="background:var(--sunk);color:var(--muted)">${esc(dayLabel(b.date))}</div>`; last = b.date; }
    const tk = ticketsFor(b.id);
    const opens = b.opens && b.status === "To book" ? (cnDate(b.opens, "08:00") > n ? `<span class="opens">Sales open ${dayLabel(b.opens)}</span>` : `<span class="opens" style="color:var(--chili)">On sale now</span>`) : "";
    h += `<div class="bk"><div style="min-width:0"><div class="nm">${esc(b.name)}</div><div class="sub">${[b.where, b.note].filter(Boolean).map(esc).join(" · ")}${b.cny ? ` · CNY ${b.cny}` : ""}</div>${opens}</div>
      <select aria-label="Status for ${esc(b.name)}" data-bkstatus="${b.id}">${STATUSES.map((s) => `<option${s === b.status ? " selected" : ""}>${s}</option>`).join("")}</select>
      <div class="ref"><input id="ref-${b.id}" data-bkref="${b.id}" placeholder="Booking ref / train no. / seat" value="${esc(b.ref || "")}">${tk.length ? `<button class="chip tix" data-ticket="${esc(tk[0].id)}">${ICON.qr}<span>${tk.length}</span></button>` : `<button class="btn small" data-act="add" data-bk="${b.id}">+ Ticket</button>`}</div></div>`;
  });
  return h + `</div>`;
}

/* ========================= PREP ========================= */
function renderPrep() {
  const doneN = CHECKLIST.filter((c) => S.checks[c[0]]?.done).length;
  let h = `<section class="card" style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap"><span class="sync ${S.sync[0]}"><i></i>${esc(S.sync[1])}</span><button class="btn small" data-act="signout">Sign out</button></section>`;
  h += `<section class="card" style="display:grid;gap:10px"><h2>Check before you go</h2><ul class="warnlist">${WARNINGS.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></section>`;
  h += `<div class="sec-h"><h2>Checklist</h2><span class="mono muted">${doneN} of ${CHECKLIST.length}</span></div><div class="tl">${CHECKLIST.map((c) => { const d = !!S.checks[c[0]]?.done; return `<label class="check${d ? " done" : ""}" for="ck-${c[0]}"><input type="checkbox" id="ck-${c[0]}" data-check="${c[0]}" ${d ? "checked" : ""}><span><span class="k">${esc(c[1])}</span><span class="t">${esc(c[2])}</span></span></label>`; }).join("")}</div>`;
  const picked = IDEAS.filter((i) => S.ideas[i[0]]?.picked).length;
  h += `<div class="sec-h"><h2>${esc(PLAN.ideasTitle || "Ideas")}</h2><span class="mono muted">${picked} picked</span></div><div class="tl">${IDEAS.map((i) => { const p = !!S.ideas[i[0]]?.picked; return `<label class="idea" for="id-${i[0]}"><input type="checkbox" id="id-${i[0]}" data-idea="${i[0]}" ${p ? "checked" : ""} style="width:20px;height:20px;accent-color:var(--lake);margin-top:2px"><span style="min-width:0"><b>${esc(i[1])}</b> <span class="stars">${"★".repeat(i[3])}</span><br><span class="note">${esc(i[4])} · ${esc(i[5])}</span></span></label>`; }).join("")}</div>`;
  h += `<section class="card" style="display:grid;gap:6px"><h2 style="font-size:18px">Using the app in China</h2><p class="note" style="margin:0">The app, the plan and your tickets are stored on the phone, so they open with no signal. Syncing with the other phone needs a connection that reaches Google: Singapore roaming or a travel eSIM, not hotel Wi-Fi or a local SIM. Map buttons open AMap (高德) on the place's Chinese name; tap 路线 there for live-traffic directions. Leave-by times are estimates from the plan.</p></section>`;
  h += `<section class="card links"><div class="label" style="margin-bottom:6px">Guides &amp; sources</div>${LINKS.map((l) => `<a href="${esc(l[1])}" target="_blank" rel="noopener">${esc(l[0])} ↗</a>`).join("")}</section>`;
  return h;
}

/* ========================= overlays ========================= */
let wake = null;
async function keepAwake() { try { if (!wake && navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); } catch {} }
function releaseWake() { try { wake && wake.release(); } catch {} wake = null; }
function renderOverlay() {
  let el = $("#ov"); if (el) el.remove();
  const o = S.overlay; if (!o) { releaseWake(); document.body.style.overflow = ""; return; }
  el = document.createElement("div"); el.id = "ov"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
  if (o.kind === "place") {
    const p = place(o.id); el.className = "ov";
    el.innerHTML = `<div class="wrap"><div class="bar"><h2>${esc(p.en)}</h2><button class="btn" data-act="close">Close</button></div>
      <div style="display:grid;gap:16px;padding-block:8px 32px">
      <div class="card" style="display:grid;gap:8px"><div class="label">Show the driver</div><div class="zh-big">${esc(p.zh)}</div>${p.addr ? `<div class="addr-big">${esc(p.addr)}</div>` : ""}${p.check && !p.addr ? `<div class="note" style="color:var(--gold)">Add the exact Chinese name/address from your booking below.</div>` : ""}</div>
      <div class="row">${mapLinks(p).map((l, i) => `<a class="btn${i ? "" : " primary"}" href="${esc(l[1])}" target="_blank" rel="noopener">${esc(l[0])} ↗</a>`).join("")}<button class="btn" data-copy="${esc(p.addr ? p.zh + " " + p.addr : p.zh)}">Copy Chinese</button></div>
      <p class="note" style="margin:0">AMap opens on the place. Tap 路线 (Route) there for live-traffic directions from where you are, or 打车 to call a taxi.</p>
      ${!p.gmap ? `<section class="card form"><div class="label">Edit for both of you</div><label>Chinese name (what AMap searches)<input id="pzh" value="${esc(p.zh)}"></label><label>Address (optional)<input id="paddr" value="${esc(p.addr || "")}" placeholder="四川省…"></label><div class="row"><button class="btn primary" data-act="saveplace">Save</button></div></section>` : ""}
      </div></div>`;
  } else if (o.kind === "ticket") {
    const t = S.tickets.find((x) => x.id === o.id); if (!t) { S.overlay = null; releaseWake(); return; }
    el.className = "ov white";
    const b = t.bk ? bkData(t.bk) : null, pages = pagesOf(t);
    el.innerHTML = `<div class="wrap"><div class="bar"><h2>${esc(t.title || "Ticket")}</h2><button class="btn" data-act="close">Close</button></div>
      ${b || t.note ? `<div class="muted" style="font-size:14px">${esc([b?.name, b?.ref, t.note].filter(Boolean).join(" · "))}</div>` : ""}
      <div class="imgs">${pages.length ? pages.map((src) => `<img src="${src}" alt="${esc(t.title || "Ticket")}">`).join("") : `<p class="muted">Loading the image…</p>`}</div>
      <div class="row" style="padding-bottom:28px"><button class="btn" data-act="savephone">Save to phone</button>
      ${S.confirmDel === t.id ? `<span class="muted" style="font-size:13px">Delete for both of you?</span><button class="btn danger" data-act="delyes">Delete</button><button class="btn" data-act="delno">Keep</button>` : `<button class="btn danger" data-act="del">Delete</button>`}</div></div>`;
    keepAwake();
  }
  document.body.style.overflow = "hidden";
  document.body.appendChild(el);
}

/* ========================= main render ========================= */
let started = false;
function render(force) {
  if (!started) return;
  const tabs = { now: renderNow, days: renderDays, tickets: renderTickets, bookings: renderBookings, prep: renderPrep };
  const view = $("#view"), ae = document.activeElement;
  if (!force && ae && view.contains(ae) && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) S.dirty = true;
  else { view.innerHTML = tabs[S.tab](); S.dirty = false; }
  document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.tab === S.tab ? "page" : "false"));
  renderClock();
}
function renderClock() {
  const c = $("#clock");
  c.className = "clock" + (S.preview ? " preview" : "");
  c.innerHTML = `<b>${fmtHM(now())}</b><span>${S.preview ? "Preview · " + dayLabel(cnYMD(now())) : "China time"}</span>`;
}
function route() {
  const h = location.hash.slice(1);
  S.tab = ["now", "days", "tickets", "bookings", "prep"].includes(h) ? h : "now";
  render(true); window.scrollTo(0, 0);
}
function start() {
  $("#gate").hidden = true; $("#app").hidden = false;
  if (!started) {
    started = true;
    addEventListener("hashchange", route);
    setInterval(() => { renderClock(); if (S.tab === "now" && !S.overlay) render(); }, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { render(); if (S.overlay?.kind === "ticket") keepAwake(); } });
  }
  listen();
  route();
}

/* ========================= tickets: images ========================= */
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
async function pdfToCanvases(file) {
  if (!window.pdfjsLib) {
    await loadScript(`${PDFJS}/pdf.min.js`);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
  }
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 6); i++) {
    const page = await pdf.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 1600 / Math.max(v1.width, v1.height) });
    const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(c);
  }
  return out;
}
async function imageToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
// Fit one page into a Firestore document: PNG keeps QR codes crisp when it is small
// enough, otherwise JPEG, scaling down until it fits.
function compress(src) {
  let side = Math.min(2000, Math.max(src.width, src.height));
  for (let tries = 0; tries < 8; tries++) {
    const k = side / Math.max(src.width, src.height);
    const c = document.createElement("canvas"); c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high"; ctx.drawImage(src, 0, 0, c.width, c.height);
    const png = c.toDataURL("image/png");
    if (png.length <= MAX_IMG_CHARS) return png;
    for (const q of [0.92, 0.85]) { const jpg = c.toDataURL("image/jpeg", q); if (jpg.length <= MAX_IMG_CHARS) return jpg; }
    side = Math.round(side * 0.8);
  }
  throw new Error("too-large");
}
async function saveTicket() {
  readForm(); const a = S.adding; if (!a.files.length) return;
  a.busy = "Preparing…"; a.err = ""; render(true);
  try {
    const pages = [];
    for (const f of a.files) {
      const canvases = f.isPdf ? await pdfToCanvases(f.file) : [await imageToCanvas(f.file)];
      for (const c of canvases) pages.push(compress(c));
    }
    const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ids = pages.map((_, i) => `${id}-${i}`);
    const batch = fb.writeBatch(fb.db);
    pages.forEach((data, i) => batch.set(ref("ticketImgs", ids[i]), { t: id, data }));
    batch.set(ref("tickets", id), { title: a.title.trim() || (a.bk ? bkData(a.bk).name : "Ticket"), bk: a.bk, note: a.note.trim(), pages: ids, created: Date.now() });
    batch.commit().catch(failed);
    a.files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    S.adding = null; toast("Ticket saved"); render(true);
  } catch (err) {
    console.error(err);
    a.busy = "";
    a.err = err?.message === "too-large" ? "That image is too big to store. Crop the screenshot to the ticket and try again." : "Couldn't read that file. Use a screenshot (PNG/JPG) or a PDF.";
    render(true);
  }
}
function deleteTicket(id) {
  const t = S.tickets.find((x) => x.id === id); if (!t) return;
  const batch = fb.writeBatch(fb.db);
  (t.pages || []).forEach((p) => batch.delete(ref("ticketImgs", p)));
  batch.delete(ref("tickets", id));
  batch.commit().catch(failed);
  S.overlay = null; S.confirmDel = null; renderOverlay(); toast("Ticket deleted");
}
async function saveToPhone(id) {
  const t = S.tickets.find((x) => x.id === id); if (!t) return;
  const slug = (t.title || "ticket").replace(/[^\w一-鿿-]+/g, "-").slice(0, 60);
  const files = await Promise.all(pagesOf(t).map(async (src, i, all) => {
    const blob = await (await fetch(src)).blob();
    return new File([blob], `${slug}${all.length > 1 ? "-" + (i + 1) : ""}.${blob.type === "image/png" ? "png" : "jpg"}`, { type: blob.type });
  }));
  if (!files.length) return;
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); } catch (e) { if (e.name !== "AbortError") toast("Long-press the image and choose Save to Photos"); }
    return;
  }
  files.forEach((f) => { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
}

/* ========================= events ========================= */
function readForm() {
  const a = S.adding; if (!a) return;
  const g = (id) => document.getElementById(id);
  if (g("tbk")) a.bk = g("tbk").value; if (g("ttitle")) a.title = g("ttitle").value; if (g("tnote")) a.note = g("tnote").value;
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-place],[data-ticket],[data-act],[data-day],[data-late],[data-pv],[data-goday],[data-copy]");
  if (!t) return;
  if (t.dataset.goday) { S.day = t.dataset.goday; return; }
  if (t.dataset.place) { S.overlay = { kind: "place", id: t.dataset.place }; renderOverlay(); return; }
  if (t.dataset.ticket) { S.overlay = { kind: "ticket", id: t.dataset.ticket }; S.confirmDel = null; renderOverlay(); return; }
  if (t.dataset.day) { S.day = t.dataset.day; render(true); return; }
  if (t.dataset.copy) { try { await navigator.clipboard.writeText(t.dataset.copy); toast("Copied"); } catch { toast("Long-press the Chinese text to copy it"); } return; }
  if (t.dataset.pv !== undefined) { S.preview = t.dataset.pv ? +new Date(t.dataset.pv + ":00+08:00") : null; render(true); return; }
  if (t.dataset.late !== undefined) {
    const date = t.dataset.lateday || cnYMD(now());
    const v = +t.dataset.late ? delayFor(date) + +t.dataset.late : 0;
    S.days[date] = { delay: v }; render(true); put("days", date, { delay: v });
    return;
  }
  const act = t.dataset.act;
  if (act === "close") { S.overlay = null; renderOverlay(); }
  else if (act === "add") {
    S.adding = { files: [], bk: t.dataset.bk || "", title: t.dataset.bk ? bkData(t.dataset.bk).name : "", note: "", busy: "" };
    if (S.tab !== "tickets") location.hash = "#tickets"; else render(true);
  }
  else if (act === "cancel") { S.adding.files.forEach((f) => f.url && URL.revokeObjectURL(f.url)); S.adding = null; render(true); }
  else if (act === "save") saveTicket();
  else if (act === "del") { S.confirmDel = S.overlay.id; renderOverlay(); }
  else if (act === "delno") { S.confirmDel = null; renderOverlay(); }
  else if (act === "delyes") deleteTicket(S.overlay.id);
  else if (act === "savephone") saveToPhone(S.overlay.id);
  else if (act === "signout") { local.del("trip-pass-" + uid); fb.signOut(fb.auth); }
  else if (act === "saveplace") {
    const id = S.overlay.id, zh = $("#pzh").value.trim(), addr = $("#paddr").value.trim();
    S.places[id] = { zh: zh || PLACES[id].zh, addr }; put("places", id, S.places[id]);
    renderOverlay(); render(); toast("Saved for both of you");
  }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "tfile") {
    S.adding.files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    S.adding.files = [...t.files].map((f) => {
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      return { file: f, isPdf, url: isPdf ? "" : URL.createObjectURL(f) };
    });
    readForm(); render(true); return;
  }
  if (t.id === "tbk") { readForm(); if (!S.adding.title && t.value) { S.adding.title = bkData(t.value).name; $("#ttitle").value = S.adding.title; } return; }
  if (t.id === "pv") { S.preview = t.value ? +new Date(t.value + ":00+08:00") : null; render(true); return; }
  if (!uid) return;
  if (t.dataset.bkstatus) { const id = t.dataset.bkstatus; S.bookings[id] = { ...(S.bookings[id] || {}), status: t.value }; render(true); put("bookings", id, S.bookings[id]); }
  else if (t.dataset.bkref) { const id = t.dataset.bkref; S.bookings[id] = { ...(S.bookings[id] || {}), status: bkData(id).status, ref: t.value.trim() }; put("bookings", id, S.bookings[id]); toast("Saved"); }
  else if (t.dataset.check) { const id = t.dataset.check; S.checks[id] = { done: t.checked }; render(true); put("checks", id, S.checks[id]); }
  else if (t.dataset.idea) { const id = t.dataset.idea; S.ideas[id] = { picked: t.checked }; render(true); put("ideas", id, S.ideas[id]); }
});
document.addEventListener("focusout", () => {
  setTimeout(() => { if (S.dirty && !(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))) render(true); }, 0);
});

/* ========================= sign-in + unlock ========================= */
function toEmail(name) {
  name = name.trim().toLowerCase();
  if (name.includes("@")) return name;
  if (!/^[a-z0-9._-]{2,30}$/.test(name)) throw { code: "app/bad-username" };
  return name + "@" + USER_DOMAIN;
}
const toPassword = (pw) => (pw.length < 6 ? pw + "#cfa-pin" : pw);
function authMsg(text, err) { const m = $("#authMsg"); m.textContent = text; m.className = "msg" + (err ? " err" : ""); }
function authError(e) {
  const map = {
    "app/bad-username": "Use 2 to 30 letters or numbers for the username (dots, dashes and underscores are fine too).",
    "auth/invalid-credential": "Wrong password for that username.",
    "auth/wrong-password": "Wrong password for that username.",
    "auth/email-already-in-use": "Wrong password for that username.",
    "auth/network-request-failed": "No connection. Check your internet and try again.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  };
  console.error(e);
  authMsg(map[e.code] || "Couldn't sign in (" + (e.code || e.message || e) + ").", true);
}
$("#signin").addEventListener("submit", async (e) => {
  e.preventDefault();
  let email; const password = $("#password").value;
  try { email = toEmail($("#username").value); } catch (err) { authError(err); return; }
  if (password.length < 4) { authMsg("Use a password with at least 4 characters.", true); return; }
  $("#signInBtn").disabled = true; authMsg("Signing in…");
  try {
    await fb.signInWithEmailAndPassword(fb.auth, email, toPassword(password)); authMsg("");
  } catch (err) {
    // Same error for "no such account" and "wrong password": try creating it; if taken, the password was wrong.
    if (["auth/invalid-credential", "auth/user-not-found", "auth/invalid-login-credentials"].includes(err.code)) {
      try { await fb.createUserWithEmailAndPassword(fb.auth, email, toPassword(password)); authMsg(""); } catch (err2) { authError(err2); }
    } else authError(err);
  }
  $("#signInBtn").disabled = false;
});
$("#unlock").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#unlockBtn").disabled = true; $("#unlockMsg").className = "msg"; $("#unlockMsg").textContent = "Unlocking…";
  await unlock($("#passphrase").value.trim());
  $("#unlockBtn").disabled = false;
});
$("#signOut2").onclick = () => fb.signOut(fb.auth);

gate("loading");
boot().catch((e) => { console.error(e); $("#loadMsg").textContent = "Couldn't load. Check your connection and reopen the app."; });
