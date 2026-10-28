// Epoptes landing page: the hero dashboard mock, the night-shift comparison, crash-course tabs and copy buttons.
// Everything is simulated in the browser: no requests, libraries or storage.
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const $ = (id) => document.getElementById(id);
document.documentElement.classList.add("js");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function onVisible(target, callback) {
  new IntersectionObserver((entries) => callback(entries[0].isIntersecting), { threshold: 0.2 }).observe(target);
}
const hm = (min) => `${Math.floor(min / 60)}h${String(Math.floor(min % 60)).padStart(2, "0")}`;

// --- Hero: a goal page mid-run ---
const SCRIPT = [
  ["orchestrator", "r-orch", "Read state/handoff.md"],
  ["orchestrator", "r-orch", "epoptes board --open"],
  ["writer", "r-writer", "Write guide/06-webhooks.md"],
  ["factcheck", "r-check", "Bash node scripts/run-examples.mjs"],
  ["factcheck", "r-check", "48 examples pass · 0 fail"],
  ["orchestrator", "r-orch", "epoptes card C-6 review"],
  ["editor", "r-edit", "Read guide/05-pagination.md"],
  ["editor", "r-edit", "score 8/10 · intro too long"],
  ["you", "r-you", "comment on C-5: “link the error table”"],
  ["orchestrator", "r-orch", 'git commit -m "C-5 pagination chapter"'],
  ["◆ milestone", "r-ms", "M2 · reference chapters"],
  ["orchestrator", "r-orch", "epoptes clock"],
];
const NEW_CARDS = ["Changelog", "SDK notes", "Retries", "Idempotency", "Versioning", "Glossary", "Webhook security"];
const WHO = [null, null, "writer", "factcheck", null];

function dashboard() {
  const board = $("d-board");
  if (!board) return;
  const cols = [...board.querySelectorAll("ol")];
  const ticker = $("d-ticker");
  let minute = 161;
  let cycle = 7;
  let step = 0;
  let nextId = 10;
  let line = 0;
  let timer = null;

  function moveCard() {
    // Try each column from the right, starting at a rotating point, so the board keeps flowing.
    for (let i = 0; i < 4; i++) {
      const from = 3 - ((step + i) % 4);
      const card = cols[from].firstElementChild;
      if (!card) continue;
      const who = WHO[from + 1];
      if (who) card.dataset.who = who;
      else delete card.dataset.who;
      card.classList.remove("moved");
      cols[from + 1].append(card);
      void card.offsetWidth;
      card.classList.add("moved");
      break;
    }
    if (cols[4].children.length > 3) cols[4].firstElementChild.remove();
    if (!cols[0].children.length) {
      const card = el("li", "moved", `C-${nextId++} ${NEW_CARDS[nextId % NEW_CARDS.length]}`);
      card.dataset.who = "you";
      cols[0].append(card);
    }
  }

  function tick() {
    step++;
    minute++;
    if (step % 12 === 0) $("d-cycle").textContent = String(++cycle);
    if (minute > 470) minute = 161;
    $("d-clock").textContent = `${hm(minute)}m of 8h`;
    $("d-fill").style.width = `${(minute / 480) * 100}%`;
    const [who, cls, text] = SCRIPT[line++ % SCRIPT.length];
    const li = el("li", "new");
    li.append(el("time", "", hm(minute).replace("h", ":")), el("b", cls, who), el("span", "", text));
    ticker.append(li);
    while (ticker.children.length > 5) ticker.firstElementChild.remove();
    if (step % 3 === 0) moveCard();
  }

  $("d-fill").style.width = `${(minute / 480) * 100}%`;
  if (reduced.matches) return;
  onVisible(board, (on) => {
    clearInterval(timer);
    if (on && !document.hidden) timer = setInterval(tick, 1700);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInterval(timer);
  });
}

// --- The night shift: one long session against an Epoptes harness, as a function of the minute ---
const SOLO = {
  segs: [
    { a: 0, b: 190, kind: "run" },
    { a: 190, b: 480, kind: "idle" },
  ],
  marks: [75, 150],
  ms: [
    [62, "on"],
    [172, "meh"],
  ],
  log: [
    [0, "You: “Build the field guide. Keep going all night.” You go to bed."],
    [18, "Reads the spec, the README and all of docs/ into its context."],
    [62, "Finishes the quick start and the auth chapter."],
    [75, "Context full. The auto-compact summary keeps the plan and drops which examples failed.", "bad"],
    [112, "Re-reads files it had read before the compaction."],
    [150, "Compacted again. The style decisions from hour one are gone.", "bad"],
    [172, "Says the reference chapters are done. Nothing checked them."],
    [190, "Asks: “Shall I continue with the webhooks chapter?”", "bad"],
    [260, "Still waiting for an answer.", "wait"],
    [480, "Morning: 2 of 6 milestones, examples never run, 4h50 idle.", "bad"],
  ],
  ctx(t) {
    if (t < 75) return 8 + t * 1.1;
    if (t < 150) return 30 + (t - 75) * 0.8;
    return 32 + (Math.min(t, 190) - 150) * 0.9;
  },
  state(t) {
    if (t >= 480) return ["morning · 2 of 6 milestones", "bad"];
    if (t >= 190) return [`waiting for you · since ${hm(190)}`, "bad"];
    return ["working · one context", ""];
  },
};

const CYCLES = [
  [0, 44],
  [46, 92],
  [94, 138],
  [163, 207],
  [209, 252],
  [254, 298],
  [300, 344],
  [346, 390],
  [392, 428],
];
const EPO = {
  segs: [...CYCLES.map(([a, b]) => ({ a, b, kind: "run" })), { a: 138, b: 163, kind: "wait" }],
  marks: [],
  ms: [
    [44, "on"],
    [120, "on"],
    [207, "on"],
    [280, "on"],
    [344, "on"],
    [388, "on"],
  ],
  log: [
    [0, "Cycle 1 orients from the handoff, the board and the clock in 6 tool calls."],
    [30, "writer drafts the quick start; factcheck runs every example in it."],
    [44, "M1 done, checks pass. The cycle writes its handoff and exits.", "good"],
    [46, "Cycle 2 starts fresh from a 25-line handoff, not 45 minutes of transcript."],
    [95, "Triages the card you left before bed (C-9) into TODO."],
    [120, "M2 done · factcheck: 48 examples pass.", "good"],
    [138, "Rate limit. The runner waits for the reset with the clock paused.", "wait"],
    [163, "Limit reset. Cycle 4 picks up where the handoff says."],
    [185, "Needs approval to publish to the wiki. C-12 waits; the other cards carry on.", "wait"],
    [207, "M3 done.", "good"],
    [262, "editor scores chapters 3–5 against the rubric: 8, 9, 8."],
    [280, "M4 done.", "good"],
    [344, "M5 done.", "good"],
    [388, "M6 done.", "good"],
    [392, "Every done check passes: wrap-up, lessons recorded for the brain.", "good"],
    [428, "DONE at 6h43 active of 8h. Report written.", "good"],
    [480, "Morning: 6 of 6 milestones, a report, one approval to answer.", "good"],
  ],
  ctx(t) {
    const c = CYCLES.find(([a, b]) => t >= a && t < b);
    return c ? 8 + ((t - c[0]) / (c[1] - c[0])) * 48 : 0;
  },
  state(t) {
    if (t >= 428) return ["DONE · 6h43 of 8h, early", "done"];
    if (t >= 138 && t < 163) return ["rate-limited · clock paused", "wait"];
    const n = CYCLES.findIndex(([a, b]) => t >= a && t < b);
    if (n < 0) return ["between cycles", ""];
    return [`${t >= 392 ? "wrap-up" : "build"} · cycle ${n + 1} · fresh context`, "ok"];
  },
};

function night() {
  const range = $("sim-t");
  if (!range) return;
  const play = $("sim-play");
  const lanes = [
    { m: SOLO, id: "solo", shown: -1 },
    { m: EPO, id: "epo", shown: -1 },
  ];
  for (const lane of lanes) {
    const strip = $(`${lane.id}-strip`);
    lane.segs = lane.m.segs.map((s) => {
      const seg = el("i", `seg ${s.kind === "run" ? "" : s.kind}`);
      seg.style.left = `${(s.a / 480) * 100}%`;
      strip.append(seg);
      return [s, seg];
    });
    for (const m of lane.m.marks) {
      const mark = el("i", "mark-c");
      mark.style.left = `${(m / 480) * 100}%`;
      mark.hidden = true;
      strip.append(mark);
      lane.segs.push([{ a: m, b: m, kind: "mark" }, mark]);
    }
    lane.now = el("i", "now");
    strip.append(lane.now);
    lane.ms = Array.from({ length: 6 }, () => $(`${lane.id}-ms`).appendChild(el("li")));
  }

  function render(t) {
    $("sim-time").textContent = hm(t);
    for (const lane of lanes) {
      const { m, id } = lane;
      const ctx = Math.round(m.ctx(t));
      const bar = $(`${id}-ctx`);
      bar.style.width = `${ctx}%`;
      bar.className = ctx > 80 ? "hot" : ctx > 55 ? "warm" : "";
      $(`${id}-ctx-n`).textContent = `${ctx}%`;
      const [text, tone] = m.state(t);
      const state = $(`${id}-state`);
      if (state.textContent !== text) state.textContent = text;
      state.dataset.tone = tone;
      for (const [s, node] of lane.segs) {
        if (s.kind === "mark") node.hidden = t < s.a;
        else node.style.width = `${(Math.max(0, Math.min(t, s.b) - s.a) / 480) * 100}%`;
      }
      lane.now.style.left = `${(t / 480) * 100}%`;
      lane.ms.forEach((li, i) => {
        const hit = m.ms[i] && t >= m.ms[i][0];
        li.className = hit ? m.ms[i][1] : "";
      });
      const seen = m.log.filter(([at]) => at <= t);
      if (seen.length !== lane.shown) {
        const log = $(`${id}-log`);
        log.replaceChildren(
          ...seen.slice(-6).map(([at, msg, tone], i, arr) => {
            const li = el("li", tone ?? "");
            if (seen.length > lane.shown && i === arr.length - 1 && lane.shown >= 0) li.classList.add("new");
            li.append(el("time", "", hm(at)), el("span", "", msg));
            return li;
          }),
        );
        lane.shown = seen.length;
      }
    }
  }

  let raf = 0;
  let last = 0;
  function stop() {
    cancelAnimationFrame(raf);
    play.setAttribute("aria-pressed", "false");
    play.textContent = Number(range.value) >= 480 ? "↻ Replay the night" : "▶ Play the night";
  }
  function frame(now) {
    // 8 hours in about 24 seconds.
    const t = Math.min(480, Number(range.value) + ((now - last) / 1000) * 20);
    last = now;
    range.value = String(t);
    render(t);
    if (t >= 480) stop();
    else raf = requestAnimationFrame(frame);
  }
  function start() {
    if (Number(range.value) >= 480) range.value = "0";
    play.setAttribute("aria-pressed", "true");
    play.textContent = "❚❚ Pause";
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  play.addEventListener("click", () => (play.getAttribute("aria-pressed") === "true" ? stop() : start()));
  range.addEventListener("input", () => {
    stop();
    render(Number(range.value));
  });
  render(0);

  let autoplayed = false;
  onVisible($("scrub"), (on) => {
    if (on && !autoplayed && !reduced.matches) {
      autoplayed = true;
      start();
    }
  });
}

// --- Crash course tabs ---
function tabs() {
  const list = $("steps");
  if (!list) return;
  const buttons = [...list.querySelectorAll('[role="tab"]')];
  function select(button, focus) {
    for (const b of buttons) {
      const on = b === button;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      $(b.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) button.focus();
  }
  for (const b of buttons) b.addEventListener("click", () => select(b, false));
  list.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(buttons[(next + buttons.length) % buttons.length], true);
  });
  select(buttons[0], false);
}

// --- Copy buttons ---
function copyButtons() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    const source = $(button.dataset.copy);
    button.hidden = false;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(source.textContent);
        $("copy-status").textContent = "Copied to the clipboard";
        button.textContent = "copied";
        setTimeout(() => (button.textContent = "copy"), 1600);
      } catch {
        getSelection().selectAllChildren(source);
        $("copy-status").textContent = "Selected; press Ctrl+C or ⌘C to copy";
      }
    });
  }
}

dashboard();
night();
tabs();
copyButtons();
