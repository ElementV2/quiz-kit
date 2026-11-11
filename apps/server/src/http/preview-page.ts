/**
 * PROVISIONAL phase-0 preview (replaced by apps/control, host, player, output in phase 1).
 * Vanilla JS, no build: talks the real protocol (hello / intent / ack / resync) so links can be tested
 * in a browser, on a phone or in OBS / vMix right now. All text is rendered with textContent (doc 10).
 */
export const PREVIEW_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quizzkit — aperçu</title>
<link rel="stylesheet" href="/assets/preview.css">
</head>
<body>
<div id="app">
  <header><span id="role"></span><span id="status" class="status">connexion…</span></header>
  <main>
    <section id="question" class="card"><div id="meta" class="meta"></div><h1 id="prompt">En attente…</h1><div id="timer" class="timer"></div></section>
    <section id="options" class="options"></section>
    <section id="me" class="card small hidden"></section>
    <section id="controls" class="controls hidden"></section>
    <section id="board" class="card small"><h2>Classement</h2><ol id="leaderboard"></ol></section>
    <section id="host" class="card small hidden"></section>
  </main>
  <footer>Aperçu provisoire — phase 0 (l'habillage arrive en phase 1)</footer>
</div>
<script type="module" src="/assets/preview.js"></script>
</body>
</html>`;

export const PREVIEW_CSS = `
:root { color-scheme: dark; --bg:#0d1020; --card:#171b33; --ink:#f3f4ff; --muted:#9aa0c3; --accent:#7c5cff; --ok:#22c55e; --ko:#ef4444; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
body.output { background: transparent; }
body.output header, body.output footer { display:none; }
#app { max-width: 1100px; margin: 0 auto; padding: 16px; }
header { display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px; color: var(--muted); }
.status { padding: 2px 10px; border-radius: 99px; background:#333; font-size: 13px; }
.status.on { background: #14532d; color:#bbf7d0; } .status.off { background:#7f1d1d; color:#fecaca; }
.card { background: var(--card); border-radius: 16px; padding: 20px 24px; margin-bottom: 12px; }
.card.small { font-size: 15px; } .hidden { display:none; }
.meta { color: var(--muted); font-size: 14px; margin-bottom: 6px; }
h1 { margin: 0; font-size: clamp(22px, 4vw, 44px); line-height: 1.15; }
h2 { margin: 0 0 8px; font-size: 16px; color: var(--muted); }
.timer { margin-top: 10px; font-variant-numeric: tabular-nums; font-size: 28px; font-weight: 700; color: var(--accent); }
.options { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 12px; }
.opt { background: var(--card); border: 2px solid transparent; color: var(--ink); border-radius: 14px; padding: 18px; font-size: clamp(18px, 2.4vw, 28px); text-align:left; display:flex; justify-content:space-between; gap: 8px; }
button.opt { cursor:pointer; } button.opt:disabled { cursor: default; opacity: .75; }
.opt.selected { border-color: var(--accent); } .opt.correct { background: #14532d; border-color: var(--ok); } .opt.wrong { opacity:.45; }
.count { color: var(--muted); font-variant-numeric: tabular-nums; }
.controls { display:flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.controls button { background: var(--accent); color: white; border: 0; border-radius: 10px; padding: 12px 16px; font-size: 16px; cursor: pointer; }
.controls button.secondary { background: #2a3058; }
.controls .msg { flex-basis: 100%; color: var(--muted); font-size: 14px; min-height: 1.2em; }
ol { margin: 0; padding-left: 22px; } li { padding: 2px 0; font-variant-numeric: tabular-nums; }
footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 16px; }
`;

export const PREVIEW_JS = `
const params = new URLSearchParams(location.search);
const token = params.get("t") ?? "";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = String(text); return e; };
const clientId = (() => { try { let id = localStorage.getItem("quiz.clientId"); if (!id) { id = "c_" + crypto.randomUUID().replaceAll("-", ""); localStorage.setItem("quiz.clientId", id); } return id; } catch { return "c_" + Math.random().toString(36).slice(2); } })();
const PHASES = { lobby: "Avant la partie", idle: "Entre deux questions", presenting: "Question présentée", open: "Réponses ouvertes", locked: "Réponses fermées", judging: "Validation", revealed: "Réponse révélée", "round.end": "Fin de manche", "game.end": "Fin de partie" };
let ws = null, view = null, viewSeq = 0, offset = 0, attempt = 0, pending = new Map(), lastAck = "";

function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: 1, token, clientId }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "welcome") { attempt = 0; offset = m.serverTime - Date.now(); view = m.view; viewSeq = m.viewSeq; setStatus(true); for (const [key, action] of pending) send({ t: "intent", key, action }); render(); }
    else if (m.t === "snapshot") { view = m.view; viewSeq = m.viewSeq; render(); }
    else if (m.t === "patch") { send({ t: "resync" }); } // preview: always ask for a snapshot (real apps apply the patch)
    else if (m.t === "ping") { offset = m.serverTime - Date.now(); }
    else if (m.t === "ack") { pending.delete(m.key); lastAck = m.ok ? "✓ enregistré" : "✗ " + m.reason; render(); }
    else if (m.t === "error") { setStatus(false, m.message); }
  };
  ws.onclose = () => { setStatus(false); const d = Math.random() * Math.min(2000, 100 * 2 ** attempt++); setTimeout(connect, d); };
}
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function intent(action) { const key = "k_" + crypto.randomUUID().replaceAll("-", ""); pending.set(key, action); send({ t: "intent", key, action }); }
function setStatus(on, text) { const s = $("status"); s.textContent = text ?? (on ? "connecté" : "reconnexion…"); s.className = "status " + (on ? "on" : "off"); }

function render() {
  if (!view) return;
  const v = view, m = v.mechanic;
  document.body.className = v.role;
  $("role").textContent = { control: v.readonly ? "Régie (lecture)" : "Régie", host: "Animateur", output: "Sortie", player: "Joueur" }[v.role] ?? v.role;
  $("meta").textContent = [PHASES[v.phase] ?? v.phase, v.round ? v.round.title : "", v.question ? "Question " + (v.question.index + 1) + "/" + v.question.count : ""].filter(Boolean).join(" · ");
  $("prompt").textContent = v.question ? v.question.prompt.text : (v.phase === "game.end" ? "Partie terminée !" : "En attente…");
  const opts = $("options"); opts.replaceChildren();
  if (m && m.options) {
    const canPick = v.role === "player" && v.canAnswer;
    for (const o of m.options) {
      const b = el(canPick ? "button" : "div", "opt");
      b.append(el("span", "", o.label));
      if (m.counts) b.append(el("span", "count", m.counts[o.id] ?? 0));
      if (v.role === "player" && v.myAnswer && v.myAnswer.includes(o.id)) b.classList.add("selected");
      if (m.correct) b.classList.add(m.correct.includes(o.id) ? "correct" : "wrong");
      if (canPick) b.onclick = () => {
        let ids = [o.id];
        if (m.maxPick > 1) { const cur = new Set(v.myAnswer ?? []); cur.has(o.id) ? cur.delete(o.id) : cur.add(o.id); ids = [...cur].slice(0, m.maxPick); if (ids.length === 0) return; }
        intent({ type: "answer.submit", participantId: v.me.participantId, answer: { kind: "choice", optionIds: ids } });
      };
      opts.append(b);
    }
  }
  const lb = $("leaderboard"); lb.replaceChildren();
  for (const r of v.leaderboard.slice(0, 10)) lb.append(el("li", "", r.displayName + " — " + r.total));
  const me = $("me");
  if (v.role === "player") {
    me.classList.remove("hidden");
    me.textContent = v.me ? v.me.displayName + " · " + v.me.total + " pts" + (v.myResult === "correct" ? " · ✓ Bonne réponse !" : v.myResult === "wrong" ? " · ✗ Raté" : v.myAnswer ? " · Réponse enregistrée" : "") : "Siège libre : la régie doit assigner un joueur.";
  }
  const host = $("host");
  if ((v.role === "host" || v.role === "control") && v.notes) { host.classList.remove("hidden"); host.textContent = "Notes : " + v.notes; } else host.classList.add("hidden");
  renderControls(v);
}

function renderControls(v) {
  const c = $("controls");
  if (v.role !== "control" || v.readonly) { c.classList.add("hidden"); return; }
  c.classList.remove("hidden"); c.replaceChildren();
  const next = { lobby: ["Démarrer la partie", { type: "game.start" }], idle: v.round === null ? ["Démarrer la manche", { type: "round.start" }] : ["Présenter la question", { type: "question.present" }],
    "round.end": ["Manche suivante", { type: "round.start" }], presenting: ["Ouvrir les réponses", { type: "question.open" }], open: ["Fermer les réponses", { type: "question.lock" }],
    locked: ["Révéler", { type: "question.reveal" }], revealed: ["Question suivante", { type: "question.next" }] }[v.phase];
  const btn = (label, action, cls) => { const b = el("button", cls, label); b.onclick = () => intent(action); c.append(b); };
  if (next) btn(next[0] + "  ▶", next[1]);
  btn("↶ Annuler", { type: "undo" }, "secondary");
  const add = el("button", "secondary", "+ Joueur");
  add.onclick = () => { const n = v.participants.length + 1; intent({ type: "player.add", participantId: "p_" + Date.now().toString(36), displayName: "Joueur " + n, seat: firstFreeSeat(v), channel: "seat" }); };
  c.append(add);
  const msg = el("div", "msg", lastAck);
  msg.id = "msg";
  c.append(msg);
  c.append(el("div", "msg", v.participants.length + " joueur(s) · réponses : " + v.answers.length + " · événement #" + v.lastSeq));
}
function firstFreeSeat(v) { const used = new Set(v.participants.map((p) => p.seat)); for (let i = 1; i < 999; i++) if (!used.has(i)) return i; return undefined; }

setInterval(() => {
  const t = $("timer");
  if (!view || !view.timer) { t.textContent = ""; return; }
  const left = Math.max(0, view.timer.endsAt - (Date.now() + offset));
  t.textContent = "⏱ " + Math.ceil(left / 1000) + " s";
}, 200);
connect();
`;
