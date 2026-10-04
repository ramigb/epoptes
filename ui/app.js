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
};
const listeners = new Set();
function set(patch) {
  Object.assign(store, patch);
  for (const f of listeners) f();
}
function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    listeners.add(f);
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
const STATUS_LABEL = { new: 'new', seen: 'seen', in_progress: 'in progress', done: 'done', blocked: 'blocked', wont_do: "won't do" };
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
    .get(`/api/goals/${id}`)
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
  for (const f of u.feedback) {
    if (f.op === 'add' && f.src === 'orchestrator' && f.kind !== 'approval') toast({ kind: 'info', title: `${name}: agent note ${f.id} for the next cycle`, body: f.text, ms: 10000 });
    if (f.op === 'status' && f.by === 'orchestrator') toast({ kind: 'info', title: `${f.id} → ${STATUS_LABEL[f.status]}`, body: f.note || name });
    if (f.op === 'note' && f.by === 'orchestrator') toast({ kind: 'info', title: `${f.id}: note from the orchestrator`, body: f.text });
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

function ClockBar({ g, big }) {
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
  return html`<div class="clockbar ${big ? 'big' : ''} ${marks.length ? 'has-ms' : ''}">
    <div class="track-wrap">
      <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax=${c.timebox_s} aria-valuenow=${Math.round(active)} aria-label="Active time">
        <div class="zone-wrap" style=${{ left: `${wrapStart}%`, width: `${(c.wrapup_s / total) * 100}%` }}></div>
        <div class="fill ${cls}" style=${{ width: `${w}%` }}></div>
      </div>
      ${marks.map((m) => html`<span key=${m.id} class="ms-tick ${m.state}" style=${{ left: `${m.pos}%` }} title=${m.tip}></span>`)}
      ${marks.filter((m) => m.reachedPos != null).map((m) => html`<span key=${`r${m.id}`} class="ms-hit ${m.state}" style=${{ left: `${m.reachedPos}%` }} title=${m.tip}></span>`)}
    </div>
    ${big && marks.length > 0 && html`<div class="ms-labels" aria-hidden="true">${marks.map((m) => html`<span key=${m.id} class="${m.state} ${m.current ? 'current' : ''}" style=${{ left: `${m.pos}%` }}>${m.id}${m.state === 'overdue' ? ' overdue' : m.state === 'late' ? ' (late)' : ''}</span>`)}</div>`}
    <div class="labels">
      <span class="num">${dur(active)} active${c.paused ? ' · clock paused' : ''}</span>
      <span class="num">${c.to_end > 0 ? `${dur(c.timebox_s - active)} left of ${dur(c.timebox_s)}` : `over by ${dur(active - c.timebox_s)}`}</span>
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

function Topbar() {
  const s = useStore();
  const limits = s.state?.limits;
  const limited = s.state?.goals.some((g) => g.state === 'rate_limited');
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const windows = limits ? Object.entries(limits.windows) : [];
  const hot = windows.some(([, w]) => w.utilization >= 0.8) || (limits && !['allowed', 'allowed_warning'].includes(limits.status));
  return html`<header class="topbar">
    <a class="brand" href="#/" aria-label="Epoptes: all goals"><${Logo} />epoptes</a>
    ${s.state?.lan && html`<span class="pill bad" title="Anyone on your network can control runs">LAN mode</span>`}
    <span class="spacer"></span>
    ${limited && html`<span class="pill warn">rate-limited</span>`}
    ${windows.length > 0 &&
    html`<span class="pill ${hot ? 'warn' : ''} hide-sm" title=${`Account usage, as of ${ago(limits.at)}. Shared by every goal.`}>
      ${windows.map(([k, w]) => html`<span key=${k}>${k.replace('_', ' ').replace('five hour', '5h').replace('seven day', '7d')} ${pct(w.utilization)}</span>`)}
    </span>`}
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
    .post(`/api/goals/${goalId}/feedback/${id}`, { decision, note: note || undefined })
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

/** The panel at the top of a goal when it needs the human: what it waits for, approvals, and a reply box. */
function NeedsYou({ d }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = d.feedback.filter((f) => f.kind === 'approval' && !f.decision && !['done', 'wont_do'].includes(f.status));
  if (!d.needs && !pending.length) return null;
  const reply = (e) => {
    e?.preventDefault();
    setBusy(true);
    const p = text.trim() ? api.post(`/api/goals/${d.id}/feedback`, { text: text.trim(), resume: true }) : api.post(`/api/goals/${d.id}/control`, { action: 'start' }).then(() => ({ resumed: true }));
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
  return html`<section class="panel needs-you" aria-live="polite">
    <h2><span class="flagmark" aria-hidden="true">⚑</span> ${d.needs ? 'Waiting for you' : 'Approval needed'}
      <span class="right muted">${d.needs ? `paused ${ago(d.needs.since)} · the clock is stopped` : 'the run keeps working on other tasks meanwhile'}</span></h2>
    ${d.needs && html`<p class="needs-reason">${d.needs.reason}</p>`}
    ${pending.length > 0 &&
    html`<ul class="approvals">${pending.map((f) => html`<li key=${f.id}>
      <div class="approval-text"><span class="id">${f.id}</span> ${f.text}${f.ref ? html` <span class="chip">${f.ref}</span>` : ''}</div>
      <${ApprovalButtons} goalId=${d.id} f=${f} />
    </li>`)}</ul>`}
    ${d.needs &&
    html`<form class="fb-form needs-reply" onSubmit=${reply}>
      <textarea rows="2" value=${text} disabled=${busy} placeholder=${pending.length ? 'Anything else to tell it? (optional)' : 'Your answer or opinion. It becomes a feedback item the next cycle reads first.'}
        aria-label="Reply" onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && reply(e)}></textarea>
      <div class="row"><span class="faint">${pending.length ? 'Answering the last approval resumes the run by itself.' : 'Ctrl+Enter to send'}</span>
        <button class="btn primary small" disabled=${busy}>${text.trim() ? 'Send & resume' : 'Resume'}</button></div>
    </form>`}
  </section>`;
}

// ---------------------------------------------------------------- goal list

function GoalCard({ g }) {
  const now = useNow();
  if (g.error) {
    return html`<div class="panel card error"><div class="top"><span class="name">${g.id}</span><span class="state failed">invalid</span></div><div class="objective">${g.error}</div><div class="facts mono">${g.path}</div></div>`;
  }
  const unread = g.unread.feedback + g.unread.events;
  const b = g.backlog;
  const total = b ? b.todo + b.doing + b.done + b.blocked : 0;
  const flash = Date.now() - (flashed.get(g.id) ?? 0) < 4000;
  return html`<a class=${`panel card ${flash ? 'flash' : ''}`} href=${`#/g/${g.id}`}>
    <div class="top">
      <span class="name">${g.name}</span>
      ${unread > 0 && html`<span class="badge" title=${`${g.unread.events} new events, ${g.unread.feedback} feedback updates`}>${unread}</span>`}
      <${StatePill} state=${g.state} />
    </div>
    <div class="objective">${g.objective}</div>
    <${NeedsYouLine} g=${g} />
    <${ClockBar} g=${g} />
    <div class="facts">
      ${g.mode && html`<span class="chip ${g.mode}">${g.mode}</span>`}
      <span>cycle <b class="num">${g.cycle || '–'}</b>${g.round ? html` · round <b>${g.round}</b>` : ''}</span>
      ${b && html`<span>backlog <b class="num">${b.done}/${total}</b></span>`}
      ${g.cycles > 0 && html`<span><${Money} usd=${g.cost_usd} basis=${g.cost_basis} /></span>`}
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

// ---------------------------------------------------------------- goal detail

function Controls({ d }) {
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
  const live = d.live;
  const finished = d.run_finished;
  const newRunText = d.done_marker
    ? 'This goal is done. Start a new run?\n\nA new run gets a fresh time box and spends tokens. The orchestrator only finds work if you added feedback or backlog tasks since.'
    : 'The time box is over. Start a new run with a fresh time box?\n\nTo continue this run instead, cancel and use +30m / +1h / +2h.';
  const start = () => (finished ? act('start', { new_run: true }, newRunText) : act('start'));
  const fu = d.followup_items;
  return html`<div class="controls">
    ${!live && finished && fu > 0 && html`<button class="btn primary" disabled=${busy} onClick=${() => act('start', { follow_up: true })}
      title="Handle just the open feedback, with no time box. Minor items are fixed in place; anything that needs a restart or a new version is flagged for a new run instead.">▶ Follow up on ${fu} feedback item${fu > 1 ? 's' : ''}</button>`}
    ${!live && html`<button class=${`btn ${finished ? '' : 'primary'}`} disabled=${busy} onClick=${start} title=${d.needs ? 'Resume without answering' : ''}>▶ ${finished ? 'Start new run…' : d.clock ? 'Resume' : 'Start'}</button>`}
    ${live && html`<button class="btn" disabled=${busy || d.pause_requested} onClick=${() => act('pause')} title="Finish the current cycle, then pause (the clock pauses too)">‖ ${d.pause_requested ? 'Pausing after cycle' : 'Pause after cycle'}</button>`}
    ${live && html`<button class="btn danger" disabled=${busy} onClick=${() => act('stop', {}, 'Stop now? The current cycle is interrupted; the next start recovers its work.')}>■ Stop now</button>`}
    ${d.clock &&
    html`<span class="btn-group" role="group" aria-label="Extend the time box">
      ${[['+30m', 1800], ['+1h', 3600], ['+2h', 7200]].map(([l, s]) => html`<button key=${l} class="btn small" disabled=${busy} onClick=${() => act('extend', { seconds: s })} title="Extend the time box">${l}</button>`)}
    </span>`}
    ${!live && d.clock && html`<button class="btn small" disabled=${busy} onClick=${() => act('reset', {}, 'Reset the clock? The next start begins a new run with the time box from goal.json.')}>Reset clock</button>`}
    <a class="btn small" href=${`/goals/${d.id}/report.html`} target="_blank" rel="noopener">Report</a>
    <${OutputLink} o=${d.output} />
  </div>`;
}

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

function Banners({ d }) {
  const now = useNow();
  const out = [];
  if (d.pause_requested) out.push(html`<div class="banner">Pause requested: the run pauses when this cycle finishes.</div>`);
  if (d.waiting_until && d.wait_reason !== 'between_cycles') {
    const left = (Date.parse(d.waiting_until) - now) / 1000;
    out.push(html`<div class="banner warn">${d.wait_reason === 'rate_limit' ? 'Rate-limited' : 'Cooling down after failed cycles'}: next cycle in ${dur(Math.max(0, left))}.</div>`);
  }
  const lastCycle = d.cycles_detail.at(-1);
  if (lastCycle && ['error', 'timeout'].includes(lastCycle.exit) && !d.live) {
    out.push(html`<div class="banner bad">Cycle ${lastCycle.cycle} ended with <b>${lastCycle.exit}</b>${lastCycle.error ? html`: <span class="mono">${lastCycle.error}</span>` : ''}. <a href="#" onClick=${(e) => { e.preventDefault(); set({ selectedCycle: lastCycle.cycle, cycleView: null }); api.get(`/api/goals/${d.id}/cycles/${lastCycle.cycle}`).then((cycleView) => set({ cycleView })); }}>See its activity</a>.</div>`);
  }
  if (d.state === 'done') {
    const last = d.events.findLast((e) => e.type === 'done');
    out.push(html`<div class="banner done-banner"><span>✓ <b>Done</b>${last?.text ? `: ${last.text}` : ''}</span>${d.output ? html`<${OutputLink} o=${d.output} big=${true} />` : ''}</div>`);
  }
  if (d.state === 'crashed') out.push(html`<div class="banner bad">The runner stopped without cleaning up (crashed). The clock was paused at its last heartbeat. Resume to continue.</div>`);
  if (d.state === 'failed') out.push(html`<div class="banner bad">Too many failed cycles in a row. Check the last cycle's error below, then resume.</div>`);
  return out.length ? html`<div class="stack">${out}</div>` : null;
}

function Stats({ d }) {
  const all = d.cycles_detail;
  let read = 0;
  let totalIn = 0;
  for (const r of all) for (const u of Object.values(r.models)) {
    read += u.cache_read;
    totalIn += u.input + u.cache_read + u.cache_write;
  }
  const b = d.backlog;
  const bt = b ? b.todo + b.doing + b.done + b.blocked : 0;
  return html`<div class="stats">
    <div class="panel stat"><div class="k">Cycles</div><div class="v num">${all.length}${d.round ? html` <small>round ${d.round} now</small>` : ''}</div></div>
    <div class="panel stat"><div class="k">Cost</div><div class="v"><${Money} usd=${all.length ? d.cost_usd : null} basis=${d.cost_basis} /></div></div>
    <div class="panel stat"><div class="k">Cache-read share</div><div class="v num">${totalIn ? pct(read / totalIn) : '–'}</div></div>
    <div class="panel stat"><div class="k">Median cycle</div><div class="v"><${Money} usd=${d.cost_median || null} basis=${d.cost_basis} /></div></div>
    <div class="panel stat"><div class="k">Backlog</div><div class="v num">${b ? html`${b.done}<small>/${bt} done</small>` : '–'}</div></div>
  </div>`;
}

function Ticker({ d }) {
  const s = useStore();
  const items = d.activity;
  const open = new Map();
  for (const a of items) {
    if (a.kind === 'agent.start') open.set(a.agent, a);
    if (a.kind === 'agent.end') open.delete(a.agent);
  }
  const lastBy = new Map();
  for (const a of items) lastBy.set(a.agent, a);
  const running = d.state === 'running' || d.state === 'pausing';
  const shown = items.slice(-60).reverse();
  return html`<section class="panel">
    <h2>${running ? 'Now' : 'Last cycle'} <span class="right muted">cycle ${d.activity_cycle || '–'} · ${items.length} steps</span></h2>
    ${running &&
    html`<div class="agents">
      <${Agent} name="orchestrator" working=${true} />
      ${[...open.keys()].map((a) => html`<span key=${a} title=${lastBy.get(a)?.summary}><${Agent} name=${a} working=${true} /></span>`)}
    </div>`}
    ${shown.length === 0
      ? html`<p class="empty">${running ? 'Waiting for the first step…' : 'No activity yet.'}</p>`
      : html`<ul class="ticker" aria-live="polite">
          ${shown.map((a, i) => html`<li key=${a.ts + a.summary + i} class="kind-${a.kind} ${s.freshActivity.has(a.ts + a.summary) ? 'fresh' : ''}">
            <time>${clockTime(a.ts)}</time>
            <${Agent} name=${a.agent} />
            <span class="what" title=${a.summary}>${a.tool && html`<span class="tool">${a.tool}</span>`}${a.kind === 'agent.start' ? '▶ ' : a.kind === 'agent.end' ? '■ ' : ''}${a.summary}</span>
          </li>`)}
        </ul>`}
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

function Timeline({ d }) {
  const s = useStore();
  const now = useNow();
  const known = useRef(null);
  const results = d.cycles_detail;
  const maxCost = Math.max(0.0001, ...results.map((r) => r.cost_usd ?? 0));
  const waits = new Map();
  for (const e of d.events) if (e.type === 'wait' && e.reason !== 'between_cycles' && e.cycle) waits.set(e.cycle, [...(waits.get(e.cycle) ?? []), e]);
  const segs = [];
  let lastRun = null;
  for (const r of results) {
    segs.push({ key: `c${r.cycle}`, kind: 'cycle', r, runLabel: r.run !== lastRun ? r.run : null });
    lastRun = r.run;
    for (const w of waits.get(r.cycle) ?? []) segs.push({ key: `w${w.ts}`, kind: 'wait', w });
  }
  const running = d.cycle_started_at && !results.some((r) => r.cycle === d.cycle);
  if (running) segs.push({ key: `c${d.cycle}`, kind: 'running', elapsed: (now - Date.parse(d.cycle_started_at)) / 1000, runLabel: d.run !== lastRun ? d.run : null });

  // Only segments that weren't there on the previous render animate in.
  const prev = known.current;
  const keys = new Set(segs.map((x) => x.key));
  useEffect(() => {
    known.current = keys;
  });

  const select = (n) => {
    if (s.selectedCycle === n) return set({ selectedCycle: null, cycleView: null });
    set({ selectedCycle: n, cycleView: null });
    api.get(`/api/goals/${d.id}/cycles/${n}`).then((cycleView) => set({ cycleView })).catch(() => {});
  };

  return html`<div>
    <div class="timeline" role="list" aria-label="Cycles">
      ${segs.length === 0 && html`<p class="empty">No cycles yet.</p>`}
      ${segs.map((x) => {
        const enter = prev && !prev.has(x.key) ? 'enter' : '';
        if (x.kind === 'wait') {
          return html`<div key=${x.key} role="listitem" class="seg wait ${enter}" style=${{ flexGrow: Math.max(30, x.w.seconds), height: '30%' }} title=${`${x.w.reason === 'rate_limit' ? 'Rate-limit wait' : 'Cooldown'}: ${dur(x.w.seconds)}`}></div>`;
        }
        if (x.kind === 'running') {
          return html`<div key=${x.key} role="listitem" class="seg running ${enter}" style=${{ flexGrow: Math.max(30, x.elapsed), height: '55%' }} title=${`Cycle ${d.cycle}: running for ${dur(x.elapsed)}`} onClick=${() => select(d.cycle)}>
            ${x.runLabel && html`<span class="run-label">${x.runLabel}</span>`}
          </div>`;
        }
        const r = x.r;
        const models = Object.entries(r.models).map(([m, u]) => `${shortModel(m)}: in ${tokens(u.input)} · out ${tokens(u.output)} · cache read ${tokens(u.cache_read)} · write ${tokens(u.cache_write)}`).join('\n');
        const share = cacheShare(r);
        const tip = `Cycle ${r.cycle} (${r.run}) · ${r.exit}\n${dur(r.duration_s)} · ${r.turns ?? '?'} turns · ${r.cost_usd != null ? `${r.cost_basis === 'estimate' ? '≈ ' : ''}$${r.cost_usd.toFixed(2)}` : '–'}${share != null ? ` · cache read ${pct(share)}` : ''}${r.flagged ? '\n⚠ costs more than twice the median cycle' : ''}\n${models}`;
        return html`<div key=${x.key} role="listitem" class="seg ${r.exit} ${enter} ${s.selectedCycle === r.cycle ? 'selected' : ''}" title=${tip} onClick=${() => select(r.cycle)}
          style=${{ flexGrow: Math.max(30, r.duration_s), height: `${24 + 76 * ((r.cost_usd ?? 0) / maxCost)}%` }}>
          ${x.runLabel && html`<span class="run-label">${x.runLabel}</span>`}
          ${r.flagged && html`<span class="flag" aria-label="expensive">⚠</span>`}
        </div>`;
      })}
    </div>
    <div class="legend">
      <span>width = duration · height = cost${results.some((r) => r.cost_usd == null) ? ' (unknown costs use minimum height)' : ''}</span>
      <span><i style=${{ background: 'var(--ok)' }}></i>ok</span>
      <span><i style=${{ background: 'var(--bad)' }}></i>error / timeout</span>
      <span><i style=${{ background: 'var(--idle)' }}></i>interrupted</span>
      <span><i style=${{ background: 'var(--warn)' }}></i>rate-limited / wait</span>
      <span>⚠ over 2× median cost</span>
    </div>
  </div>`;
}

function CycleTable({ d }) {
  const s = useStore();
  const rows = [...d.cycles_detail].reverse();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 12);
  const select = (n) => {
    if (s.selectedCycle === n) return set({ selectedCycle: null, cycleView: null });
    set({ selectedCycle: n, cycleView: null });
    api.get(`/api/goals/${d.id}/cycles/${n}`).then((cycleView) => set({ cycleView })).catch(() => {});
  };
  if (!rows.length) return null;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>run</th><th>exit</th><th class="r">time</th><th class="r">turns</th><th>tokens by model</th><th class="r">cache read</th><th class="r">cost</th></tr></thead>
    <tbody>
      ${shown.map((r) => {
        const share = cacheShare(r);
        return html`<tr key=${r.cycle} class="clickable ${r.flagged ? 'flagged' : ''} ${s.selectedCycle === r.cycle ? 'selected' : ''}" onClick=${() => select(r.cycle)}>
          <td class="num">${r.cycle}${r.flagged ? html` <span title="costs more than twice the median cycle">⚠</span>` : ''}</td>
          <td class="muted">${r.run}</td>
          <td><span class="exit ${r.exit}">${r.exit.replace('_', ' ')}</span></td>
          <td class="r num">${dur(r.duration_s)}</td>
          <td class="r num">${r.turns ?? '–'}</td>
          <td><div class="models mono">${Object.entries(r.models).map(([m, u]) => html`<span key=${m} title=${`input ${u.input} · output ${u.output} · cache read ${u.cache_read} · cache write ${u.cache_write}`}>${shortModel(m)} · out ${tokens(u.output)} · cache ${tokens(u.cache_read)} · ${u.cost_usd != null ? `${r.cost_basis === 'estimate' ? '≈' : ''}$${u.cost_usd.toFixed(2)}` : ''}</span>`)}</div></td>
          <td class="r num">${share != null ? pct(share) : '–'}</td>
          <td class="r"><${Money} usd=${r.cost_usd} basis=${r.cost_basis} /></td>
        </tr>`;
      })}
    </tbody>
  </table>
  ${rows.length > 12 && html`<button class="btn small" style=${{ marginTop: '8px' }} onClick=${() => setAll(!all)}>${all ? 'Show recent' : `Show all ${rows.length}`}</button>`}
  </div>`;
}

function CycleDetail({ d }) {
  const s = useStore();
  if (!s.selectedCycle) return null;
  const v = s.cycleView;
  const r = v?.result;
  return html`<section class="panel">
    <h2>Cycle ${s.selectedCycle} <span class="right"><button class="btn small" onClick=${() => set({ selectedCycle: null, cycleView: null })}>Close</button></span></h2>
    ${!v
      ? html`<p class="empty">Loading…</p>`
      : html`${r &&
        html`<dl class="kv" style=${{ marginBottom: '12px' }}>
          <dt>exit</dt><dd><span class="exit ${r.exit}">${r.exit}</span>${r.error ? html` · <span class="muted">${r.error}</span>` : ''}</dd>
          <dt>time</dt><dd class="num">${dur(r.duration_s)} · ${clockTime(r.started_at)} → ${clockTime(r.ended_at)}</dd>
          <dt>cost</dt><dd><${Money} usd=${r.cost_usd} basis=${r.cost_basis} /> · ${r.turns ?? '?'} turns</dd>
          ${r.session_id && html`<dt>session</dt><dd class="mono">${r.session_id}</dd>`}
        </dl>`}
        <ul class="ticker">
          ${[...v.activity].reverse().map((a, i) => html`<li key=${i} class="kind-${a.kind}"><time>${clockTime(a.ts)}</time><${Agent} name=${a.agent} /><span class="what" title=${a.summary}>${a.tool && html`<span class="tool">${a.tool}</span>`}${a.summary}</span></li>`)}
        </ul>
        ${v.activity_total > v.activity.length && html`<p class="faint">Showing the last ${v.activity.length} of ${v.activity_total} steps.</p>`}`}
  </section>`;
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
    api.get(`/api/goals/${d.id}/time`).then((x) => live && setT(x)).catch(() => {});
    return () => (live = false);
  }, [d.id, d.cycles, d.state]);
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
    <h2>Where the time went <span class="right muted">${t.cycles} cycle${t.cycles === 1 ? '' : 's'} · all runs</span></h2>
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
function Feed({ d }) {
  const [filter, setFilter] = useState('all');
  const groups = {
    all: (e) => !['cycle.start', 'round'].includes(e.type) && !(e.type === 'cycle.end' && e.exit === 'ok') && !(e.type === 'wait' && e.reason === 'between_cycles'),
    milestones: (e) => ['milestone', 'done', 'artifact', 'wrapup'].includes(e.type),
    problems: (e) => ['blocked', 'warn', 'needs_you'].includes(e.type) || (e.type === 'cycle.end' && e.exit !== 'ok') || (e.type === 'wait' && e.reason !== 'between_cycles'),
    notes: (e) => e.type === 'note',
  };
  const items = d.events.filter(groups[filter]).reverse().slice(0, 120);
  const seen = store.seenAtOpen[d.id]?.events_at;
  return html`<section class="panel">
    <h2>Activity feed</h2>
    <div class="feed-filter" role="group" aria-label="Filter">
      ${Object.keys(groups).map((k) => html`<button key=${k} class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${k}</button>`)}
    </div>
    ${items.length === 0
      ? html`<p class="empty">Nothing here yet.</p>`
      : html`<ul class="feed">${items.map((e, i) => {
          const t = e.type === 'cycle.end' ? 'fail' : e.type.startsWith('run.') ? 'run' : e.type;
          return html`<li key=${e.ts + i} class="t-${t}">
            <span class="ico" aria-hidden="true">${FEED_ICON[e.type] ?? '·'}</span>
            <span>${seen && e.ts > seen && e.src !== 'user' ? html`<span class="new-dot" title="new since you last looked"></span> ` : ''}${feedText(e)}</span>
            <span class="when" title=${new Date(e.ts).toLocaleString()}>${e.cycle ? `c${e.cycle} · ` : ''}${ago(e.ts)}</span>
          </li>`;
        })}</ul>`}
  </section>`;
}

const SRC_LABEL = { file: 'from FEEDBACK.md', orchestrator: 'from the orchestrator', dashboard: 'from the dashboard', cli: 'from the CLI' };
const histVerb = (o) => (o.op === 'status' ? ` → ${STATUS_LABEL[o.status]}` : o.op === 'decide' ? (o.decision === 'approved' ? ' approved' : ' disapproved') : ' noted');

function FeedbackItem({ d, f, seen }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(f.text);
  const agentNote = f.kind !== 'approval' && f.src === 'orchestrator';
  const closed = ['done', 'wont_do'].includes(f.status);
  const updated = seen && f.history.some((o) => (o.op === 'add' ? o.src === 'orchestrator' : o.by === 'orchestrator') && o.ts > seen);
  const post = (body) =>
    api.post(`/api/goals/${d.id}/feedback/${f.id}`, body).then(() => loadDetail()).catch((e) => toast({ kind: 'bad', title: `Could not update ${f.id}`, body: e.message }));
  const lastCycle = f.history.findLast((o) => o.cycle)?.cycle;
  return html`<li class="fb ${updated ? 'updated' : ''}">
    <div class="head"><span class="id">${f.id}</span>${f.kind === 'approval' && html`<span class="kind approval">approval</span>`}${f.steer && html`<span class="kind steer" title="Steering: the next cycle replans around this first">⚡ steer</span>`}${agentNote && html`<span class="kind agent" title="The orchestrator filed this for a later cycle. Edit or dismiss it if it's wrong.">agent note</span>`}<span class="st ${f.status}">${f.kind === 'approval' && !f.decision && f.status === 'blocked' ? 'waiting for you' : STATUS_LABEL[f.status]}</span>${f.decision && html`<span class="decision ${f.decision}">${f.decision === 'approved' ? '✓ approved' : '✕ disapproved'}</span>`}${updated && html`<span class="new-dot" title="updated since you last looked"></span>`}</div>
    ${editing
      ? html`<form class="fb-form" style=${{ margin: '4px 0 0' }} onSubmit=${(e) => {
          e.preventDefault();
          if (draft.trim() && draft.trim() !== f.text) post({ text: draft.trim() }).then(() => setEditing(false));
          else setEditing(false);
        }}>
          <textarea rows="3" value=${draft} onInput=${(e) => setDraft(e.currentTarget.value)} aria-label=${`Text of ${f.id}`}></textarea>
          <div class="row"><span class="faint">The next cycle reads the new text.</span><span><button type="button" class="btn small ghost" onClick=${() => (setDraft(f.text), setEditing(false))}>Cancel</button> <button class="btn primary small">Save</button></span></div>
        </form>`
      : html`<div class="text">${f.text}${f.ref ? html` <span class="chip">${f.ref}</span>` : ''}${f.edited ? html` <span class="faint">(edited)</span>` : ''}</div>`}
    <div class="meta"><span>${SRC_LABEL[f.src] ?? `from ${f.src}`} · ${ago(f.created_at)}</span>${lastCycle && html`<span>last touched in c${lastCycle}</span>`}</div>
    ${f.kind === 'approval' && !f.decision && !['done', 'wont_do'].includes(f.status) && html`<${ApprovalButtons} goalId=${d.id} f=${f} />`}
    ${f.status === 'blocked' && /^needs a new run/.test(f.history.findLast((o) => o.op === 'status')?.note ?? '') && html`<div class="needs-run">This needs a new run. Use <b>Start new run…</b> when you're ready.</div>`}
    ${f.history.length > 1 &&
    html`<details open=${updated}>
      <summary>${f.history.length - 1} update${f.history.length > 2 ? 's' : ''}</summary>
      <ul class="hist">${f.history.slice(1).map((o, i) => html`<li key=${i}>${o.cycle ? `c${o.cycle} · ` : ''}${o.by === 'user' ? 'you' : o.by}${histVerb(o)}${o.note || o.text ? `: ${o.note ?? o.text}` : ''} <span class="faint">· ${ago(o.ts)}</span></li>`)}</ul>
    </details>`}
    <div class="actions">
      <select aria-label=${`Status of ${f.id}`} value=${f.status} onChange=${(e) => post({ status: e.currentTarget.value })}>
        ${Object.entries(STATUS_LABEL).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
      </select>
      <button class="btn small" onClick=${() => setNoting(!noting)}>Note</button>
      ${!closed && !editing && html`<button class="btn small" onClick=${() => (setDraft(f.text), setEditing(true))}>Edit</button>`}
      ${agentNote && !closed && html`<button class="btn small ghost" title="Mark it won't do: the next cycle skips it" onClick=${() => post({ status: 'wont_do', note: 'dismissed by the human' })}>Dismiss</button>`}
      ${(d.run_finished || d.clock?.followup) && !closed && !agentNote && f.kind !== 'approval' &&
      html`<select class="scope" aria-label=${`How to handle ${f.id} after DONE`} value=${f.scope} onChange=${(e) => post({ scope: e.currentTarget.value })}
        title="After DONE, a follow-up handles open feedback with no time box. Choose how this item is treated.">
        <option value="auto">agent decides</option><option value="tweak">quick tweak</option><option value="new_run">needs a new run</option>
      </select>`}
    </div>
    ${noting &&
    html`<form class="fb-form" style=${{ marginTop: '8px', marginBottom: 0 }} onSubmit=${(e) => {
      e.preventDefault();
      if (note.trim()) post({ note: note.trim() }).then(() => (setNote(''), setNoting(false)));
    }}>
      <input type="text" value=${note} onInput=${(e) => setNote(e.currentTarget.value)} placeholder="Add a note for the orchestrator" aria-label="Note" />
    </form>`}
  </li>`;
}

function Feedback({ d }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const seen = store.seenAtOpen[d.id]?.feedback_at;
  const running = d.state === 'running' || d.state === 'pausing';
  const submit = (e, steer = false) => {
    e?.preventDefault();
    if (!text.trim()) return;
    if (steer && running && !confirm(`Steer now?\n\nThis interrupts cycle ${d.cycle} (its work on disk is kept) and starts a fresh cycle that replans the backlog around your feedback before doing anything else.`)) return;
    setBusy(true);
    api
      .post(`/api/goals/${d.id}/feedback`, { text: text.trim(), ...(steer ? { steer: true } : {}) })
      .then(({ id, interrupted }) => {
        setText('');
        if (!steer && d.run_finished) toast({ kind: 'info', title: `${id} added`, body: 'This goal is finished: press "Follow up" to apply your feedback (no time box).', ms: 6000 });
        else if (steer) toast({ kind: 'info', title: `${id}: steering`, body: interrupted ? `Cycle ${d.cycle} is interrupted; a fresh cycle replans around it now.` : 'The next cycle replans around it first.', ms: 5000 });
        else toast({ kind: 'info', title: `${id} added`, body: 'The next cycle picks it up.', ms: 3500 });
        loadDetail();
      })
      .catch((e) => toast({ kind: 'bad', title: 'Could not add feedback', body: e.message }))
      .finally(() => setBusy(false));
  };
  const open = d.feedback.filter((f) => !['done', 'wont_do'].includes(f.status)).length;
  return html`<section class="panel">
    <h2>Feedback <span class="right muted">${open} open</span></h2>
    <form class="fb-form" onSubmit=${submit}>
      <textarea rows="3" value=${text} disabled=${busy} placeholder="Tell the harness something. New items outrank the backlog."
        aria-label="New feedback" onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && submit(e)}></textarea>
      <div class="row"><span class="faint">Ctrl+Enter to send</span>
        <span class="send-btns">
          <button type="button" class="btn small steer" disabled=${busy || !text.trim()} onClick=${(e) => submit(e, true)}
            title=${running ? 'Interrupt the running cycle now and replan the whole backlog around this' : 'The next cycle replans the whole backlog around this before anything else'}>⚡ ${running ? 'Steer now' : 'Steer'}</button>
          <button class="btn primary small" disabled=${busy || !text.trim()} title="Picked up at the start of the next cycle">Send</button>
        </span></div>
    </form>
    ${d.feedback.length === 0 ? html`<p class="empty">No feedback yet.</p>` : html`<ul class="fb-list">${d.feedback.map((f) => html`<${FeedbackItem} key=${f.id} d=${d} f=${f} seen=${seen} />`)}</ul>`}
  </section>`;
}

/** Backlog progress split by milestone: one segment per milestone, width by task count, filled by state. */
function MilestoneBar({ ms }) {
  return html`<div class="ms-bar" role="list" aria-label="Progress by milestone">
    ${ms.map((m) => {
      const n = m.todo + m.doing + m.done + m.blocked + m.cut;
      const finished = m.todo + m.doing === 0;
      const tip = `${m.id} ${m.title}${m.target_s != null ? ` (target ${dur(m.target_s)})` : ''}\n${m.done} done · ${m.doing} in progress · ${m.blocked} blocked · ${m.cut} cut · ${m.todo} to do${m.reached ? `\nreached ${ago(m.reached.at)}` : ''}`;
      return html`<div key=${m.id} role="listitem" class="ms-seg ${m.current ? 'current' : ''}" style=${{ flexGrow: n }} title=${tip}>
        <div class="progress"><span class="done" style=${{ flexGrow: m.done }}></span><span class="doing" style=${{ flexGrow: m.doing }}></span><span class="blocked" style=${{ flexGrow: m.blocked }}></span><span class="cut" style=${{ flexGrow: m.cut }}></span><span style=${{ flexGrow: m.todo }}></span></div>
        <div class="ms-name"><b>${m.id}</b> ${finished ? '✓' : `${m.done}/${n}`}</div>
      </div>`;
    })}
  </div>`;
}

function Backlog({ d }) {
  const b = d.backlog;
  if (!b) return html`<section class="panel"><h2>Backlog</h2><p class="empty">No state/backlog.md yet.</p></section>`;
  const order = { doing: 0, blocked: 1, todo: 2 };
  const open = d.backlog_items.filter((t) => t.mark in order).sort((a, b) => order[a.mark] - order[b.mark]);
  const total = b.todo + b.doing + b.done + b.blocked + b.cut;
  const ms = (d.milestones ?? []).filter((m) => m.todo + m.doing + m.done + m.blocked + m.cut > 0);
  return html`<section class="panel">
    <h2>Backlog <span class="right muted">${b.milestone ? `milestone ${b.milestone}` : ''}</span></h2>
    ${ms.length > 1
      ? html`<${MilestoneBar} ms=${ms} />`
      : html`<div class="progress" title=${`${b.done} done · ${b.doing} in progress · ${b.blocked} blocked · ${b.cut} cut · ${b.todo} to do`}>
      <span class="done" style=${{ flexGrow: b.done }}></span><span class="doing" style=${{ flexGrow: b.doing }}></span><span class="blocked" style=${{ flexGrow: b.blocked }}></span><span class="cut" style=${{ flexGrow: b.cut }}></span><span style=${{ flexGrow: b.todo }}></span>
    </div>`}
    <div class="muted num" style=${{ fontSize: '12.5px' }}>${b.done} of ${total} done · ${b.doing} in progress · ${b.blocked} blocked${b.cut ? ` · ${b.cut} cut` : ''}</div>
    ${open.length > 0 &&
    html`<ul class="tasks">
      ${open.slice(0, 14).map((t, i) => html`<li key=${i} class=${t.mark}><span class="m">${{ doing: '~', blocked: '!', todo: '○' }[t.mark]}</span><span>${t.text}</span></li>`)}
      ${open.length > 14 && html`<li class="faint">…and ${open.length - 14} more</li>`}
    </ul>`}
  </section>`;
}

function Checkpoints({ d }) {
  const artifacts = d.events.filter((e) => e.type === 'artifact').reverse().slice(0, 10);
  if (!d.commits.length && !artifacts.length) return null;
  return html`<section class="panel">
    <h2>${d.goal.checkpoints === 'shadow' ? 'Snapshots' : 'Commits'} ${artifacts.length ? '& artifacts' : ''}</h2>
    ${d.commits.length > 0 && html`<ul class="commits">${d.commits.map((c) => html`<li key=${c.hash}><span class="hash">${c.hash}</span><span class="s" title=${c.subject}>${c.subject}</span><span class="faint" style=${{ marginLeft: 'auto', flex: 'none' }}>${ago(c.at)}</span></li>`)}</ul>`}
    ${artifacts.length > 0 && html`<ul class="commits" style=${{ marginTop: '10px' }}>${artifacts.map((a, i) => html`<li key=${i}><span class="hash">▤</span><span class="s mono" title=${a.text ?? ''}>${a.path}</span></li>`)}</ul>`}
  </section>`;
}

function About({ d }) {
  const g = d.goal;
  return html`<section class="panel">
    <h2>Goal</h2>
    <dl class="kv">
      <dt>path</dt><dd class="mono">${d.path}</dd>
      <dt>model</dt><dd>${g.adapter.model} / ${g.adapter.effort} · ${g.adapter.permission_mode}</dd>
      <dt>time box</dt><dd>${dur(g.timebox.total_min * 60)} · wrap-up ${dur(g.timebox.wrapup_min * 60)} · grace ${dur(g.timebox.grace_min * 60)}</dd>
      <dt>cycle</dt><dd>timeout ${g.cycle.timeout_min}m${g.cycle.max_budget_usd ? ` · budget $${g.cycle.max_budget_usd}` : ''}</dd>
      <dt>done when</dt><dd>${g.done.map((x) => html`<div key=${x.id}>${x.id}: ${x.check}</div>`)}</dd>
    </dl>
  </section>`;
}

function FirstRun({ d }) {
  return html`<section class="panel first-run">
    <h2>Before the first cycle</h2>
    <ol>
      <li>Check the setup (it never starts the clock): <span class="mono">epoptes run ${d.id} --dry-run</span></li>
      <li>Read <span class="mono">.epoptes/loop.md</span> and the backlog once: that's exactly what every cycle will do.</li>
      <li>Press <b>Start</b>. The first cycle begins within seconds; this page follows it live.</li>
    </ol>
    <p class="muted">Time box ${dur(d.goal.timebox.total_min * 60)} of active time · orchestrator ${d.goal.adapter.model}/${d.goal.adapter.effort} · pausing or stopping never loses verified work.</p>
  </section>`;
}

function GoalDetail({ id }) {
  const s = useStore();
  useEffect(() => {
    set({ detailId: id, detail: null, selectedCycle: null, cycleView: null });
    loadDetail(id);
    return () => set({ detailId: null, detail: null });
  }, [id]);
  const d = s.detail;
  if (!d || d.id !== id) return html`<a class="back" href="#/">← All goals</a><p class="empty">Loading…</p>`;
  if (d.error) {
    return html`<a class="back" href="#/">← All goals</a>
      <div class="panel empty-state">
        <h2>${d.missing ? 'Goal not found' : `Can't read ${d.id}`}</h2>
        <p>${d.missing ? html`No registered goal is called <b>${d.id}</b>. It may have been removed from the registry.` : d.error}</p>
        ${!d.missing && html`<p class="muted">Fix the file, then check it with <span class="mono">epoptes run ${d.id} --dry-run</span>. This page updates by itself.</p>`}
      </div>`;
  }
  return html`<a class="back" href="#/">← All goals</a>
    <div class="detail-head">
      <div class="title"><h1>${d.name}</h1><${StatePill} state=${d.state} />${d.mode && html`<span class="chip ${d.mode}">${d.mode}</span>`}<span class="muted">run ${d.run ?? '–'} · cycle ${d.cycle || '–'}${d.round ? ` · round ${d.round}` : ''}</span></div>
      <p class="objective">${d.objective}</p>
      <${ClockBar} g=${d} big=${true} />
      <${Controls} d=${d} />
      <${Banners} d=${d} />
      <${NeedsYou} d=${d} />
    </div>
    ${d.cycles === 0 && !d.live && html`<${FirstRun} d=${d} />`}
    <${Stats} d=${d} />
    <div class="grid">
      <div class="stack">
        <${Ticker} d=${d} />
        <section class="panel"><h2>Cycles <span class="right muted">median <${Money} usd=${d.cost_median || null} basis=${d.cost_basis} /></span></h2><${Timeline} d=${d} /><${CycleTable} d=${d} /></section>
        <${CycleDetail} d=${d} />
        <${TimeUse} d=${d} />
        <${Feed} d=${d} />
      </div>
      <div class="stack">
        <${Feedback} d=${d} />
        <${Backlog} d=${d} />
        <section class="panel"><h2>Handoff</h2>${d.handoff ? html`<pre class="handoff"><${Rich} text=${d.handoff} /></pre>` : html`<p class="empty">No handoff yet.</p>`}</section>
        <${Checkpoints} d=${d} />
        <${About} d=${d} />
      </div>
    </div>`;
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
    if (location.hash.startsWith('#/brain')) return 'brain';
    const m = /^#\/g\/([a-z0-9-]+)/.exec(location.hash);
    return m ? m[1] : null;
  };
  const [id, setId] = useState(parse());
  useEffect(() => {
    const f = () => setId(parse());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return id;
}

function Toasts() {
  const s = useStore();
  return html`<div class="toasts" aria-live="polite">${s.toasts.map((t) => html`<div key=${t.id} class="toast ${t.kind}" onClick=${() => set({ toasts: s.toasts.filter((x) => x.id !== t.id) })}><b>${t.title}</b>${t.body && html`<span>${t.body}</span>`}</div>`)}</div>`;
}

function App() {
  const s = useStore();
  const id = useRoute();
  useEffect(() => {
    const goals = s.state?.goals ?? [];
    // On a goal's page the icon follows that goal; on the list, the most urgent goal.
    const kinds = id && id !== 'brain' ? [favKind(goals.find((g) => g.id === id))] : goals.map(favKind);
    favicon.set(kinds.sort((a, b) => FAV_ORDER.indexOf(a) - FAV_ORDER.indexOf(b))[0] ?? 'idle');
    const waiting = goals.filter((g) => g.needs || g.pending_approvals?.length).length;
    if (id !== 'brain') document.title = `${waiting ? `⚑ ${waiting} · ` : ''}${s.detail?.name ? `${s.detail.name} · Epoptes` : 'Epoptes'}`;
  }, [s.detail?.name, s.state, id]);
  return html`<${Topbar} />
    ${s.offline && html`<div class="offline pill bad">Dashboard server unreachable. Runs keep going; reconnecting…</div>`}
    <main>${id === 'brain' ? html`<${Brain} />` : id ? html`<${GoalDetail} id=${id} />` : html`<${GoalList} />`}</main>
    <${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
loadState(); // don't wait for the stream's first message
connect();
