// Epoptes dashboard. Plain ES modules + Preact (via htm's standalone build); no build step.
// Data comes from the local server, which only reads and writes the goal files.
import { html, render, useEffect, useMemo, useRef, useState } from '/vendor/preact.js';

// ---------------------------------------------------------------- api

async function request(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  return body;
}
const api = {
  get: (url) => request(url),
  post: (url, body = {}) =>
    request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Epoptes': '1' }, body: JSON.stringify(body) }),
};

// ---------------------------------------------------------------- store

const store = {
  state: null, // { goals, limits, lan }
  detail: null,
  detailId: null,
  loadedAt: Date.now(),
  seenAtOpen: {}, // goal id -> cursors captured when the detail was first opened this visit
  toasts: [],
  offline: false,
  selectedCycle: null,
  cycleView: null,
  freshActivity: new Set(),
  jobScope: 'job', // 'job' (the current job) or 'all' (every job of the harness)
  cardSel: null, // the open card on the board
};
const listeners = new Set();
let version = 0; // bumped on every change
function set(patch) {
  Object.assign(store, patch);
  version++;
  for (const f of listeners) f();
}
function useStore() {
  const [, force] = useState(0);
  const seen = version;
  useEffect(() => {
    const f = () => force((x) => x + 1);
    listeners.add(f);
    // A change between render and subscribing (a fast first /api/state) would otherwise be missed until the next one.
    if (version !== seen) f();
    return () => listeners.delete(f);
  }, []);
  return store;
}
function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------- formatting

const dur = (s) => {
  if (s == null || !isFinite(s)) return '–';
  const neg = s < 0;
  s = Math.abs(Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const out = h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m` : `${s}s`;
  return neg ? `-${out}` : out;
};
const ago = (iso) => {
  if (!iso) return '–';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const clockTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));
const shortModel = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
const pct = (x) => `${Math.round(x * 100)}%`;
const STATE_LABEL = {
  idle: 'idle', running: 'running', waiting: 'between cycles', rate_limited: 'rate-limited', cooldown: 'cooling down',
  pausing: 'pausing after cycle', paused: 'paused', needs_input: 'waiting for you', stopped: 'stopped', crashed: 'crashed', failed: 'failed', done: 'done', timeboxed: 'time box over',
};
const LIVE = ['running', 'waiting', 'rate_limited', 'cooldown', 'pausing'];

function Money({ usd, basis }) {
  if (usd == null) return html`<span class="faint">–</span>`;
  if (basis === 'billed') return html`<span class="num">$${usd.toFixed(2)}</span>`;
  return html`<span class="num est" title="API-equivalent estimate, not billed">≈ $${usd.toFixed(2)}</span>`;
}

const hue = (name) => {
  if (name === 'orchestrator') return 30;
  let h = 0;
  for (const c of name.split('#')[0]) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (h + 140) % 360;
};
const Agent = ({ name, working }) => html`<span class="agent ${working ? 'working' : ''}" style=${{ '--h': hue(name) }}>${name}</span>`;

/** Handoff text with headings and **bold**, rendered without innerHTML. */
function Rich({ text }) {
  return text.split('\n').map((line, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const parts = (h ? h[1] : line).split(/(\*\*[^*]+\*\*)/g).map((p, j) => (/^\*\*[^*]+\*\*$/.test(p) ? html`<strong key=${j}>${p.slice(2, -2)}</strong>` : p));
    return html`<span key=${i} class=${h ? 'h' : ''}>${parts}${'\n'}</span>`;
  });
}

// ---------------------------------------------------------------- data flow

let stateTimer = null;
let detailTimer = null;
function loadState() {
  return api.get('/api/state').then((state) => set({ state, loadedAt: Date.now() })).catch(() => {});
}
function loadDetail(id = store.detailId) {
  if (!id) return Promise.resolve();
  return api
    .get(`/api/goals/${id}${store.jobScope === 'all' ? '?jobs=all' : ''}`)
    .then((detail) => {
      if (store.detailId !== id) return;
      const seenAtOpen = store.seenAtOpen[id] ? store.seenAtOpen : { ...store.seenAtOpen, [id]: detail.seen };
      set({ detail, seenAtOpen, loadedAt: Date.now() });
      api.post(`/api/goals/${id}/seen`).then(scheduleState).catch(() => {});
    })
    .catch((e) => {
      if (store.detailId === id) set({ detail: { id, error: e.message, missing: /no goal/.test(e.message) } });
    });
}
const scheduleState = () => {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(loadState, 300);
};
const scheduleDetail = () => {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => loadDetail(), 300);
};

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', () => {
    if (store.offline) set({ offline: false });
    loadState();
    loadDetail();
  });
  es.addEventListener('update', (e) => onUpdate(JSON.parse(e.data)));
  es.onerror = () => set({ offline: true });
}

function onUpdate(u) {
  const onlyActivity = u.parts.every((p) => p === 'activity');
  if (!onlyActivity) scheduleState();
  if (store.detailId === u.id && store.detail) {
    if (onlyActivity && u.cycle === store.detail.activity_cycle) {
      const fresh = new Set(u.activity.map((a) => a.ts + a.summary));
      set({ detail: { ...store.detail, activity: [...store.detail.activity, ...u.activity].slice(-200) }, freshActivity: fresh });
    } else scheduleDetail();
  }
  announce(u);
}

// ---------------------------------------------------------------- notifications

let toastId = 0;
function toast(t) {
  const id = ++toastId;
  set({ toasts: [...store.toasts, { ...t, id }].slice(-5) });
  setTimeout(() => set({ toasts: store.toasts.filter((x) => x.id !== id) }), t.ms ?? 7000);
}

function desktop(goal, type, title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!(goal?.notify ?? ['milestone', 'blocked', 'done']).includes(type)) return;
  try {
    new Notification(title, { body, tag: `${goal?.id}-${type}-${Date.now()}` });
  } catch {
    // some browsers only allow notifications from a service worker
  }
}

function celebrate(big) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#e39a2d', '#7453c0', '#238a5a', '#2f73b5', '#c6412f', '#f2c14e'];
  const n = big ? 90 : 36;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 240}px`);
    p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    p.style.animationDuration = `${1.6 + Math.random() * (big ? 2 : 1)}s`;
    p.style.animationDelay = `${Math.random() * 0.4}s`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4500);
}

const flashed = new Map(); // goal id -> time of the last milestone or done
function announce(u) {
  const goal = store.state?.goals.find((g) => g.id === u.id);
  if (u.events.some((e) => e.type === 'milestone' || e.type === 'done')) flashed.set(u.id, Date.now());
  const name = goal?.name ?? u.id;
  for (const e of u.events) {
    if (e.type === 'milestone') {
      toast({ kind: 'good', title: `★ ${name}`, body: e.text });
      desktop(goal, 'milestone', `Milestone · ${name}`, e.text);
      celebrate(false);
    } else if (e.type === 'done') {
      toast({ kind: 'good', title: `✓ ${name} is done`, body: e.text, ms: 12000 });
      desktop(goal, 'done', `Done · ${name}`, e.text);
      celebrate(true);
    } else if (e.type === 'blocked') {
      const approval = /^needs approval: /.test(e.text ?? '');
      toast({ kind: 'warn', title: `${approval ? 'Approval needed' : 'Blocked'} · ${name}`, body: e.text.replace(/^needs approval: /, ''), ms: 12000 });
      desktop(goal, 'blocked', `${approval ? 'Approval needed' : 'Blocked'} · ${name}`, e.text);
    } else if (e.type === 'needs_you') {
      toast({ kind: 'warn', title: `Waiting for you · ${name}`, body: `${e.text} (the run pauses after this cycle)`, ms: 15000 });
      desktop(goal, 'blocked', `Waiting for you · ${name}`, e.text);
    } else if (e.type === 'warn') {
      toast({ kind: 'warn', title: `Warning · ${name}`, body: e.text });
      desktop(goal, 'warn', `Warning · ${name}`, e.text);
    } else if (e.type === 'wait' && e.reason === 'rate_limit') {
      toast({ kind: 'warn', title: `Rate-limited · ${name}`, body: `Waiting ${dur(e.seconds)} before the next cycle.` });
    } else if (e.type === 'cycle.end' && e.exit !== 'ok' && e.exit !== 'interrupted') {
      toast({ kind: 'bad', title: `Cycle ${e.cycle} ${e.exit} · ${name}`, body: 'See the cycle table for details.' });
    } else if (e.type === 'run.end' && e.reason !== 'done' && e.reason !== 'needs_you') {
      toast({ kind: e.reason === 'failed' || e.reason === 'crashed' ? 'bad' : 'info', title: `${name}: run ${e.reason}`, body: `After cycle ${e.cycle ?? '–'}.` });
      desktop(goal, 'run.end', `${name}: run ${e.reason}`, `After cycle ${e.cycle ?? '–'}`);
    }
  }
  // Card moves are routine; agent notes and replies are what the human wants to read.
  for (const o of u.board) {
    if (o.op === 'add' && o.src === 'orchestrator' && o.column === 'backlog') toast({ kind: 'info', title: `${name}: agent note ${o.id} for the next cycle`, body: o.title, ms: 10000 });
    if (o.op === 'comment' && o.by !== 'user') toast({ kind: 'info', title: `${o.id}: ${o.by} replied`, body: o.text, ms: 8000 });
  }
}

// ---------------------------------------------------------------- shared bits

// The Epoptes mark (docs/assets/epoptes-mark.svg): dark parts follow the text colour, so it works in both themes.
const Logo = () => html`<svg viewBox="0 0 410 410" aria-hidden="true">
  <g fill="none" stroke-linecap="round">
    <path d="M200 22 A178 178 0 0 1 354 111" stroke="currentColor" stroke-width="30" />
    <path d="M377 162 A178 178 0 0 1 305 347" stroke="currentColor" stroke-width="30" />
    <path d="M247 373 A178 178 0 0 1 44 238" stroke="currentColor" stroke-width="30" />
    <path d="M108 107 C165 55 261 57 318 119" stroke="#E8A23A" stroke-width="22" />
    <path d="M321 255 C292 327 199 352 126 312" stroke="#E8A23A" stroke-width="22" />
  </g>
  <circle cx="205" cy="205" r="61" fill="currentColor" /><circle cx="205" cy="205" r="25" fill="var(--bg)" /><circle cx="205" cy="205" r="9" fill="#E8A23A" />
</svg>`;

function StatePill({ state }) {
  return html`<span key=${state} class="state ${state} changed"><span class="dot"></span>${STATE_LABEL[state] ?? state}</span>`;
}

/** Active time in the browser, ticking between polls while a run is live. */
function liveActive(g, now) {
  if (!g.clock) return null;
  const tick = g.live && !g.clock.paused ? (now - store.loadedAt) / 1000 : 0;
  return g.clock.active + tick;
}

function ClockBar({ g, big, extra }) {
  const now = useNow();
  const c = g.clock;
  if (!c) return html`<div class="clockbar ${big ? 'big' : ''}"><div class="track"></div><div class="labels"><span>clock not started</span><span>${g.goal ? dur(g.goal.timebox.total_min * 60) + ' time box' : ''}</span></div></div>`;
  const active = liveActive(g, now);
  if (c.followup) {
    return html`<div class="clockbar followup ${big ? 'big' : ''}">
      <div class="track" aria-label="Follow-up: no time box"><div class="fill ${c.paused ? 'paused' : 'followup'}"></div></div>
      <div class="labels"><span class="num">${dur(active)} active${c.paused ? ' · clock paused' : ''}</span><span>follow-up · no time box</span></div>
    </div>`;
  }
  const total = c.timebox_s + c.grace_s;
  const w = Math.min(100, (active / total) * 100);
  const wrapStart = ((c.timebox_s - c.wrapup_s) / total) * 100;
  const cls = c.paused ? 'paused' : g.wrapup_marker && c.clock_mode === 'build' ? 'wrapup' : c.clock_mode;
  const marks = milestoneMarks(g.milestones ?? [], active, total);
  const proj = g.projection;
  const projTip = proj && `On pace to finish around ${dur(proj.end_s)} of active time: ${proj.basis} ${proj.pace > 1 ? 'is running at' : 'took'} ${Math.round(proj.pace * 100)}% of its planned time, and the same pace is applied to the last milestone's target.`;
  return html`<div class="clockbar ${big ? 'big' : ''} ${marks.length ? 'has-ms' : ''}">
    <div class="track-wrap">
      <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax=${c.timebox_s} aria-valuenow=${Math.round(active)} aria-label="Active time">
        <div class="zone-wrap" style=${{ left: `${wrapStart}%`, width: `${(c.wrapup_s / total) * 100}%` }}></div>
        <div class="fill ${cls}" style=${{ width: `${w}%` }}></div>
      </div>
      ${marks.map((m) => html`<span key=${m.id} class="ms-tick ${m.state}" style=${{ left: `${m.pos}%` }} title=${m.tip}></span>`)}
      ${proj && html`<span class="proj-tick ${proj.end_s > c.timebox_s ? 'over' : ''}" style=${{ left: `${Math.min(100, (proj.end_s / total) * 100)}%` }} title=${projTip}></span>`}
      ${marks.filter((m) => m.reachedPos != null).map((m) => html`<span key=${`r${m.id}`} class="ms-hit ${m.state}" style=${{ left: `${m.reachedPos}%` }} title=${m.tip}></span>`)}
    </div>
    ${big && marks.length > 0 && html`<div class="ms-labels" aria-hidden="true">${marks.map((m) => html`<span key=${m.id} class="${m.state} ${m.current ? 'current' : ''}" style=${{ left: `${m.pos}%` }}>${m.id}${m.state === 'overdue' ? ' overdue' : m.state === 'late' ? ' (late)' : ''}</span>`)}</div>`}
    <div class="labels">
      <span class="num">${dur(active)} active${c.paused ? ' · clock paused' : ''}</span>
      ${big && proj && html`<span class="num proj-label ${proj.end_s > c.timebox_s ? 'over' : ''}" title=${projTip}><span class="proj-key" aria-hidden="true"></span>on pace to finish at ~${dur(proj.end_s)}${proj.end_s > c.timebox_s ? ' · over the time box' : ''}</span>`}
      <span class="num">${c.to_end > 0 ? `${dur(c.timebox_s - active)} left of ${dur(c.timebox_s)}` : `over by ${dur(active - c.timebox_s)}`}${extra && html` ${extra}`}</span>
    </div>
  </div>`;
}

/**
 * Milestone targets on the time track, coloured by how they went: reached on time, reached late, overdue (the
 * current one, past its target), or upcoming. Reached milestones also get a dot where they actually landed.
 */
function milestoneMarks(milestones, active, total) {
  return milestones
    .filter((m) => m.target_s != null && m.target_s <= total)
    .map((m) => {
      const reachedAt = m.reached?.active_s ?? null;
      const finished = m.reached || (m.todo + m.doing === 0 && m.done > 0);
      const state = finished ? (reachedAt != null && reachedAt > m.target_s ? 'late' : 'ontime') : m.current && active > m.target_s ? 'overdue' : m.current ? 'current' : 'upcoming';
      const words = { ontime: 'reached on time', late: 'reached late', overdue: 'overdue', current: 'in progress', upcoming: 'upcoming' }[state];
      const when = reachedAt != null ? ` · reached at ${dur(reachedAt)}` : '';
      return {
        id: m.id, current: m.current, state, pos: (m.target_s / total) * 100,
        reachedPos: reachedAt != null ? Math.min(100, (reachedAt / total) * 100) : null,
        tip: `${m.id} ${m.title}: target ${dur(m.target_s)}${when} · ${words}`,
      };
    });
}

// ---------------------------------------------------------------- top bar

const CLI_NAME = { 'claude-code': 'Claude', codex: 'Codex', pi: 'pi' };

const STALE_USAGE_MS = 15 * 60 * 1000;

/** One CLI account's plan windows (Claude Code, Codex), e.g. "Claude 5h 31% 7d 9%"; an old reading says how old. */
function PlanUsage({ source, l }) {
  const now = useNow(60_000);
  // A reading can be days old (the last cycle on that CLI); a window that has reset since says nothing now.
  const windows = Object.entries(l.windows).filter(([, w]) => !w.resets_at || Date.parse(w.resets_at) > now);
  if (!windows.length) return null;
  const name = CLI_NAME[source] ?? source;
  // Epoptes only hears about the plan during its own cycles; use outside them doesn't show until the next one.
  const stale = now - Date.parse(l.at) > STALE_USAGE_MS;
  const hot = windows.some(([, w]) => w.utilization >= 0.8) || !['allowed', 'allowed_warning'].includes(l.status);
  const tip = `${name} plan usage, as of ${ago(l.at)}. Shared by every ${name} goal.${stale ? ` Epoptes reads it only while a ${name} cycle runs, so use since then isn't counted.` : ''}`;
  return html`<span class="pill ${hot ? 'warn' : ''} ${stale ? 'stale' : ''} hide-sm" title=${tip}>
    <b>${name}</b>
    ${windows.map(([k, w]) => html`<span key=${k}>${k.replace('_', ' ').replace('five hour', '5h').replace('seven day', '7d')} ${pct(w.utilization)}</span>`)}
    ${stale && html`<span>· ${ago(l.at)}</span>`}
  </span>`;
}

/** On a goal's page, the usage of the CLI that goal runs on; on the list, every CLI's plan that has reported. */
function Usage({ id }) {
  const s = useStore();
  const limits = s.state?.limits ?? {};
  const goal = id && id !== 'brain' ? s.state?.goals.find((g) => g.id === id) : null;
  if (!goal) return Object.entries(limits).map(([src, l]) => html`<${PlanUsage} key=${src} source=${src} l=${l} />`);
  if (goal.adapter === 'pi') {
    return html`<span class="pill hide-sm" title="pi bills the provider per token, so there are no plan windows. This job's spend so far, including the running cycle.">
      <b>pi</b> API <${Money} usd=${goal.cost_usd} basis=${goal.cost_basis} />
    </span>`;
  }
  return limits[goal.adapter] ? html`<${PlanUsage} source=${goal.adapter} l=${limits[goal.adapter]} />` : null;
}

function Topbar({ id }) {
  const s = useStore();
  const goal = id && id !== 'brain' ? s.state?.goals.find((g) => g.id === id) : null;
  const limited = goal ? goal.state === 'rate_limited' : s.state?.goals.some((g) => g.state === 'rate_limited');
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  return html`<header class="topbar">
    <a class="brand" href="#/" aria-label="Epoptes: all goals"><${Logo} />epoptes</a>
    ${s.state?.lan && html`<span class="pill bad" title="Anyone on your network can control runs">LAN mode</span>`}
    <span class="spacer"></span>
    ${limited && html`<span class="pill warn">rate-limited</span>`}
    <${Usage} id=${id} />
    ${perm === 'default' &&
    html`<button class="iconbtn" onClick=${() => Notification.requestPermission().then(setPerm)} title="Desktop notifications for milestones, blocks and DONE">🔔 Notify me</button>`}
    ${perm === 'granted' && html`<span class="pill hide-sm" title="Desktop notifications are on">🔔 on</span>`}
  </header>`;
}

// ---------------------------------------------------------------- waiting for you

/** One line on a goal card when the human is needed: the run waits, or approvals are pending. */
function NeedsYouLine({ g }) {
  const n = g.pending_approvals?.length ?? 0;
  if (!g.needs && !n) return null;
  const what = g.needs ? `Waiting for you: ${g.needs.reason}` : `${n} approval${n > 1 ? 's' : ''} waiting for you`;
  return html`<div class="needs-line" title=${what}><span class="flagmark" aria-hidden="true">⚑</span><span>${what}</span>${g.needs && n > 0 ? html`<span class="faint">· ${n} approval${n > 1 ? 's' : ''}</span>` : ''}</div>`;
}

function decideApproval(goalId, id, decision, note) {
  return api
    .post(`/api/goals/${goalId}/cards/${id}`, { decision, note: note || undefined })
    .then((r) => {
      toast({ kind: 'info', title: `${id} ${decision === 'approved' ? 'approved' : 'disapproved'}`, body: r.resumed ? 'Nothing else was waiting, so the run resumes.' : r.problem ? `Not resumed: ${r.problem}` : 'The next cycle acts on it.', ms: 5000 });
      loadState();
      loadDetail();
    })
    .catch((e) => toast({ kind: 'bad', title: `Could not answer ${id}`, body: e.message }));
}

/** Approve / Disapprove, with an optional note that goes to the orchestrator. */
function ApprovalButtons({ goalId, f }) {
  const [busy, setBusy] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const go = (decision) => {
    setBusy(true);
    decideApproval(goalId, f.id, decision, note.trim()).finally(() => setBusy(false));
  };
  return html`<div class="approval-actions">
    <button class="btn small approve" disabled=${busy} onClick=${() => go('approved')}>✓ Approve</button>
    <button class="btn small reject" disabled=${busy} onClick=${() => go('rejected')}>✕ Disapprove</button>
    <button class="btn small ghost" onClick=${() => setNoting(!noting)} aria-expanded=${noting}>${noting ? 'No note' : 'Add a note'}</button>
    ${noting && html`<input type="text" class="approval-note" value=${note} onInput=${(e) => setNote(e.currentTarget.value)} placeholder="Conditions or reasons (sent with your answer)" aria-label=${`Note for ${f.id}`} />`}
  </div>`;
}

// ---------------------------------------------------------------- goal list

function GoalCard({ g }) {
  const now = useNow();
  if (g.error) {
    return html`<div class="panel card error"><div class="top"><span class="name">${g.id}</span><span class="state failed">invalid</span></div><div class="objective">${g.error}</div><div class="facts mono">${g.path}</div></div>`;
  }
  const unread = g.unread.feedback + g.unread.events;
  const b = g.board;
  const total = b ? b.todo + b.doing + b.review + b.done + b.blocked : 0;
  const flash = Date.now() - (flashed.get(g.id) ?? 0) < 4000;
  return html`<a class=${`panel card ${flash ? 'flash' : ''}`} href=${`#/g/${g.id}`}>
    <div class="top">
      <span class="name">${g.name}</span>
      ${unread > 0 && html`<span class="badge" title=${`${g.unread.events} new events, ${g.unread.feedback} agent notes and replies`}>${unread}</span>`}
      <${StatePill} state=${g.state} />
    </div>
    <div class="objective">${g.objective}</div>
    <${NeedsYouLine} g=${g} />
    <${ClockBar} g=${g} />
    <div class="facts">
      ${g.mode && html`<span class="chip ${g.mode}">${g.mode}</span>`}
      ${g.job?.named && html`<span title="the current job of this harness">job <b>${g.job.title}</b></span>`}
      <span>cycle <b class="num">${g.cycle || '–'}</b>${g.round ? html` · round <b>${g.round}</b>` : ''}</span>
      ${b && html`<span>board <b class="num">${b.done}/${total}</b>${b.backlog ? ` · ${b.backlog} untriaged` : ''}</span>`}
      ${(g.cycles > 0 || g.live_usage?.cost_usd != null) && html`<span><${Money} usd=${g.cost_usd} basis=${g.cost_basis} /></span>`}
      ${g.cycle_started_at && g.state === 'running' && html`<span>this cycle <b class="num">${dur((now - Date.parse(g.cycle_started_at)) / 1000)}</b></span>`}
    </div>
  </a>`;
}

function GoalList() {
  const s = useStore();
  if (!s.state) return html`<p class="empty">Loading…</p>`;
  const goals = [...s.state.goals].sort((a, b) => (b.live ?? 0) - (a.live ?? 0) || (a.name ?? a.id).localeCompare(b.name ?? b.id));
  return html`<div class="list-head"><h1>Goals</h1><span class="muted">${goals.filter((g) => g.live).length} running · ${goals.length} total</span><span class="list-actions"><a class="btn small" href="#/brain" title="What past harnesses taught: lessons, numbers by goal kind, signals">Brain</a>${goals.length > 0 && html`<a class="btn small" href="/report.html" target="_blank" rel="noopener">Report: all goals</a>`}</span></div>
    ${goals.length === 0
      ? html`<div class="panel empty-state">
          <h2>No goals yet</h2>
          <ol>
            <li>Install the skill for Claude Code: <span class="mono">epoptes skill install</span></li>
            <li>In Claude Code, in the folder you want to work in: <b>“use the epoptes skill to build a harness for …”</b>. Claude interviews you, generates the harness and registers it.</li>
            <li>It appears here. Press <b>Start</b>, then watch, pause and give feedback from this page.</li>
          </ol>
          <p class="muted">Already have a goal folder? <span class="mono">epoptes add path/to/project</span>. Want a tiny test first? Copy <span class="mono">examples/glossary</span> somewhere and add it.</p>
        </div>`
      : html`<div class="cards">${goals.map((g) => html`<${GoalCard} key=${g.id} g=${g} />`)}</div>`}`;
}

// ---------------------------------------------------------------- goal detail: header bits

/** The goal's deliverable: a URL, or a project file served on the output origin. */
function OutputLink({ o, big }) {
  if (!o) return null;
  const label = big ? 'Open the output ↗' : 'Output ↗';
  if (!o.href) {
    const why = o.kind === 'file' && !o.exists ? `${o.target} doesn't exist yet` : `${o.target} (the output server is off in LAN mode)`;
    return html`<span class="btn small disabled-link" title=${why}>${label}</span>`;
  }
  return html`<a class=${`btn small output-link ${big ? 'primary' : ''}`} href=${o.href} target="_blank" rel="noopener noreferrer" title=${`${o.target}${o.text ? ` · ${o.text}` : ''}`}>${label}</a>`;
}

// ---------------------------------------------------------------- where the time went

// Four phases, coloured by state (validated: scripts/validate_palette.js, light and dark). Between-cycles gaps are
// short runner pauses, so they fold into "running"; the table keeps every phase separate.
const PHASES = [
  { key: 'running', label: 'Running cycles', parts: ['working', 'between_cycles'] },
  { key: 'limits', label: 'Rate limits & cooldowns', parts: ['rate_limit', 'cooldown'] },
  { key: 'you', label: 'Waiting for you', parts: ['needs_you'] },
  { key: 'paused', label: 'Paused or stopped', parts: ['paused'] },
];
const PHASE_LABEL = { working: 'cycles', between_cycles: 'between cycles', rate_limit: 'rate-limit waits', cooldown: 'cooldowns after failures', needs_you: 'waiting for you', paused: 'paused or stopped' };

/** A hover tooltip shared by the marks of one chart. */
function useTip() {
  const [tip, setTip] = useState(null);
  const on = (text) => ({
    onMouseMove: (e) => {
      const box = e.currentTarget.closest('.timeuse').getBoundingClientRect();
      setTip({ text, x: e.clientX - box.left, y: e.clientY - box.top });
    },
    onMouseLeave: () => setTip(null),
  });
  const el = tip && html`<div class="viz-tip" style=${{ left: `${tip.x}px`, top: `${tip.y}px` }}>${tip.text}</div>`;
  return [on, el];
}

function HBars({ rows, on, unit }) {
  const max = Math.max(1, ...rows.map((r) => r.seconds));
  return html`<ul class="hbars">${rows.map((r) => html`<li key=${r.name} ...${on(`${r.name}: ${dur(r.seconds)}${r.extra ? ` · ${r.extra}` : ''}`)}>
    <span class="name" title=${r.name}>${r.name}</span>
    <span class="bar-track"><span class="bar" style=${{ width: `${Math.max(0.5, (r.seconds / max) * 100)}%` }}></span></span>
    <span class="val num">${dur(r.seconds)}${unit && r.extra ? html`<small> ${r.extra}</small>` : ''}</span>
  </li>`)}</ul>`;
}

function TimeUse({ d }) {
  const [t, setT] = useState(null);
  const [on, tipEl] = useTip();
  useEffect(() => {
    let live = true;
    api.get(`/api/goals/${d.id}/time${d.job_scope === 'all' ? '?jobs=all' : ''}`).then((x) => live && setT(x)).catch(() => {});
    return () => (live = false);
  }, [d.id, d.cycles, d.state, d.job_scope]);
  if (!t || !t.cycles) return null;
  const segs = PHASES.map((p) => ({ ...p, seconds: p.parts.reduce((a, k) => a + (t.phases[k] ?? 0), 0) })).filter((p) => p.seconds > 0);
  const total = segs.reduce((a, s) => a + s.seconds, 0) || 1;
  const share = (s) => `${Math.round((s / total) * 100)}%`;
  const running = segs.find((s) => s.key === 'running')?.seconds ?? 0;
  const roles = t.roles.filter((r) => r.seconds > 0).map((r) => ({ name: r.role, seconds: r.seconds, extra: r.role === 'orchestrator (alone)' ? 'planning, briefing, checking' : `${r.spans} run${r.spans === 1 ? '' : 's'}` }));
  const top = t.tools.slice(0, 8);
  const rest = t.tools.slice(8);
  const tools = [...top, ...(rest.length ? [{ tool: `${rest.length} other tools`, seconds: rest.reduce((a, x) => a + x.seconds, 0), calls: rest.reduce((a, x) => a + x.calls, 0) }] : [])]
    .map((x) => ({ name: x.tool, seconds: x.seconds, extra: `${x.calls} call${x.calls === 1 ? '' : 's'}` }));
  return html`<section class="panel timeuse">
    <h2>Where the time went <span class="right muted">${t.cycles} cycle${t.cycles === 1 ? '' : 's'} · ${d.job.n > 1 && d.job_scope !== 'all' ? 'this job' : 'all runs'}</span></h2>
    <p class="tu-head"><b class="num">${dur(total)}</b> on record · <b class="num">${dur(running)}</b> running cycles (${share(running)})</p>
    <div class="phasebar" role="img" aria-label=${segs.map((s) => `${s.label} ${dur(s.seconds)}`).join(', ')}>
      ${segs.map((s) => html`<span key=${s.key} class="ph ${s.key}" style=${{ flexGrow: s.seconds }} ...${on(`${s.label}: ${dur(s.seconds)} (${share(s.seconds)})`)}></span>`)}
    </div>
    <div class="legend tu-legend">${segs.map((s) => html`<span key=${s.key}><i class="ph ${s.key}"></i>${s.label} <b class="num">${dur(s.seconds)}</b> <span class="faint">${share(s.seconds)}</span></span>`)}</div>
    <div class="tu-cols">
      <div><h3>Who worked <span class="faint">agent time</span></h3><${HBars} rows=${roles} on=${on} />
        <p class="faint tu-note">Subagents working in parallel add up, so this can exceed the time spent running cycles.</p></div>
      <div><h3>On what <span class="faint">tool time · calls</span></h3><${HBars} rows=${tools} on=${on} unit=${true} />
        <p class="faint tu-note">From each call to the agent's next step (capped at 15 min). Background commands run start to end, alongside other work.</p></div>
    </div>
    <details class="tu-table"><summary>Show as a table</summary>
      <table><thead><tr><th>where</th><th class="r">time</th><th class="r">share</th></tr></thead><tbody>
        ${Object.entries(t.phases).filter(([, s]) => s > 0).map(([k, s]) => html`<tr key=${k}><td>${PHASE_LABEL[k] ?? k}</td><td class="r num">${dur(s)}</td><td class="r num">${share(s)}</td></tr>`)}
      </tbody></table>
      <table><thead><tr><th>role</th><th class="r">agent time</th><th class="r">runs</th></tr></thead><tbody>
        ${t.roles.map((r) => html`<tr key=${r.role}><td>${r.role}</td><td class="r num">${dur(r.seconds)}</td><td class="r num">${r.spans}</td></tr>`)}
      </tbody></table>
      <table><thead><tr><th>tool</th><th class="r">time</th><th class="r">calls</th></tr></thead><tbody>
        ${t.tools.map((x) => html`<tr key=${x.tool}><td class="mono">${x.tool}</td><td class="r num">${dur(x.seconds)}</td><td class="r num">${x.calls}</td></tr>`)}
      </tbody></table>
    </details>
    ${tipEl}
  </section>`;
}

const FEED_ICON = {
  milestone: '★', done: '✓', blocked: '⊘', note: '•', artifact: '▤', warn: '⚠', wait: '◔', control: '›',
  'run.start': '▶', 'run.end': '■', mode: '↪', 'cycle.end': '✕', wrapup: '↧', needs_you: '⚑',
};
function feedText(e) {
  switch (e.type) {
    case 'run.start': return `Run ${e.run} ${e.resumed ? 'resumed' : 'started'}`;
    case 'run.end': return e.reason === 'needs_you' ? `Run ${e.run} paused: waiting for you` : `Run ${e.run} ended: ${e.reason}`;
    case 'needs_you': return `Waiting for you: ${e.text}`;
    case 'control': return e.action === 'steer' ? `You: steer with ${e.ref}` : `You: ${e.action}${e.seconds ? ` ${dur(e.seconds)}` : ''}`;
    case 'wait': return `${e.reason === 'rate_limit' ? 'Rate-limit wait' : 'Cooldown'}: ${dur(e.seconds)}`;
    case 'mode': return `Mode ${e.from} → ${e.to}`;
    case 'cycle.end': return e.steered ? `Cycle ${e.cycle} interrupted to steer` : `Cycle ${e.cycle} ended: ${e.exit}`;
    case 'artifact': return `${e.path}${e.text ? ` · ${e.text}` : ''}`;
    default: return e.text ?? e.type;
  }
}
// ---------------------------------------------------------------- board

const SRC_LABEL = { file: 'you, from FEEDBACK.md', orchestrator: 'the orchestrator', dashboard: 'you, from the dashboard', cli: 'you, from the CLI' };
const SRC_FROM = { file: 'from FEEDBACK.md', dashboard: 'from the dashboard', cli: 'from the CLI' };
const COLS = [['backlog', 'Backlog'], ['todo', 'Todo'], ['doing', 'Doing'], ['review', 'Review'], ['done', 'Done']];
const LANE_HINT = { backlog: 'Your feedback and agent notes, until the orchestrator triages them', todo: 'Planned, ranked', doing: 'Being worked on', review: 'Being verified', done: 'Done or cut' };
const LANE_META = { todo: 'ranked', done: 'newest first' };
const BACKLOG_SHOWN = 6;
const DONE_SHOWN = 3;
const pendingApproval = (c) => c.approval && !c.approval.decision && c.column !== 'done';

const postCard = (d, id, body) =>
  api
    .post(`/api/goals/${d.id}/cards/${id}`, body)
    .then((r) => (loadDetail(), loadState(), r))
    .catch((e) => toast({ kind: 'bad', title: `Could not update ${id}`, body: e.message }));

function CardTile({ c, selected, onSelect, seen, live }) {
  const fresh = seen && c.comments.some((m) => m.by !== 'user' && m.ts > seen);
  const yours = c.src !== 'orchestrator' && c.column !== 'done';
  const n = c.comments.length;
  const meta = [
    c.column === 'doing' ? `started${c.cycle ? ` in c${c.cycle}` : ''} · ${ago(c.updated_at)}` : yours ? `added ${SRC_FROM[c.src] ?? ''} · ${ago(c.created_at)}` : '',
    n ? `${n} comment${n > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');
  return html`<button type="button" class=${`kcard ${c.column} ${yours ? 'yours' : ''} ${selected ? 'selected' : ''} ${c.cut ? 'cut' : ''} ${c.blocked || pendingApproval(c) ? 'blocked' : ''}`} draggable="true"
    onDragStart=${(e) => e.dataTransfer.setData('text/plain', c.id)} onClick=${() => onSelect(selected ? null : c.id)} aria-expanded=${selected}>
    <span class="kc-head"><span class="id">${c.id}</span>${c.priority && html`<span class=${`prio ${c.priority}`}>${c.priority}</span>`}${fresh && html`<span class="new-dot" title="new reply since you last looked"></span>`}
      <span class="right">${yours ? html`<span class="tag yours">yours</span>` : [c.milestone, c.column === 'done' && c.cycle && `c${c.cycle}`].filter(Boolean).join(' · ')}</span></span>
    <span class="kc-title">${c.title}</span>
    ${c.assignee && html`<span class="agents"><${Agent} name=${c.assignee} working=${live && c.column === 'doing'} /></span>`}
    <span class="kc-tags">
      ${c.src === 'orchestrator' && c.column === 'backlog' && html`<span class="kind agent" title="The orchestrator filed this for a later cycle. Edit or cut it if it's wrong.">agent note</span>`}
      ${c.steering && html`<span class="kind steer">⚡ steer</span>`}
      ${pendingApproval(c) && html`<span class="kind approval">approval: waiting for you</span>`}
      ${c.approval?.decision && html`<span class=${`decision ${c.approval.decision}`}>${c.approval.decision === 'approved' ? '✓ approved' : '✕ disapproved'}</span>`}
      ${c.blocked && html`<span class="kind blocked" title=${c.blocked}>blocked</span>`}
      ${c.cut && html`<span class="kind" title=${c.cut}>cut</span>`}
      ${c.waiting && !c.steering && html`<span class="kind waiting" title="The orchestrator hasn't read your latest yet">waiting for the agent</span>`}
    </span>
    ${meta && html`<span class="kc-meta">${meta}</span>`}
  </button>`;
}

function CardDetail({ d, c, onClose }) {
  const [text, setText] = useState('');
  const [steer, setSteer] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), []);
  const running = d.state === 'running' || d.state === 'pausing';
  const closed = c.column === 'done';
  const send = (e) => {
    e?.preventDefault();
    if (!text.trim()) return;
    if (steer && running && !confirm(`Steer now?\n\nThis interrupts cycle ${d.cycle} (its work on disk is kept) and starts a fresh cycle that replans around your comment first.`)) return;
    setBusy(true);
    postCard(d, c.id, { comment: text.trim(), ...(steer ? { steer: true } : {}) })
      .then((r) => {
        if (!r) return;
        setText('');
        setSteer(false);
        const body = steer ? (r.interrupted ? `Cycle ${d.cycle} is interrupted; a fresh cycle replans around it now.` : 'The next cycle replans around it first.') : closed ? 'The card is back in Todo for the next cycle.' : d.run_finished ? 'This goal is finished: press "Follow up" to have it handled (no time box).' : 'The next cycle reads it.';
        toast({ kind: 'info', title: `${c.id}: comment sent`, body, ms: 5000 });
      })
      .finally(() => setBusy(false));
  };
  const cut = () => {
    const why = prompt(`Cut ${c.id}? Say why (the orchestrator reads it).`, '');
    if (why?.trim()) postCard(d, c.id, { column: 'done', cut: why.trim() });
  };
  return html`<div class="panel kdetail" ref=${ref} aria-label=${`Card ${c.id}`}>
    <div class="kd-head"><span class="id">${c.id}</span>${c.milestone && html`<span class="chip">${c.milestone}</span>`}${c.priority && html`<span class=${`prio ${c.priority}`}>${c.priority}</span>`}${c.assignee && html`<${Agent} name=${c.assignee} />`}
      <span class="faint">from ${SRC_LABEL[c.src] ?? c.src} · ${ago(c.created_at)}${c.cycle ? ` · last touched in c${c.cycle}` : ''}</span>
      <button class="btn small ghost close" onClick=${onClose} aria-label="Close the card">✕</button></div>
    ${editing
      ? html`<form class="fb-form" onSubmit=${(e) => {
          e.preventDefault();
          if (draft.trim() && draft.trim() !== c.title) postCard(d, c.id, { title: draft.trim() }).then(() => setEditing(false));
          else setEditing(false);
        }}>
          <textarea rows="2" value=${draft} onInput=${(e) => setDraft(e.currentTarget.value)} aria-label=${`Title of ${c.id}`}></textarea>
          <div class="row"><span class="faint">The next cycle reads the new text.</span><span><button type="button" class="btn small ghost" onClick=${() => setEditing(false)}>Cancel</button> <button class="btn primary small">Save</button></span></div>
        </form>`
      : html`<div class="kd-title">${c.title}</div>`}
    ${c.blocked && html`<div class="needs-run">Blocked: ${c.blocked}${/^needs a new run/.test(c.blocked) ? html` Use <b>Start new run…</b> when you're ready.` : ''}</div>`}
    ${c.cut && html`<div class="faint">Cut: ${c.cut}</div>`}
    ${c.approval && html`<div class="approval-text">Approval asked: ${c.approval.text}</div>`}
    ${pendingApproval(c) && html`<${ApprovalButtons} goalId=${d.id} f=${c} />`}
    <div class="kd-actions">
      <label>Column <select value=${c.column} onChange=${(e) => postCard(d, c.id, { column: e.currentTarget.value })}>
        ${COLS.map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
      </select></label>
      ${!editing && html`<button class="btn small" onClick=${() => (setDraft(c.title), setEditing(true))}>Edit</button>`}
      ${!closed && html`<button class="btn small ghost" onClick=${cut}>Cut</button>`}
      ${c.blocked && html`<button class="btn small ghost" onClick=${() => postCard(d, c.id, { blocked: null })}>Unblock</button>`}
      ${(d.run_finished || d.clock?.followup) && !closed &&
      html`<select class="scope" aria-label=${`How a follow-up treats ${c.id}`} value=${c.scope} onChange=${(e) => postCard(d, c.id, { scope: e.currentTarget.value })}
        title="After DONE, a follow-up handles your open cards and comments with no time box. Choose how this card is treated.">
        <option value="auto">agent decides</option><option value="tweak">quick tweak</option><option value="new_run">needs a new run</option>
      </select>`}
    </div>
    ${c.comments.length > 0 &&
    html`<ul class="comments">${c.comments.map((m, i) => html`<li key=${i} class=${m.by === 'user' ? 'mine' : ''}>
      <div class="by">${m.by === 'user' ? html`<b>you</b>` : html`<${Agent} name=${m.by} />`}${m.steer ? html` <span class="kind steer">⚡ steer</span>` : ''} <span class="faint">${m.cycle ? `c${m.cycle} · ` : ''}${ago(m.ts)}</span></div>
      <div class="text">${m.text}</div>
    </li>`)}</ul>`}
    <form class="fb-form" onSubmit=${send}>
      <textarea rows="2" value=${text} disabled=${busy} aria-label=${`Comment on ${c.id}`} onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && send(e)}
        placeholder=${closed ? 'Comment to reopen it: the next cycle looks at it again' : 'A comment for the agent on this card: it acts on it, or just replies'}></textarea>
      <div class="row"><label class="faint steer-box"><input type="checkbox" checked=${steer} onChange=${(e) => setSteer(e.currentTarget.checked)} /> ⚡ Steer: ${running ? 'interrupt the running cycle and replan around it' : 'the next cycle replans around it first'}</label>
        <button class="btn primary small" disabled=${busy || !text.trim()}>Comment</button></div>
    </form>
  </div>`;
}

/** New cards land in the backlog; the next cycle triages them (or replans around them first, when steering). */
function AddCard({ d, label = 'Add a card', bar }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const running = d.state === 'running' || d.state === 'pausing';
  const after = d.run_finished && !d.live; // after DONE or the time box, cards wait for a follow-up
  const submit = (e, steer = false) => {
    e?.preventDefault();
    if (!text.trim()) return;
    if (steer && running && !confirm(`Steer now?\n\nThis interrupts cycle ${d.cycle} (its work on disk is kept) and starts a fresh cycle that replans the board around your card before doing anything else.`)) return;
    setBusy(true);
    api
      .post(`/api/goals/${d.id}/cards`, { title: text.trim(), ...(steer ? { steer: true } : {}) })
      .then(({ id, interrupted }) => {
        setText('');
        if (!steer && d.run_finished) toast({ kind: 'info', title: `${id} added`, body: 'This goal is finished: press "Follow up" to have it handled (no time box).', ms: 6000 });
        else if (steer) toast({ kind: 'info', title: `${id}: steering`, body: interrupted ? `Cycle ${d.cycle} is interrupted; a fresh cycle replans around it now.` : 'The next cycle replans around it first.', ms: 5000 });
        else toast({ kind: 'info', title: `${id} added to the backlog`, body: 'The next cycle triages it.', ms: 3500 });
        loadDetail();
      })
      .catch((e) => toast({ kind: 'bad', title: 'Could not add the card', body: e.message }))
      .finally(() => setBusy(false));
  };
  const fid = `add-${bar ? 'bar' : 'ov'}`;
  return html`<form class=${bar ? 'panel addcard bar' : 'addcard'} onSubmit=${submit}>
    <label class="field-label" for=${fid}>${label}</label>
    <div class="addrow">
      <input id=${fid} type="text" value=${text} disabled=${busy} onInput=${(e) => setText(e.currentTarget.value)}
        placeholder=${after ? 'e.g. a fix or a tweak you want in the follow-up' : 'Feedback or a task for the harness. Your cards outrank the rest.'} />
      ${!after && html`<button type="button" class="btn steer" disabled=${busy || !text.trim()} onClick=${(e) => submit(e, true)}
        title=${running ? 'Interrupt the running cycle now and replan the whole board around this' : 'The next cycle replans the whole board around this before anything else'}>⚡ ${running ? 'Steer now' : 'Steer'}</button>`}
      <button class=${`btn ${after ? '' : 'primary'}`} disabled=${busy || !text.trim()} title="Triaged at the start of the next cycle">${after ? 'Add card' : 'Add to backlog'}</button>
    </div>
    ${!bar && html`<p class="faint note">${after
      ? 'After DONE your cards wait for a follow-up: just your cards, no time box. Anything big is flagged for a new run.'
      : `Add to backlog: the next cycle picks it up. ${running ? `Steer now: interrupts cycle ${d.cycle} (its work is kept) and replans around it.` : 'Steer: the next cycle replans around it first.'}`}</p>`}
  </form>`;
}

/** Done cards, newest first: the latest few, then the rest folded by milestone. */
function DoneLane({ list, tile }) {
  const sorted = [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const top = sorted.slice(0, DONE_SHOWN);
  const groups = new Map();
  for (const c of sorted.slice(DONE_SHOWN)) groups.set(c.milestone, [...(groups.get(c.milestone) ?? []), c]);
  return html`${top.map(tile)}
    ${[...groups].map(([m, cs]) => html`<details key=${m ?? '-'} class="done-group"><summary>${m ?? 'No milestone'} · ${cs.length} ${top.some((c) => c.milestone === m) ? 'more' : `card${cs.length > 1 ? 's' : ''}`}</summary><div class="lane-cards">${cs.map(tile)}</div></details>`)}`;
}

/** The kanban board: the backlog, then Todo → Doing → Review → Done, for one epic (a job) at a time. */
function Board({ d }) {
  const s = useStore();
  const [epic, setEpic] = useState(null);
  const [ms, setMs] = useState(null);
  const [mine, setMine] = useState(false);
  const [over, setOver] = useState(null);
  const [allBacklog, setAllBacklog] = useState(false);
  const setSel = (id) => set({ cardSel: id });
  const seen = store.seenAtOpen[d.id]?.feedback_at;
  const cur = curEpic(d);
  const ep = epic ?? cur;
  const all = d.board_cards.filter((c) => c.epic === ep);
  const cards = all.filter((c) => (!ms || c.milestone === ms) && (!mine || c.src !== 'orchestrator'));
  const selected = all.find((c) => c.id === s.cardSel);
  const open = [...new Set(all.filter((c) => c.column !== 'done' && c.milestone).map((c) => c.milestone))].sort();
  const now = ep === cur ? d.milestones?.find((m) => m.current)?.id : null;
  const live = d.state === 'running' || d.state === 'pausing';
  const tile = (c) => html`<${CardTile} key=${c.id} c=${c} selected=${s.cardSel === c.id} onSelect=${setSel} seen=${seen} live=${live} />`;
  const drop = (e, col) => {
    e.preventDefault();
    setOver(null);
    const c = all.find((x) => x.id === e.dataTransfer.getData('text/plain'));
    if (c && c.column !== col) postCard(d, c.id, { column: col });
  };
  return html`${ep === cur && html`<${AddCard} d=${d} bar=${true} />`}
    <div class="board-filters">
      ${d.epics.length > 1 && html`<select class="epic" value=${ep} onChange=${(e) => (setEpic(e.currentTarget.value), setMs(null), setSel(null))} aria-label="Epic (job)">
        ${d.epics.map((e) => html`<option key=${e.id} value=${e.id}>${e.title}${e.current ? ' (current job)' : ''}</option>`)}
      </select>`}
      <span class="pills" role="group" aria-label="Milestone">
        <button class=${!ms ? 'on' : ''} onClick=${() => setMs(null)}>All milestones</button>
        ${open.map((m) => html`<button key=${m} class=${ms === m ? 'on' : ''} onClick=${() => setMs(ms === m ? null : m)}>${m}${m === now ? ' · now' : ''}</button>`)}
      </span>
      <label class="check"><input type="checkbox" checked=${mine} onChange=${(e) => setMine(e.currentTarget.checked)} /> Only my cards</label>
      <span class="faint right hide-sm">Drag cards between columns · open one to comment</span>
    </div>
    <div class="board">
      ${COLS.map(([k, label]) => {
        const list = cards.filter((c) => c.column === k);
        const shown = k === 'backlog' && !allBacklog ? list.slice(0, BACKLOG_SHOWN) : list;
        return html`<div key=${k} class=${`lane lane-${k} ${over === k ? 'over' : ''}`} onDragOver=${(e) => (e.preventDefault(), setOver(k))} onDragLeave=${() => setOver(null)} onDrop=${(e) => drop(e, k)}>
          <h3 title=${LANE_HINT[k]}><span class="lane-dot"></span>${label} <span class="count num">${list.length}</span><span class="right faint">${LANE_META[k] ?? (k === 'backlog' && ms ? ms : '')}</span></h3>
          ${k === 'done' ? html`<${DoneLane} list=${list} tile=${tile} />` : shown.map(tile)}
          ${list.length > shown.length && html`<button class="btn small ghost dashed" onClick=${() => setAllBacklog(true)}>Show ${list.length - shown.length} more</button>`}
          ${list.length === 0 && html`<p class="empty">–</p>`}
        </div>`;
      })}
    </div>
    ${selected && html`<${CardDetail} key=${selected.id} d=${d} c=${selected} onClose=${() => setSel(null)} />`}`;
}


// ---------------------------------------------------------------- goal detail: shared bits

const TABS = [['', 'Overview'], ['board', 'Board'], ['cycles', 'Cycles'], ['time', 'Time'], ['activity', 'Activity'], ['setup', 'Setup']];
const tabHref = (id, tab) => `#/g/${id}${tab ? `/${tab}` : ''}`;
const FAILED = ['error', 'timeout'];
const shortAgo = (iso) => ago(iso).replace(' ago', '');
const curEpic = (d) => d.epics.find((e) => e.current)?.id;
const epicCards = (d) => d.board_cards.filter((c) => c.epic === curEpic(d));

/** Failed cycles at the end of the list (the streak that stopped the run). */
function failedStreak(cycles) {
  let i = cycles.length;
  while (i > 0 && FAILED.includes(cycles[i - 1].exit)) i--;
  return cycles.slice(i);
}

/** The cycle that was running at `iso`, for grouping commits and events. */
const cycleAt = (d, iso) => d.cycles_detail.find((r) => r.started_at <= iso && iso <= r.ended_at)?.cycle ?? null;

function cacheReadShare(d) {
  let read = 0;
  let all = 0;
  for (const models of [...d.cycles_detail.map((r) => r.models), d.live_usage?.models ?? {}]) for (const u of Object.values(models)) {
    read += u.cache_read;
    all += u.input + u.cache_read + u.cache_write;
  }
  return all ? read / all : null;
}

function selectCycle(d, n, toggle = true) {
  if (toggle && store.selectedCycle === n) return set({ selectedCycle: null, cycleView: null });
  set({ selectedCycle: n, cycleView: null });
  api.get(`/api/goals/${d.id}/cycles/${n}`).then((cycleView) => set({ cycleView })).catch(() => {});
}
const openCycle = (d, n) => (e) => {
  e.preventDefault();
  selectCycle(d, n, false);
  location.hash = tabHref(d.id, 'cycles');
};
const openCard = (d, id) => (e) => {
  e.preventDefault();
  set({ cardSel: id });
  location.hash = tabHref(d.id, 'board');
};

/** [busy, act]: a control action with its toast, then a refresh. */
function useAct(d) {
  const [busy, setBusy] = useState(false);
  const act = (action, extra = {}, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    api
      .post(`/api/goals/${d.id}/control`, { action, ...extra })
      .then(() => toast({ kind: 'info', title: extra.follow_up ? 'Starting a follow-up…' : { start: 'Starting…', pause: 'Pause requested', stop: 'Stopping…', extend: 'Time box extended', reset: 'Clock reset' }[action], body: d.name, ms: 3500 }))
      .catch((e) => toast({ kind: 'bad', title: `Could not ${action}`, body: e.message }))
      .finally(() => {
        setBusy(false);
        loadState();
        loadDetail();
      });
  };
  return [busy, act];
}

const newRunText = (d) =>
  d.done_marker
    ? 'This goal is done. Start a new run?\n\nA new run gets a fresh time box and spends tokens. The orchestrator only finds work if you added cards since.'
    : 'The time box is over. Start a new run with a fresh time box?\n\nTo continue this run instead, cancel and use +30m / +1h / +2h.';
const STOP_TEXT = 'Stop now? The current cycle is interrupted; the next start recovers its work.';
const RESET_TEXT = 'Reset the clock? The next start begins a new run with the time box from goal.json.';

function Extend({ d, busy, act }) {
  return html`<span class="btn-group" role="group" aria-label="Extend the time box">
    ${[['+30m', 1800], ['+1h', 3600], ['+2h', 7200]].map(([l, s]) => html`<button key=${l} class="btn small" disabled=${busy} onClick=${() => act('extend', { seconds: s })} title="Extend the time box">${l}</button>`)}
  </span>`;
}

function FollowUpButton({ d, busy, act }) {
  const fu = d.followup_items;
  return html`<button class="btn primary" disabled=${busy} onClick=${() => act('start', { follow_up: true })}
    title="Handle just your open cards and comments, with no time box. Minor items are fixed in place; anything that needs a restart or a new version is flagged for a new run instead.">▶ Follow up on ${fu} card${fu > 1 ? 's' : ''}</button>`;
}

/** One activity step: time, agent, tool and summary. */
function Step({ a, fresh }) {
  return html`<li class="kind-${a.kind} ${fresh ? 'fresh' : ''}">
    <time>${clockTime(a.ts)}</time>
    <${Agent} name=${a.agent} />
    <span class="what" title=${a.summary}>${a.tool && html`<span class="tool">${a.tool}</span>`}${a.kind === 'agent.start' ? '▶ ' : a.kind === 'agent.end' ? '■ ' : ''}${a.summary}</span>
  </li>`;
}

// ---------------------------------------------------------------- goal detail: header and tabs

function MoreMenu({ d }) {
  const [busy, act] = useAct(d);
  const close = (e) => (e.currentTarget.closest('details').open = false);
  return html`<details class="menu">
    <summary class="btn icon" aria-label="More actions">⋯</summary>
    <div class="menu-list" onClick=${close}>
      ${d.job.n > 1 && html`<a href=${`/goals/${d.id}/report.html?job=all`} target="_blank" rel="noopener">Report: all jobs ↗</a>`}
      <a href=${tabHref(d.id, 'setup')}>Setup and run settings</a>
      ${!d.live && d.clock && html`<button disabled=${busy} onClick=${() => act('reset', {}, RESET_TEXT)}>Reset clock…</button>`}
    </div>
  </details>`;
}

function GoalHead({ d, tab }) {
  const [busy, act] = useAct(d);
  const overview = !tab;
  const a = d.goal.adapter;
  return html`<a class="back" href="#/">‹ All goals</a>
    <div class="ghead">
      <div class="ghead-main">
        <div class="title"><h1>${d.name}</h1><${StatePill} state=${d.state} />${d.mode && html`<span class="chip ${d.mode}">${d.mode}</span>`}</div>
        <div class="meta">
          <span>run <b>${d.run ?? '–'}</b> · cycle <b class="num">${d.cycle || '–'}</b>${d.round ? html` · round <b>${d.round}</b>` : ''}</span>
          ${d.job.named && html`<span>job <b>${d.job.title}</b>${d.job.n > 1 ? ` · ${d.job.n} of ${d.job.n}` : ''}</span>`}
          <span>${[a.model && shortModel(a.model), a.effort].filter(Boolean).join(' · ')}</span>
        </div>
        ${overview && html`<p class="objective" title=${d.objective}>${d.objective}</p>`}
      </div>
      <div class="ghead-actions">
        <a class="btn" href=${`/goals/${d.id}/report.html${d.job_scope === 'all' ? '?job=all' : ''}`} target="_blank" rel="noopener">Report</a>
        <${OutputLink} o=${d.output} />
        <${MoreMenu} d=${d} />
      </div>
    </div>
    <${ClockBar} g=${d} big=${overview} extra=${d.live && d.clock && !d.clock.followup && html`<${Extend} d=${d} busy=${busy} act=${act} />`} />
    <${Tabs} d=${d} tab=${tab} />`;
}

function Tabs({ d, tab }) {
  const cards = epicCards(d).length;
  const failed = d.live ? 0 : failedStreak(d.cycles_detail).length;
  const seen = store.seenAtOpen[d.id]?.events_at;
  const fresh = seen && d.events.some((e) => e.ts > seen && e.src !== 'user' && ['milestone', 'blocked', 'needs_you', 'done', 'warn', 'run.end'].includes(e.type));
  const count = { board: cards || null, cycles: d.cycles || null };
  return html`<nav class="tabs" aria-label="Goal sections">
    ${TABS.map(([k, label]) => html`<a key=${k} href=${tabHref(d.id, k)} class=${tab === k ? 'on' : ''} aria-current=${tab === k ? 'page' : undefined}>
      ${label}${k === 'cycles' && failed ? html`<span class="count bad">${failed} failed</span>` : count[k] ? html`<span class="count">${count[k]}</span>` : ''}${k === 'activity' && fresh ? html`<span class="new-dot" title="new since you last looked"></span>` : ''}
    </a>`)}
    <span class="spacer"></span>
    <${JobToggle} d=${d} />
  </nav>`;
}

/** With several jobs: whether the numbers (and the Report button) cover this job or all of them. */
function JobToggle({ d }) {
  if (d.job.n < 2) return null;
  const scope = (s) => {
    if (s === store.jobScope) return;
    set({ jobScope: s, selectedCycle: null, cycleView: null });
    loadDetail();
  };
  return html`<span class="seg-toggle" role="group" aria-label="Which jobs the numbers cover">
    <button class=${d.job_scope !== 'all' ? 'on' : ''} onClick=${() => scope('job')}>This job</button><button class=${d.job_scope === 'all' ? 'on' : ''} onClick=${() => scope('all')}>All jobs</button>
  </span>`;
}

// ---------------------------------------------------------------- status band

function bandKind(d) {
  if (d.needs || (!d.live && d.board_cards.some(pendingApproval))) return 'needs';
  if (d.state === 'rate_limited' || d.state === 'cooldown') return 'limited';
  if (d.live) return 'running';
  if (d.state === 'done') return 'done';
  if (d.state === 'failed' || d.state === 'crashed' || FAILED.includes(d.cycles_detail.at(-1)?.exit)) return 'trouble';
  if (d.state === 'timeboxed') return 'timeboxed';
  if (d.cycles === 0) return 'first';
  return 'paused';
}

function Band({ kind, icon, title, sub, actions, children }) {
  return html`<section class="band ${kind}" aria-live="polite">
    <div class="band-head">
      ${icon && html`<span class="band-ico" aria-hidden="true">${icon}</span>`}
      <b class="band-title">${title}</b>
      ${sub && html`<span class="band-sub">${sub}</span>`}
      <span class="band-actions">${actions}</span>
    </div>
    ${children}
  </section>`;
}

function StatusBand({ d }) {
  const kind = bandKind(d);
  const pending = d.board_cards.filter(pendingApproval);
  const B = { needs: NeedsBand, limited: LimitedBand, running: RunningBand, done: DoneBand, trouble: TroubleBand, timeboxed: TimeboxedBand, first: FirstBand, paused: PausedBand }[kind];
  return html`<${B} d=${d} />
    ${kind !== 'needs' && pending.length > 0 && html`<${Approvals} d=${d} pending=${pending} strip=${true} />`}`;
}

function Approvals({ d, pending, strip }) {
  return html`<div class=${strip ? 'band-strip' : ''}>
    <h3 class="micro">${strip ? html`<span class="flagmark" aria-hidden="true">⚑</span> Approval needed · the run keeps working on other cards meanwhile` : `Needs your approval · ${pending.length}`}</h3>
    <ul class="approvals">${pending.map((c) => html`<li key=${c.id}>
      <div class="ap-head"><span class="id">${c.id}</span><span class="kind approval">approval</span>${c.approval.text !== c.title && html`<span class="chip" title=${c.title}>${c.title}</span>`}<span class="faint right">${c.cycle ? `asked in c${c.cycle}` : ago(c.created_at)}</span></div>
      <div class="approval-text">${c.approval.text}</div>
      <${ApprovalButtons} goalId=${d.id} f=${c} />
    </li>`)}</ul>
  </div>`;
}

function RunningBand({ d }) {
  const now = useNow();
  const s = useStore();
  const [busy, act] = useAct(d);
  const doing = epicCards(d).filter((c) => c.column === 'doing');
  const open = new Map();
  for (const a of d.activity) {
    if (a.kind === 'agent.start') open.set(a.agent, a);
    if (a.kind === 'agent.end') open.delete(a.agent);
  }
  const steps = d.activity.slice(-5).reverse();
  const running = d.state === 'running' || d.state === 'pausing';
  const elapsed = d.cycle_started_at ? (now - Date.parse(d.cycle_started_at)) / 1000 : null;
  const cost = d.live_usage?.cost_usd;
  const title = d.state === 'waiting' ? `Between cycles · cycle ${d.cycle + 1} is next` : d.pause_requested ? `Pausing after cycle ${d.cycle}` : `Running cycle ${d.cycle}`;
  const sub = running && elapsed != null ? `${dur(elapsed)} in · times out at ${d.goal.cycle.timeout_min}m${cost != null ? ` · ≈ $${cost.toFixed(2)} so far` : ''}` : d.clock?.followup ? 'follow-up · no time box' : '';
  const ms = (d.milestones ?? []).find((m) => m.current);
  const msN = ms && ms.todo + ms.doing + ms.done + ms.blocked + ms.cut;
  return html`<${Band} kind="running" icon=${html`<span class="live-dot"></span>`} title=${title} sub=${sub}
    actions=${html`<button class="btn" disabled=${busy || d.pause_requested} onClick=${() => act('pause')} title="Finish the current cycle, then pause (the clock pauses too)">‖ ${d.pause_requested ? 'Pausing after cycle' : 'Pause after cycle'}</button>
      <button class="btn danger" disabled=${busy} onClick=${() => act('stop', {}, STOP_TEXT)}>■ Stop now</button>`}>
    <div class="band-cols">
      <div>
        <h3 class="micro">Working on</h3>
        ${doing.length === 0
          ? html`<p class="faint">Nothing in DOING right now: the orchestrator is planning, briefing or checking.</p>`
          : doing.map((c, i) => html`<div key=${c.id} class="working">
              <a href=${tabHref(d.id, 'board')} onClick=${openCard(d, c.id)} class=${i === 0 ? 'band-headline' : 'working-title'}>${c.title}</a>
              <div class="kc-head"><span class="id">${c.id}</span>${c.milestone && html`<span class="chip">${c.milestone}</span>`}${c.priority && html`<span class=${`prio ${c.priority}`}>${c.priority}</span>`}</div>
            </div>`)}
        ${running && html`<h3 class="micro">Agents</h3>
          <div class="agents"><${Agent} name="orchestrator" working=${true} />${[...open.entries()].map(([a, x]) => html`<span key=${a} title=${x.summary}><${Agent} name=${a} working=${true} /></span>`)}</div>`}
        ${ms && html`<p class="faint">${ms.id} · ${ms.done} of ${msN} cards done${ms.target_s != null ? ` · target ${dur(ms.target_s)}` : ''}</p>`}
      </div>
      <div>
        <h3 class="micro">Latest steps ${d.activity_cycle ? html`<a class="right" href=${tabHref(d.id, 'cycles')} onClick=${openCycle(d, d.activity_cycle)}>All ${d.activity.length} steps →</a>` : ''}</h3>
        ${steps.length === 0
          ? html`<p class="faint">${running ? 'Waiting for the first step…' : 'No steps yet.'}</p>`
          : html`<ul class="ticker" aria-live="polite">${steps.map((a, i) => html`<${Step} key=${a.ts + a.summary + i} a=${a} fresh=${s.freshActivity.has(a.ts + a.summary)} />`)}</ul>`}
      </div>
    </div>
  </${Band}>`;
}

function LimitedBand({ d }) {
  const now = useNow();
  const [busy, act] = useAct(d);
  const left = d.waiting_until ? Math.max(0, (Date.parse(d.waiting_until) - now) / 1000) : null;
  const rl = d.state === 'rate_limited';
  return html`<${Band} kind="waiting" icon="◔" title=${rl ? 'Rate-limited' : 'Cooling down after failed cycles'} sub=${left != null ? `next cycle in ${dur(left)}` : ''}
    actions=${html`<button class="btn danger" disabled=${busy} onClick=${() => act('stop', {}, STOP_TEXT)}>■ Stop now</button>`}>
    <p class="band-text">${rl ? 'The plan hit its usage limit. The run waits and starts the next cycle by itself; the clock is paused meanwhile.' : 'Several cycles failed in a row, so the run waits a little before trying again.'}</p>
  </${Band}>`;
}

function NeedsBand({ d }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = d.board_cards.filter(pendingApproval);
  const reply = (e, withText = true) => {
    e?.preventDefault();
    setBusy(true);
    const t = withText ? text.trim() : '';
    const p = t ? api.post(`/api/goals/${d.id}/cards`, { title: t, resume: true }) : api.post(`/api/goals/${d.id}/control`, { action: 'start' }).then(() => ({ resumed: true }));
    p.then((r) => {
      setText('');
      toast({ kind: 'info', title: r.resumed ? 'Resuming' : r.id ? `${r.id} added` : 'Sent', body: r.problem ? `Not resumed: ${r.problem}` : d.name, ms: 4000 });
    })
      .catch((err) => toast({ kind: 'bad', title: 'Could not resume', body: err.message }))
      .finally(() => {
        setBusy(false);
        loadState();
        loadDetail();
      });
  };
  const sub = d.needs ? `paused after cycle ${d.cycle} · ${ago(d.needs.since)} · the clock is stopped until you answer` : 'the run is stopped; answering the last approval resumes it';
  return html`<${Band} kind="needs" icon="⚑" title=${d.needs ? 'Waiting for you' : 'Approval needed'} sub=${sub}>
    <div class=${d.needs && pending.length ? 'band-cols' : ''}>
      ${d.needs && html`<form onSubmit=${reply}>
        <h3 class="micro">The orchestrator asks</h3>
        <p class="band-headline">${d.needs.reason}</p>
        <label class="field-label" for="needs-reply">Your answer</label>
        <textarea id="needs-reply" rows="2" value=${text} disabled=${busy} placeholder="It becomes a card the next cycle reads first."
          onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && reply(e)}></textarea>
        <div class="row"><span class="faint">${pending.length ? 'Answering the last approval also resumes the run.' : 'Ctrl+Enter to send'}</span>
          <span class="send-btns"><button type="button" class="btn ghost" disabled=${busy} onClick=${(e) => reply(e, false)}>Resume without answering</button>
          <button class="btn primary" disabled=${busy || !text.trim()}>▶ Send & resume</button></span></div>
      </form>`}
      ${pending.length > 0 && html`<${Approvals} d=${d} pending=${pending} />`}
    </div>
  </${Band}>`;
}

function TroubleBand({ d }) {
  const [busy, act] = useAct(d);
  const streak = failedStreak(d.cycles_detail);
  const last = streak.at(-1) ?? d.cycles_detail.at(-1);
  const note = epicCards(d).filter((c) => c.src === 'orchestrator' && c.column === 'backlog').at(-1);
  const spent = streak.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  const title = d.state === 'crashed' ? 'The runner crashed' : d.state === 'failed' ? 'Run stopped' : `Cycle ${last?.cycle} ended with ${last?.exit}`;
  const headline =
    d.state === 'crashed' ? 'The runner stopped without cleaning up' : streak.length > 1 ? `${streak.length} cycles failed in a row` : last ? `Cycle ${last.cycle}: ${last.exit}` : 'The run stopped';
  return html`<${Band} kind="trouble" icon="⚠" title=${title} sub=${`after cycle ${d.cycle}${last ? ` · ${ago(last.ended_at)}` : ''} · the clock is paused`}
    actions=${html`${last && html`<a class="btn" href=${tabHref(d.id, 'cycles')} onClick=${openCycle(d, last.cycle)}>See cycle ${last.cycle}'s steps</a>`}
      <button class="btn primary" disabled=${busy} onClick=${() => act('start')}>▶ Resume</button>`}>
    <div class=${note ? 'band-cols' : ''}>
      <div>
        <p class="band-headline">${headline}</p>
        <p class="band-text">${d.state === 'crashed' ? 'The clock was paused at its last heartbeat. Resume to continue; verified work is kept.' : 'Nothing verified is lost. Check the error, fix what it needs, then resume.'}</p>
        ${last?.error && html`<pre class="errbox"><span class="faint">c${last.cycle} · ${last.exit} after ${dur(last.duration_s)}</span>${'\n'}${last.error}</pre>`}
        ${streak.length > 0 && html`<div class="fail-chips">${streak.map((r) => html`<a key=${r.cycle} class="kind blocked" href=${tabHref(d.id, 'cycles')} onClick=${openCycle(d, r.cycle)}>✕ c${r.cycle} · ${dur(r.duration_s)}</a>`)}
          ${spent > 0 && html`<span class="faint">≈ $${spent.toFixed(2)} spent on failed cycles</span>`}</div>`}
      </div>
      ${note && html`<div>
        <h3 class="micro">Latest agent note</h3>
        <div class="note-card">
          <div class="ap-head"><span class="id">${note.id}</span><span class="kind agent">agent note</span><span class="faint right">${note.cycle ? `filed in c${note.cycle}` : ago(note.created_at)}</span></div>
          <div class="approval-text">${note.title}</div>
          <a class="btn small" href=${tabHref(d.id, 'board')} onClick=${openCard(d, note.id)}>Open on the board</a>
        </div>
      </div>`}
    </div>
  </${Band}>`;
}

/** The done text as a headline when it's short; otherwise its first sentence, with the rest below. */
function splitDone(text) {
  if (!text) return ['Done', ''];
  if (text.length <= 100) return [text, ''];
  const m = /^(.{10,100}?[.:;])\s+(.*)$/s.exec(text);
  return m ? [m[1], m[2]] : ['Done', text];
}

function DoneBand({ d }) {
  const [busy, act] = useAct(d);
  const last = d.events.findLast((e) => e.type === 'done');
  const [headline, rest] = splitDone(last?.text);
  const c = d.clock;
  const spare = c && !c.followup && c.to_end > 0 ? c.timebox_s - c.active : null;
  const out = d.output && html`<${OutputLink} o=${d.output} big=${d.followup_items === 0} />`;
  return html`<${Band} kind="done" icon="✓" title=${`Done${last ? ` · finished ${ago(last.ts)}${last.cycle ? ` in cycle ${last.cycle}` : ''}` : ''}`}
    actions=${html`${d.followup_items > 0 && html`<${FollowUpButton} d=${d} busy=${busy} act=${act} />`}${out}
      <a class="btn" href=${`/goals/${d.id}/report.html`} target="_blank" rel="noopener">Read the report</a>
      <button class="btn ghost" disabled=${busy} onClick=${() => act('start', { new_run: true }, newRunText(d))}>Start new run…</button>`}>
    <p class="band-headline">${headline}</p>
    ${(rest || spare != null) && html`<p class="band-text">${rest}${rest && spare != null ? ' ' : ''}${spare != null ? `Finished with ${dur(spare)} of the time box to spare.` : ''}</p>`}
  </${Band}>`;
}

function TimeboxedBand({ d }) {
  const [busy, act] = useAct(d);
  return html`<${Band} kind="waiting" icon="◔" title="Time box over" sub=${`after cycle ${d.cycle}${d.clock ? ` · ${dur(d.clock.active)} active` : ''}`}
    actions=${html`${d.followup_items > 0 && html`<${FollowUpButton} d=${d} busy=${busy} act=${act} />`}
      ${d.clock && html`<${Extend} d=${d} busy=${busy} act=${act} />`}
      <button class="btn" disabled=${busy} onClick=${() => act('start', { new_run: true }, newRunText(d))}>▶ Start new run…</button>`}>
    <p class="band-text">The run used its whole time box. Extend it to continue this run, or start a new one with a fresh time box.</p>
  </${Band}>`;
}

function PausedBand({ d }) {
  const [busy, act] = useAct(d);
  const title = { paused: 'Paused', stopped: 'Stopped' }[d.state] ?? 'Not running';
  return html`<${Band} kind="idle" icon="‖" title=${title} sub=${d.cycle ? `after cycle ${d.cycle} · the clock is paused` : ''}
    actions=${html`<button class="btn primary" disabled=${busy} onClick=${() => act('start')}>▶ ${d.clock ? 'Resume' : 'Start'}</button>`}>
  </${Band}>`;
}

function FirstBand({ d }) {
  const [busy, act] = useAct(d);
  return html`<${Band} kind="idle" title="Before the first cycle" sub=${`time box ${dur(d.goal.timebox.total_min * 60)} of active time`}
    actions=${html`<button class="btn primary" disabled=${busy} onClick=${() => act('start')}>▶ Start</button>`}>
    <ol class="band-steps">
      <li>Check the setup (it never starts the clock): <span class="mono">epoptes run ${d.id} --dry-run</span></li>
      <li>Read <span class="mono">.epoptes/loop.md</span> and the board once: that's exactly what every cycle will do.</li>
      <li>Press <b>Start</b>. The first cycle begins within seconds; this page follows it live. Pausing or stopping never loses verified work.</li>
    </ol>
  </${Band}>`;
}

// ---------------------------------------------------------------- overview

function Overview({ d }) {
  const kind = bandKind(d);
  const handoff = html`<${Handoff} key="h" d=${d} />`;
  const board = html`<${BoardSummary} key="b" d=${d} done=${kind === 'done'} />`;
  return html`<${StatusBand} d=${d} />
    <div class="split">
      <div class="main-col">
        ${kind === 'trouble' && d.activity.length > 0 && html`<${LastSteps} d=${d} />`}
        ${kind === 'done' ? [handoff, board] : [board, handoff]}
      </div>
      <aside class="rail">
        <${DoneChecks} d=${d} />
        <${CostRail} d=${d} />
        <${Lately} d=${d} />
      </aside>
    </div>`;
}

function LastSteps({ d }) {
  const steps = d.activity.slice(-8).reverse();
  return html`<section class="panel">
    <h2>Cycle ${d.activity_cycle} <span class="sub">the last cycle · ${d.activity.length} steps · newest first</span>
      <a class="right" href=${tabHref(d.id, 'cycles')} onClick=${openCycle(d, d.activity_cycle)}>All steps →</a></h2>
    <ul class="ticker">${steps.map((a, i) => html`<${Step} key=${i} a=${a} />`)}</ul>
  </section>`;
}

function Handoff({ d }) {
  const [all, setAll] = useState(false);
  const long = (d.handoff ?? '').split('\n').length > 14;
  return html`<section class="panel">
    <h2>Handoff <span class="sub">written by the orchestrator</span></h2>
    ${d.handoff
      ? html`<pre class=${`handoff ${long && !all ? 'clamp' : ''}`}><${Rich} text=${d.handoff} /></pre>
        ${long && html`<button class="linkbtn" onClick=${() => setAll(!all)}>${all ? 'Show less' : 'Read the whole handoff'}</button>`}`
      : html`<p class="empty">No handoff yet.</p>`}
  </section>`;
}

const FLIGHT = [['doing', (c) => c.column === 'doing'], ['review', (c) => c.column === 'review'], ['blocked', (c) => c.column !== 'done' && (c.blocked || pendingApproval(c))], ['yours', (c) => c.column !== 'done' && c.src !== 'orchestrator']];

function BoardSummary({ d, done }) {
  const cards = epicCards(d);
  const n = (col) => cards.filter((c) => c.column === col).length;
  const closed = cards.filter((c) => c.column === 'done');
  const cut = closed.filter((c) => c.cut).length;
  const seen = new Set();
  const rows = [];
  for (const [tag, f] of FLIGHT) for (const c of cards) if (f(c) && !seen.has(c.id)) (seen.add(c.id), rows.push([tag, c]));
  const recent = [...closed].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3);
  const ms = (d.milestones ?? []).filter((m) => m.todo + m.doing + m.done + m.blocked + m.cut > 0);
  const inFlight = n('doing') + n('review');
  return html`<section class="panel">
    <h2>Board <span class="sub">${closed.length} of ${cards.length} cards done${cut ? ` · ${cut} cut` : ''}${done ? (inFlight ? '' : ' · nothing in flight') : d.board?.milestone ? ` · milestone ${d.board.milestone}` : ''}</span>
      <a class="right" href=${tabHref(d.id, 'board')}>Open board ›</a></h2>
    ${ms.length > 0 && html`<${MilestoneBar} ms=${ms} />`}
    ${!done && cards.length > 0 && html`<div class="colcounts">${COLS.map(([k, l]) => html`<a key=${k} href=${tabHref(d.id, 'board')} class=${`cc ${k}`}><span>${l}</span><b class="num">${n(k)}</b></a>`)}</div>`}
    ${done
      ? recent.length > 0 && html`<h3 class="micro">Last cards closed</h3><ul class="rows closed">${recent.map((c) => html`<${CardRow} key=${c.id} d=${d} c=${c} />`)}</ul>`
      : rows.length > 0 && html`<h3 class="micro">In flight and yours</h3><ul class="rows">${rows.slice(0, 6).map(([tag, c]) => html`<${CardRow} key=${c.id} d=${d} c=${c} tag=${tag} />`)}</ul>`}
    ${cards.length === 0 && html`<p class="empty">No cards yet: the first cycle plans the board.</p>`}
    <${AddCard} d=${d} label=${done ? 'Feedback for a follow-up' : 'Add a card'} />
  </section>`;
}

function CardRow({ d, c, tag }) {
  return html`<li>
    ${tag && html`<span class=${`tag ${tag}`}>${tag}</span>`}
    <span class="id">${c.id}</span>
    <span class="prio-slot">${c.priority && html`<span class=${`prio ${c.priority}`}>${c.priority}</span>`}</span>
    <a class="row-title" href=${tabHref(d.id, 'board')} onClick=${openCard(d, c.id)}>${c.milestone ? `${c.milestone} · ` : ''}${c.title}${tag === 'yours' || tag === 'blocked' ? html`<span class="faint"> · ${c.blocked ? `blocked: ${c.blocked}` : pendingApproval(c) ? 'waits for your approval' : c.column}</span>` : ''}</a>
    ${!tag && c.cycle && html`<span class="faint">c${c.cycle}</span>`}
  </li>`;
}

/** Board progress split by milestone: one segment per milestone, width by card count, filled by state. */
function MilestoneBar({ ms }) {
  return html`<div class="ms-bar" role="list" aria-label="Progress by milestone">
    ${ms.map((m) => {
      const n = m.todo + m.doing + m.done + m.blocked + m.cut;
      const finished = m.todo + m.doing === 0;
      const tip = `${m.id} ${m.title}${m.target_s != null ? ` (target ${dur(m.target_s)})` : ''}\n${m.done} done · ${m.doing} in progress · ${m.blocked} blocked · ${m.cut} cut · ${m.todo} to do${m.reached ? `\nreached ${ago(m.reached.at)}` : ''}`;
      return html`<div key=${m.id} role="listitem" class="ms-seg ${m.current ? 'current' : ''}" style=${{ flexGrow: n }} title=${tip}>
        <div class="progress"><span class="done" style=${{ flexGrow: m.done }}></span><span class="doing" style=${{ flexGrow: m.doing }}></span><span class="blocked" style=${{ flexGrow: m.blocked }}></span><span class="cut" style=${{ flexGrow: m.cut }}></span><span style=${{ flexGrow: m.todo }}></span></div>
        <div class="ms-name"><b>${m.id}</b> ${finished ? `done${m.cut ? ` · ${m.cut} cut` : ''}` : `${m.done}/${n}${m.current ? ' · now' : ''}${m.blocked ? ` · ${m.blocked} blocked` : ''}`}</div>
      </div>`;
    })}
  </div>`;
}

const VERIFY = { command: (v) => html`runs <span class="mono">${v.run}</span>`, file: (v) => html`file <span class="mono">${v.path}</span>`, agent: () => 'reviewed by an agent', manual: () => 'checked by you' };

/** The done criteria. Epoptes doesn't run them itself (yet), so there's no pass/fail to show; agent checks get the latest scores. */
function DoneChecks({ d }) {
  const sc = d.scores;
  return html`<section class="rail-sec">
    <h3 class="micro">Done checks <span class="right" title="Epoptes doesn't run these checks itself yet; the orchestrator runs them and calls DONE.">${d.done_marker ? 'the orchestrator called DONE' : 'run by the orchestrator'}</span></h3>
    <ul class="checks">${d.goal.done.map((x) => html`<li key=${x.id}>
      <span class=${`ck ${d.done_marker ? 'ok' : ''}`} aria-hidden="true">${d.done_marker ? '✓' : '–'}</span>
      <div><div class="ck-text"><b>${x.id}</b> · ${x.check}</div>
        <div class="faint">${VERIFY[x.verify.type]?.(x.verify) ?? x.verify.type}</div>
        ${x.verify.type === 'agent' && sc && html`<div class="score-chips">${Object.entries(sc.scores).map(([k, v]) => html`<span key=${k} class="chip">${k} <b>${v ?? '–'}</b></span>`)}<span class="faint">${sc.cycle ? `scored in c${sc.cycle}` : 'latest scores'}</span></div>`}
      </div>
    </li>`)}</ul>
  </section>`;
}

function CostRail({ d }) {
  const share = cacheReadShare(d);
  const recent = d.cycles_detail.slice(-12);
  const max = Math.max(0.0001, ...recent.map((r) => r.cost_usd ?? 0), d.live_usage?.cost_usd ?? 0);
  const failed = recent.filter((r) => FAILED.includes(r.exit)).length;
  const running = d.cycle_started_at && !d.cycles_detail.some((r) => r.cycle === d.cycle);
  const flagged = recent.filter((r) => r.flagged).length;
  return html`<section class="rail-sec">
    <h3 class="micro">Cost <a class="right" href=${tabHref(d.id, 'cycles')}>Cycles →</a></h3>
    <div class="big-money"><${Money} usd=${d.cycles || d.live_usage?.cost_usd != null ? d.cost_usd : null} basis=${d.cost_basis} /> <span class="faint">${d.cost_basis === 'billed' ? 'billed' : 'API-equivalent estimate'}${running ? ', incl. the running cycle' : ''}</span></div>
    <p class="faint">${d.cycles} cycle${d.cycles === 1 ? '' : 's'}${d.cost_median ? ` · median ≈ $${d.cost_median.toFixed(2)}` : ''}${share != null ? ` · cache read ${pct(share)}` : ''}</p>
    ${recent.length > 0 && html`<a class="minibars" href=${tabHref(d.id, 'cycles')} aria-label="Cost of recent cycles">
      ${recent.map((r) => html`<span key=${r.cycle} class=${`mb ${r.exit}`} style=${{ height: `${Math.max(6, ((r.cost_usd ?? 0) / max) * 100)}%`, flexGrow: Math.max(1, r.duration_s) }} title=${`c${r.cycle} · ${r.exit} · ${dur(r.duration_s)} · ${r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : '–'}`}></span>`)}
      ${running && html`<span class="mb running" style=${{ height: `${Math.max(6, ((d.live_usage?.cost_usd ?? 0) / max) * 100)}%`, flexGrow: Math.max(1, (Date.now() - Date.parse(d.cycle_started_at)) / 1000) }}></span>`}
    </a>
    <div class="mb-labels"><span>c${recent[0].cycle}</span><span>${failed ? `${failed} failed` : `all ok${flagged ? '' : ' · none over 2× median'}`}</span><span>${running ? `c${d.cycle} now` : `c${recent.at(-1).cycle}`}</span></div>`}
  </section>`;
}

const LATELY_ICON = { milestone: '★', done: '✓', needs_you: '⚑', blocked: '⊘', 'run.end': '✕', commit: '⌥' };

/** Milestones, done, needs-you and failures, merged with commits by time. */
function Lately({ d }) {
  const events = d.events
    .filter((e) => ['milestone', 'done', 'needs_you', 'blocked'].includes(e.type) || (e.type === 'run.end' && ['failed', 'crashed'].includes(e.reason)))
    .map((e) => ({ ts: e.ts, cycle: e.cycle, t: e.type, text: feedText(e) }));
  const commits = d.commits.map((c) => ({ ts: c.at, cycle: cycleAt(d, c.at), t: 'commit', hash: c.hash, text: c.subject }));
  const items = [...events, ...commits].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
  return html`<section class="rail-sec">
    <h3 class="micro">Lately <a class="right" href=${tabHref(d.id, 'activity')}>Activity →</a></h3>
    ${items.length === 0
      ? html`<p class="empty">Nothing yet.</p>`
      : html`<ul class="lately">${items.map((x, i) => html`<li key=${i} class=${`t-${x.t.replace('.', '-')}`}>
          <span class="ico" aria-hidden="true">${LATELY_ICON[x.t]}</span>
          <span class="txt">${x.hash && html`<span class="hash">${x.hash}</span> `}${x.text}</span>
          <span class="when" title=${new Date(x.ts).toLocaleString()}>${x.cycle ? `c${x.cycle} · ` : ''}${shortAgo(x.ts)}</span>
        </li>`)}</ul>`}
  </section>`;
}

// ---------------------------------------------------------------- cycles tab

function CyclesTab({ d }) {
  const s = useStore();
  const all = d.cycles_detail;
  useEffect(() => {
    if (!store.selectedCycle && all.length) selectCycle(d, all.at(-1).cycle, false);
  }, []);
  const share = cacheReadShare(d);
  const failed = all.filter((r) => FAILED.includes(r.exit)).length;
  const durs = all.map((r) => r.duration_s).sort((a, b) => a - b);
  const medDur = durs.length ? durs[Math.floor(durs.length / 2)] : null;
  return html`<div class="sumrow">
      <div><span>Total</span><b><${Money} usd=${all.length || d.live_usage?.cost_usd != null ? d.cost_usd : null} basis=${d.cost_basis} /></b></div>
      <div><span>Cycles</span><b class="num">${all.length} <small class=${failed ? 'bad' : 'ok'}>${all.length ? (failed ? `${failed} failed` : 'all ok') : ''}</small></b></div>
      <div><span>Median cycle</span><b><${Money} usd=${d.cost_median || null} basis=${d.cost_basis} />${medDur != null ? html` <small>· ${dur(medDur)}</small>` : ''}</b></div>
      <div><span>Cache read</span><b class="num">${share != null ? pct(share) : '–'}</b></div>
      <div><span>Over 2× median</span><b class="num">${all.filter((r) => r.flagged).length}</b></div>
    </div>
    <${CostChart} d=${d} />
    <div class="split">
      <div class="main-col"><${CycleTable} d=${d} /></div>
      ${s.selectedCycle && html`<aside class="rail wide"><${CycleDetail} d=${d} /></aside>`}
    </div>`;
}

/** A round axis step for `max` dollars: 0.05, 0.1, 0.25, 0.5, 1, 2, 5… */
function niceStep(max) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw);
}

function CostChart({ d }) {
  const s = useStore();
  const now = useNow();
  const known = useRef(null);
  const results = d.cycles_detail;
  const waits = new Map();
  for (const e of d.events) if (e.type === 'wait' && e.reason !== 'between_cycles' && e.cycle) waits.set(e.cycle, [...(waits.get(e.cycle) ?? []), e]);
  const live = d.live_usage?.cost_usd ?? 0;
  const max = Math.max(0.01, ...results.map((r) => r.cost_usd ?? 0), live);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const h = (usd) => `${Math.max(2, ((usd ?? 0) / top) * 100)}%`;
  const segs = [];
  for (const r of results) {
    segs.push({ key: `c${r.cycle}`, kind: 'cycle', r });
    for (const w of waits.get(r.cycle) ?? []) segs.push({ key: `w${w.ts}`, kind: 'wait', w });
  }
  const running = d.cycle_started_at && !results.some((r) => r.cycle === d.cycle);
  if (running) segs.push({ key: `c${d.cycle}`, kind: 'running', elapsed: (now - Date.parse(d.cycle_started_at)) / 1000 });
  // Only segments that weren't there on the previous render animate in.
  const prev = known.current;
  const keys = new Set(segs.map((x) => x.key));
  useEffect(() => {
    known.current = keys;
  });
  const runs = new Set(results.map((r) => r.run));
  const models = new Set(results.flatMap((r) => Object.keys(r.models)));
  const money = (x) => (x == null ? '–' : `${d.cost_basis === 'estimate' ? '≈ ' : ''}$${x.toFixed(2)}`);
  return html`<section class="panel">
    <h2>Cost per cycle <span class="sub">bar width is duration${runs.size === 1 ? ` · run ${[...runs][0]}` : ''}${models.size === 1 ? ` · all on ${shortModel([...models][0])}` : ''}</span>
      <span class="legend right"><span><i class="ok"></i>ok</span><span><i class="bad"></i>error or timeout</span><span><i class="idle"></i>interrupted</span><span><i class="wait"></i>rate-limit wait</span><span><i class="med"></i>median</span></span></h2>
    ${segs.length === 0
      ? html`<p class="empty">No cycles yet.</p>`
      : html`<div class="chart">
          <div class="yaxis" aria-hidden="true">${ticks.map((t) => html`<span key=${t} style=${{ bottom: `${(t / top) * 100}%` }}>$${t.toFixed(step < 0.1 ? 2 : step < 1 ? 2 : 0)}</span>`)}</div>
          <div class="plot">
            ${ticks.map((t) => html`<span key=${t} class="grid-line" style=${{ bottom: `${(t / top) * 100}%` }}></span>`)}
            ${d.cost_median > 0 && html`<span class="median-line" style=${{ bottom: `${(d.cost_median / top) * 100}%` }}><span>median ${money(d.cost_median)}</span></span>`}
            <div class="bars" role="list" aria-label="Cycles">
              ${segs.map((x) => {
                const enter = prev && !prev.has(x.key) ? 'enter' : '';
                if (x.kind === 'wait') return html`<div key=${x.key} role="listitem" class="bar-col"><div class="seg wait ${enter}" style=${{ height: '30%' }} title=${`${x.w.reason === 'rate_limit' ? 'Rate-limit wait' : 'Cooldown'}: ${dur(x.w.seconds)}`}></div><span class="xl"></span></div>`;
                if (x.kind === 'running') {
                  return html`<div key=${x.key} role="listitem" class="bar-col" style=${{ flexGrow: Math.max(30, x.elapsed) }}>
                    <div class="seg running ${enter} ${s.selectedCycle === d.cycle ? 'selected' : ''}" style=${{ height: h(live) }} title=${`Cycle ${d.cycle}: running for ${dur(x.elapsed)}`} onClick=${() => selectCycle(d, d.cycle)}></div>
                    <span class="xl">c${d.cycle}</span></div>`;
                }
                const r = x.r;
                const tip = `Cycle ${r.cycle} (${r.run}) · ${r.exit}\n${dur(r.duration_s)} · ${r.turns ?? '?'} turns · ${money(r.cost_usd)}${r.flagged ? '\n⚠ costs more than twice the median cycle' : ''}\n${Object.entries(r.models).map(([m, u]) => `${shortModel(m)}: in ${tokens(u.input)} · out ${tokens(u.output)} · cache read ${tokens(u.cache_read)} · write ${tokens(u.cache_write)}`).join('\n')}`;
                return html`<div key=${x.key} role="listitem" class="bar-col" style=${{ flexGrow: Math.max(30, r.duration_s) }}>
                  <div class="seg ${r.exit} ${enter} ${s.selectedCycle === r.cycle ? 'selected' : ''}" title=${tip} onClick=${() => selectCycle(d, r.cycle)} style=${{ height: h(r.cost_usd) }}>${r.flagged && html`<span class="flag" aria-label="expensive">⚠</span>`}</div>
                  <span class=${`xl ${s.selectedCycle === r.cycle ? 'on' : ''}`}>c${r.cycle}</span></div>`;
              })}
            </div>
          </div>
        </div>`}
  </section>`;
}

function CycleTable({ d }) {
  const s = useStore();
  const rows = [...d.cycles_detail].reverse();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 20);
  if (!rows.length) return null;
  const perRun = new Set(rows.map((r) => r.run)).size > 1;
  const perModel = new Set(rows.flatMap((r) => Object.keys(r.models))).size > 1;
  const sum = (r, k) => Object.values(r.models).reduce((a, u) => a + u[k], 0);
  return html`<section class="panel">
    <h2>All cycles <span class="sub">newest first · pick one to see its steps</span></h2>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th>${perRun && html`<th>run</th>`}<th>exit</th><th class="r">time</th><th class="r">turns</th>${perModel && html`<th>models</th>`}<th class="r">output</th><th class="r">cache read</th><th class="r">cost</th></tr></thead>
      <tbody>
        ${shown.map((r) => {
          const share = cacheShare(r);
          const tip = Object.entries(r.models).map(([m, u]) => `${shortModel(m)}: input ${tokens(u.input)} · output ${tokens(u.output)} · cache read ${tokens(u.cache_read)} · cache write ${tokens(u.cache_write)}${u.cost_usd != null ? ` · $${u.cost_usd.toFixed(2)}` : ''}`).join('\n');
          return html`<tr key=${r.cycle} title=${tip} class="clickable ${r.flagged ? 'flagged' : ''} ${s.selectedCycle === r.cycle ? 'selected' : ''}" onClick=${() => selectCycle(d, r.cycle)}>
            <td class="num"><b>${r.cycle}</b>${r.flagged ? html` <span title="costs more than twice the median cycle">⚠</span>` : ''}</td>
            ${perRun && html`<td class="muted">${r.run}</td>`}
            <td><span class="exit ${r.exit}">${r.exit.replace('_', ' ')}</span></td>
            <td class="r num">${dur(r.duration_s)}</td>
            <td class="r num">${r.turns ?? '–'}</td>
            ${perModel && html`<td class="muted">${Object.keys(r.models).map(shortModel).join(', ')}</td>`}
            <td class="r num">${tokens(sum(r, 'output'))}</td>
            <td class="r num">${tokens(sum(r, 'cache_read'))}${share != null ? html` <span class="faint">· ${pct(share)}</span>` : ''}</td>
            <td class="r"><${Money} usd=${r.cost_usd} basis=${r.cost_basis} /></td>
          </tr>`;
        })}
      </tbody>
    </table></div>
    ${rows.length > 20 && html`<button class="btn small" onClick=${() => setAll(!all)}>${all ? 'Show recent' : `Show all ${rows.length}`}</button>`}
    <p class="faint note">${d.cost_basis === 'estimate' ? 'Costs are API-equivalent estimates. ' : ''}Hover a row for input, output, cache read and cache write by model.</p>
  </section>`;
}

function CycleDetail({ d }) {
  const s = useStore();
  const [all, setAll] = useState(false);
  if (!s.selectedCycle) return null;
  const v = s.cycleView;
  const r = v?.result;
  // The running cycle's steps stream into d.activity; a fetched view would be a stale snapshot.
  const live = d.live && s.selectedCycle === d.activity_cycle;
  const steps = live ? d.activity : v?.activity ?? [];
  const total = live ? d.activity.length : v?.activity_total ?? 0;
  const shown = [...steps].reverse().slice(0, all ? undefined : 40);
  return html`<section class="panel cycle-detail">
    <h2>Cycle ${s.selectedCycle} ${r ? html`<span class="exit ${r.exit}">${r.exit}</span>` : live ? html`<span class="exit ok">running</span>` : ''}
      <button class="btn small ghost right" onClick=${() => set({ selectedCycle: null, cycleView: null })} aria-label="Close the cycle">✕</button></h2>
    ${!v && !live
      ? html`<p class="empty">Loading…</p>`
      : html`${r &&
        html`<dl class="kv">
          ${r.error && html`<dt>error</dt><dd class="mono bad">${r.error}</dd>`}
          <dt>time</dt><dd class="num">${dur(r.duration_s)} · ${clockTime(r.started_at)} → ${clockTime(r.ended_at)}</dd>
          <dt>cost</dt><dd><${Money} usd=${r.cost_usd} basis=${r.cost_basis} /> · ${r.turns ?? '?'} turns</dd>
          <dt>tokens</dt><dd class="num">${Object.entries(r.models).map(([m, u]) => html`<div key=${m}>${Object.keys(r.models).length > 1 ? `${shortModel(m)}: ` : ''}out ${tokens(u.output)} · cache read ${tokens(u.cache_read)}</div>`)}</dd>
          ${r.session_id && html`<dt>session</dt><dd class="mono">${r.session_id}</dd>`}
        </dl>`}
        <h3 class="micro">Steps · ${total}</h3>
        <ul class="ticker tall">${shown.map((a, i) => html`<${Step} key=${i} a=${a} />`)}</ul>
        ${steps.length > shown.length && html`<button class="linkbtn" onClick=${() => setAll(true)}>Show all ${steps.length} steps</button>`}
        ${total > steps.length && html`<p class="faint">Showing the last ${steps.length} of ${total} steps.</p>`}`}
  </section>`;
}

function cacheShare(r) {
  let read = 0;
  let all = 0;
  for (const u of Object.values(r.models)) {
    read += u.cache_read;
    all += u.input + u.cache_read + u.cache_write;
  }
  return all ? read / all : null;
}

// ---------------------------------------------------------------- time tab

function TimeTab({ d }) {
  return html`<div class="stack"><${MilestonePlan} d=${d} /><${TimeUse} d=${d} /></div>`;
}

/** Each milestone's active time until reached, against its planned target, on one time-box axis. */
function MilestonePlan({ d }) {
  const now = useNow();
  const ms = (d.milestones ?? []).filter((m) => m.target_s != null);
  if (!ms.length || !d.clock || d.clock.followup) return null;
  const active = liveActive(d, now);
  const box = d.clock.timebox_s;
  const max = Math.max(box, ...ms.map((m) => m.target_s), ...ms.map((m) => m.reached?.active_s ?? 0));
  const stepH = Math.max(1, Math.ceil(max / 3600 / 3));
  const ticks = [];
  for (let t = 0; t < max; t += stepH * 3600) ticks.push(t);
  const x = (s) => `${Math.min(100, (s / max) * 100)}%`;
  const reached = ms.filter((m) => m.reached);
  const late = reached.filter((m) => m.reached.active_s != null && m.reached.active_s > m.target_s).length;
  const sub = reached.length === 0 ? 'none reached yet' : `${reached.length} of ${ms.length} reached${late ? ` · ${late} late` : reached.every((m) => m.reached.active_s != null) ? ' · all on time' : ''}`;
  return html`<section class="panel">
    <h2>Milestones against the plan <span class="sub">${sub}</span></h2>
    <div class="msplan">
      <div class="mp-axis"><span></span><div>${ticks.map((t) => html`<span key=${t} style=${{ left: x(t) }}>${t ? `${t / 3600}h` : '0'}</span>`)}<span style=${{ left: x(box) }}>${dur(box)} box</span></div><span></span></div>
      ${ms.map((m) => {
        const at = m.reached ? m.reached.active_s : m.current ? active : null;
        const diff = at != null ? m.target_s - at : null;
        const state = m.reached ? (diff != null && diff < 0 ? 'late' : 'ontime') : m.current ? (active > m.target_s ? 'late' : 'current') : 'upcoming';
        const text = m.reached
          ? at != null ? html`${dur(at)} of ${dur(m.target_s)} · <span class=${state}>${diff >= 0 ? `${dur(diff)} early` : `${dur(-diff)} late`}</span>` : `reached in an earlier run · target ${dur(m.target_s)}`
          : m.current ? html`${dur(at)} so far of ${dur(m.target_s)}${diff < 0 ? html` · <span class="late">${dur(-diff)} over</span>` : ''}` : `target ${dur(m.target_s)}`;
        return html`<div key=${m.id} class="mp-row" title=${`${m.id} ${m.title}`}>
          <b>${m.id}</b>
          <div class="mp-track">${at != null && html`<span class=${`mp-bar ${state}`} style=${{ width: x(at) }}></span>`}<span class="mp-target" style=${{ left: x(m.target_s) }}></span></div>
          <span class="mp-text">${text}</span>
        </div>`;
      })}
    </div>
    <div class="legend"><span><i class="ok"></i>active time until reached</span><span><i class="tick"></i>planned target</span></div>
  </section>`;
}

// ---------------------------------------------------------------- activity tab

function ActivityTab({ d }) {
  return html`<div class="split">
    <div class="main-col"><${Feed} d=${d} /></div>
    <aside class="rail wide"><${Checkpoints} d=${d} /></aside>
  </div>`;
}

/** Items grouped by cycle, newest first; `key` gives each item's cycle. */
function byCycle(items, key) {
  const groups = [];
  for (const x of items) {
    const c = key(x);
    if (groups.at(-1)?.cycle !== c) groups.push({ cycle: c, items: [] });
    groups.at(-1).items.push(x);
  }
  return groups;
}

function Feed({ d }) {
  const [filter, setFilter] = useState('all');
  const [more, setMore] = useState(false);
  const groups = {
    all: (e) => !['cycle.start', 'round'].includes(e.type) && !(e.type === 'cycle.end' && e.exit === 'ok') && !(e.type === 'wait' && e.reason === 'between_cycles'),
    milestones: (e) => ['milestone', 'done', 'artifact', 'wrapup'].includes(e.type),
    problems: (e) => ['blocked', 'warn', 'needs_you'].includes(e.type) || (e.type === 'cycle.end' && e.exit !== 'ok') || (e.type === 'wait' && e.reason !== 'between_cycles'),
    notes: (e) => e.type === 'note',
  };
  const items = d.events.filter(groups[filter]).reverse();
  const cycles = byCycle(items, (e) => e.cycle ?? null);
  const shown = more ? cycles : cycles.slice(0, 4);
  const seen = store.seenAtOpen[d.id]?.events_at;
  return html`<section class="panel">
    <h2>Events
      <span class="feed-filter right" role="group" aria-label="Filter">${Object.keys(groups).map((k) => html`<button key=${k} class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${k[0].toUpperCase() + k.slice(1)}</button>`)}</span></h2>
    ${items.length === 0
      ? html`<p class="empty">Nothing here yet.</p>`
      : shown.map((g, gi) => html`<div key=${gi} class="cgroup">
          <h3 class="micro">${g.cycle ? `Cycle ${g.cycle}` : 'Between runs'} <span class="faint">· ${ago(g.items.at(-1).ts)}</span></h3>
          <ul class="feed">${g.items.map((e, i) => {
            const t = e.type === 'cycle.end' ? 'fail' : e.type.startsWith('run.') ? 'run' : e.type;
            return html`<li key=${e.ts + i} class="t-${t}">
              <span class="ico" aria-hidden="true">${FEED_ICON[e.type] ?? '·'}</span>
              <span>${seen && e.ts > seen && e.src !== 'user' ? html`<span class="new-dot" title="new since you last looked"></span> ` : ''}${e.type === 'note' ? html`<span class="kind">note</span> ` : ''}${feedText(e)}</span>
              <span class="when" title=${new Date(e.ts).toLocaleString()}>${shortAgo(e.ts)}</span>
            </li>`;
          })}</ul>
        </div>`)}
    ${cycles.length > shown.length && html`<button class="btn small ghost dashed" onClick=${() => setMore(true)}>Show earlier cycles (${cycles.length - shown.length})</button>`}
    <p class="faint note">Every tool step of a cycle lives in the <a href=${tabHref(d.id, 'cycles')}>Cycles tab</a>: pick a cycle there.</p>
  </section>`;
}

function Checkpoints({ d }) {
  const artifacts = d.events.filter((e) => e.type === 'artifact').reverse().slice(0, 10);
  const groups = byCycle(d.commits, (c) => cycleAt(d, c.at));
  return html`<section class="panel">
    <h2>${d.goal.checkpoints === 'shadow' ? 'Snapshots' : 'Commits'} <span class="sub">${d.commits.length ? `last ${d.commits.length} · newest first` : ''}</span></h2>
    ${d.commits.length === 0 && html`<p class="empty">${d.goal.checkpoints === 'none' ? 'Checkpoints are off for this goal.' : 'None yet.'}</p>`}
    ${groups.map((g, gi) => html`<div key=${gi} class="cgroup">
      <h3 class="micro">${g.cycle ? `c${g.cycle}` : 'outside cycles'}</h3>
      <ul class="commits">${g.items.map((c) => html`<li key=${c.hash}><span class="hash">${c.hash}</span><span class="s" title=${c.subject}>${c.subject}</span><span class="faint">${shortAgo(c.at)}</span></li>`)}</ul>
    </div>`)}
    ${artifacts.length > 0 && html`<h3 class="micro">Artifacts</h3><ul class="commits">${artifacts.map((a, i) => html`<li key=${i}><span class="hash">▤</span><span class="s mono" title=${a.text ?? ''}>${a.path}</span></li>`)}</ul>`}
  </section>`;
}

// ---------------------------------------------------------------- setup tab

function SetupTab({ d }) {
  const g = d.goal;
  const [busy, act] = useAct(d);
  const ms = (d.milestones ?? []).filter((m) => m.target_s != null);
  return html`<div class="split">
    <div class="main-col">
      <section class="panel"><h2>Objective</h2><p class="prose">${d.objective}</p>
        ${g.non_goals?.length > 0 && html`<h3 class="micro">Not in scope</h3><ul class="prose">${g.non_goals.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul>`}</section>
      <section class="panel"><h2>Done when <span class="sub">${g.done.length === 1 ? 'the check passes' : `all ${g.done.length} pass`}</span></h2>
        <ul class="defs">${g.done.map((x) => html`<li key=${x.id}><b class="id">${x.id}</b><div>${x.check}<div class="faint">${VERIFY[x.verify.type]?.(x.verify) ?? x.verify.type}</div></div></li>`)}</ul></section>
      <section class="panel"><h2>Jobs in this harness ${d.job.n > 1 && html`<a class="right" href=${`/goals/${d.id}/report.html?job=all`} target="_blank" rel="noopener">Report: all jobs ↗</a>`}</h2>
        <ul class="defs">${[...d.epics].reverse().map((e, i) => html`<li key=${e.id}><span class="faint num">${d.epics.length - i}</span><div><b>${e.title}</b></div>
          <span class="faint right">${e.current ? html`<span class="done-ink">current${d.state === 'done' ? ' · done' : ''}</span>` : e.archive ? `archived in .epoptes/${e.archive}` : 'archived'}</span></li>`)}</ul>
        <p class="faint note">Next feature in this project? Ask the skill for a new job; it keeps the roles, permissions, lessons and decisions.</p></section>
    </div>
    <aside class="rail wide">
      <section class="panel"><h2>Run settings</h2>
        <dl class="kv">
          <dt>path</dt><dd class="mono">${d.path}</dd>
          <dt>model</dt><dd>${[g.adapter.type, g.adapter.model, g.adapter.effort && `${g.adapter.effort} effort`, g.adapter.permission_mode].filter(Boolean).join(' · ')}</dd>
          <dt>time box</dt><dd>${dur(g.timebox.total_min * 60)} · wrap-up ${dur(g.timebox.wrapup_min * 60)} · grace ${dur(g.timebox.grace_min * 60)}</dd>
          <dt>cycle</dt><dd>times out at ${g.cycle.timeout_min}m · ${g.cycle.max_budget_usd ? `budget $${g.cycle.max_budget_usd}` : 'no budget cap'}</dd>
          ${ms.length > 0 && html`<dt>milestones</dt><dd>${ms.map((m) => `${m.id} ${dur(m.target_s)}`).join(' · ')}</dd>`}
          <dt>checkpoints</dt><dd>${g.checkpoints}</dd>
          <dt>harness</dt><dd class="mono">.epoptes/goal.json<br />.epoptes/loop.md<br />.epoptes/state/</dd>
        </dl>
      </section>
      ${d.clock && !d.live && html`<section class="panel danger-zone"><h2>Reset the clock</h2>
        <p class="prose">The next start begins a new run with the time box from goal.json. Nothing on disk changes.</p>
        <button class="btn danger" disabled=${busy} onClick=${() => act('reset', {}, RESET_TEXT)}>Reset clock…</button></section>`}
    </aside>
  </div>`;
}

// ---------------------------------------------------------------- goal detail

function GoalDetail({ id, tab }) {
  const s = useStore();
  useEffect(() => {
    set({ detailId: id, detail: null, selectedCycle: null, cycleView: null, cardSel: null, jobScope: 'job' });
    loadDetail(id);
    return () => set({ detailId: null, detail: null });
  }, [id]);
  useEffect(() => scrollTo(0, 0), [tab]);
  const d = s.detail;
  if (!d || d.id !== id) return html`<a class="back" href="#/">‹ All goals</a><p class="empty">Loading…</p>`;
  if (d.error) {
    return html`<a class="back" href="#/">‹ All goals</a>
      <div class="panel empty-state">
        <h2>${d.missing ? 'Goal not found' : `Can't read ${d.id}`}</h2>
        <p>${d.missing ? html`No registered goal is called <b>${d.id}</b>. It may have been removed from the registry.` : d.error}</p>
        ${!d.missing && html`<p class="muted">Fix the file, then check it with <span class="mono">epoptes run ${d.id} --dry-run</span>. This page updates by itself.</p>`}
      </div>`;
  }
  const Tab = { board: Board, cycles: CyclesTab, time: TimeTab, activity: ActivityTab, setup: SetupTab }[tab] ?? Overview;
  return html`<${GoalHead} d=${d} tab=${Tab === Overview ? '' : tab} />
    <div class="tab-body"><${Tab} d=${d} /></div>`;
}


// ---------------------------------------------------------------- favicon

// The tab icon says what's happening, so a background tab is enough to keep an eye on things:
// needs-you (amber flag, blinking) > failed (red) > running (spinning arcs) > rate-limited (amber, slow pulse)
// > between cycles (green pulse) > done (purple check) > idle (the plain mark).
const FAV_ORDER = ['needs', 'failed', 'running', 'limited', 'waiting', 'done', 'idle'];
const FAV_COLOR = { needs: '#E8A23A', failed: '#D9503C', running: '#2EA36B', limited: '#D9A030', waiting: '#2EA36B', done: '#8C6BDB', idle: '#E8A23A' };
const ANIMATED = new Set(['needs', 'running', 'limited', 'waiting']);

function favKind(g) {
  if (!g || g.error) return 'idle';
  if (g.needs || g.pending_approvals?.length) return 'needs';
  if (g.state === 'failed' || g.state === 'crashed') return 'failed';
  if (g.state === 'running' || g.state === 'pausing') return 'running';
  if (g.state === 'rate_limited' || g.state === 'cooldown') return 'limited';
  if (g.state === 'waiting') return 'waiting';
  if (g.state === 'done') return 'done';
  return 'idle';
}

const favicon = {
  kind: null,
  timer: null,
  frame: 0,
  canvas: null,
  link: null,
  set(kind) {
    if (kind === this.kind) return;
    this.kind = kind;
    clearInterval(this.timer);
    this.timer = null;
    this.frame = 0;
    this.draw();
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (ANIMATED.has(kind) && !still) this.timer = setInterval(() => (this.frame++, this.draw()), 110);
  },
  draw() {
    this.canvas ??= Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    this.link ??= document.querySelector('link[rel=icon]');
    const c = this.canvas.getContext('2d');
    const k = this.kind;
    const f = this.frame;
    const col = FAV_COLOR[k];
    c.clearRect(0, 0, 64, 64);
    c.lineCap = 'round';
    // Three outer arcs, like the mark; they turn while a cycle runs.
    const spin = k === 'running' ? f * 0.35 : 0;
    c.strokeStyle = k === 'idle' || k === 'done' ? '#7d828b' : col;
    c.lineWidth = 9;
    for (let i = 0; i < 3; i++) {
      const a = spin + (i * 2 * Math.PI) / 3 - Math.PI / 2;
      c.beginPath();
      c.arc(32, 32, 26, a + 0.3, a + 2 * Math.PI / 3 - 0.3);
      c.stroke();
    }
    // The eye: a pupil that pulses between cycles and while rate-limited.
    const pulse = k === 'waiting' || k === 'limited' ? (Math.sin(f / (k === 'limited' ? 6 : 3)) + 1) / 2 : 0;
    c.fillStyle = k === 'idle' ? '#7d828b' : col;
    c.globalAlpha = 1 - pulse * 0.55;
    c.beginPath();
    c.arc(32, 32, 14 + pulse * 4, 0, 2 * Math.PI);
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(32, 32, 4.5, 0, 2 * Math.PI);
    c.fill();
    if (k === 'done') {
      c.strokeStyle = col;
      c.lineWidth = 7;
      c.beginPath();
      c.moveTo(36, 50); c.lineTo(45, 58); c.lineTo(61, 38);
      c.stroke();
    }
    // A badge in the corner when the human is needed (blinking) or a run failed.
    if (k === 'needs' || k === 'failed') {
      const on = k === 'failed' || Math.floor(f / 5) % 2 === 0;
      if (on) {
        c.fillStyle = col;
        c.beginPath();
        c.arc(48, 16, 16, 0, 2 * Math.PI);
        c.fill();
        c.fillStyle = '#ffffff';
        c.font = 'bold 26px system-ui, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('!', 48, 17);
      }
    }
    if (this.link) this.link.href = this.canvas.toDataURL('image/png');
  },
};

// ---------------------------------------------------------------- brain

function Brain() {
  const [b, setB] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = (gather) => {
    setBusy(true);
    (gather ? api.post('/api/brain') : api.get('/api/brain'))
      .then(setB)
      .catch((e) => toast({ kind: 'bad', title: 'Could not read the brain', body: e.message }))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(false), []);
  useEffect(() => {
    document.title = 'Brain · Epoptes';
  });
  const money = (x) => (x == null ? '–' : `≈ $${x.toFixed(2)}`);
  return html`<a class="back" href="#/">← All goals</a>
    <div class="list-head"><h1>Brain</h1><span class="muted">what past harnesses taught, for designing the next one</span>
      <span class="list-actions"><button class="btn small" disabled=${busy} onClick=${() => load(true)} title="Gather every goal's numbers and lessons again (no tokens)">↻ Gather now</button></span></div>
    ${!b
      ? html`<p class="empty">Loading…</p>`
      : html`<div class="grid brain">
      <div class="stack">
        ${b.notes && html`<section class="panel"><h2>Curated notes <span class="right muted mono">NOTES.md</span></h2><pre class="handoff"><${Rich} text=${b.notes} /></pre></section>`}
        <section class="panel"><h2>Harness lessons <span class="right muted">${b.lessons.reduce((a, t) => a + t.lessons.length, 0)} from ${b.goals.length} goals</span></h2>
          ${b.lessons.length === 0
            ? html`<p class="empty">No lessons yet. Orchestrators record them in wrap-up (<span class="mono">epoptes lesson "…" --topic roles</span>); they arrive here when a run ends.</p>`
            : b.lessons.map((t) => html`<div key=${t.topic} class="lesson-topic"><h3>${t.topic}</h3><ul class="lessons">${t.lessons.map((l, i) => html`<li key=${i}>${l.text}<span class="faint"> · ${l.goals.join(', ')}${l.goals.length > 1 ? ` (${l.goals.length} goals)` : ''}</span></li>`)}</ul></div>`)}
        </section>
        <section class="panel"><h2>Signals by goal</h2>
          ${b.goals.filter((g) => g.signals.length).length === 0
            ? html`<p class="empty">No signals yet.</p>`
            : html`<ul class="lessons">${b.goals.filter((g) => g.signals.length).map((g) => g.signals.map((s, i) => html`<li key=${g.id + i}><a href=${`#/g/${g.id}`}>${g.name}</a>: ${s}</li>`))}</ul>`}
        </section>
      </div>
      <div class="stack">
        <section class="panel"><h2>By goal kind</h2>
          <div class="table-wrap" style=${{ marginTop: 0 }}><table><thead><tr><th>kind</th><th class="r" title="done / all">goals</th><th class="r">cycles</th><th class="r">median cycle</th><th class="r">cycle cost</th><th class="r">timeouts</th></tr></thead><tbody>
            ${b.kinds.map((k) => html`<tr key=${k.kind}><td>${k.kind}</td><td class="r num">${k.done}/${k.goals}</td><td class="r num">${k.cycles}</td><td class="r num">${dur(k.median_cycle_s)}</td><td class="r num">${money(k.median_cycle_cost_usd)}</td><td class="r num">${pct(k.timeout_share)}</td></tr>`)}
          </tbody></table></div>
          <p class="faint" style=${{ fontSize: '12px', marginBottom: 0 }}>Median cycle cost is an API-equivalent estimate unless runs were billed.</p>
        </section>
        <section class="panel"><h2>Work lessons <span class="right muted">from each goal's state/lessons.md</span></h2>
          ${b.goals.filter((g) => g.work_lessons.length).map((g) => html`<details key=${g.id}><summary>${g.name} <span class="faint">${g.work_lessons.length}</span></summary><ul class="lessons">${g.work_lessons.map((l, i) => html`<li key=${i}>${l}</li>`)}</ul></details>`)}
        </section>
        <p class="faint" style=${{ fontSize: '12px' }}>Stored in <span class="mono">${b.dir}</span> on this machine only. The epoptes skill reads INDEX.md when it designs a harness; ask it to "distill the brain" to write NOTES.md.</p>
      </div>
    </div>`}`;
}

// ---------------------------------------------------------------- app

function useRoute() {
  const parse = () => {
    if (location.hash.startsWith('#/brain')) return { id: 'brain' };
    const m = /^#\/g\/([a-z0-9-]+)(?:\/([a-z]+))?/.exec(location.hash);
    return m ? { id: m[1], tab: m[2] ?? '' } : { id: null };
  };
  const [route, setRoute] = useState(parse());
  useEffect(() => {
    const f = () => setRoute(parse());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return route;
}

function Toasts() {
  const s = useStore();
  return html`<div class="toasts" aria-live="polite">${s.toasts.map((t) => html`<div key=${t.id} class="toast ${t.kind}" onClick=${() => set({ toasts: s.toasts.filter((x) => x.id !== t.id) })}><b>${t.title}</b>${t.body && html`<span>${t.body}</span>`}</div>`)}</div>`;
}

function App() {
  const s = useStore();
  const { id, tab } = useRoute();
  useEffect(() => {
    const goals = s.state?.goals ?? [];
    // On a goal's page the icon follows that goal; on the list, the most urgent goal.
    const kinds = id && id !== 'brain' ? [favKind(goals.find((g) => g.id === id))] : goals.map(favKind);
    favicon.set(kinds.sort((a, b) => FAV_ORDER.indexOf(a) - FAV_ORDER.indexOf(b))[0] ?? 'idle');
    const waiting = goals.filter((g) => g.needs || g.pending_approvals?.length).length;
    if (id !== 'brain') document.title = `${waiting ? `⚑ ${waiting} · ` : ''}${s.detail?.name ? `${s.detail.name} · Epoptes` : 'Epoptes'}`;
  }, [s.detail?.name, s.state, id]);
  return html`<${Topbar} id=${id} />
    ${s.offline && html`<div class="offline pill bad">Dashboard server unreachable. Runs keep going; reconnecting…</div>`}
    <main>${id === 'brain' ? html`<${Brain} />` : id ? html`<${GoalDetail} id=${id} tab=${tab} />` : html`<${GoalList} />`}</main>
    <${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
loadState(); // don't wait for the stream's first message
connect();
