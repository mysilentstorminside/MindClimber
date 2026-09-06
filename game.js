/* ==========================================================================
   MindClimber IQ — multiplayer visual logic / matrix game
   --------------------------------------------------------------------------
   Uses window.IQ_BANK from mindclimber_iq_bank.js
   Levels: easy (+1/-1), medium (+2/-2), hard (+3/-3)
   No knowledge categories — pure IQ progression.
   ========================================================================== */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAcJrilspQLdDFshcEJwFPpFlLjmx8sKbo",
  authDomain: "mindclimber-b9c69.firebaseapp.com",
  databaseURL: "https://mindclimber-b9c69-default-rtdb.firebaseio.com",
  projectId: "mindclimber-b9c69",
  storageBucket: "mindclimber-b9c69.firebasestorage.app",
  messagingSenderId: "676358113604",
  appId: "1:676358113604:web:2558c13c798ce6ffaaef11",
};

const MAX_STEPS = 30;
const MAX_PLAYERS = 5;
const QUESTION_SECONDS = 25; // visual puzzles need more time
const PLAYER_SECONDS = 300;
const DIFFICULTY_CHOICE_SECONDS = 6;
const AVATAR_COUNT = 11;
const COLOR_DELTA = { green: 1, blue: 2, orange: 3 };
const COLOR_TO_LEVEL = { green: "easy", blue: "medium", orange: "hard" };
const RESULT_PAUSE_MS = 2200;

// ---------------------------------------------------------------------------
// Sounds
// ---------------------------------------------------------------------------
let audioCtx = null;
let soundEnabled = true;
function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }
  return audioCtx;
}
function unlockAudio() {
  const ctx = getAudioCtx();
  if (ctx && ctx.state === "suspended") ctx.resume();
}
document.addEventListener("touchstart", unlockAudio, { once: true, passive: true });
document.addEventListener("click", unlockAudio, { once: true });

function playTone(freqStart, freqEnd, durationMs, type, vol) {
  if (!soundEnabled) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "sine";
  const now = ctx.currentTime;
  const v = vol == null ? 0.16 : vol;
  osc.frequency.setValueAtTime(freqStart, now);
  osc.frequency.linearRampToValueAtTime(freqEnd, now + durationMs / 1000);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(v, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + durationMs / 1000 + 0.03);
}
function playSuccessSound() {
  // Climb up — bright arpeggio
  playTone(523, 659, 70, "sine", 0.14);
  setTimeout(() => playTone(659, 784, 80, "sine", 0.15), 70);
  setTimeout(() => playTone(784, 1046, 120, "triangle", 0.12), 150);
}
function playFailureSound() {
  // Slip — falling buzz
  playTone(300, 90, 280, "sawtooth", 0.1);
  setTimeout(() => playTone(160, 70, 180, "triangle", 0.08), 100);
}
function playTickSound() {
  playTone(880, 880, 35, "square", 0.04);
}
function playClickSound() {
  playTone(420, 520, 40, "triangle", 0.07);
}
function playVictorySound() {
  const notes = [523, 659, 784, 1046, 784, 1046];
  notes.forEach((f, i) => setTimeout(() => playTone(f, f * 1.02, 140, "sine", 0.13), i * 110));
}
function playStartSound() {
  playTone(392, 523, 90, "sine", 0.1);
  setTimeout(() => playTone(523, 659, 120, "sine", 0.12), 90);
}

// ---------------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------------
let db = null;
let firebaseReady = false;
try {
  if (FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("PASTE_")) {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.database();
    firebaseReady = true;
  }
} catch (e) {
  console.error("Firebase init failed", e);
}

function uid() {
  return "p" + Math.random().toString(36).slice(2, 10);
}
let myPlayerId = sessionStorage.getItem("mc_iq_playerId");
if (!myPlayerId) {
  myPlayerId = uid();
  sessionStorage.setItem("mc_iq_playerId", myPlayerId);
}

const $ = (id) => document.getElementById(id);
const screens = ["desktopBlock", "homeScreen", "setupScreen", "lobbyScreen", "gameScreen", "resultsScreen", "leaderboardScreen"];
function showScreen(id) {
  screens.forEach((s) => {
    const el = $(s);
    if (el) el.classList.toggle("active", s === id);
  });
}

function avatarSrc(n, pose) {
  return `assets/Avatars/avatar${n}_${pose}.png`;
}

let currentRoomCode = null;
let isHost = false;
let isSolo = false;
let roomRef = null;
let roomListenerAttached = false;
let latestRoom = null;
let selectedAvatar = null;
let localQuestionTimerHandle = null;

function isMobileViewport() {
  return window.innerWidth <= 620 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}
function checkMobile() {
  if (!isMobileViewport()) {
    showScreen("desktopBlock");
    return false;
  }
  return true;
}
window.addEventListener("resize", () => {
  if (!isMobileViewport() && currentRoomCode === null) showScreen("desktopBlock");
});


// ===========================================================================
// Global leaderboard (Firebase + local cache)
// ===========================================================================
const LB_PATH = "leaderboard_iq";
const LB_LOCAL_KEY = "mc_iq_stats";

function loadLocalStats() {
  try {
    return JSON.parse(localStorage.getItem(LB_LOCAL_KEY) || "{}") || {};
  } catch (e) { return {}; }
}
function saveLocalStats(stats) {
  try { localStorage.setItem(LB_LOCAL_KEY, JSON.stringify(stats)); } catch (e) {}
}

function recordLocalGameResult({ name, avatar, won, reachedSummit, step, solo }) {
  const stats = loadLocalStats();
  const key = (name || "Παίκτης").trim().slice(0, 14) || "Παίκτης";
  if (!stats[key]) {
    stats[key] = { name: key, avatar: avatar || 1, wins: 0, games: 0, summits: 0, bestStep: 0, totalSteps: 0, soloWins: 0 };
  }
  const s = stats[key];
  s.avatar = avatar || s.avatar || 1;
  s.games += 1;
  s.totalSteps += step || 0;
  s.bestStep = Math.max(s.bestStep || 0, step || 0);
  if (won) s.wins += 1;
  if (won && solo) s.soloWins = (s.soloWins || 0) + 1;
  if (reachedSummit) s.summits = (s.summits || 0) + 1;
  saveLocalStats(stats);
  return s;
}

async function pushLeaderboardEntry(entry) {
  if (!firebaseReady || !db) return;
  try {
    const safe = (entry.name || "Player").replace(/[.#$\[\]]/g, "_").slice(0, 20);
    const ref = db.ref(LB_PATH + "/" + safe);
    const snap = await ref.once("value");
    const prev = snap.val() || {};
    const next = {
      name: entry.name,
      avatar: entry.avatar || prev.avatar || 1,
      wins: (prev.wins || 0) + (entry.won ? 1 : 0),
      games: (prev.games || 0) + 1,
      summits: (prev.summits || 0) + (entry.reachedSummit ? 1 : 0),
      bestStep: Math.max(prev.bestStep || 0, entry.step || 0),
      totalSteps: (prev.totalSteps || 0) + (entry.step || 0),
      soloWins: (prev.soloWins || 0) + (entry.won && entry.solo ? 1 : 0),
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
    };
    await ref.set(next);
  } catch (e) {
    console.warn("leaderboard push failed", e);
  }
}

async function fetchLeaderboard(sortBy) {
  // Merge Firebase global + local
  let remote = {};
  if (firebaseReady && db) {
    try {
      const snap = await db.ref(LB_PATH).once("value");
      remote = snap.val() || {};
    } catch (e) {
      console.warn("leaderboard fetch failed", e);
    }
  }
  const local = loadLocalStats();
  const merged = { ...remote };
  Object.entries(local).forEach(([k, v]) => {
    if (!merged[k]) merged[k] = v;
    else {
      merged[k] = {
        ...merged[k],
        wins: Math.max(merged[k].wins || 0, v.wins || 0),
        games: Math.max(merged[k].games || 0, v.games || 0),
        summits: Math.max(merged[k].summits || 0, v.summits || 0),
        bestStep: Math.max(merged[k].bestStep || 0, v.bestStep || 0),
        totalSteps: Math.max(merged[k].totalSteps || 0, v.totalSteps || 0),
        soloWins: Math.max(merged[k].soloWins || 0, v.soloWins || 0),
        avatar: v.avatar || merged[k].avatar || 1,
        name: v.name || merged[k].name || k,
      };
    }
  });
  const list = Object.values(merged);
  const key = sortBy === "summit" ? "summits" : sortBy === "steps" ? "bestStep" : "wins";
  list.sort((a, b) => (b[key] || 0) - (a[key] || 0) || (b.wins || 0) - (a.wins || 0));
  return list.slice(0, 25);
}

let currentLbSort = "wins";
async function renderLeaderboard(sortBy) {
  currentLbSort = sortBy || currentLbSort;
  document.querySelectorAll(".lbTab").forEach((t) => {
    t.classList.toggle("active", t.dataset.lb === currentLbSort);
  });
  const listEl = $("leaderboardList");
  const hint = $("lbHint");
  if (hint) hint.textContent = "Φόρτωση…";
  if (listEl) listEl.innerHTML = "";
  const rows = await fetchLeaderboard(currentLbSort);
  if (!listEl) return;
  if (!rows.length) {
    if (hint) hint.textContent = "Δεν υπάρχουν ακόμη αποτελέσματα. Παίξε για να μπεις στην κατάταξη!";
    return;
  }
  if (hint) hint.textContent = "";
  const label = currentLbSort === "summit" ? "κορυφές" : currentLbSort === "steps" ? "σκαλιά" : "νίκες";
  rows.forEach((r, i) => {
    const val = currentLbSort === "summit" ? (r.summits || 0)
      : currentLbSort === "steps" ? (r.bestStep || 0)
      : (r.wins || 0);
    const row = document.createElement("div");
    row.className = "lbRow" + (i < 3 ? " top" + (i + 1) : "");
    row.innerHTML = `
      <span class="lbPos">${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1)}</span>
      <img src="${avatarSrc(r.avatar || 1, "front")}" alt="" onerror="this.style.opacity=0.25">
      <span class="lbName">${escapeHtml(r.name || "Παίκτης")}</span>
      <span class="lbVal">${val} <small>${label}</small></span>
    `;
    listEl.appendChild(row);
  });
}


// ===========================================================================
// Home
// ===========================================================================
function initHome() {
  if (!checkMobile()) return;
  if (!firebaseReady) {
    $("homeError").textContent = "Το online multiplayer χρειάζεται σύνδεση Firebase.";
  }
  if (!window.IQ_BANK) {
    $("homeError").textContent = "Δεν φορτώθηκε το IQ bank (mindclimber_iq_bank.js).";
  }
  showScreen("homeScreen");
}

$("createRoomBtn").addEventListener("click", async () => {
  if (!firebaseReady) return;
  $("homeError").textContent = "";
  const code = await createUniqueRoomCode();
  isHost = true;
  isSolo = false;
  beginSetup(code);
});

$("showJoinBtn").addEventListener("click", () => {
  $("joinRow").classList.toggle("hidden");
});

$("joinRoomBtn").addEventListener("click", async () => {
  if (!firebaseReady) return;
  const code = $("joinCodeInput").value.trim().toUpperCase();
  $("homeError").textContent = "";
  if (code.length < 4) {
    $("homeError").textContent = "Δώσε έναν έγκυρο κωδικό δωματίου.";
    return;
  }
  const snap = await db.ref(`rooms_iq/${code}`).once("value");
  if (!snap.exists()) {
    $("homeError").textContent = "Δεν βρέθηκε δωμάτιο με αυτόν τον κωδικό.";
    return;
  }
  const room = snap.val();
  if (room.status !== "lobby") {
    $("homeError").textContent = "Το παιχνίδι έχει ήδη ξεκινήσει.";
    return;
  }
  const playerCount = room.players ? Object.keys(room.players).length : 0;
  if (playerCount >= MAX_PLAYERS) {
    $("homeError").textContent = "Το δωμάτιο είναι γεμάτο (μέγιστο 5 παίκτες).";
    return;
  }
  isHost = false;
  isSolo = false;
  beginSetup(code);
});

$("soloPlayBtn").addEventListener("click", async () => {
  if (!firebaseReady) return;
  $("homeError").textContent = "";
  const code = await createUniqueRoomCode();
  isHost = true;
  isSolo = true;
  beginSetup(code);
});

async function createUniqueRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const snap = await db.ref(`rooms_iq/${code}`).once("value");
    if (!snap.exists()) return code;
  }
  return uid().toUpperCase().slice(0, 5);
}

// ===========================================================================
// Setup
// ===========================================================================
function beginSetup(code) {
  currentRoomCode = code;
  $("roomCodeBadge").textContent = code;
  selectedAvatar = null;
  $("setupError").textContent = "";
  $("playerNameInput").value = "";
  $("avatarPickedTag").classList.add("hidden");
  buildAvatarGrid();
  showScreen("setupScreen");
  watchTakenAvatars();
}

function buildAvatarGrid() {
  const grid = $("avatarGrid");
  grid.innerHTML = "";
  for (let i = 1; i <= AVATAR_COUNT; i++) {
    const div = document.createElement("div");
    div.className = "avatarOption";
    div.dataset.avatar = i;
    div.innerHTML = `<img src="${avatarSrc(i, "front")}" alt="avatar${i}" onerror="this.parentElement.style.opacity=0.3">`;
    div.addEventListener("click", () => {
      if (div.classList.contains("taken")) return;
      grid.querySelectorAll(".avatarOption").forEach((el) => el.classList.remove("selected"));
      div.classList.add("selected");
      selectedAvatar = i;
      $("avatarPickedTag").classList.remove("hidden");
    });
    grid.appendChild(div);
  }
}

let takenAvatarsRef = null;
function watchTakenAvatars() {
  if (takenAvatarsRef) takenAvatarsRef.off();
  takenAvatarsRef = db.ref(`rooms_iq/${currentRoomCode}/players`);
  takenAvatarsRef.on("value", (snap) => {
    const players = snap.val() || {};
    const taken = new Set(
      Object.entries(players)
        .filter(([pid]) => pid !== myPlayerId)
        .map(([, p]) => p.avatar)
    );
    document.querySelectorAll("#avatarGrid .avatarOption").forEach((el) => {
      const n = Number(el.dataset.avatar);
      el.classList.toggle("taken", taken.has(n) && n !== selectedAvatar);
    });
  });
}

$("confirmSetupBtn").addEventListener("click", async () => {
  const name = $("playerNameInput").value.trim() || "Παίκτης";
  if (!selectedAvatar) {
    $("setupError").textContent = "Επίλεξε ένα avatar.";
    return;
  }
  $("setupError").textContent = "";

  const roomBase = `rooms_iq/${currentRoomCode}`;
  if (isHost) {
    await db.ref(roomBase).set({
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      hostId: myPlayerId,
      status: "lobby",
      maxSteps: MAX_STEPS,
      solo: isSolo,
      mode: "iq",
      players: {
        [myPlayerId]: {
          name, avatar: selectedAvatar, step: 0, order: 0,
          timeLeft: PLAYER_SECONDS, eliminated: false,
          joinedAt: firebase.database.ServerValue.TIMESTAMP
        },
      },
    });
  } else {
    const snap = await db.ref(`${roomBase}/players`).once("value");
    const players = snap.val() || {};
    const order = Object.keys(players).length;
    if (order >= MAX_PLAYERS) {
      $("setupError").textContent = "Το δωμάτιο είναι γεμάτο.";
      return;
    }
    await db.ref(`${roomBase}/players/${myPlayerId}`).set({
      name, avatar: selectedAvatar, step: 0, order,
      timeLeft: PLAYER_SECONDS, eliminated: false,
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  if (takenAvatarsRef) { takenAvatarsRef.off(); takenAvatarsRef = null; }

  if (isSolo) {
    await startSoloGame();
  } else {
    enterLobby();
  }
});

async function startSoloGame() {
  const updates = await buildSoloTurn(myPlayerId, 0);
  await db.ref(`rooms_iq/${currentRoomCode}`).update({
    status: "playing",
    startedAt: firebase.database.ServerValue.TIMESTAMP,
    turnOrder: [myPlayerId],
    turnIndex: 0,
    [`players/${myPlayerId}/timeLeft`]: PLAYER_SECONDS,
    [`players/${myPlayerId}/eliminated`]: false,
    ...updates,
  });
  showScreen("gameScreen");
  attachRoomListener();
}

// ===========================================================================
// Lobby
// ===========================================================================
function enterLobby() {
  $("lobbyCodeBadge").textContent = currentRoomCode;
  showScreen("lobbyScreen");
  attachRoomListener();
}

function renderLobby(room) {
  const players = room.players || {};
  const list = Object.entries(players).sort((a, b) => a[1].order - b[1].order);
  const container = $("lobbyPlayerList");
  container.innerHTML = "";
  list.forEach(([pid, p]) => {
    const row = document.createElement("div");
    row.className = "lobbyPlayerRow";
    row.innerHTML = `
      <img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.opacity=0.3">
      <span class="pname">${escapeHtml(p.name)}</span>
      ${pid === room.hostId ? '<span class="hostTag">HOST</span>' : ""}
      ${pid === myPlayerId ? '<span class="youTag">Εσύ</span>' : ""}
    `;
    container.appendChild(row);
  });
  const count = list.length;
  $("lobbyHint").textContent =
    count < 2 ? "Χρειάζονται τουλάχιστον 2 παίκτες για έναρξη." : `${count}/${MAX_PLAYERS} παίκτες συνδεδεμένοι.`;
  $("startGameBtn").classList.toggle("hidden", !(isHost && count >= 2));
}

$("startGameBtn").addEventListener("click", async () => {
  if (!latestRoom) return;
  const players = latestRoom.players || {};
  const turnOrder = Object.entries(players)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([pid]) => pid);
  const shuffledQueues = latestRoom.shuffledQueues || {};
  const resetPlayers = {};
  Object.entries(players).forEach(([pid, p]) => {
    resetPlayers[pid] = { ...p, timeLeft: PLAYER_SECONDS, eliminated: false, step: 0, finishedAt: null };
  });
  playStartSound();
  await db.ref(`rooms_iq/${currentRoomCode}`).update({
    status: "playing",
    startedAt: firebase.database.ServerValue.TIMESTAMP,
    turnOrder,
    turnIndex: 0,
    shuffledQueues,
    players: resetPlayers,
    turn: {
      colorPickerId: turnOrder[0],
      phase: "difficulty",
      key: uid(),
      phaseDeadline: Date.now() + DIFFICULTY_CHOICE_SECONDS * 1000,
    },
  });
});

$("leaveLobbyBtn").addEventListener("click", async () => {
  try { await db.ref(`rooms_iq/${currentRoomCode}/players/${myPlayerId}`).remove(); } catch (e) {}
  detachRoomListener();
  currentRoomCode = null;
  showScreen("homeScreen");
});

// ===========================================================================
// Room listener
// ===========================================================================
function attachRoomListener() {
  if (roomListenerAttached) return;
  roomRef = db.ref(`rooms_iq/${currentRoomCode}`);
  roomRef.on("value", (snap) => {
    const room = snap.val();
    if (!room) return;
    latestRoom = room;
    if (room.status === "lobby") {
      renderLobby(room);
      showScreen("lobbyScreen");
    } else if (room.status === "playing") {
      showScreen("gameScreen");
      renderGame(room);
    } else if (room.status === "finished") {
      showScreen("resultsScreen");
      renderResults(room);
    }
  });
  roomListenerAttached = true;
}
function detachRoomListener() {
  if (roomRef) roomRef.off();
  roomListenerAttached = false;
  latestRoom = null;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ===========================================================================
// Staircase
// ===========================================================================
let staircaseBuilt = false;
function buildStaircase() {
  if (staircaseBuilt) return;
  staircaseBuilt = true;
  const peakLabel = $("peakStepLabel");
  if (peakLabel) peakLabel.textContent = MAX_STEPS;
  const wrap = $("stairLines");
  wrap.innerHTML = "";
  const labelSteps = new Set([1]);
  for (let s = 5; s <= MAX_STEPS; s += 5) labelSteps.add(s);
  if (!labelSteps.has(MAX_STEPS)) labelSteps.add(MAX_STEPS);
  for (let step = 1; step <= MAX_STEPS; step++) {
    const pos = stepPosition(step, 2);
    const line = document.createElement("div");
    line.className = "stepRung" + (labelSteps.has(step) ? " major" : "");
    line.style.bottom = pos.bottom + "%";
    wrap.appendChild(line);
    if (labelSteps.has(step)) {
      const label = document.createElement("div");
      label.className = "stepRungLabel";
      label.style.bottom = pos.bottom + "%";
      label.textContent = step;
      wrap.appendChild(label);
    }
  }
}

const STEP_TOP_BOTTOM = 88;
const PEAK_BOTTOM_OFFSET = 5;

function stepPosition(step, orderIndex) {
  const baseBottom = 7;
  const topBottom = STEP_TOP_BOTTOM;
  const bottom = baseBottom + (step / MAX_STEPS) * (topBottom - baseBottom);
  const jitter = (orderIndex - 2) * 15;
  const left = Math.min(90, Math.max(10, 50 + jitter));
  return { bottom, left, size: 34 };
}

function formatTimeLeft(seconds) {
  const t = Math.max(0, Math.round(seconds ?? PLAYER_SECONDS));
  const mm = Math.floor(t / 60);
  const ss = String(t % 60).padStart(2, "0");
  return `⏱ ${mm}:${ss}`;
}

function computeLiveTimeLeft(pid, p, room) {
  if (!p || p.eliminated) return 0;
  const stored = p.timeLeft ?? PLAYER_SECONDS;
  const turn = room.turn || {};
  if (turn.phase === "question" && turn.deadline && !(turn.answers && turn.answers[pid])) {
    const totalSeconds = QUESTION_SECONDS;
    const questionStart = turn.deadline - totalSeconds * 1000;
    const elapsed = Math.min(totalSeconds, Math.max(0, (Date.now() - questionStart) / 1000));
    return Math.max(0, stored - elapsed);
  }
  if (turn.phase === "difficulty" && turn.colorPickerId === pid && turn.phaseDeadline) {
    const elapsed = Math.min(DIFFICULTY_CHOICE_SECONDS, Math.max(0, (Date.now() - ((turn.phaseDeadline || Date.now()) - DIFFICULTY_CHOICE_SECONDS * 1000)) / 1000));
    return Math.max(0, stored - elapsed);
  }
  return stored;
}

function renderPlayerTimers(room) {
  const players = room.players || {};
  Object.keys(players).forEach((pid) => {
    const badge = document.querySelector(`.playerToken[data-pid="${pid}"] .tokenTimer`);
    if (!badge) return;
    badge.textContent = formatTimeLeft(computeLiveTimeLeft(pid, players[pid], room));
  });
}

function renderGame(room) {
  buildStaircase();
  const players = room.players || {};
  const order = Object.entries(players).sort((a, b) => a[1].order - b[1].order);

  const peakWrap = $("peakFlags");
  peakWrap.innerHTML = "";
  order.forEach((_, idx) => {
    const pos = stepPosition(MAX_STEPS, idx);
    const flag = document.createElement("span");
    flag.className = "peakFlag";
    flag.style.left = pos.left + "%";
    flag.textContent = "🚩";
    peakWrap.appendChild(flag);
  });
  $("peakMarker").style.bottom = `${STEP_TOP_BOTTOM + PEAK_BOTTOM_OFFSET}%`;

  const tokenWrap = $("playerTokens");
  tokenWrap.innerHTML = "";
  order.forEach(([pid, p], idx) => {
    const pos = stepPosition(p.step || 0, idx);
    const tok = document.createElement("div");
    tok.className = "playerToken" + (p.eliminated ? " eliminated" : "") + ((p.step || 0) < 4 ? " lowStep" : "");
    tok.dataset.pid = pid;
    tok.style.left = pos.left + "%";
    tok.style.bottom = pos.bottom + "%";
    tok.style.width = pos.size + "px";
    tok.style.height = pos.size + "px";
    const isPicker = room.turn && room.turn.colorPickerId === pid;
    if (isPicker) tok.classList.add("active-turn");
    if (pid === myPlayerId) tok.classList.add("is-me");
    tok.innerHTML = `
      <div class="tokenTimer">${formatTimeLeft(computeLiveTimeLeft(pid, p, room))}</div>
      <div class="tokenAvatarWrap"><img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.opacity=0.3"></div>
      <div class="tokenName">${escapeHtml(p.name)}</div>
      <div class="tokenStep">${p.step || 0}</div>
    `;
    tokenWrap.appendChild(tok);
  });

  const turn = room.turn || {};
  const picker = players[turn.colorPickerId];
  $("turnText").textContent = picker
    ? (turn.colorPickerId === myPlayerId ? "Σειρά σου!" : `Σειρά: ${picker.name}`)
    : "—";
  $("turnAvatarMini").innerHTML = picker
    ? `<img src="${avatarSrc(picker.avatar, "front")}" alt="">`
    : "";

  // Phase UI
  $("colorChoiceRow").classList.add("hidden");
  $("waitingNote").classList.add("hidden");
  $("iqPuzzleWrap").classList.add("hidden");
  $("answerRectangle").classList.add("hidden");
  $("allAnswersStatus").classList.add("hidden");
  $("qTimerWrap").classList.add("hidden");
  stopLocalChoiceTimer();
  stopLocalQuestionTimer();

  if (turn.phase === "difficulty") {
    if (turn.colorPickerId === myPlayerId) {
      $("colorChoiceRow").classList.remove("hidden");
      startLocalChoiceTimer(turn);
    } else {
      $("waitingNote").classList.remove("hidden");
      $("waitingNote").textContent = "Περιμένεις να επιλέξει δυσκολία…";
    }
  } else if (turn.phase === "question") {
    $("qTimerWrap").classList.remove("hidden");
    $("iqPuzzleWrap").classList.remove("hidden");
    $("answerRectangle").classList.remove("hidden");
    $("allAnswersStatus").classList.remove("hidden");
    renderQuestion(turn);
    startLocalQuestionTimer(turn);
    renderAnswerStatuses(room);
  } else if (turn.phase === "result") {
    $("iqPuzzleWrap").classList.remove("hidden");
    $("answerRectangle").classList.remove("hidden");
    $("allAnswersStatus").classList.remove("hidden");
    renderQuestion(turn, true);
    renderAnswerStatuses(room);
  }

  renderPlayerTimers(room);
  checkTurnProgress(room);
}

function scaleHtmlContent(container, html) {
  container.innerHTML = html || "";
  const wrap = container.parentElement; // #iqPuzzleWrap, which carries the real size cap
  function fit() {
    // Only scale the actual top-level puzzle element(s) - not every nested
    // div inside it (cells, shape wrappers, etc.) - re-scaling nested
    // children after their parent is already scaled caused compounding,
    // inconsistent measurements. Puzzle HTML starts with a <style> tag
    // followed by the real content, so skip past any <style>/<script>
    // elements to find the actual visible element to measure and scale.
    let target = null;
    for (const child of container.children) {
      if (child.tagName !== "STYLE" && child.tagName !== "SCRIPT") {
        target = child;
        break;
      }
    }
    if (!target) return;
    target.style.transform = "";
    target.style.transformOrigin = "center top";
    const availW = Math.max(160, (wrap ? wrap.clientWidth : container.clientWidth) - 16);
    const availH = Math.max(100, (wrap ? wrap.clientHeight : container.clientHeight) - 8);
    const r = target.getBoundingClientRect();
    const w = r.width || target.scrollWidth || 0;
    const h = r.height || target.scrollHeight || 0;
    if (w < 20 || h < 20) return;
    const scale = Math.min(availW / w, availH / h, 1);
    if (scale < 0.995) {
      target.style.transform = "scale(" + scale + ")";
    }
  }
  requestAnimationFrame(() => {
    fit();
    // Fonts/nested styles can settle a frame or two late on some devices -
    // re-measure once more shortly after to correct any initial mis-fit.
    setTimeout(fit, 60);
  });
}

function renderQuestion(turn, showResult) {
  const q = turn.question || {};
  scaleHtmlContent($("iqPuzzle"), q.text || "");

  const opts = q.options || ["", "", ""];
  ["A", "B", "C"].forEach((letter, i) => {
    const el = $("opt" + letter);
    if (!el) return;
    el.innerHTML = opts[i] || "";
    el.style.transform = "";
    requestAnimationFrame(() => {
      try {
        const wrap = el.parentElement;
        const child = el.firstElementChild || el.querySelector("svg, div, table");
        if (!child || !wrap) return;
        const maxW = Math.max(80, wrap.clientWidth - 44);
        const maxH = 72;
        const r = child.getBoundingClientRect();
        const w = r.width || 100;
        const h = r.height || 60;
        const s = Math.min(1, maxW / w, maxH / h);
        if (s < 0.99) {
          el.style.transform = "scale(" + s + ")";
          el.style.transformOrigin = "center center";
        }
      } catch (e) {}
    });
  });

  document.querySelectorAll(".answerOption").forEach((el) => {
    el.classList.remove("picked", "correct", "wrong", "disabled");
    if (showResult || (turn.answers && turn.answers[myPlayerId])) {
      el.classList.add("disabled");
      if (el.dataset.option === q.correct) el.classList.add("correct");
      const myAns = turn.answers && turn.answers[myPlayerId];
      if (myAns && myAns.option === el.dataset.option && !myAns.correct) {
        el.classList.add("wrong");
      }
    }
  });
}

function renderAnswerStatuses(room) {
  const wrap = $("allAnswersStatus");
  wrap.innerHTML = "";
  const players = room.players || {};
  const answers = (room.turn && room.turn.answers) || {};
  Object.entries(players).forEach(([pid, p]) => {
    const chip = document.createElement("div");
    let cls = "answerStatusChip";
    let mark = "…";
    if (p.eliminated) { cls += " eliminated-chip"; mark = "—"; }
    else if (answers[pid]) {
      if (answers[pid].correct) { cls += " correct"; mark = "✓"; }
      else { cls += " wrong"; mark = "✗"; }
    } else {
      cls += " waiting";
    }
    chip.className = cls;
    chip.innerHTML = `<img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.display='none'"><span>${escapeHtml(p.name)} ${mark}</span>`;
    wrap.appendChild(chip);
  });
}

// ===========================================================================
// IQ question picking
// ===========================================================================
function fisherYatesShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickFromIqQueue(level, queueState) {
  const pool = (window.IQ_BANK && window.IQ_BANK[level]) || [];
  if (pool.length === 0) {
    return {
      item: { text: "<div style='color:#fff;padding:20px'>Δεν βρέθηκαν παζλ.</div>", options: ["", "", ""], correct: "A", time: 20 },
      newQueueState: queueState || null,
    };
  }
  let order = queueState && queueState.order;
  let pos = queueState && queueState.pos;
  if (!Array.isArray(order) || order.length !== pool.length || typeof pos !== "number" || pos >= order.length) {
    order = fisherYatesShuffle(pool.map((_, i) => i));
    pos = 0;
  }
  const index = order[pos];
  const item = pool[index];
  return {
    item: {
      text: item.q,
      options: item.o,
      correct: item.a,
      time: item.time || QUESTION_SECONDS,
    },
    newQueueState: { order, pos: pos + 1 },
  };
}

function applyTimeDeduction(updates, pid, currentTimeLeft, alreadyEliminated, elapsedSeconds) {
  const newTimeLeft = Math.max(0, (currentTimeLeft ?? PLAYER_SECONDS) - elapsedSeconds);
  updates[`players/${pid}/timeLeft`] = newTimeLeft;
  if (newTimeLeft <= 0 && !alreadyEliminated) updates[`players/${pid}/eliminated`] = true;
  return newTimeLeft;
}

async function buildQuestionTurnUpdates(color) {
  const level = COLOR_TO_LEVEL[color] || "easy";
  const qSnap = await db.ref(`rooms_iq/${currentRoomCode}/shuffledQueues/${level}`).once("value");
  const { item: q, newQueueState } = pickFromIqQueue(level, qSnap.val());
  const secs = q.time || QUESTION_SECONDS;
  return {
    [`shuffledQueues/${level}`]: newQueueState,
    "turn/phase": "question",
    "turn/color": color,
    "turn/level": level,
    "turn/question": { text: q.text, options: q.options, correct: q.correct },
    "turn/deadline": Date.now() + secs * 1000,
    "turn/answers": {},
  };
}

async function buildSoloTurn(pid, step) {
  // Solo: auto-pick difficulty based on height on the mountain
  let color = "green";
  if (step >= 20) color = "orange";
  else if (step >= 10) color = "blue";
  const updates = await buildQuestionTurnUpdates(color);
  updates["turn/colorPickerId"] = pid;
  updates["turn/key"] = uid();
  return updates;
}

async function chooseColor(color, isTimeout) {
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.colorPickerId !== myPlayerId) return;
  if (latestRoom.turn.phase !== "difficulty") return;
  stopLocalChoiceTimer();
  const turn = latestRoom.turn;
  const elapsedSeconds = isTimeout
    ? DIFFICULTY_CHOICE_SECONDS
    : Math.min(DIFFICULTY_CHOICE_SECONDS, Math.max(0, (Date.now() - ((turn.phaseDeadline || Date.now()) - DIFFICULTY_CHOICE_SECONDS * 1000)) / 1000));
  const me = (latestRoom.players || {})[myPlayerId] || {};
  const updates = await buildQuestionTurnUpdates(color);
  applyTimeDeduction(updates, myPlayerId, me.timeLeft, me.eliminated, elapsedSeconds);
  await db.ref(`rooms_iq/${currentRoomCode}`).update(updates);
}
$("greenButton").addEventListener("click", () => chooseColor("green"));
$("blueButton").addEventListener("click", () => chooseColor("blue"));
$("orangeButton").addEventListener("click", () => chooseColor("orange"));

// Choice timer
let localChoiceTimerHandle = null;
function stopLocalChoiceTimer() {
  if (localChoiceTimerHandle) {
    clearInterval(localChoiceTimerHandle);
    localChoiceTimerHandle = null;
  }
  const w = $("choiceTimerWrap");
  if (w) w.classList.add("hidden");
}
function startLocalChoiceTimer(turn) {
  stopLocalChoiceTimer();
  $("choiceTimerWrap").classList.remove("hidden");
  const windowSeconds = DIFFICULTY_CHOICE_SECONDS;
  const deadline = turn.phaseDeadline || Date.now() + windowSeconds * 1000;
  function tick() {
    const remainMs = deadline - Date.now();
    const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
    $("choiceTimerNum").textContent = remainSec;
    $("choiceTimerFill").style.width = `${Math.max(0, (remainMs / (windowSeconds * 1000)) * 100)}%`;
    if (remainMs <= 0) {
      clearInterval(localChoiceTimerHandle);
      localChoiceTimerHandle = null;
      const colors = ["green", "blue", "orange"];
      chooseColor(colors[Math.floor(Math.random() * colors.length)], true);
    }
  }
  tick();
  localChoiceTimerHandle = setInterval(tick, 200);
}

// Question timer
function stopLocalQuestionTimer() {
  if (localQuestionTimerHandle) {
    clearInterval(localQuestionTimerHandle);
    localQuestionTimerHandle = null;
  }
}
function startLocalQuestionTimer(turn) {
  stopLocalQuestionTimer();
  const deadline = turn.deadline || Date.now() + QUESTION_SECONDS * 1000;
  const totalMs = Math.max(1000, deadline - (Date.now() - 50));
  function tick() {
    const remainMs = deadline - Date.now();
    const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
    $("qTimerNum").textContent = remainSec;
    $("qTimerFill").style.width = `${Math.max(0, (remainMs / (QUESTION_SECONDS * 1000)) * 100)}%`;
    if (remainMs <= 0) {
      clearInterval(localQuestionTimerHandle);
      localQuestionTimerHandle = null;
    }
  }
  tick();
  localQuestionTimerHandle = setInterval(tick, 200);
}

// Safety: force pick if stalled
let forcedPickForKey = null;
async function forceRandomPickForStalledPicker(turn) {
  const marker = turn.key + ":" + turn.phase;
  if (forcedPickForKey === marker) return;
  forcedPickForKey = marker;
  const snap = await db.ref(`rooms_iq/${currentRoomCode}`).once("value");
  const room = snap.val();
  if (!room || !room.turn || room.turn.key !== turn.key || room.turn.phase !== turn.phase) return;
  const pid = room.turn.colorPickerId;
  const me = (room.players || {})[pid] || {};
  const updates = {};
  applyTimeDeduction(updates, pid, me.timeLeft, me.eliminated, DIFFICULTY_CHOICE_SECONDS);
  const colors = ["green", "blue", "orange"];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const level = COLOR_TO_LEVEL[color];
  const qSnap = await db.ref(`rooms_iq/${currentRoomCode}/shuffledQueues/${level}`).once("value");
  const { item: q, newQueueState } = pickFromIqQueue(level, qSnap.val());
  updates[`shuffledQueues/${level}`] = newQueueState;
  updates["turn/phase"] = "question";
  updates["turn/color"] = color;
  updates["turn/level"] = level;
  updates["turn/question"] = { text: q.text, options: q.options, correct: q.correct };
  updates["turn/deadline"] = Date.now() + (q.time || QUESTION_SECONDS) * 1000;
  updates["turn/answers"] = {};
  await db.ref(`rooms_iq/${currentRoomCode}`).update(updates);
}

// Answers
$("answerRectangle").addEventListener("click", (e) => {
  const opt = e.target.closest(".answerOption");
  if (!opt || opt.classList.contains("disabled")) return;
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.phase !== "question") return;
  const answers = latestRoom.turn.answers || {};
  if (answers[myPlayerId]) return;
  submitAnswer(opt.dataset.option);
});

async function submitAnswer(pickedOption) {
  if (!latestRoom || !latestRoom.turn) return;
  const turn = latestRoom.turn;
  if (turn.phase !== "question") return;
  if (turn.answers && turn.answers[myPlayerId]) return;
  stopLocalQuestionTimer();

  const correct = pickedOption === turn.question.correct;
  if (correct) playSuccessSound(); else playFailureSound();

  const delta = COLOR_DELTA[turn.color] * (correct ? 1 : -1);
  const players = latestRoom.players || {};
  const me = players[myPlayerId] || { step: 0 };
  const newStep = Math.max(0, Math.min(MAX_STEPS, (me.step || 0) + delta));
  const reachedSummit = newStep >= MAX_STEPS;

  const updates = {
    [`players/${myPlayerId}/step`]: newStep,
    [`turn/answers/${myPlayerId}`]: { option: pickedOption, correct },
  };

  const totalSeconds = QUESTION_SECONDS;
  const questionStart = turn.deadline - totalSeconds * 1000;
  const elapsedSeconds = Math.min(totalSeconds, Math.max(0, (Date.now() - questionStart) / 1000));
  applyTimeDeduction(updates, myPlayerId, me.timeLeft, me.eliminated, elapsedSeconds);

  if (reachedSummit && !me.finishedAt) {
    updates[`players/${myPlayerId}/finishedAt`] = firebase.database.ServerValue.TIMESTAMP;
  }

  await db.ref(`rooms_iq/${currentRoomCode}`).update(updates);

  if (reachedSummit) {
    const snap = await db.ref(`rooms_iq/${currentRoomCode}`).once("value");
    const freshRoom = snap.val();
    if (freshRoom && freshRoom.status === "playing") await finishGame(freshRoom, myPlayerId);
  }
}

// Turn progression
let resultScheduledForKey = null;
let advancedForKey = null;
let advanceInFlightForKey = null;

async function checkTurnProgress(room) {
  const turn = room.turn;
  if (!turn || room.status !== "playing") return;

  if (turn.phase === "question") {
    const players = room.players || {};
    const activePids = Object.keys(players).filter((pid) => !players[pid].eliminated);
    const answers = turn.answers || {};
    const answeredCount = activePids.filter((pid) => answers[pid]).length;
    const timedOut = Date.now() >= turn.deadline + 1200;

    if (answeredCount >= activePids.length || timedOut) {
      const updates = {};
      const totalSeconds = QUESTION_SECONDS;
      activePids.forEach((pid) => {
        if (!answers[pid]) {
          const delta = -COLOR_DELTA[turn.color];
          const newStep = Math.max(0, Math.min(MAX_STEPS, (players[pid].step || 0) + delta));
          updates[`players/${pid}/step`] = newStep;
          updates[`turn/answers/${pid}`] = { option: null, correct: false };
          applyTimeDeduction(updates, pid, players[pid].timeLeft, players[pid].eliminated, totalSeconds);
        }
      });
      updates["turn/phase"] = "result";
      updates["turn/resultAt"] = Date.now();
      if (Object.keys(updates).length) await db.ref(`rooms_iq/${currentRoomCode}`).update(updates);
    }
  } else if (turn.phase === "result" && resultScheduledForKey !== turn.key) {
    resultScheduledForKey = turn.key;
    setTimeout(() => advanceTurnIfNeeded(turn.key), RESULT_PAUSE_MS);
  }

  if (turn.phase === "difficulty" && turn.phaseDeadline && Date.now() >= turn.phaseDeadline + 2000) {
    forceRandomPickForStalledPicker(turn);
  }
}

async function advanceTurnIfNeeded(turnKey) {
  if (advancedForKey === turnKey) return;
  if (advanceInFlightForKey === turnKey) return;
  advanceInFlightForKey = turnKey;
  try {
    const snap = await db.ref(`rooms_iq/${currentRoomCode}`).once("value");
    const room = snap.val();
    if (!room || room.status !== "playing") return;
    if (!room.turn || room.turn.key !== turnKey) return;
    const isOwner = room.turn.colorPickerId === myPlayerId;
    const isFallbackHost = isHost && Date.now() >= (room.turn.resultAt || 0) + RESULT_PAUSE_MS * 3;
    if (!isOwner && !isFallbackHost) return;
    advancedForKey = turnKey;

    const players = room.players || {};
    const order = room.turnOrder || [];
    const anyActive = order.some((pid) => !(players[pid] || {}).eliminated);
    if (!anyActive) {
      await finishGame(room, null);
      return;
    }

    const currentIdx = order.indexOf(room.turn.colorPickerId);
    let nextIndex = currentIdx;
    for (let i = 1; i <= order.length; i++) {
      const cand = (currentIdx + i) % order.length;
      if (!(players[order[cand]] || {}).eliminated) {
        nextIndex = cand;
        break;
      }
    }

    if (room.solo) {
      const pid = order[nextIndex];
      const step = (players[pid] || {}).step || 0;
      const updates = await buildSoloTurn(pid, step);
      await db.ref(`rooms_iq/${currentRoomCode}`).update({ turnIndex: nextIndex, ...updates });
      return;
    }

    await db.ref(`rooms_iq/${currentRoomCode}`).update({
      turnIndex: nextIndex,
      turn: {
        colorPickerId: order[nextIndex],
        phase: "difficulty",
        key: uid(),
        phaseDeadline: Date.now() + DIFFICULTY_CHOICE_SECONDS * 1000,
      },
    });
  } finally {
    advanceInFlightForKey = null;
  }
}

function comparePlayers(a, b) {
  const pa = a[1], pb = b[1];
  const reachedA = (pa.step || 0) >= MAX_STEPS;
  const reachedB = (pb.step || 0) >= MAX_STEPS;
  if (reachedA !== reachedB) return reachedA ? -1 : 1;
  if (reachedA && reachedB) {
    const ta = pa.finishedAt || Infinity;
    const tb = pb.finishedAt || Infinity;
    if (ta !== tb) return ta - tb;
  }
  return (pb.step || 0) - (pa.step || 0);
}
function rankPlayers(players) {
  return Object.entries(players).sort(comparePlayers);
}

async function finishGame(room, forcedWinnerId) {
  const players = room.players || {};
  const ranked = rankPlayers(players);
  const winnerId = ranked[0]?.[0] || forcedWinnerId || null;
  await db.ref(`rooms_iq/${currentRoomCode}`).update({ status: "finished", winnerId });

  // Sounds + leaderboard for local player
  try {
    const me = players[myPlayerId];
    if (me) {
      const won = winnerId === myPlayerId;
      const reachedSummit = (me.step || 0) >= MAX_STEPS;
      if (won) playVictorySound();
      const entry = {
        name: me.name || "Παίκτης",
        avatar: me.avatar || 1,
        won,
        reachedSummit,
        step: me.step || 0,
        solo: !!room.solo,
      };
      recordLocalGameResult(entry);
      pushLeaderboardEntry(entry);
    }
  } catch (e) {
    console.warn("post-finish extras failed", e);
  }
}

// Results
function renderResults(room) {
  const players = room.players || {};
  const ranked = rankPlayers(players);
  const winnerEntry = room.winnerId && players[room.winnerId] ? [room.winnerId, players[room.winnerId]] : ranked[0];
  const winner = winnerEntry ? winnerEntry[1] : null;

  $("resultsTitle").textContent = winner
    ? `Νικητής: ${winner.name}! 🎉`
    : "Τέλος Παιχνιδιού!";
  if (winner) {
    const img = $("winnerAvatarImg");
    if (img) { img.style.display = ""; img.src = avatarSrc(winner.avatar, "front"); }
  }

  const list = $("rankingList");
  list.innerHTML = "";
  ranked.forEach(([pid, p], i) => {
    const row = document.createElement("div");
    row.className = "rankRow" + (room.winnerId === pid ? " winner" : "");
    row.innerHTML = `
      <span class="rpos">#${i + 1}</span>
      <img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.opacity=0.3">
      <span class="rname">${escapeHtml(p.name)}${pid === myPlayerId ? " (Εσύ)" : ""}</span>
      <span class="rstep">${p.step || 0}/${MAX_STEPS}</span>
    `;
    list.appendChild(row);
  });
  $("playAgainBtn").classList.toggle("hidden", !isHost);

  const note = $("lbPersonalNote");
  if (note) {
    const me = players[myPlayerId];
    if (me) {
      const local = loadLocalStats()[me.name] || {};
      note.textContent = `Οι νίκες σου: ${local.wins || 0} · Κορυφές: ${local.summits || 0} · Ρεκόρ: ${local.bestStep || me.step || 0}/${MAX_STEPS}`;
    } else {
      note.textContent = "";
    }
  }
}

$("playAgainBtn").addEventListener("click", async () => {
  if (!isHost || !latestRoom) return;
  const players = latestRoom.players || {};
  const resetPlayers = {};
  Object.entries(players).forEach(([pid, p]) => {
    resetPlayers[pid] = { ...p, step: 0, finishedAt: null, timeLeft: PLAYER_SECONDS, eliminated: false };
  });
  resultScheduledForKey = null;
  advancedForKey = null;

  if (latestRoom.solo) {
    const pid = Object.keys(players)[0];
    const soloUpdates = await buildSoloTurn(pid, 0);
    await db.ref(`rooms_iq/${currentRoomCode}`).update({
      status: "playing",
      startedAt: firebase.database.ServerValue.TIMESTAMP,
      players: resetPlayers,
      turnOrder: [pid],
      turnIndex: 0,
      winnerId: null,
      ...soloUpdates,
    });
    return;
  }

  await db.ref(`rooms_iq/${currentRoomCode}`).update({
    status: "lobby",
    players: resetPlayers,
    turn: null,
    turnIndex: 0,
    turnOrder: null,
    startedAt: null,
    winnerId: null,
  });
});

$("backHomeBtn").addEventListener("click", async () => {
  try { await db.ref(`rooms_iq/${currentRoomCode}/players/${myPlayerId}`).remove(); } catch (e) {}
  detachRoomListener();
  currentRoomCode = null;
  showScreen("homeScreen");
});

// Live timer refresh
setInterval(() => {
  if (latestRoom && latestRoom.status === "playing") renderPlayerTimers(latestRoom);
}, 1000);


// Leaderboard UI
const showLbBtn = $("showLeaderboardBtn");
if (showLbBtn) showLbBtn.addEventListener("click", () => {
  playClickSound();
  showScreen("leaderboardScreen");
  renderLeaderboard(currentLbSort);
});
const closeLbBtn = $("closeLeaderboardBtn");
if (closeLbBtn) closeLbBtn.addEventListener("click", () => {
  playClickSound();
  showScreen("homeScreen");
});
document.querySelectorAll(".lbTab").forEach((tab) => {
  tab.addEventListener("click", () => {
    playClickSound();
    renderLeaderboard(tab.dataset.lb);
  });
});

// Soft click sounds on main buttons
["createRoomBtn","showJoinBtn","joinRoomBtn","soloPlayBtn","confirmSetupBtn","startGameBtn","playAgainBtn","backHomeBtn"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("click", () => playClickSound());
});
["greenButton","blueButton","orangeButton"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("click", () => playClickSound());
});

// Boot
initHome();

