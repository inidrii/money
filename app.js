/* Money — offline-first app for the "Monthly expenses" Google Sheet.
 * Everything is saved on the phone first (instant, works offline) and synced to the
 * sheet through the Apps Script API whenever there is a connection. */
'use strict';

const $ = id => document.getElementById(id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MODES = {
  Expense:    { color: 'var(--exp)', account: 'Paid from',   desc: 'Seller / description', save: 'Save expense',    scan: true,  cats: 'Expense' },
  Income:     { color: 'var(--inc)', account: 'Received in', desc: 'Client / description', save: 'Save income',     scan: true,  cats: 'Income' },
  Transfer:   { color: 'var(--tra)', account: 'From',        desc: 'Description',          save: 'Save transfer',   scan: false, cats: null },
  Adjustment: { color: 'var(--adj)', account: 'Account',     desc: 'Description',          save: 'Save correction', scan: false, cats: null }
};

/* ---------- Small helpers ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('money.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('money.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('money.' + k); } catch (e) {} }
};
function rid() { const a = new Uint8Array(8); crypto.getRandomValues(a); return 'e' + [...a].map(b => b.toString(16).padStart(2, '0')).join(''); }
function today() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function num(v) { return parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); }
function fmt(n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function money(n, cur, signed) {
  const s = signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
  return s + fmt(Math.abs(n)) + (cur ? ' ' + cur : '');
}
function r2(n) { return Math.round(n * 100) / 100; }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function fill(select, items, placeholder) {
  select.innerHTML = '';
  if (placeholder != null) select.appendChild(new Option(placeholder, ''));
  items.forEach(v => select.appendChild(typeof v === 'object' ? new Option(v.label, v.value) : new Option(v, v)));
}
function shortDate(iso) { return iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''; }
function keyOfDate(iso) { const p = String(iso).split('-'); return +p[0] * 12 + (+p[1] - 1); }
function keyOfTab(tab) { const m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(tab || ''); return m ? +m[2] * 12 + MONTHS.indexOf(m[1]) : NaN; }
function tabName(key) { return MONTHS[key % 12] + ' ' + Math.floor(key / 12); }
function currentKey() { return keyOfDate(today()); }
function keyOf(e) { return e.date ? keyOfDate(e.date) : keyOfTab(e.tab); }

// Messages slide down from the top (✓ success, ⚠ problem); tap to close.
let toastTimer = null;
function toast(text, type) {
  const kind = type === true || type === 'err' ? 'err' : type === 'ok' ? 'ok' : 'info';
  const t = $('toast');
  $('toastIcon').textContent = kind === 'err' ? '⚠' : kind === 'ok' ? '✓' : 'ℹ';
  $('toastText').textContent = text;
  t.className = kind;
  void t.offsetWidth;                       // restart the slide-in when messages follow each other
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'err' ? 6000 : 2800);
}
$('toast').addEventListener('click', () => $('toast').classList.remove('show'));
function flash(id, text, ok) {
  if (id === 'connMsg') { const m = $(id); m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'err'); return; }
  toast(text, ok ? 'ok' : 'err');
}
// Points at a field that needs fixing: red outline, scroll to it, and say why.
function invalid(fieldId, text) {
  const f = $(fieldId);
  if (f) { f.classList.add('invalid'); f.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  toast(text, 'err');
}
document.addEventListener('input', ev => ev.target.classList && ev.target.classList.remove('invalid'));
document.addEventListener('change', ev => ev.target.classList && ev.target.classList.remove('invalid'));
function busy(text) { $('busyText').textContent = text; $('busy').classList.remove('hide'); }
function idle() { $('busy').classList.add('hide'); }

/* ---------- State (kept on the phone) ---------- */
let cfg = store.get('cfg', null);              // {u: API url, k: personal key}
let data = store.get('data', null);            // last copy of the sheet: {setup, entries, months, serverTime}
let outbox = store.get('outbox', []);          // changes not yet in the sheet
let lastSync = store.get('lastSync', null);
const saveData = () => store.set('data', data);
const saveOutbox = () => store.set('outbox', outbox);

function decodeCode(s) {
  s = String(s || '').trim().replace(/^.*#c=/, '').replace(/\s/g, '');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const o = JSON.parse(decodeURIComponent(escape(atob(s))));
  if (!o || !/^https:\/\/script\.google\.com\//.test(o.u) || !o.k) throw new Error('bad code');
  return { u: o.u, k: o.k };
}
// A connection code in the link (…/#c=CODE) also connects; it stays in the Home Screen link.
(function () {
  const m = /#c=([^&]+)/.exec(location.hash);
  if (!m) return;
  try { const c = decodeCode(m[1]); if (!cfg || cfg.k !== c.k || cfg.u !== c.u) { cfg = c; store.set('cfg', cfg); } } catch (e) {}
})();

/* ---------- Talking to the sheet ---------- */
async function api(action, payload) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    // text/plain keeps this a "simple" request, which Google's servers accept from another site.
    const res = await fetch(cfg.u, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: cfg.k, action: action }, payload || {}))
    });
    const j = await res.json();
    if (!j.ok) { const e = new Error(j.error || 'Something went wrong.'); e.auth = !!j.auth; e.server = true; throw e; }
    return j;
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('The sheet took too long to answer.'); t.network = true; throw t; }
    if (!e.server) e.network = true;
    throw e;
  } finally { clearTimeout(timer); }
}

let syncing = false, syncAgain = false, syncTimer = null, syncError = '';
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms == null ? 400 : ms); }

async function sync() {
  if (!cfg) return;
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { syncError = ''; status(); return; }
  syncing = true; syncAgain = false; status();
  try {
    const ops = outbox.slice(0, 25);
    const j = ops.length ? await api('sync', { ops: ops, appUrl: location.href.split('#')[0] }) : await api('pull');
    if (ops.length) {
      const done = new Set((j.results || []).map(r => r.opId));
      outbox = outbox.filter(o => !done.has(o.opId));
      saveOutbox();
      (j.results || []).filter(r => !r.ok).forEach(r => toast('Not saved in the sheet: ' + r.error, true));
      if (outbox.length) syncAgain = true;
    }
    data = j.data; saveData();
    lastSync = new Date().toISOString(); store.set('lastSync', lastSync);
    syncError = '';
    render();
    deliver(j.notify);                 // notifications the sheet prepared (partner, budget, low balance)
    bookReminders();
  } catch (e) {
    // A slow answer or a dropped connection is not an error: the change stays on the phone and is
    // sent again (anything that already reached the sheet is recognised by its ID and skipped).
    syncError = e.network ? '' : e.message;
    if (e.auth) { toast(e.message, true); }
    if (e.network && outbox.length) syncAgain = 'later';
  } finally {
    syncing = false; status();
    if (syncAgain === 'later') { syncAgain = false; scheduleSync(15000); }
    else if (syncAgain && !syncError && navigator.onLine) scheduleSync(200);
  }
}

function status() {
  const b = $('sync');
  if (!cfg || !data) { b.classList.add('hide'); return; }
  b.classList.remove('hide');
  const n = outbox.length;
  let cls = '', text = 'Synced';
  if (syncing) { cls = 'syncing'; text = 'Syncing'; }
  else if (!navigator.onLine) { cls = 'offline'; text = n ? 'Offline · ' + n : 'Offline'; }
  else if (syncError) { cls = 'error'; text = 'Sync error'; }
  else if (n) { cls = 'syncing'; text = n + ' waiting'; }
  if (updateReady && !syncing) { cls = 'update'; text = 'Update ↻'; }     // a new app version is ready
  b.className = cls;
  $('syncText').textContent = text;
}
$('sync').addEventListener('click', () => {
  if (updateReady) return applyUpdate();
  if (syncError) toast(syncError, true);
  else if (!navigator.onLine) toast(outbox.length ? 'Offline. ' + outbox.length + ' change(s) will sync when you are back online.' : 'Offline. Everything is saved on this phone.');
  sync();
});
window.addEventListener('online', () => { status(); sync(); });
window.addEventListener('offline', status);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);

/* ---------- Notifications (ntfy) ----------
 * Google's servers can't reach ntfy.sh, so the phones deliver the notifications themselves.
 * Messages that can't be sent right now wait on the phone and go out with the next sync. */
let nq = store.get('nq', []), delivering = false;
async function ntfyPost(body) {
  // Tapping a notification runs the iPhone Shortcut "Open Money", which opens the installed
  // Home Screen app (webapp://https://…). ntfy can't open webapp:// links itself, and a plain
  // https:// link would open Safari instead of the installed app.
  body = Object.assign({}, body, { click: 'shortcuts://run-shortcut?name=' + encodeURIComponent('Open Money') });
  // text/plain keeps this a simple request; ntfy reads the JSON body either way.
  const res = await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify(body),
                                                headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
  if (!res.ok) throw new Error('ntfy answered ' + res.status);
}
async function deliver(list) {
  if (list && list.length) { nq = nq.concat(list).slice(-50); store.set('nq', nq); }
  if (delivering || !nq.length || !navigator.onLine) return;
  delivering = true;
  try {
    while (nq.length) {
      try { await ntfyPost(nq[0]); } catch (e) { break; }
      nq.shift(); store.set('nq', nq);
    }
  } finally { delivering = false; }
}
// Daily reminder: ntfy can hold a message until a set time, so the phone books the reminder
// for today (if nothing is logged yet) and the next two days, each time the app syncs.
async function bookReminders() {
  const s = data && data.setup;
  if (!s || !s.myTopic || !navigator.onLine) return;
  const booked = store.get('reminders', {}), hour = Number(s.reminderHour), now = Date.now();
  const loggedToday = entries().some(e => e.date === today() && e.who === s.me);
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  for (let i = 0; i < 3; i++) {
    const at = new Date(); at.setDate(at.getDate() + i); at.setHours(hour, 0, 0, 0);
    const key = ymd(at) + '@' + hour;
    if (booked[key] || at.getTime() < now + 2 * 60000 || (i === 0 && loggedToday)) continue;
    try {
      await ntfyPost({ topic: s.myTopic, title: '📝 Money · Reminder', message: 'Time to log today\'s expenses (ignore this if you already did).',
                       delay: String(Math.floor(at.getTime() / 1000)) });
      booked[key] = true;
    } catch (e) { break; }
  }
  const yesterday = ymd(new Date(now - 86400000));
  Object.keys(booked).forEach(k => { if (k.slice(0, 10) < yesterday) delete booked[k]; });
  store.set('reminders', booked);
}

/* ---------- The data as the app shows it: sheet copy + changes not synced yet ---------- */
function entries() {
  const map = new Map((data ? data.entries : []).map(e => [e.id, e]));
  outbox.forEach(o => {
    if (o.op === 'delete') map.delete(o.id);
    else map.set(o.id, Object.assign({ id: o.id, pending: true }, o.entry));
  });
  return [...map.values()];
}
function S() { return data.setup; }
function account(name) { return S().accounts.find(a => a.name === name); }
function currencyOf(name) { const a = account(name); return a ? a.currency : ''; }

/** Balances, totals, categories and people for one month (same rules as the sheet). */
function overview(key) {
  const accs = {};
  S().accounts.forEach(a => { accs[a.name] = Object.assign({}, a, { open: a.opening, income: 0, expense: 0, out: 0, in: 0, adj: 0 }); });
  const month = [];
  entries().forEach((e, i) => {
    const k = keyOf(e);
    if (!(k <= key)) return;
    const now = k === key;
    if (now) month.push(Object.assign({ _i: i }, e));
    const amt = Number(e.amount) || 0, A = accs[e.account], T = accs[e.toAccount];
    const add = (acc, field, v) => { if (!acc) return; if (now) acc[field] += v; else acc.open += (field === 'expense' || field === 'out' ? -v : v); };
    if (e.type === 'Income') add(A, 'income', amt);
    else if (e.type === 'Expense') add(A, 'expense', amt);
    else if (e.type === 'Adjustment') add(A, 'adj', amt);
    else if (e.type === 'Transfer') { add(A, 'out', amt); add(T, 'in', e.received != null && e.received > 0 ? Number(e.received) : amt); }
  });
  const accounts = S().accounts.map(a => {
    const x = accs[a.name];
    x.closing = r2(x.open + x.income - x.expense - x.out + x.in + x.adj);
    return x;
  });
  const totals = {}, cats = {}, who = {};
  month.forEach(e => {
    if (e.type !== 'Income' && e.type !== 'Expense') return;
    const c = currencyOf(e.account) || 'ALL', amt = Number(e.amount) || 0;
    totals[c] = totals[c] || { income: 0, expense: 0 };
    totals[c][e.type === 'Income' ? 'income' : 'expense'] += amt;
    const w = e.who || 'Not set';
    who[c] = who[c] || {}; who[c][w] = who[c][w] || { income: 0, expense: 0 };
    who[c][w][e.type === 'Income' ? 'income' : 'expense'] += amt;
    if (e.type === 'Expense') { cats[c] = cats[c] || {}; const k = e.category || 'Uncategorised'; cats[c][k] = (cats[c][k] || 0) + amt; }
  });
  month.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b._i - a._i);
  return { key: key, tab: tabName(key), accounts: accounts, totals: totals, cats: cats, who: who, entries: month };
}
function monthKeys() {
  const ks = new Set([currentKey()]);
  (data.months || []).forEach(t => { const k = keyOfTab(t); if (!isNaN(k)) ks.add(k); });
  entries().forEach(e => { const k = keyOf(e); if (!isNaN(k)) ks.add(k); });
  return [...ks].sort((a, b) => a - b);
}
function curOrder(list) { return [...new Set(list)].sort((a, b) => (a === 'ALL' ? -1 : b === 'ALL' ? 1 : a.localeCompare(b))); }

/* ---------- Navigation ---------- */
let view = 'Add';
function showView(v) {
  view = v;
  ['Connect', 'Add', 'Accounts', 'Account', 'Month', 'Settings', 'AccountEdit'].forEach(x => $('view' + x).classList.toggle('hide', x !== v));
  const tab = v === 'Account' ? 'Accounts' : v === 'AccountEdit' ? 'Settings' : v;
  document.querySelectorAll('#bottombar button[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === tab));
  $('bottombar').classList.toggle('hide', v === 'Connect');
  window.scrollTo(0, 0);
  renderView();
}
function renderView() {
  if (!data) return;
  if (view === 'Accounts') renderAccounts();
  if (view === 'Account' && openAccName) renderAccount();
  if (view === 'Month') renderMonth();
  if (view === 'Settings') renderSettings();
}
/** Called after every sync: refresh lists and dropdowns without disturbing a half-filled form. */
function render() {
  refreshForm();
  renderView();
  status();
}
document.querySelectorAll('#bottombar button[data-view]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.view === 'Month' && view === 'Month') monthKey = currentKey();
  if (editTx) endEdit();
  showView(b.dataset.view);
}));

/* ---------- Add / edit form ---------- */
let mode = 'Expense';
let editTx = null;              // {id, back, accName}
let invoice = blankInvoice();
let amountEdited = false, whoEdited = false, lookupSeq = 0;
function blankInvoice() { return { iic: '', nipt: '', amounts: null, currency: '', rate: null, pending: false }; }

function refreshForm() {
  const names = S().accounts.map(a => a.name);
  const keep = { a: $('account').value, t: $('toAccount').value, w: $('who').value, c: $('category').value };
  fill($('account'), names);
  fill($('toAccount'), names, 'Choose…');
  fill($('who'), S().owners);
  if (names.includes(keep.a)) $('account').value = keep.a;
  if (names.includes(keep.t)) $('toAccount').value = keep.t;
  if (S().owners.includes(keep.w)) $('who').value = keep.w;
  const cfgM = MODES[mode];
  if (cfgM.cats) { fill($('category'), S().categories.filter(c => c.type === cfgM.cats).map(c => c.name), 'Choose…'); $('category').value = keep.c; }
  if (!keep.a) setMode(mode); else updateCurrency();
}

function setMode(m) {
  mode = m;
  const c = MODES[m];
  document.documentElement.style.setProperty('--accent', c.color);
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.type === m));
  $('accountLabel').textContent = c.account;
  $('descLabel').textContent = c.desc;
  $('save').textContent = editTx ? 'Save changes' : c.save;
  $('scanBlock').classList.toggle('hide', !c.scan || !!editTx);
  $('toBlock').classList.toggle('hide', m !== 'Transfer');
  $('categoryBlock').classList.toggle('hide', !c.cats);
  $('amtSign').classList.toggle('hide', m !== 'Adjustment');
  if (c.cats) fill($('category'), S().categories.filter(x => x.type === c.cats).map(x => x.name), 'Choose…');
  if (!editTx) {
    const last = store.get('lastAccount_' + m, null);
    if (last && account(last)) $('account').value = last;
    if (m === 'Transfer') { const t = store.get('lastTo', null); if (t && account(t)) $('toAccount').value = t; }
  }
  updateCurrency();
  $('msg').className = 'msg';
}

function updateCurrency() {
  $('cur').textContent = currencyOf($('account').value);
  const to = currencyOf($('toAccount').value);
  $('cur2').textContent = to;
  const fx = mode === 'Transfer' && $('toAccount').value && to && to !== $('cur').textContent;
  $('receivedBlock').classList.toggle('hide', !fx);
  whoDefault();
}
// Who = the person using this phone (from the connection code); can be changed by hand.
function whoDefault() {
  if (whoEdited || !data) return;
  const has = v => v && [...$('who').options].some(o => o.value === v);
  if (has(S().me)) { $('who').value = S().me; return; }
  const a = account($('account').value);
  if (a && has(a.owner)) $('who').value = a.owner;
}
function resetForm() {
  invoice = blankInvoice(); amountEdited = false; whoEdited = false;
  ['amount', 'received', 'description', 'link'].forEach(id => { $(id).value = ''; });
  $('category').value = '';
  $('info').textContent = ''; $('amountHint').textContent = '';
  $('date').value = today();
  whoDefault();
}

document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.type === mode) return;
  if (!editTx) resetForm();
  setMode(b.dataset.type);
}));
$('account').addEventListener('change', () => { updateCurrency(); applyInvoiceAmount(); });
$('toAccount').addEventListener('change', updateCurrency);
$('amount').addEventListener('input', () => { amountEdited = true; });
$('who').addEventListener('change', () => { whoEdited = true; });
$('amtSign').addEventListener('click', () => { const v = $('amount').value.trim(); $('amount').value = v.startsWith('-') ? v.slice(1) : '-' + v; });

/* ---------- Invoices (QR) ---------- */
function applyInvoiceAmount() {
  if (!invoice.amounts || amountEdited) return;
  const accCur = currencyOf($('account').value) || 'ALL';
  const a = invoice.amounts;
  let hint = 'Invoice: ' + Object.keys(a).map(c => fmt(a[c]) + ' ' + c).join(' = ') + (invoice.rate ? ' (rate ' + invoice.rate + ')' : '');
  if (a[accCur] != null) $('amount').value = a[accCur].toFixed(2);
  else {
    $('amount').value = '';
    hint += invoice.pending ? '. Getting the ' + accCur + ' amount from the tax office…'
                            : '. This invoice has no ' + accCur + ' amount: enter what was charged to this account.';
  }
  $('amountHint').textContent = hint;
}

function applyLink(url) {
  const p = new URLSearchParams(String(url).split('?')[1] || '');
  if (!p.get('prc')) { flash('msg', 'This QR is not a fiscal invoice link.', false); return; }
  const nipt = (p.get('tin') || '').trim();
  const mine = S().myNipts.includes(nipt);
  const target = mine ? 'Income' : 'Expense';      // your own NIPT = an invoice you issued
  if (mode !== target) setMode(target);
  $('description').value = ''; $('category').value = '';
  const crtd = p.get('crtd') || '';
  amountEdited = false;
  invoice = blankInvoice();
  invoice.iic = p.get('iic') || ''; invoice.nipt = nipt;
  invoice.amounts = { ALL: r2(num(p.get('prc'))) };  // the QR total is always in ALL
  invoice.pending = true;
  $('link').value = url;
  if (/^\d{4}-\d{2}-\d{2}/.test(crtd)) $('date').value = crtd.slice(0, 10);
  const known = S().sellers[nipt];
  if (mode === 'Expense' && known) {
    if (known.name) $('description').value = known.name;
    if (known.category) $('category').value = known.category;
  }
  if (entries().some(e => invoice.iic && ((e.note || '').includes(invoice.iic) || e.iic === invoice.iic))) {
    flash('msg', 'This invoice is already saved.', false);
  } else $('msg').className = 'msg';
  applyInvoiceAmount();

  if (!navigator.onLine) {
    invoice.pending = false; applyInvoiceAmount();
    $('info').textContent = 'Offline: using the QR amount (in ALL). Seller name and currency are checked only online.';
    return;
  }
  $('info').textContent = 'Checking the invoice at the tax office…';
  busy('Checking the invoice at the tax office…');
  const seq = ++lookupSeq;
  api('lookupInvoice', { iic: invoice.iic, crtd: crtd, tin: nipt }).then(j => {
    if (seq !== lookupSeq) return;
    const r = j.invoice;
    invoice.pending = false; invoice.amounts = r.amounts; invoice.currency = r.currency; invoice.rate = r.rate;
    if (r.currency && currencyOf($('account').value) !== r.currency) {    // pick an account in the invoice's currency
      const same = S().accounts.filter(a => a.currency === r.currency).map(a => a.name);
      const last = store.get('lastAccountCur_' + r.currency, null);
      const pick = same.includes(last) ? last : same[0];
      if (pick) { $('account').value = pick; updateCurrency(); }
    }
    if (mode === 'Expense' && !$('description').value && r.seller) $('description').value = r.seller;
    if (mode === 'Income' && !$('description').value && r.buyer) $('description').value = r.buyer;
    const who = mode === 'Income' ? (r.buyer ? 'Client: ' + r.buyer : 'Your outgoing invoice') : (r.seller || 'Seller');
    $('info').textContent = '✓ ' + who + (r.invoiceNumber ? ' · invoice ' + r.invoiceNumber : '') +
      (r.items ? ' · ' + r.items + ' item' + (r.items > 1 ? 's' : '') : '') + (r.payment ? ' · ' + r.payment : '');
    applyInvoiceAmount();
  }).catch(e => {
    if (seq !== lookupSeq) return;
    invoice.pending = false; applyInvoiceAmount();
    $('info').textContent = 'Couldn\'t check the invoice (' + e.message + '). Using the QR amount, which is in ALL.';
  }).finally(() => { if (seq === lookupSeq) idle(); });
}
$('link').addEventListener('input', ev => { if (ev.target.value.indexOf('?') > 0) applyLink(ev.target.value.trim()); });

/* Live scanner (camera) with photo as fallback */
let stream = null, scanning = false;
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

async function openScanner() {
  if (editTx) endEdit();
  if (view !== 'Add') showView('Add');
  $('liveErr').classList.add('hide'); $('liveFrame').classList.remove('hide');
  $('live').classList.remove('hide');
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return cameraUnavailable();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) { return cameraUnavailable(); }
  const v = $('liveVideo');
  v.srcObject = stream;
  try { await v.play(); } catch (e) {}
  scanning = true;
  scanFrame();
}
function cameraUnavailable() {
  $('liveFrame').classList.add('hide');
  $('liveErr').textContent = 'The camera isn\'t available. Allow camera access for Money in iPhone Settings, or take a photo of the QR instead.';
  $('liveErr').classList.remove('hide');
}
function closeScanner() {
  scanning = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('liveVideo').srcObject = null;
  $('live').classList.add('hide');
}
function scanFrame() {
  if (!scanning) return;
  const v = $('liveVideo');
  if (v.readyState >= 2 && v.videoWidth) {
    const vw = v.videoWidth, vh = v.videoHeight, s = Math.min(vw, vh) * 0.85;
    const size = Math.min(720, Math.round(s));
    canvas.width = size; canvas.height = size;
    ctx.drawImage(v, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const code = jsQR(img.data, size, size, { inversionAttempts: 'dontInvert' });
    if (code && code.data) {
      closeScanner();
      if (navigator.vibrate) navigator.vibrate(40);
      applyLink(code.data);
      return;
    }
  }
  setTimeout(() => requestAnimationFrame(scanFrame), 90);
}
$('scanBtn').addEventListener('click', openScanner);
$('liveCancel').addEventListener('click', closeScanner);
// Paste an invoice link copied elsewhere (e.g. from the iPhone camera or a message).
$('livePaste').addEventListener('click', async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (e) {}
  if (!/[?&]prc=/.test(text)) return toast('No invoice link on the clipboard. Copy the link first, then tap Paste link.', 'err');
  closeScanner();
  applyLink(text.trim());
});

function loadImage(file) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
async function decodePhoto(file) {
  const img = await loadImage(file);
  const W = img.naturalWidth, H = img.naturalHeight;
  const crops = [[0, 0, 1], [0.15, 0.15, 0.7], [0.25, 0.25, 0.5]];
  for (const target of [1200, 800, 1600, 600]) {
    for (const [cx, cy, cw] of crops) {
      const sx = W * cx, sy = H * cy, sw = W * cw, sh = H * cw;
      const scale = Math.min(1, target / Math.max(sw, sh));
      canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
      if (code && code.data) return code.data;
    }
  }
  throw new Error('No QR found');
}
$('photo').addEventListener('change', ev => {
  const file = ev.target.files[0];
  if (!file) return;
  closeScanner();
  if (view !== 'Add') showView('Add');
  busy('Reading the QR code…');
  decodePhoto(file)
    .then(text => { idle(); applyLink(text); })
    .catch(() => { idle(); flash('msg', 'No QR code found. Hold the phone 10–15 cm from the QR, in good light, and try again.', false); })
    .finally(() => { ev.target.value = ''; });
});

/* ---------- Saving (always on the phone first) ---------- */
function queue(op) { op.opId = rid(); outbox.push(op); saveOutbox(); status(); scheduleSync(); }

function formEntry() {
  const fx = !$('receivedBlock').classList.contains('hide');
  return {
    type: mode, date: $('date').value, amount: num($('amount').value), account: $('account').value,
    toAccount: mode === 'Transfer' ? $('toAccount').value : '',
    received: fx ? num($('received').value) : null,
    category: MODES[mode].cats ? $('category').value : '',
    description: $('description').value.trim(), who: $('who').value
  };
}
// Returns [message, field] for the first problem, or null.
function checkEntry(e) {
  const okAmt = e.type === 'Adjustment' ? (!isNaN(e.amount) && e.amount !== 0) : e.amount > 0;
  if (!okAmt) return ['Enter an amount.', 'amount'];
  if (!e.date) return ['Choose a date.', 'date'];
  if (e.type === 'Transfer') {
    if (!e.toAccount) return ['Choose the account the money goes to.', 'toAccount'];
    if (e.toAccount === e.account) return ['From and To must be different accounts.', 'toAccount'];
    if (!$('receivedBlock').classList.contains('hide') && !(e.received > 0)) return ['Enter the amount received.', 'received'];
  }
  if (MODES[e.type].cats && !e.category) return ['Choose a category.', 'category'];
  return null;
}

$('save').addEventListener('click', () => {
  const e = formEntry();
  const bad = checkEntry(e);
  if (bad) return invalid(bad[1], bad[0]);
  if (editTx) return saveEdit(e);
  if (invoice.iic) {
    if (entries().some(x => (x.note || '').includes(invoice.iic) || x.iic === invoice.iic)) return flash('msg', 'This invoice is already saved.', false);
    e.iic = invoice.iic; e.nipt = invoice.nipt;
    e.note = 'Invoice ' + invoice.iic + (invoice.nipt ? ' · NIPT ' + invoice.nipt : '');
    if (mode === 'Expense') S().sellers[invoice.nipt] = { name: e.description, category: e.category };
    if (mode === 'Income' && !S().myNipts.includes(invoice.nipt)) S().myNipts.push(invoice.nipt);
    saveData();
  }
  queue({ op: 'add', id: rid(), entry: e });
  store.set('lastAccount_' + mode, e.account);
  store.set('lastAccountCur_' + currencyOf(e.account), e.account);
  if (mode === 'Transfer') store.set('lastTo', e.toAccount);
  toast(navigator.onLine ? e.type + ' saved.' : e.type + ' saved on this phone. It will sync when you are online.', 'ok');
  resetForm();
});

function startEdit(t, back) {
  editTx = { id: t.id, back: back, accName: openAccName || '' };
  invoice = blankInvoice();
  showView('Add');
  $('msg').className = 'msg';
  setMode(t.type);
  $('addTitle').textContent = 'Edit entry';
  $('editBar').classList.remove('hide');
  $('editDelete').classList.remove('armed'); $('editDelete').textContent = 'Delete entry';
  $('link').value = '';
  $('account').value = t.account;
  $('toAccount').value = t.toAccount || '';
  $('amount').value = Number(t.amount).toFixed(2);
  $('received').value = t.received != null ? Number(t.received).toFixed(2) : '';
  $('date').value = t.date || today();
  if (MODES[t.type].cats) $('category').value = t.category;
  $('description').value = t.description || '';
  amountEdited = true; whoEdited = true;
  if ([...$('who').options].some(o => o.value === t.who)) $('who').value = t.who;
  $('info').textContent = t.pending ? 'Not synced yet.' : '';
  $('amountHint').textContent = '';
  updateCurrency();
}
function endEdit() {
  editTx = null;
  $('addTitle').textContent = 'Add';
  $('editBar').classList.add('hide');
  if (mode === 'Adjustment') setMode('Expense'); else setMode(mode);
  resetForm();
}
function leaveEdit(text) {
  const back = editTx.back, accName = editTx.accName;
  endEdit();
  if (back === 'Account' && accName) { openAccount(accName); }
  else showView(back || 'Month');
  toast(text, 'ok');
}
function saveEdit(e) {
  const id = editTx.id;
  const add = outbox.find(o => o.op === 'add' && o.id === id);
  if (add) { add.entry = Object.assign({}, add.entry, e); saveOutbox(); scheduleSync(); }   // not in the sheet yet: change the pending add
  else {
    outbox = outbox.filter(o => !(o.op === 'update' && o.id === id));
    queue({ op: 'update', id: id, entry: e });
  }
  leaveEdit('Changes saved.');
}
$('editCancel').addEventListener('click', () => {
  const back = editTx ? editTx.back : 'Month', accName = editTx ? editTx.accName : '';
  endEdit();
  if (back === 'Account' && accName) openAccount(accName); else showView(back);
});
$('editDelete').addEventListener('click', () => {
  const b = $('editDelete');
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Tap again to delete this entry'; return; }
  const id = editTx.id;
  const pendingAdd = outbox.some(o => o.op === 'add' && o.id === id);
  outbox = outbox.filter(o => o.id !== id);
  saveOutbox();
  if (!pendingAdd) queue({ op: 'delete', id: id }); else status();
  leaveEdit('Entry deleted.');
});

/* ---------- Accounts ---------- */
let openAccName = null;
function renderAccounts() {
  const o = overview(currentKey());
  $('accSub').textContent = 'Balances with everything entered up to ' + o.tab + '.';
  const tot = {}, loans = {};
  o.accounts.forEach(a => {
    const box = a.type === 'Loan' ? loans : tot;
    box[a.currency] = (box[a.currency] || 0) + a.closing;
    if (!(a.currency in tot)) tot[a.currency] = 0;
  });
  const card = (label, value, cur, note) => {
    const c = el('div', 'card');
    c.appendChild(el('div', 'label', label));
    c.appendChild(el('div', 'val' + (value < 0 ? ' neg' : ''), money(value, cur)));
    if (note) c.appendChild(el('div', 'sub', note));
    return c;
  };
  const t = $('accTotals'); t.innerHTML = '';
  curOrder(Object.keys(tot)).forEach(c => t.appendChild(card('Total ' + c, tot[c], c)));
  const l = $('accTotalsLoans'); l.innerHTML = '';
  curOrder(Object.keys(loans)).forEach(c => l.appendChild(card(c + ' including loans', tot[c] + loans[c], c, 'Loans: ' + money(loans[c], c))));

  const order = S().owners;
  const group = a => a.type === 'Loan' ? 'Loans' : (a.owner || 'Other');
  const groups = [...new Set(o.accounts.map(group))]
    .sort((a, b) => (a === 'Loans') - (b === 'Loans') || (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const g = $('accGroups'); g.innerHTML = '';
  groups.forEach(name => {
    g.appendChild(el('h2', null, name));
    o.accounts.filter(a => group(a) === name).forEach(a => {
      const b = el('button', 'row'); b.type = 'button';
      const left = el('div', 'l');
      left.appendChild(el('div', 'name', a.name));
      left.appendChild(el('div', 'sub', 'This month: ' + money(a.income + a.in, '', true) + ' in · ' + money(-(a.expense + a.out), '', true) + ' out'));
      const right = el('div', 'r');
      right.appendChild(el('span', 'amt' + (a.closing < 0 ? ' neg' : ''), money(a.closing, a.currency)));
      right.appendChild(el('span', 'chev', '›'));
      b.appendChild(left); b.appendChild(right);
      b.addEventListener('click', () => openAccount(a.name));
      g.appendChild(b);
    });
  });
}
function openAccount(name) { openAccName = name; showView('Account'); }
function renderAccount() {
  const o = overview(currentKey());
  const a = o.accounts.find(x => x.name === openAccName);
  if (!a) { showView('Accounts'); return; }
  $('adName').textContent = a.name;
  $('adBalance').textContent = money(a.closing, a.currency);
  $('adBalance').className = 'bigNum' + (a.closing < 0 ? ' neg' : '');
  $('adLine').textContent = 'Start of ' + o.tab + ': ' + money(a.open, a.currency) + ' · in ' + fmt(a.income + a.in) +
    ' · out ' + fmt(a.expense + a.out) + (a.adj ? ' · corrections ' + money(a.adj, '', true) : '');
  $('adListTitle').textContent = 'Transactions in ' + o.tab;
  const txs = o.entries.filter(t => t.account === a.name || t.toAccount === a.name);
  renderTxList($('adList'), txs.map(t => {
    let amt, title = t.description || t.category || t.type, sub;
    if (t.type === 'Adjustment') { amt = t.amount; title = 'Balance correction'; sub = t.who; }
    else if (t.type === 'Income') { amt = t.amount; sub = t.description ? t.category : ''; }
    else if (t.type === 'Expense') { amt = -t.amount; sub = t.description ? t.category : ''; }
    else if (t.account === a.name) { amt = -t.amount; sub = 'Transfer to ' + t.toAccount; if (!t.description) title = 'Transfer'; }
    else { amt = t.received != null && t.received > 0 ? t.received : t.amount; sub = 'Transfer from ' + t.account; if (!t.description) title = 'Transfer'; }
    return { src: t, date: t.date, title: title, sub: sub, amt: amt, cur: a.currency, type: t.type, signed: true };
  }), 'Account');
}
$('accBack').addEventListener('click', () => showView('Accounts'));

/* Correct balance */
function fixDiff() {
  const o = overview(keyOfDate($('adDate').value || today()));
  const a = o.accounts.find(x => x.name === openAccName);
  const v = num($('adActual').value);
  if (!a || isNaN(v)) { $('adDiff').textContent = ''; return null; }
  const d = r2(v - a.closing);
  $('adDiff').textContent = d ? 'Correction: ' + money(d, a.currency, true) : 'Matches the app already: nothing to correct.';
  return { diff: d, currency: a.currency };
}
$('adFix').addEventListener('click', () => {
  const box = $('adFixBox');
  box.classList.toggle('hide');
  if (!box.classList.contains('hide')) {
    const a = overview(currentKey()).accounts.find(x => x.name === openAccName);
    $('adActual').value = a ? a.closing.toFixed(2) : '';
    $('adDate').value = today();
    fixDiff();
  }
});
$('adActual').addEventListener('input', fixDiff);
$('adDate').addEventListener('change', fixDiff);
$('adSign').addEventListener('click', () => { const v = $('adActual').value.trim(); $('adActual').value = v.startsWith('-') ? v.slice(1) : '-' + v; fixDiff(); });
$('adSave').addEventListener('click', () => {
  const r = fixDiff();
  if (!r) return toast('Enter the balance you actually have.', true);
  if (!r.diff) { $('adFixBox').classList.add('hide'); return toast('The balance already matches.'); }
  queue({ op: 'add', id: rid(), entry: { type: 'Adjustment', date: $('adDate').value, account: openAccName, amount: r.diff,
                                          description: 'Balance correction', who: S().me || '' } });
  $('adFixBox').classList.add('hide');
  renderAccount();
  toast('Corrected by ' + money(r.diff, r.currency, true) + '.', 'ok');
});

/* ---------- Transaction lists ---------- */
function renderTxList(box, rows, back) {
  box.innerHTML = '';
  if (!rows.length) { box.appendChild(el('div', 'empty', 'No transactions yet.')); return; }
  rows.forEach(x => {
    const row = el('div', 'tx'); row.setAttribute('role', 'button');
    const l = el('div', 'l');
    l.appendChild(el('div', 't', x.title));
    const sub = el('div', 'sub', [shortDate(x.date), x.sub].filter(Boolean).join(' · '));
    if (x.src.pending) { sub.appendChild(document.createTextNode(' · ')); sub.appendChild(el('span', 'pend', 'not synced')); }
    l.appendChild(sub);
    const cls = x.type === 'Transfer' ? 'tra' : x.type === 'Adjustment' ? 'adj' : x.amt < 0 ? 'neg' : 'pos';
    row.appendChild(l);
    row.appendChild(el('div', 'r ' + cls, money(x.amt, x.cur, x.signed)));
    row.addEventListener('click', () => startEdit(x.src, back));
    box.appendChild(row);
  });
}

/* ---------- Month ---------- */
let monthKey = currentKey(), whoFilter = 'All';
function renderMonth() {
  const keys = monthKeys();
  if (!keys.includes(monthKey)) monthKey = currentKey();
  const i = keys.indexOf(monthKey), o = overview(monthKey);
  $('mTitle').textContent = o.tab;
  $('mPrev').disabled = i <= 0; $('mNext').disabled = i >= keys.length - 1;
  $('mPrev').onclick = () => { if (i > 0) { monthKey = keys[i - 1]; renderMonth(); } };
  $('mNext').onclick = () => { if (i < keys.length - 1) { monthKey = keys[i + 1]; renderMonth(); } };

  const t = $('mTotals'); t.innerHTML = '';
  const totals = Object.assign({}, o.totals);
  if (!Object.keys(totals).length) totals.ALL = { income: 0, expense: 0 };
  curOrder(Object.keys(totals)).forEach(c => {
    const v = totals[c], net = r2(v.income - v.expense);
    const card = el('div', 'card');
    card.appendChild(el('div', 'label', c));
    [['Income', v.income, 'pos', true], ['Expenses', -v.expense, 'neg', true], ['Net', net, net < 0 ? 'neg' : 'pos', false]].forEach(([k, n, cls, signed]) => {
      const kv = el('div', 'kv'); kv.appendChild(el('span', null, k));
      kv.appendChild(el(signed ? 'span' : 'b', n ? cls : null, money(n, '', signed)));
      card.appendChild(kv);
    });
    t.appendChild(card);
  });

  // Expenses by category; ALL categories with a budget show progress against it.
  const budgets = {};
  S().categories.forEach(c => { if (c.budget > 0) budgets[c.name] = c.budget; });
  const cats = $('mCats'); cats.innerHTML = '';
  const curs = curOrder(Object.keys(o.cats));
  if (!curs.length) cats.appendChild(el('div', 'empty', 'No expenses this month.'));
  curs.forEach(c => {
    if (curs.length > 1) cats.appendChild(el('div', 'curTag', c));
    const list = Object.keys(o.cats[c]).map(k => ({ k: k, v: r2(o.cats[c][k]) })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    const max = list.length ? list[0].v : 1;
    list.forEach(x => {
      const b = c === 'ALL' ? budgets[x.k] : null;
      const row = el('div', 'cat'), top = el('div', 'top');
      top.appendChild(el('span', null, x.k));
      top.appendChild(el('b', b && x.v > b ? 'neg' : null, money(x.v, c) + (b ? ' / ' + fmt(b) : '')));
      const pct = b ? x.v / b : x.v / max;
      const bar = el('div', 'bar' + (b ? (pct >= 1 ? ' over' : pct >= 0.8 ? ' warn' : '') : ''));
      const f = el('span'); f.style.width = Math.max(2, Math.min(100, Math.round(pct * 100))) + '%';
      bar.appendChild(f); row.appendChild(top); row.appendChild(bar);
      cats.appendChild(row);
    });
  });

  const people = S().owners, order = people.concat('Not set');
  const sortWho = l => l.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const w = $('mWho'); w.innerHTML = '';
  const wc = curOrder(Object.keys(o.who));
  if (!wc.length) w.appendChild(el('div', 'empty', 'Nothing yet this month.'));
  wc.forEach(c => {
    const ppl = o.who[c], names = sortWho(Object.keys(ppl));
    if (wc.length > 1) w.appendChild(el('div', 'curTag', c));
    const max = Math.max(1, ...names.map(n => ppl[n].expense));
    names.forEach(n => {
      const v = ppl[n], row = el('div', 'cat'), top = el('div', 'top');
      top.appendChild(el('span', null, n));
      top.appendChild(el('b', v.expense ? 'neg' : null, v.expense ? money(-v.expense, c, true) : '0.00 ' + c));
      const bar = el('div', 'bar who'), f = el('span');
      f.style.width = (v.expense ? Math.max(2, Math.round(v.expense / max * 100)) : 0) + '%';
      bar.appendChild(f); row.appendChild(top); row.appendChild(bar);
      if (v.income) row.appendChild(el('div', 'inc', 'Income ' + money(v.income, c, true)));
      w.appendChild(row);
    });
  });

  const present = sortWho([...new Set(o.entries.map(e => e.who || 'Not set'))]);
  const choices = ['All'].concat(people, present.filter(x => !people.includes(x)));
  if (!choices.includes(whoFilter)) whoFilter = 'All';
  const fb = $('mFilter'); fb.innerHTML = '';
  choices.forEach(c => {
    const b = el('button', c === whoFilter ? 'on' : null, c); b.type = 'button';
    b.addEventListener('click', () => { whoFilter = c; renderMonth(); });
    fb.appendChild(b);
  });
  const shown = o.entries.filter(e => whoFilter === 'All' || (e.who || 'Not set') === whoFilter);
  renderTxList($('mList'), shown.map(x => {
    const cur = currencyOf(x.account);
    if (x.type === 'Adjustment') return { src: x, date: x.date, type: x.type, cur: cur, amt: x.amount, signed: true, title: 'Balance correction', sub: x.account };
    if (x.type === 'Transfer') {
      const toCur = currencyOf(x.toAccount), fx = toCur && toCur !== cur && x.received != null && x.received > 0;
      return { src: x, date: x.date, type: x.type, cur: cur, amt: x.amount, signed: false, title: x.description || 'Transfer',
               sub: x.account + ' → ' + x.toAccount + (fx ? ' (' + money(x.received, toCur) + ')' : '') };
    }
    return { src: x, date: x.date, type: x.type, cur: cur, amt: x.type === 'Expense' ? -x.amount : x.amount, signed: true,
             title: x.description || x.category, sub: [x.description ? x.category : '', x.account].filter(Boolean).join(' · ') };
  }), 'Month');
}

/* ---------- Settings (these need a connection) ---------- */
let editingAcc = null;
async function settingsCall(action, payload, msgId, okText, after) {
  $(msgId).className = 'msg';
  if (!navigator.onLine) return flash(msgId, 'Settings can only be changed online.', false);
  busy('Saving…');
  try {
    if (outbox.length) await sync();                 // send pending entries first
    const j = await api(action, payload);
    data = j.data; saveData();
    idle();
    render();
    if (after) after(); else flash(msgId, okText, true);
  } catch (e) { idle(); flash(msgId, e.message, false); }
}

function usage() {
  const acc = {}, cat = {};
  entries().forEach(e => {
    acc[e.account] = (acc[e.account] || 0) + 1;
    if (e.toAccount && e.toAccount !== e.account) acc[e.toAccount] = (acc[e.toAccount] || 0) + 1;
    if (e.category) cat[e.category] = (cat[e.category] || 0) + 1;
  });
  return { acc: acc, cat: cat };
}

function chip(label, onDelete) {
  const c = el('span', onDelete ? 'chip' : 'chip locked');
  c.appendChild(el('span', null, label));
  if (!onDelete) return c;
  const x = el('button', null, '×'); x.type = 'button'; x.setAttribute('aria-label', 'Delete ' + label);
  x.addEventListener('click', () => {
    if (!c.classList.contains('armed')) {
      document.querySelectorAll('.chip.armed').forEach(o => { o.classList.remove('armed'); o.lastChild.textContent = '×'; });
      c.classList.add('armed'); x.textContent = 'Delete?';
      return;
    }
    onDelete();
  });
  c.appendChild(x);
  return c;
}

function renderSettings() {
  const s = S(), u = usage();
  $('setMe').textContent = 'Connected as ' + (s.me || '?') + '. ' +
    (lastSync ? 'Last synced ' + new Date(lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '.' : '') +
    (outbox.length ? ' ' + outbox.length + ' change(s) waiting to sync.' : '');

  const accBox = $('setAccounts'); accBox.innerHTML = '';
  s.accounts.forEach(a => {
    const b = el('button', 'row'); b.type = 'button';
    const l = el('div', 'l');
    l.appendChild(el('div', 'name', a.name));
    l.appendChild(el('div', 'sub', [a.owner, a.type, a.currency].filter(Boolean).join(' · ') + (a.alertBelow != null ? ' · alert below ' + fmt(a.alertBelow) : '')));
    const r = el('div', 'r');
    r.appendChild(el('span', 'amt' + (a.opening < 0 ? ' neg' : ''), money(a.opening, a.currency)));
    r.appendChild(el('span', 'chev', '›'));
    b.appendChild(l); b.appendChild(r);
    b.addEventListener('click', () => openAccountEdit(a));
    accBox.appendChild(b);
  });

  const bb = $('setBudgets'); bb.innerHTML = '';
  const withBudget = s.categories.filter(c => c.type === 'Expense' && c.budget > 0);
  if (!withBudget.length) bb.appendChild(el('div', 'empty', 'No budgets yet.'));
  const chipsBox = el('div', 'chips');
  withBudget.forEach(c => chipsBox.appendChild(chip(c.name + ': ' + fmt(c.budget), () =>
    settingsCall('setBudget', { name: c.name, amount: '' }, 'setMsg', 'Budget removed.'))));
  bb.appendChild(chipsBox);
  fill($('budCat'), s.categories.filter(c => c.type === 'Expense').map(c => c.name), 'Category…');

  [['Expense', 'setCatExp'], ['Income', 'setCatInc']].forEach(([type, id]) => {
    const box = $(id); box.innerHTML = '';
    s.categories.filter(c => c.type === type).forEach(c => box.appendChild(chip(c.name, u.cat[c.name] ? null :
      () => settingsCall('deleteCategory', { name: c.name }, 'setMsg', 'Deleted "' + c.name + '".'))));
  });
  const cur = $('setCur'); cur.innerHTML = '';
  s.currencies.forEach(c => {
    const used = s.accounts.some(a => a.currency === c) || s.currencies.length <= 1;
    cur.appendChild(chip(c, used ? null : () => settingsCall('deleteCurrency', { code: c }, 'setMsg', 'Deleted ' + c + '.')));
  });
  $('setNipt').value = s.myNipts.join(', ');
  $('ntfyTopic').textContent = s.myTopic || 'No topic yet: run setupApp in Apps Script.';
  fill($('remHour'), Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: String(h).padStart(2, '0') + ':00' })));
  $('remHour').value = String(s.reminderHour);
}

function openAccountEdit(a) {
  const s = S();
  editingAcc = a;
  showView('AccountEdit');
  $('aeMsg').className = 'msg';
  $('aeTitle').textContent = a ? 'Edit account' : 'New account';
  fill($('aeOwner'), s.owners); fill($('aeType'), s.types); fill($('aeCur'), s.currencies);
  $('aeName').value = a ? a.name : '';
  $('aeOwner').value = a ? a.owner : (s.me || s.owners[0]);
  $('aeType').value = a ? a.type : 'Bank';
  $('aeCur').value = a ? a.currency : s.currencies[0];
  $('aeOpening').value = a ? Number(a.opening).toFixed(2) : '';
  $('aeAlert').value = a && a.alertBelow != null ? String(a.alertBelow) : '';
  const uses = a ? (usage().acc[a.name] || 0) : 0;
  $('aeDelete').classList.toggle('hide', !a || uses > 0);
  $('aeDelete').classList.remove('armed'); $('aeDelete').textContent = 'Delete account';
  $('aeUsed').textContent = uses ? 'Used in ' + uses + ' entr' + (uses > 1 ? 'ies' : 'y') + ', so it can be renamed but not deleted. Renaming updates those entries too.' : '';
}
$('setAddAcc').addEventListener('click', () => openAccountEdit(null));
$('aeBack').addEventListener('click', () => showView('Settings'));
$('aeSign').addEventListener('click', () => { const v = $('aeOpening').value.trim(); $('aeOpening').value = v.startsWith('-') ? v.slice(1) : '-' + v; });
$('aeSave').addEventListener('click', () => {
  const op = $('aeOpening').value.trim();
  const opening = op === '' || op === '-' ? 0 : num(op);
  if (isNaN(opening)) return flash('aeMsg', 'The opening balance must be a number.', false);
  const al = $('aeAlert').value.trim();
  if (al !== '' && isNaN(num(al))) return flash('aeMsg', 'The alert amount must be a number.', false);
  const acc = { name: $('aeName').value.trim(), owner: $('aeOwner').value, type: $('aeType').value, currency: $('aeCur').value,
                opening: opening, alertBelow: al === '' ? '' : num(al) };
  if (!acc.name) return flash('aeMsg', 'Enter an account name.', false);
  const isNew = !editingAcc;
  settingsCall('saveAccount', { original: editingAcc ? editingAcc.name : '', acc: acc }, 'aeMsg', '', () => {
    showView('Settings'); flash('setMsg', (isNew ? 'Added "' : 'Saved "') + acc.name + '".', true);
  });
});
$('aeDelete').addEventListener('click', () => {
  const b = $('aeDelete');
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Tap again to delete "' + editingAcc.name + '"'; return; }
  const name = editingAcc.name;
  settingsCall('deleteAccount', { name: name }, 'aeMsg', '', () => { showView('Settings'); flash('setMsg', 'Deleted "' + name + '".', true); });
});
function addFrom(inputId, action, payloadOf) {
  const v = $(inputId).value.trim();
  if (!v) return;
  settingsCall(action, payloadOf(v), 'setMsg', '', () => { $(inputId).value = ''; flash('setMsg', 'Added "' + (action === 'addCurrency' ? v.toUpperCase() : v) + '".', true); });
}
$('addCatExp').addEventListener('click', () => addFrom('newCatExp', 'addCategory', v => ({ name: v, type: 'Expense' })));
$('addCatInc').addEventListener('click', () => addFrom('newCatInc', 'addCategory', v => ({ name: v, type: 'Income' })));
$('addCur').addEventListener('click', () => addFrom('newCur', 'addCurrency', v => ({ code: v })));
$('saveNipt').addEventListener('click', () => settingsCall('saveMyNipts', { list: $('setNipt').value.split(',') }, 'setMsg', 'NIPT saved.'));
$('budSet').addEventListener('click', () => {
  const c = $('budCat').value, a = num($('budAmt').value);
  if (!c || !(a > 0)) return flash('setMsg', 'Choose a category and an amount above 0.', false);
  settingsCall('setBudget', { name: c, amount: a }, 'setMsg', '', () => { $('budAmt').value = ''; flash('setMsg', 'Budget for ' + c + ': ' + fmt(a) + ' ALL.', true); });
});
$('remSave').addEventListener('click', () => settingsCall('saveReminder', { hour: Number($('remHour').value) }, 'setMsg', 'Reminder time saved.'));
$('ntfyTest').addEventListener('click', async () => {
  if (!S().myTopic) return toast('No topic yet: run setupApp in Apps Script.', 'err');
  try {
    await ntfyPost({ topic: S().myTopic, title: '🔔 Money · Test', message: 'Notifications work on this phone.' });
    toast('Test sent. It should appear in ntfy within a few seconds.', 'ok');
  } catch (e) { toast('Couldn\'t reach ntfy (' + e.message + '). Check the internet connection.', 'err'); }
});
$('ntfyCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(S().myTopic); toast('Topic copied.'); }
  catch (e) { toast('Couldn\'t copy. Select the topic and copy it by hand.', true); }
});
$('setSyncNow').addEventListener('click', () => { sync().then(() => { renderSettings(); toast(syncError ? syncError : navigator.onLine ? 'Synced.' : 'Offline.', !!syncError); }); });
$('disconnect').addEventListener('click', () => {
  const b = $('disconnect');
  if (outbox.length) return toast(outbox.length + ' change(s) are not synced yet. Go online and sync first.', true);
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Tap again to disconnect'; return; }
  ['cfg', 'data', 'outbox', 'lastSync'].forEach(k => store.del(k));
  location.replace(location.pathname);
});

/* ---------- Connect screen ---------- */
$('connPaste').addEventListener('click', async () => {
  try { $('connCode').value = await navigator.clipboard.readText(); } catch (e) { toast('Couldn\'t read the clipboard. Long-press the box and choose Paste.', true); }
});
$('connGo').addEventListener('click', async () => {
  let c;
  try { c = decodeCode($('connCode').value); } catch (e) { return flash('connMsg', 'That doesn\'t look like a connection code. Copy it again from Apps Script.', false); }
  if (!navigator.onLine) return flash('connMsg', 'Connect to the internet for the first start.', false);
  cfg = c;
  busy('Connecting…');
  try {
    const j = await api('pull');
    data = j.data; saveData(); store.set('cfg', cfg);
    lastSync = new Date().toISOString(); store.set('lastSync', lastSync);
    idle();
    start();
  } catch (e) { idle(); cfg = null; flash('connMsg', e.message, false); }
});

/* ---------- Start ---------- */
function start() {
  setMode('Expense');
  resetForm();
  showView('Add');
  status();
  sync();
}
/* ---------- App updates ----------
 * The app keeps its files on the phone (that's what makes it open offline). New versions are
 * fetched in the background; when one is ready the status pill turns into "Update ↻". */
const APP_VERSION = 12;
let swReg = null, updateReady = false;
function showUpdate() { if (!updateReady) { updateReady = true; status(); toast('A new version of Money is ready. Tap "Update" at the top.', 'info'); } }
function applyUpdate() {
  if (outbox.length && navigator.onLine) toast('Updating…');
  location.reload();
}
async function checkUpdate(manual) {
  if (!swReg && 'serviceWorker' in navigator) {        // may still be starting right after the app opened
    try { swReg = (await navigator.serviceWorker.getRegistration()) || null; } catch (e) {}
  }
  if (!swReg) { if (manual) toast('Updates can\'t be checked in this browser.', 'err'); return; }
  if (!navigator.onLine) { if (manual) toast('You are offline. Check again when you are online.', 'err'); return; }
  try { await swReg.update(); } catch (e) { if (manual) toast('Couldn\'t check for updates. Try again later.', 'err'); return; }
  if (swReg.installing || swReg.waiting) showUpdate();
  else if (manual) setTimeout(() => { if (!updateReady) toast('You have the latest version (' + APP_VERSION + ').', 'ok'); }, 1500);
}
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    swReg = reg;
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => {
        if ((w.state === 'installed' || w.state === 'activated') && hadController) showUpdate();
      });
    });
    checkUpdate(false);
  }).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(false); });
}
$('appVer').textContent = 'Money app version ' + APP_VERSION;
$('checkUpd').addEventListener('click', () => checkUpdate(true));
if (cfg && data) start();
else if (cfg) { showView('Connect'); $('connMsg').className = 'msg'; busy('Loading your data…');
  api('pull').then(j => { data = j.data; saveData(); idle(); start(); })
             .catch(e => { idle(); flash('connMsg', e.message, false); }); }
else showView('Connect');
