/* ==========================================================================
   MindClimber Online — Παιχνίδι Γνώσεων (multiplayer)
   Uses window.QUESTION_BANK + window.QUESTION_CATEGORIES
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
const QUESTION_SECONDS = 15;
const QUESTION_SECONDS_EXTRA_DEFAULT = 3;
const QUESTION_SECONDS_EXTRA_PUZZLES = 6;
function questionSecondsFor(category) {
  // Η κατηγορία «Σπαζοκεφαλιές» καταργήθηκε, οπότε ο επιπλέον χρόνος δεν ισχύει πια.
  return QUESTION_SECONDS + QUESTION_SECONDS_EXTRA_DEFAULT;
}
const PLAYER_SECONDS = 260;
const CATEGORY_CHOICE_SECONDS = 8;
const DIFFICULTY_CHOICE_SECONDS = 6;
const AVATAR_COUNT = 12;
const COLOR_DELTA = { green: 1, blue: 2, orange: 3 };
const COLOR_TO_DIFF = { green: "easy", blue: "medium", orange: "hard" };
const RESULT_PAUSE_MS = 2200;

let isMuted = localStorage.getItem("mc_muted") === "1";
function setMuted(val) {
  isMuted = val;
  localStorage.setItem("mc_muted", val ? "1" : "0");
  const btn = $("muteToggleBtn");
  if (btn) { btn.textContent = isMuted ? "🔇" : "🔊"; btn.classList.toggle("isMuted", isMuted); }
}
function vibrate(pattern) {
  if (isMuted) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }
  return audioCtx;
}
function playTone(freqStart, freqEnd, durationMs, type) {
  if (isMuted) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "sine";
  const now = ctx.currentTime;
  osc.frequency.setValueAtTime(freqStart, now);
  osc.frequency.linearRampToValueAtTime(freqEnd, now + durationMs / 1000);
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + durationMs / 1000 + 0.02);
}
function playSuccessSound() {
  playTone(523, 784, 90, "sine");
  setTimeout(() => playTone(784, 1046, 140, "sine"), 90);
}
function playFailureSound() {
  playTone(260, 110, 320, "sawtooth");
}

let db = null;
let firebaseReady = false;
try {
  if (FIREBASE_CONFIG.apiKey && !String(FIREBASE_CONFIG.apiKey).startsWith("PASTE_")) {
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
let myPlayerId = sessionStorage.getItem("mc_playerId");
if (!myPlayerId) {
  myPlayerId = uid();
  sessionStorage.setItem("mc_playerId", myPlayerId);
}

const $ = (id) => document.getElementById(id);
const screens = ["desktopBlock", "homeScreen", "setupScreen", "lobbyScreen", "gameScreen", "resultsScreen"];
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
let localChoiceTimerHandle = null;
let myPlayerRef = null;
let playingDisconnectRegistered = false;

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

function initHome() {
  if (!checkMobile()) return;
  setMuted(isMuted);
  if (!firebaseReady) {
    $("homeError").textContent = "Το online multiplayer χρειάζεται σύνδεση Firebase.";
  } else if (!window.QUESTION_BANK) {
    $("homeError").textContent = "Δεν φορτώθηκε το questions_data.js.";
  } else {
    $("homeError").textContent = "";
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
$("showJoinBtn").addEventListener("click", () => $("joinRow").classList.toggle("hidden"));
$("joinRoomBtn").addEventListener("click", async () => {
  if (!firebaseReady) return;
  const code = $("joinCodeInput").value.trim().toUpperCase();
  $("homeError").textContent = "";
  if (code.length < 4) { $("homeError").textContent = "Δώσε έγκυρο κωδικό."; return; }
  const snap = await db.ref(`rooms/${code}`).once("value");
  if (!snap.exists()) { $("homeError").textContent = "Δεν βρέθηκε δωμάτιο."; return; }
  const room = snap.val();
  if (room.status !== "lobby") { $("homeError").textContent = "Το παιχνίδι έχει ήδη ξεκινήσει."; return; }
  if (room.players && Object.keys(room.players).length >= MAX_PLAYERS) {
    $("homeError").textContent = "Το δωμάτιο είναι γεμάτο."; return;
  }
  isHost = false; isSolo = false; beginSetup(code);
});
$("soloPlayBtn").addEventListener("click", async () => {
  if (!firebaseReady) return;
  $("homeError").textContent = "";
  const code = await createUniqueRoomCode();
  isHost = true; isSolo = true; beginSetup(code);
});

async function createUniqueRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const snap = await db.ref(`rooms/${code}`).once("value");
    if (!snap.exists()) return code;
  }
  return uid().toUpperCase().slice(0, 5);
}

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
    div.innerHTML = `<img src="${avatarSrc(i, "front")}" alt="avatar${i}" onerror="this.parentElement.style.opacity=0.35">`;
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
  takenAvatarsRef = db.ref(`rooms/${currentRoomCode}/players`);
  takenAvatarsRef.on("value", (snap) => {
    const players = snap.val() || {};
    const taken = new Set(Object.entries(players).filter(([pid]) => pid !== myPlayerId).map(([, p]) => p.avatar));
    document.querySelectorAll("#avatarGrid .avatarOption").forEach((el) => {
      const n = Number(el.dataset.avatar);
      el.classList.toggle("taken", taken.has(n) && n !== selectedAvatar);
    });
  });
}

$("confirmSetupBtn").addEventListener("click", async () => {
  const name = $("playerNameInput").value.trim() || "Παίκτης";
  if (!selectedAvatar) { $("setupError").textContent = "Επίλεξε avatar."; return; }
  $("setupError").textContent = "";
  const roomBase = `rooms/${currentRoomCode}`;
  if (isHost) {
    await db.ref(roomBase).set({
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      hostId: myPlayerId,
      status: "lobby",
      maxSteps: MAX_STEPS,
      solo: isSolo,
      players: {
        [myPlayerId]: { name, avatar: selectedAvatar, step: 0, order: 0, timeLeft: PLAYER_SECONDS, eliminated: false, joinedAt: firebase.database.ServerValue.TIMESTAMP },
      },
    });
  } else {
    const snap = await db.ref(`${roomBase}/players`).once("value");
    const players = snap.val() || {};
    const order = Object.keys(players).length;
    if (order >= MAX_PLAYERS) { $("setupError").textContent = "Γεμάτο."; return; }
    await db.ref(`${roomBase}/players/${myPlayerId}`).set({
      name, avatar: selectedAvatar, step: 0, order, timeLeft: PLAYER_SECONDS, eliminated: false, joinedAt: firebase.database.ServerValue.TIMESTAMP,
    });
  }
  if (takenAvatarsRef) { takenAvatarsRef.off(); takenAvatarsRef = null; }
  myPlayerRef = db.ref(`rooms/${currentRoomCode}/players/${myPlayerId}`);
  playingDisconnectRegistered = false;
  try { await myPlayerRef.onDisconnect().remove(); } catch (e) {}
  if (isSolo) await startSoloGame();
  else enterLobby();
});

// If a player's connection drops mid-game, mark them eliminated instead of
// leaving a ghost turn that stalls the whole room every rotation.
async function registerPlayingDisconnect() {
  if (playingDisconnectRegistered || !myPlayerRef) return;
  playingDisconnectRegistered = true;
  try {
    await myPlayerRef.onDisconnect().cancel();
    await myPlayerRef.onDisconnect().update({ eliminated: true, disconnected: true, timeLeft: 0 });
  } catch (e) {}
}

async function startSoloGame() {
  const updates = await buildSoloTurn(myPlayerId, 0, 0);
  await db.ref(`rooms/${currentRoomCode}`).update({
    status: "playing",
    startedAt: firebase.database.ServerValue.TIMESTAMP,
    turnOrder: [myPlayerId],
    turnIndex: 0,
    soloCatIdx: 0,
    [`players/${myPlayerId}/timeLeft`]: PLAYER_SECONDS,
    [`players/${myPlayerId}/eliminated`]: false,
    ...updates,
  });
  showScreen("gameScreen");
  attachRoomListener();
}

function enterLobby() {
  $("lobbyCodeBadge").textContent = currentRoomCode;
  showScreen("lobbyScreen");
  attachRoomListener();
}

const copyCodeBtn = $("copyCodeBtn");
if (copyCodeBtn) {
  copyCodeBtn.addEventListener("click", async () => {
    if (!currentRoomCode) return;
    try {
      await navigator.clipboard.writeText(currentRoomCode);
    } catch (e) {
      // Clipboard API unavailable — fall back silently, code is already on screen.
    }
    const original = copyCodeBtn.textContent;
    copyCodeBtn.textContent = "✅";
    copyCodeBtn.classList.add("copied");
    setTimeout(() => { copyCodeBtn.textContent = original; copyCodeBtn.classList.remove("copied"); }, 1200);
  });
}

function maybeReassignHost(room) {
  const players = room.players || {};
  if (!room.hostId || players[room.hostId]) return; // host still present
  const remaining = Object.entries(players).sort((a, b) => a[1].order - b[1].order);
  if (!remaining.length) return;
  const candidateId = remaining[0][0];
  if (candidateId !== myPlayerId) return; // only the new host-to-be acts
  const staleHostId = room.hostId;
  db.ref(`rooms/${currentRoomCode}/hostId`).transaction((cur) => (cur === staleHostId ? candidateId : undefined));
}

function renderLobby(room) {
  isHost = room.hostId === myPlayerId;
  maybeReassignHost(room);
  const players = room.players || {};
  const list = Object.entries(players).sort((a, b) => a[1].order - b[1].order);
  const container = $("lobbyPlayerList");
  container.innerHTML = "";
  list.forEach(([pid, p]) => {
    const row = document.createElement("div");
    row.className = "lobbyPlayerRow";
    row.innerHTML = `<img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.opacity=0.3"><span class="pname">${escapeHtml(p.name)}</span>${pid === room.hostId ? '<span class="hostTag">HOST</span>' : ""}${pid === myPlayerId ? '<span class="youTag">Εσύ</span>' : ""}`;
    container.appendChild(row);
  });
  const count = list.length;
  $("lobbyHint").textContent = count < 2 ? "Χρειάζονται τουλάχιστον 2 παίκτες." : `${count}/${MAX_PLAYERS} παίκτες.`;
  $("startGameBtn").classList.toggle("hidden", !(isHost && count >= 2));
}

$("startGameBtn").addEventListener("click", async () => {
  if (!latestRoom) return;
  const players = latestRoom.players || {};
  const turnOrder = Object.entries(players).sort((a, b) => a[1].order - b[1].order).map(([pid]) => pid);
  const shuffledQueues = latestRoom.shuffledQueues || {};
  const resetPlayers = {};
  Object.entries(players).forEach(([pid, p]) => {
    resetPlayers[pid] = { ...p, timeLeft: PLAYER_SECONDS, eliminated: false, step: 0, finishedAt: null };
  });
  await db.ref(`rooms/${currentRoomCode}`).update({
    status: "playing",
    startedAt: firebase.database.ServerValue.TIMESTAMP,
    turnOrder, turnIndex: 0, shuffledQueues, players: resetPlayers,
    turn: { colorPickerId: turnOrder[0], phase: "category", key: uid(), phaseDeadline: Date.now() + CATEGORY_CHOICE_SECONDS * 1000 },
  });
});

$("leaveLobbyBtn").addEventListener("click", async () => {
  try { if (myPlayerRef) await myPlayerRef.onDisconnect().cancel(); } catch (e) {}
  try { await db.ref(`rooms/${currentRoomCode}/players/${myPlayerId}`).remove(); } catch (e) {}
  detachRoomListener();
  currentRoomCode = null;
  myPlayerRef = null;
  showScreen("homeScreen");
});

function attachRoomListener() {
  if (roomListenerAttached) return;
  roomRef = db.ref(`rooms/${currentRoomCode}`);
  roomRef.on("value", (snap) => {
    const room = snap.val();
    if (!room) return;
    latestRoom = room;
    if (room.status === "lobby") { renderLobby(room); showScreen("lobbyScreen"); }
    else if (room.status === "playing") { registerPlayingDisconnect(); showScreen("gameScreen"); renderGame(room); }
    else if (room.status === "finished") { showScreen("resultsScreen"); renderResults(room); }
  });
  roomListenerAttached = true;
}
function detachRoomListener() {
  if (roomRef) roomRef.off();
  roomListenerAttached = false;
  latestRoom = null;
}
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

let staircaseBuilt = false;
let lastStaircasePlayerCount = 0;
// Climb mapping: leave room at bottom so avatar at step 0 is fully visible
// above the question panel. Compress rungs toward the upper band.
const STEP_BASE_BOTTOM = 10.7;   // % — above grass
const STEP_TOP_BOTTOM = 64.4;    // % — leaves room for flag above step 30
const PEAK_BOTTOM_OFFSET = 0;

/** Mountain silhouette widths (% of climb zone) by player count. */
const LANE_SPREAD_TOP = 23.2;    // % — μετρημένο από το artwork στην κορυφή
const LANE_SPREAD_BASE = 36.6;   // % — και στη βάση

const MOUNTAIN_SHAPE = {
  1: { base: 52, top: 12 },
  2: { base: 64, top: 16 },
  3: { base: 76, top: 20 },
  4: { base: 86, top: 24 },
  5: { base: 94, top: 28 },
};

/** Width of one stair tread (under a single player), in % of climb zone */
const TREAD_WIDTH = {
  1: 22,
  2: 16,
  3: 13,
  4: 11,
  5: 9,
};

function mountainWidthAt(step, playerCount) {
  const shape = MOUNTAIN_SHAPE[playerCount] || MOUNTAIN_SHAPE[1];
  const t = Math.max(0, Math.min(1, step / MAX_STEPS));
  return shape.base - t * (shape.base - shape.top);
}

/** Horizontal center of each player lane at a given step */
function laneCenters(step, playerCount) {
  /* Οι σκάλες είναι ζωγραφισμένες στην εικόνα και ανοίγουν σαν βεντάλια όσο
     κατεβαίνουν. Μετρημένο από το artwork: ±21% στην κορυφή, ±36% στη βάση.
     Οι παίκτες πατούν πάντα πάνω σε μία από τις 5 ζωγραφισμένες σκάλες. */
  const count = Math.max(1, Math.min(5, playerCount || 1));
  const t = Math.max(0, Math.min(MAX_STEPS, step)) / MAX_STEPS;   // 0 βάση, 1 κορυφή
  const halfSpread = LANE_SPREAD_BASE + (LANE_SPREAD_TOP - LANE_SPREAD_BASE) * t;
  const grid = [-1, -0.5, 0, 0.5, 1].map(k => 50 + k * halfSpread);
  const PICK = { 1: [2], 2: [1, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] };
  return PICK[count].map(k => grid[k]);
}




/* ── Mountain relief ────────────────────────────────────────────────────────
   Drawn in the same 0-100 percentage space the treads use, so the rock always
   lines up with the lanes no matter how many players there are. A seeded
   pseudo-random generator keeps the ridgeline jagged but identical on every
   render — a re-render must not make the mountain twitch.                    */
function buildMountainSvg(count) {
  const shape = MOUNTAIN_SHAPE[count] || MOUNTAIN_SHAPE[1];
  const baseHalf = shape.base / 2;
  const topHalf  = Math.max(4, shape.top / 2);
  const peakY = 100 - (STEP_TOP_BOTTOM + 9);   // a little headroom for the flag
  const baseY = 100 - 4;

  let seed = 1337 + count * 97;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const lerp = (a, b, t) => a + (b - a) * t;

  /* The rock must always be wider than the staircase carved into it, otherwise
     treads hang off the slope in mid-air. So at every height we take whichever
     is wider: the silhouette, or what the lanes + tread actually need. */
  const treadW = TREAD_WIDTH[count] || 12;
  const neededHalf = (step) => {
    let m = 0;
    laneCenters(step, count).forEach(cx => { m = Math.max(m, Math.abs(cx - 50)); });
    return m + treadW / 2 + 2.5;
  };
  const edge = (sign, jag) => {
    const pts = [];
    const N = 14;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const y = lerp(peakY, baseY, t);
      // t = 0 is the summit, so the matching step counts down from MAX_STEPS
      const step = Math.round((1 - t) * MAX_STEPS);
      const half = Math.max(lerp(topHalf, baseHalf, Math.pow(t, 0.86)), neededHalf(step));
      const wobble = (rnd() - 0.5) * jag * (0.35 + t);
      pts.push([50 + sign * (half + Math.abs(wobble)), y]);
    }
    return pts;
  };
  const P = (pts) => pts.map(p => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");

  const left = edge(-1, 3.2);
  const right = edge(1, 3.2).reverse();
  const massif = `50,${peakY} ${P(left)} ${P(right)}`;

  // shaded half: peak → straight down the spine → back up the right edge
  const spine = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    spine.push([50 + (rnd() - 0.5) * 1.6, lerp(peakY, baseY, t)]);
  }
  const shaded = `50,${peakY} ${P(spine)} ${P(right)}`;

  // snow: the cap plus tongues that run further down the gullies
  const snowBottom = lerp(peakY, baseY, 0.30);
  const sl = [], sr = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    const y = lerp(peakY, snowBottom, t);
    const step = Math.round((1 - t * 0.30) * MAX_STEPS);
    const half = Math.max(lerp(topHalf, lerp(topHalf, baseHalf, 0.30), t), neededHalf(step) * 0.94);
    sl.push([50 - (half + (rnd() - 0.5) * 1.5), y]);
    sr.push([50 + (half + (rnd() - 0.5) * 1.5), y]);
  }
  const tongue = [
    [50 - topHalf * 0.55, snowBottom],
    [50 - topHalf * 0.30, snowBottom + 5.5],
    [50 - topHalf * 0.05, snowBottom + 1.2],
    [50 + topHalf * 0.28, snowBottom + 7.0],
    [50 + topHalf * 0.52, snowBottom + 1.8],
  ];
  const snow = `50,${peakY} ${P(sr)} ${P(tongue.slice().reverse())} ${P(sl.slice().reverse())}`;

  // far ranges — hazy and desaturated so they sit behind
  const range = (yTop, amp, n) => {
    let d = `0,100 0,${yTop + amp}`;
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * 100;
      const y = yTop + Math.abs(Math.sin(i * 1.9 + count)) * amp;
      d += ` ${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return d + ` 100,${yTop + amp} 100,100`;
  };

  return `<svg class="mountainSvg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <linearGradient id="mcLit" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="#9fb6a4"/>
      <stop offset="22%" stop-color="#87a189"/>
      <stop offset="48%" stop-color="#9d8a6b"/>
      <stop offset="76%" stop-color="#8a7454"/>
      <stop offset="100%" stop-color="#6b5940"/>
    </linearGradient>
    <linearGradient id="mcShade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#2f3b39" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#222c2b" stop-opacity="0.52"/>
    </linearGradient>
    <linearGradient id="mcSnow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#ffffff"/>
      <stop offset="70%"  stop-color="#e6eff6"/>
      <stop offset="100%" stop-color="#cfe0ec"/>
    </linearGradient>
  </defs>
  <polygon points="${range(46, 9, 9)}"  fill="#a9c8dc" opacity="0.55"/>
  <polygon points="${range(56, 7, 7)}"  fill="#8fb3cb" opacity="0.6"/>
  <polygon points="${massif}" fill="url(#mcLit)"/>
  <polygon points="${shaded}" fill="url(#mcShade)"/>
  <polygon points="${snow}"   fill="url(#mcSnow)"/>
  <g stroke="#4a4133" stroke-opacity="0.28" fill="none" stroke-linecap="round">
    <path d="M${(50 - topHalf * 0.7).toFixed(1)},${(peakY + 6).toFixed(1)}
             L${(50 - baseHalf * 0.42).toFixed(1)},${lerp(peakY, baseY, 0.55).toFixed(1)}
             L${(50 - baseHalf * 0.58).toFixed(1)},${(baseY - 4).toFixed(1)}" stroke-width="0.7"/>
    <path d="M${(50 + topHalf * 0.6).toFixed(1)},${(peakY + 8).toFixed(1)}
             L${(50 + baseHalf * 0.40).toFixed(1)},${lerp(peakY, baseY, 0.6).toFixed(1)}
             L${(50 + baseHalf * 0.55).toFixed(1)},${(baseY - 3).toFixed(1)}" stroke-width="0.55"/>
  </g>
</svg>`;
}

let mountainsPreloaded = false;
function preloadMountains() {
  if (mountainsPreloaded) return;
  mountainsPreloaded = true;
  for (let i = 1; i <= 5; i++) { const im = new Image(); im.src = `assets/mountains/mountain-${i}.jpg`; }
}

function buildStaircase(playerCount) {
  preloadMountains();
  const count = Math.max(1, Math.min(5, playerCount || 1));
  if (staircaseBuilt && lastStaircasePlayerCount === count) return;
  staircaseBuilt = true;
  lastStaircasePlayerCount = count;

  const climbZone = $("climbZone");
  if (climbZone) {
    climbZone.classList.remove("players-1", "players-2", "players-3", "players-4", "players-5");
    climbZone.classList.add("players-" + count);
    const shape = MOUNTAIN_SHAPE[count] || MOUNTAIN_SHAPE[1];
    climbZone.style.setProperty("--mtn-base", shape.base + "%");
    climbZone.style.setProperty("--mtn-top", (shape.top / shape.base * 50) + "%");
  }

  const peakLabel = $("peakStepLabel");
  if (peakLabel) peakLabel.textContent = MAX_STEPS;

  // Hide ground marker if present
  const ground = $("groundMarker");
  if (ground) ground.style.display = "none";

  const wrap = $("stairLines");
  wrap.innerHTML = "";

  // Το βουνό έρχεται ως background-image από το CSS (κλάση players-N).

  // Grass + flowers (no bird)
  const grass = document.createElement("div");
  grass.className = "grassStrip";
  wrap.appendChild(grass);

  const flowerEmojis = ["🌼", "🌸", "🌺", "🌷", "🌻"];
  const flowerPositions = [6, 16, 28, 58, 72, 84, 93];
  flowerPositions.forEach((left, i) => {
    const f = document.createElement("div");
    f.className = "flower";
    f.style.left = left + "%";
    f.style.animationDelay = (i * 0.4) + "s";
    f.textContent = flowerEmojis[i % flowerEmojis.length];
    wrap.appendChild(f);
  });

  const treadW = TREAD_WIDTH[count] || 12;
  const labelSteps = new Set([10, 20]);

  for (let step = 1; step <= MAX_STEPS; step++) {
    const bottom = STEP_BASE_BOTTOM + (step / MAX_STEPS) * (STEP_TOP_BOTTOM - STEP_BASE_BOTTOM);
    const centers = laneCenters(step, count);
    const isMajor = labelSteps.has(step) || step === MAX_STEPS;

    // Τα πατήματα είναι ήδη ζωγραφισμένα στην εικόνα φόντου, οπότε δεν
    // σχεδιάζουμε δικά μας — μόνο τους δείκτες 10/20 στο πλάι.
    // Labels 10 & 20 glued to the left of the leftmost tread
    if (labelSteps.has(step)) {
      const leftmost = centers[0] - treadW / 2;
      const label = document.createElement("div");
      label.className = "stepRungLabel";
      label.style.bottom = bottom + "%";
      label.style.left = leftmost + "%"; // CSS translate(-100%) pulls it just left of the tread
      label.textContent = step;
      wrap.appendChild(label);
    }
  }
}

/**
 * Position a player token on its lane.
 */
function stepPosition(step, orderIndex, playerCount) {
  const count = Math.max(1, Math.min(5, playerCount || 1));
  const s = Math.max(0, Math.min(MAX_STEPS, step));
  const bottom = STEP_BASE_BOTTOM + (s / MAX_STEPS) * (STEP_TOP_BOTTOM - STEP_BASE_BOTTOM);
  const centers = laneCenters(s, count);
  const left = centers[Math.min(orderIndex, centers.length - 1)];

  const sizeMap = { 1: 44, 2: 38, 3: 34, 4: 30, 5: 27 };
  const size = sizeMap[count] || 34;

  return { bottom, left, size };
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
    const totalSeconds = questionSecondsFor(turn.category);
    const questionStart = turn.deadline - totalSeconds * 1000;
    const elapsed = Math.min(totalSeconds, Math.max(0, (Date.now() - questionStart) / 1000));
    return Math.max(0, stored - elapsed);
  }
  if ((turn.phase === "category" || turn.phase === "difficulty") && turn.colorPickerId === pid && turn.phaseDeadline) {
    const windowSeconds = turn.phase === "category" ? CATEGORY_CHOICE_SECONDS : DIFFICULTY_CHOICE_SECONDS;
    const elapsed = Math.min(windowSeconds, Math.max(0, (Date.now() - ((turn.phaseDeadline || Date.now()) - windowSeconds * 1000)) / 1000));
    return Math.max(0, stored - elapsed);
  }
  return stored;
}

function renderPlayerTimers(room) {
  Object.keys(room.players || {}).forEach((pid) => {
    const badge = document.querySelector(`.playerToken[data-pid="${pid}"] .tokenTimer`);
    if (badge) badge.textContent = formatTimeLeft(computeLiveTimeLeft(pid, room.players[pid], room));
  });
}




function renderGame(room) {
  const players = room.players || {};
  const order = Object.entries(players).sort((a, b) => a[1].order - b[1].order);
  const playerCount = order.length || 1;

  buildStaircase(playerCount);

  // Η κορυφή δείχνει πλέον το χρυσό αγαλματίδιο, που είναι ζωγραφισμένο
  // μέσα στην εικόνα φόντου — δεν χρειάζονται σημαίες.
  const peakWrap = $("peakFlags");
  if (peakWrap.childNodes.length) peakWrap.innerHTML = "";
  $("peakMarker").style.bottom = (STEP_TOP_BOTTOM + 6) + "%";

  const tokenWrap = $("playerTokens");
  tokenWrap.innerHTML = "";
  order.forEach(([pid, p], idx) => {
    const step = p.step || 0;
    const pos = stepPosition(step, idx, playerCount);
    const tok = document.createElement("div");
    const isActive = room.turn && room.turn.colorPickerId === pid;
    // Σωστό/λάθος πάνω στο avatar: φαίνεται μόλις απαντήσει ο παίκτης
    const ans = room.turn && room.turn.answers && room.turn.answers[pid];
    const answeredCls = ans ? (ans.correct ? " answered-correct" : " answered-wrong") : "";
    tok.className = "playerToken" + answeredCls
      + (p.eliminated ? " eliminated" : "")
      + (step < 3 ? " lowStep" : "")
      + (pid === myPlayerId ? " is-me" : "")
      + (isActive ? " active-turn" : "");
    tok.dataset.pid = pid;
    tok.style.left = pos.left + "%";
    tok.style.bottom = pos.bottom + "%";
    tok.style.width = pos.size + "px";
    tok.style.height = pos.size + "px";
    // Compact token: no turn text (turn is shown in the answer-status row)
    tok.innerHTML = `
      <div class="tokenTimer">${formatTimeLeft(computeLiveTimeLeft(pid, p, room))}</div>
      <div class="tokenAvatarWrap"><img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.opacity=0.3">${
        ans ? `<span class="answerMark">${ans.correct ? "✓" : "✗"}</span>` : ""
      }</div>
      <div class="tokenName">${escapeHtml(p.name)}</div>
      <div class="tokenStep">${step}</div>`;
    tokenWrap.appendChild(tok);
  });

  // Top player strip removed (reclaimed vertical space) — the turn
  // indicator now lives in the answer-status row below the question instead.

  const turn = room.turn || {};

  // hide all phase panels
  ["categoryChoiceRow","selectedCategoryLabel","colorChoiceRow","waitingNote","questionRectangle","questionImage","answerRectangle","qTimerWrap","choiceTimerWrap"].forEach((id) => {
    const el = $(id); if (el) el.classList.add("hidden");
  });
  stopLocalChoiceTimer();
  stopLocalQuestionTimer();

  if (turn.phase === "category") {
    if (turn.colorPickerId === myPlayerId) {
      renderCategoryButtons();
      $("categoryChoiceRow").classList.remove("hidden");
      startLocalChoiceTimer(turn, "category");
    } else {
      $("waitingNote").classList.remove("hidden");
      $("waitingNote").textContent = "Περιμένεις επιλογή κατηγορίας…";
    }
  } else if (turn.phase === "difficulty") {
    $("selectedCategoryLabel").textContent = turn.category || "";
    $("selectedCategoryLabel").classList.remove("hidden");
    if (turn.colorPickerId === myPlayerId) {
      $("colorChoiceRow").classList.remove("hidden");
      startLocalChoiceTimer(turn, "difficulty");
    } else {
      $("waitingNote").classList.remove("hidden");
      $("waitingNote").textContent = "Περιμένεις επιλογή δυσκολίας…";
    }
  } else if (turn.phase === "question" || turn.phase === "result") {
    $("qTimerWrap").classList.remove("hidden");
    if (turn.question && turn.question.img) preloadImage(turn.question.img);
    $("selectedCategoryLabel").textContent = (turn.category || "") + (turn.color ? " · " + ({green:"Εύκολο",blue:"Μέτριο",orange:"Δύσκολο"}[turn.color]||"") : "");
    $("selectedCategoryLabel").classList.remove("hidden");
    renderQuestion(turn, turn.phase === "result");
    $("answerRectangle").classList.remove("hidden");
    if (turn.phase === "question") startLocalQuestionTimer(turn);
  }

  // Answer-status row stays visible in every phase now — it doubles as the
  // "whose turn" indicator (gold ring) while nobody has categoryChoiceRow /
  // colorChoiceRow, since the top playerStrip was removed to save space.
  $("allAnswersStatus").classList.remove("hidden");
  renderAnswerStatuses(room);

  renderPlayerTimers(room);
  checkTurnProgress(room);
}

function renderCategoryButtons() {
  const row = $("categoryChoiceRow");
  row.innerHTML = "";
  const cats = window.QUESTION_CATEGORIES || [];
  cats.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = "categoryBtn";
    btn.textContent = cat;
    btn.addEventListener("click", () => chooseCategory(cat));
    row.appendChild(btn);
  });
}

let lastRenderedImgSrc = null;
let lastRenderedQText = null;

function renderQuestion(turn, showResult) {
  const q = turn.question || {};
  const img = $("questionImage");
  const rect = $("questionRectangle");

  // The question text is now ALWAYS shown, even for image questions. Before,
  // an image question hid the prompt entirely, so "Ποιον ήρωα του 1821
  // απεικονίζει αυτή η προσωπογραφία;" arrived as a bare picture — and if the
  // image failed to load the player got a blank box with three options.
  const text = q.text || "";
  if (lastRenderedQText !== text) {
    rect.textContent = text;
    lastRenderedQText = text;
  }
  rect.classList.toggle("hidden", !text);
  rect.classList.toggle("withImage", !!q.img);

  if (q.img) {
    // Only touch .src when it actually changes, otherwise every Firebase
    // update re-decodes (and sometimes re-downloads) the same picture.
    if (lastRenderedImgSrc !== q.img) {
      lastRenderedImgSrc = q.img;
      img.classList.remove("imgFailed");
      img.removeAttribute("src");
      img.alt = text;
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      // Try the local copy in assets/questions_pics first. If it is missing
      // (e.g. download_images.sh has not been run yet) fall back once to the
      // original online address, and only then give up and show text alone.
      let triedFallback = false;
      img.onerror = () => {
        if (!triedFallback && q.imgFallback) {
          triedFallback = true;
          img.src = q.imgFallback;
          return;
        }
        img.classList.add("hidden");
        img.classList.add("imgFailed");
        rect.classList.remove("hidden");
        rect.textContent = text || "Η εικόνα δεν φορτώθηκε.";
      };
      img.onload = () => { img.classList.remove("hidden"); };
      img.src = q.img;
    }
    if (!img.classList.contains("imgFailed")) img.classList.remove("hidden");
  } else {
    img.classList.add("hidden");
    img.removeAttribute("src");
    lastRenderedImgSrc = null;
  }

  const correctLetter = decodeCorrect(q);
  const opts = q.options || ["", "", ""];
  const myAns = turn.answers && turn.answers[myPlayerId];
  const locked = showResult || !!myAns;
  document.querySelectorAll(".answerOption").forEach((el) => {
    const letter = el.dataset.option;
    const i = letter.charCodeAt(0) - 65;
    const label = (letter + ". " + (opts[i] || "")).trim();
    if (el.textContent !== label) el.textContent = label;
    el.classList.remove("picked", "correct", "wrong", "disabled");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", locked ? "-1" : "0");
    if (locked) {
      el.classList.add("disabled");
      if (myAns && myAns.option === letter) el.classList.add("picked");
      if (letter === correctLetter) el.classList.add("correct");
      if (myAns && myAns.option === letter && !myAns.correct) el.classList.add("wrong");
    }
  });
}

// Reconcile in place. The old version wiped innerHTML on every single room
// update, which rebuilt each <img> from scratch — causing avatar flicker and
// repeated image work several times per second during a question.
function renderAnswerStatuses(room) {
  const wrap = $("allAnswersStatus");
  const turn = room.turn || {};
  const answers = turn.answers || {};
  const inAnswerPhase = turn.phase === "question" || turn.phase === "result";
  const activeId = turn.colorPickerId;
  const seen = new Set();

  Object.entries(room.players || {}).forEach(([pid, p]) => {
    seen.add(pid);
    let chip = wrap.querySelector(`.answerStatusChip[data-pid="${pid}"]`);
    if (!chip) {
      chip = document.createElement("div");
      chip.dataset.pid = pid;
      const im = document.createElement("img");
      im.alt = "";
      im.onerror = function () { this.style.display = "none"; };
      im.src = avatarSrc(p.avatar, "front");
      const sp = document.createElement("span");
      chip.appendChild(im);
      chip.appendChild(sp);
      wrap.appendChild(chip);
    }
    let cls = "answerStatusChip", mark = "";
    if (p.eliminated) {
      cls += " eliminated-chip"; mark = "—";
    } else if (inAnswerPhase) {
      if (answers[pid]) { cls += answers[pid].correct ? " correct" : " wrong"; mark = answers[pid].correct ? "✓" : "✗"; }
      else { cls += " waiting"; mark = "…"; }
    }
    if (pid === activeId) cls += " chipActive";
    if (chip.className !== cls) chip.className = cls;
    const label = p.name + (mark ? " " + mark : "");
    const sp = chip.querySelector("span");
    if (sp.textContent !== label) sp.textContent = label;
  });

  wrap.querySelectorAll(".answerStatusChip").forEach((el) => {
    if (!seen.has(el.dataset.pid)) el.remove();
  });
}

// Deterministic PRNG so a whole question order can be rebuilt from one integer.
// Previously the full index array (up to ~300 numbers) was written to Firebase
// on EVERY question and re-downloaded by every client. Now we store {seed,pos}.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function seededOrder(len, seed) {
  const rand = mulberry32(seed);
  const a = new Array(len);
  for (let i = 0; i < len; i++) a[i] = i;
  for (let i = len - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function pickFromShuffledQueue(category, color, queueState) {
  const diffKey = COLOR_TO_DIFF[color] || "easy";
  const pool = (window.QUESTION_BANK && window.QUESTION_BANK[category] && window.QUESTION_BANK[category][diffKey]) || [];
  if (!pool.length) {
    return { item: { text: "Δεν βρέθηκαν ερωτήσεις.", options: ["-", "-", "-"], correct: "A", img: null }, newQueueState: queueState || null };
  }
  let seed = queueState && queueState.seed;
  let pos = queueState && queueState.pos;
  const len = queueState && queueState.len;
  // Reshuffle when the queue is new, exhausted, or the pool size changed
  // (i.e. the question bank was updated since the room was created).
  if (typeof seed !== "number" || typeof pos !== "number" || len !== pool.length || pos >= pool.length) {
    seed = (Math.random() * 4294967295) >>> 0;
    pos = 0;
  }
  const order = seededOrder(pool.length, seed);
  const item = pool[order[pos]];
  return {
    item: { text: item.q, options: item.o, correct: item.a, img: item.img || null, imgFallback: item.imgFallback || null },
    newQueueState: { seed, pos: pos + 1, len: pool.length },
  };
}

function applyTimeDeduction(updates, pid, currentTimeLeft, alreadyEliminated, elapsedSeconds) {
  const newTimeLeft = Math.max(0, (currentTimeLeft ?? PLAYER_SECONDS) - elapsedSeconds);
  updates[`players/${pid}/timeLeft`] = newTimeLeft;
  if (newTimeLeft <= 0 && !alreadyEliminated) updates[`players/${pid}/eliminated`] = true;
  return newTimeLeft;
}

// The answer used to be sent to every client as a plain "A"/"B"/"C", visible to
// anyone who opened the network tab. It is now offset by a per-question key.
// This is obfuscation, not security — a determined player can still decode it —
// but it stops trivial cheating. Real protection needs server-side validation.
function encodeCorrect(letter, key) {
  const i = "ABC".indexOf(letter);
  if (i < 0) return 0;
  return (i + (key % 3) + 3) % 3;
}
function decodeCorrect(question) {
  if (!question) return "A";
  if (typeof question.correct === "string") return question.correct; // legacy rooms
  const key = typeof question.k === "number" ? question.k : 0;
  const c = typeof question.c === "number" ? question.c : 0;
  return "ABC"[((c - (key % 3)) % 3 + 3) % 3];
}

async function buildQuestionTurnUpdates(category, color) {
  const qSnap = await db.ref(`rooms/${currentRoomCode}/shuffledQueues/${category}/${color}`).once("value");
  const { item: q, newQueueState } = pickFromShuffledQueue(category, color, qSnap.val());
  const qKey = (Math.random() * 100000) | 0;
  return {
    [`shuffledQueues/${category}/${color}`]: newQueueState,
    "turn/phase": "question",
    "turn/color": color,
    "turn/category": category,
    "turn/question": { text: q.text, options: q.options, c: encodeCorrect(q.correct, qKey), k: qKey, img: q.img || null, imgFallback: q.imgFallback || null },
    "turn/deadline": Date.now() + questionSecondsFor(category) * 1000,
    "turn/answers": {},
  };
}

// Warm the browser cache for a picture we are about to show.
function preloadImage(url) {
  if (!url) return;
  try { const i = new Image(); i.referrerPolicy = "no-referrer"; i.src = url; } catch (e) {}
}

async function buildSoloTurn(pid, step, catIdx) {
  const cats = window.QUESTION_CATEGORIES || [];
  const category = cats[catIdx % Math.max(1, cats.length)] || cats[0];
  let color = "green";
  if (step >= 20) color = "orange";
  else if (step >= 10) color = "blue";
  const updates = await buildQuestionTurnUpdates(category, color);
  updates["turn/colorPickerId"] = pid;
  updates["turn/key"] = uid();
  updates["soloCatIdx"] = (catIdx + 1) % Math.max(1, cats.length);
  return updates;
}

async function chooseCategory(category, isTimeout) {
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.colorPickerId !== myPlayerId) return;
  if (latestRoom.turn.phase !== "category") return;
  stopLocalChoiceTimer();
  const turn = latestRoom.turn;
  const elapsed = isTimeout ? CATEGORY_CHOICE_SECONDS : Math.min(CATEGORY_CHOICE_SECONDS, Math.max(0, (Date.now() - ((turn.phaseDeadline || Date.now()) - CATEGORY_CHOICE_SECONDS * 1000)) / 1000));
  const me = (latestRoom.players || {})[myPlayerId] || {};
  const updates = {
    "turn/phase": "difficulty",
    "turn/category": category,
    "turn/phaseDeadline": Date.now() + DIFFICULTY_CHOICE_SECONDS * 1000,
  };
  applyTimeDeduction(updates, myPlayerId, me.timeLeft, me.eliminated, elapsed);
  await db.ref(`rooms/${currentRoomCode}`).update(updates);
}

async function chooseColor(color, isTimeout) {
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.colorPickerId !== myPlayerId) return;
  if (latestRoom.turn.phase !== "difficulty") return;
  stopLocalChoiceTimer();
  const turn = latestRoom.turn;
  const elapsed = isTimeout ? DIFFICULTY_CHOICE_SECONDS : Math.min(DIFFICULTY_CHOICE_SECONDS, Math.max(0, (Date.now() - ((turn.phaseDeadline || Date.now()) - DIFFICULTY_CHOICE_SECONDS * 1000)) / 1000));
  const me = (latestRoom.players || {})[myPlayerId] || {};
  const updates = await buildQuestionTurnUpdates(turn.category, color);
  applyTimeDeduction(updates, myPlayerId, me.timeLeft, me.eliminated, elapsed);
  await db.ref(`rooms/${currentRoomCode}`).update(updates);
}
$("greenButton").addEventListener("click", () => chooseColor("green"));
$("blueButton").addEventListener("click", () => chooseColor("blue"));
$("orangeButton").addEventListener("click", () => chooseColor("orange"));

function stopLocalChoiceTimer() {
  if (localChoiceTimerHandle) { clearInterval(localChoiceTimerHandle); localChoiceTimerHandle = null; }
  const w = $("choiceTimerWrap"); if (w) w.classList.add("hidden");
}
function startLocalChoiceTimer(turn, kind) {
  stopLocalChoiceTimer();
  $("choiceTimerWrap").classList.remove("hidden");
  const windowSeconds = kind === "category" ? CATEGORY_CHOICE_SECONDS : DIFFICULTY_CHOICE_SECONDS;
  const deadline = turn.phaseDeadline || Date.now() + windowSeconds * 1000;
  function tick() {
    const remainMs = deadline - Date.now();
    $("choiceTimerNum").textContent = Math.max(0, Math.ceil(remainMs / 1000));
    $("choiceTimerFill").style.width = Math.max(0, (remainMs / (windowSeconds * 1000)) * 100) + "%";
    if (remainMs <= 0) {
      clearInterval(localChoiceTimerHandle); localChoiceTimerHandle = null;
      if (kind === "category") {
        const cats = window.QUESTION_CATEGORIES || [];
        chooseCategory(cats[Math.floor(Math.random() * cats.length)] || "Ιστορία και Μυθολογία", true);
      } else {
        chooseColor(["green","blue","orange"][Math.floor(Math.random()*3)], true);
      }
    }
  }
  tick();
  localChoiceTimerHandle = setInterval(tick, 200);
}

function stopLocalQuestionTimer() {
  if (localQuestionTimerHandle) { clearInterval(localQuestionTimerHandle); localQuestionTimerHandle = null; }
}
function startLocalQuestionTimer(turn) {
  stopLocalQuestionTimer();
  const total = questionSecondsFor(turn.category);
  const deadline = turn.deadline || Date.now() + total * 1000;
  function tick() {
    const remainMs = deadline - Date.now();
    $("qTimerNum").textContent = Math.max(0, Math.ceil(remainMs / 1000));
    $("qTimerFill").style.width = Math.max(0, (remainMs / (total * 1000)) * 100) + "%";
    if (remainMs <= 0) {
      clearInterval(localQuestionTimerHandle);
      localQuestionTimerHandle = null;
      // Timer expired → force timeout handling so unanswered players fall
      if (latestRoom) {
        try { checkTurnProgress(latestRoom); } catch (e) {}
      }
    }
  }
  tick();
  localQuestionTimerHandle = setInterval(tick, 200);
}

let forcedPickForKey = null;
async function forceRandomPickForStalledPicker(turn) {
  const marker = turn.key + ":" + turn.phase;
  if (forcedPickForKey === marker) return;
  forcedPickForKey = marker;
  const snap = await db.ref(`rooms/${currentRoomCode}`).once("value");
  const room = snap.val();
  if (!room || !room.turn || room.turn.key !== turn.key || room.turn.phase !== turn.phase) return;
  const pid = room.turn.colorPickerId;
  const me = (room.players || {})[pid] || {};
  const updates = {};
  const secs = turn.phase === "category" ? CATEGORY_CHOICE_SECONDS : DIFFICULTY_CHOICE_SECONDS;
  applyTimeDeduction(updates, pid, me.timeLeft, me.eliminated, secs);
  if (turn.phase === "category") {
    const cats = window.QUESTION_CATEGORIES || [];
    updates["turn/phase"] = "difficulty";
    updates["turn/category"] = cats[Math.floor(Math.random() * cats.length)] || "Ιστορία και Μυθολογία";
    updates["turn/phaseDeadline"] = Date.now() + DIFFICULTY_CHOICE_SECONDS * 1000;
    await db.ref(`rooms/${currentRoomCode}`).update(updates);
  } else {
    const color = ["green","blue","orange"][Math.floor(Math.random()*3)];
    const qPart = await buildQuestionTurnUpdates(room.turn.category, color);
    Object.assign(updates, qPart);
    await db.ref(`rooms/${currentRoomCode}`).update(updates);
  }
}

$("answerRectangle").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const opt = e.target.closest(".answerOption");
  if (!opt || opt.classList.contains("disabled")) return;
  e.preventDefault();
  opt.click();
});
$("answerRectangle").addEventListener("click", (e) => {
  const opt = e.target.closest(".answerOption");
  if (!opt || opt.classList.contains("disabled")) return;
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.phase !== "question") return;
  if (latestRoom.turn.answers && latestRoom.turn.answers[myPlayerId]) return;
  submitAnswer(opt.dataset.option);
});

async function submitAnswer(pickedOption) {
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.phase !== "question") return;
  if (latestRoom.turn.answers && latestRoom.turn.answers[myPlayerId]) return;
  stopLocalQuestionTimer();
  const turn = latestRoom.turn;
  const correct = pickedOption === decodeCorrect(turn.question);
  if (correct) { playSuccessSound(); vibrate(30); } else { playFailureSound(); vibrate([40, 60, 40]); }
  const delta = COLOR_DELTA[turn.color] * (correct ? 1 : -1);
  const me = (latestRoom.players || {})[myPlayerId] || { step: 0 };
  const newStep = Math.max(0, Math.min(MAX_STEPS, (me.step || 0) + delta));
  const updates = {
    [`players/${myPlayerId}/step`]: newStep,
    [`turn/answers/${myPlayerId}`]: { option: pickedOption, correct },
  };
  const totalSeconds = questionSecondsFor(turn.category);
  const questionStart = turn.deadline - totalSeconds * 1000;
  const elapsed = Math.min(totalSeconds, Math.max(0, (Date.now() - questionStart) / 1000));
  applyTimeDeduction(updates, myPlayerId, me.timeLeft, me.eliminated, elapsed);
  if (newStep >= MAX_STEPS && !me.finishedAt) {
    updates[`players/${myPlayerId}/finishedAt`] = firebase.database.ServerValue.TIMESTAMP;
  }
  await db.ref(`rooms/${currentRoomCode}`).update(updates);
  if (newStep >= MAX_STEPS) {
    const snap = await db.ref(`rooms/${currentRoomCode}`).once("value");
    const fresh = snap.val();
    if (fresh && fresh.status === "playing") await finishGame(fresh, myPlayerId);
  }
}

let resultScheduledForKey = null;
let advancedForKey = null;
let advanceInFlightForKey = null;

async function checkTurnProgress(room) {
  const turn = room.turn;
  if (!turn || room.status !== "playing") return;
  if (turn.phase === "question") {
    const players = room.players || {};
    const active = Object.keys(players).filter((pid) => !players[pid].eliminated);
    const answers = turn.answers || {};
    const answered = active.filter((pid) => answers[pid]).length;
    // Allow a short grace, but still process as soon as the local timer ends
    const timedOut = Date.now() >= (turn.deadline || 0) + 400;
    if (answered >= active.length || timedOut) {
      const updates = {};
      const totalSeconds = questionSecondsFor(turn.category);
      const colorDelta = COLOR_DELTA[turn.color] || 1;
      active.forEach((pid) => {
        if (!answers[pid]) {
          const delta = -colorDelta;
          const cur = players[pid].step || 0;
          updates[`players/${pid}/step`] = Math.max(0, Math.min(MAX_STEPS, cur + delta));
          updates[`turn/answers/${pid}`] = { option: null, correct: false };
          applyTimeDeduction(updates, pid, players[pid].timeLeft, players[pid].eliminated, totalSeconds);
        }
      });
      updates["turn/phase"] = "result";
      updates["turn/resultAt"] = Date.now();
      await db.ref(`rooms/${currentRoomCode}`).update(updates);
    }
  } else if (turn.phase === "result" && resultScheduledForKey !== turn.key) {
    resultScheduledForKey = turn.key;
    setTimeout(() => advanceTurnIfNeeded(turn.key), RESULT_PAUSE_MS);
  }
  if ((turn.phase === "category" || turn.phase === "difficulty") && turn.phaseDeadline && Date.now() >= turn.phaseDeadline + 2000) {
    forceRandomPickForStalledPicker(turn);
  }
}

async function advanceTurnIfNeeded(turnKey) {
  if (advancedForKey === turnKey || advanceInFlightForKey === turnKey) return;
  advanceInFlightForKey = turnKey;
  try {
    const snap = await db.ref(`rooms/${currentRoomCode}`).once("value");
    const room = snap.val();
    if (!room || room.status !== "playing" || !room.turn || room.turn.key !== turnKey) return;
    const isOwner = room.turn.colorPickerId === myPlayerId;
    const isFallbackHost = isHost && Date.now() >= (room.turn.resultAt || 0) + RESULT_PAUSE_MS * 3;
    if (!isOwner && !isFallbackHost) return;
    advancedForKey = turnKey;
    const players = room.players || {};
    const order = room.turnOrder || [];
    if (!order.some((pid) => !(players[pid] || {}).eliminated)) {
      await finishGame(room, null); return;
    }
    const currentIdx = order.indexOf(room.turn.colorPickerId);
    let nextIndex = currentIdx;
    for (let i = 1; i <= order.length; i++) {
      const cand = (currentIdx + i) % order.length;
      if (!(players[order[cand]] || {}).eliminated) { nextIndex = cand; break; }
    }
    if (room.solo) {
      const pid = order[nextIndex];
      const step = (players[pid] || {}).step || 0;
      const catIdx = room.soloCatIdx || 0;
      const updates = await buildSoloTurn(pid, step, catIdx);
      await db.ref(`rooms/${currentRoomCode}`).update({ turnIndex: nextIndex, ...updates });
      return;
    }
    await db.ref(`rooms/${currentRoomCode}`).update({
      turnIndex: nextIndex,
      turn: { colorPickerId: order[nextIndex], phase: "category", key: uid(), phaseDeadline: Date.now() + CATEGORY_CHOICE_SECONDS * 1000 },
    });
  } finally {
    advanceInFlightForKey = null;
  }
}

function comparePlayers(a, b) {
  const pa = a[1], pb = b[1];
  const ra = (pa.step || 0) >= MAX_STEPS, rb = (pb.step || 0) >= MAX_STEPS;
  if (ra !== rb) return ra ? -1 : 1;
  if (ra && rb) {
    const ta = pa.finishedAt || Infinity, tb = pb.finishedAt || Infinity;
    if (ta !== tb) return ta - tb;
  }
  return (pb.step || 0) - (pa.step || 0);
}
function rankPlayers(players) { return Object.entries(players).sort(comparePlayers); }

async function finishGame(room, forcedWinnerId) {
  const ranked = rankPlayers(room.players || {});
  const winnerId = ranked[0]?.[0] || forcedWinnerId || null;
  await db.ref(`rooms/${currentRoomCode}`).update({ status: "finished", winnerId });
}

let confettiShownForRoom = null;
function launchConfetti() {
  const colors = ["#ffd54f", "#4CAF50", "#0ea5e9", "#ef4444", "#a855f7", "#f97316"];
  const wrap = document.createElement("div");
  wrap.className = "confettiWrap";
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement("span");
    piece.className = "confettiPiece";
    piece.style.left = Math.random() * 100 + "%";
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = (Math.random() * 0.4) + "s";
    piece.style.animationDuration = (2.2 + Math.random() * 1.2) + "s";
    piece.style.setProperty("--rot", (Math.random() * 360) + "deg");
    wrap.appendChild(piece);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 3800);
}

function renderResults(room) {
  isHost = room.hostId === myPlayerId;
  const players = room.players || {};
  const ranked = rankPlayers(players);
  const winnerEntry = room.winnerId && players[room.winnerId] ? [room.winnerId, players[room.winnerId]] : ranked[0];
  const winner = winnerEntry ? winnerEntry[1] : null;
  if (winner && confettiShownForRoom !== currentRoomCode + (room.startedAt || "")) {
    confettiShownForRoom = currentRoomCode + (room.startedAt || "");
    launchConfetti();
  }
  $("resultsTitle").textContent = winner ? `Νικητής: ${winner.name}! 🎉` : "Τέλος Παιχνιδιού!";
  if (winner) $("winnerAvatarImg").src = avatarSrc(winner.avatar, "front");
  const list = $("rankingList");
  list.innerHTML = "";
  ranked.forEach(([pid, p], i) => {
    const row = document.createElement("div");
    row.className = "rankRow" + (room.winnerId === pid ? " winner" : "");
    row.innerHTML = `<span class="rpos">#${i + 1}</span><img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.opacity=0.3"><span class="rname">${escapeHtml(p.name)}${pid === myPlayerId ? " (Εσύ)" : ""}</span><span class="rstep">${p.step || 0}/${MAX_STEPS}</span>`;
    list.appendChild(row);
  });
  $("playAgainBtn").classList.toggle("hidden", !isHost);
}

$("playAgainBtn").addEventListener("click", async () => {
  if (!isHost || !latestRoom) return;
  const players = latestRoom.players || {};
  const resetPlayers = {};
  Object.entries(players).forEach(([pid, p]) => {
    resetPlayers[pid] = { ...p, step: 0, finishedAt: null, timeLeft: PLAYER_SECONDS, eliminated: false };
  });
  resultScheduledForKey = null; advancedForKey = null;
  if (latestRoom.solo) {
    const pid = Object.keys(players)[0];
    const soloUpdates = await buildSoloTurn(pid, 0, 0);
    await db.ref(`rooms/${currentRoomCode}`).update({
      status: "playing", startedAt: firebase.database.ServerValue.TIMESTAMP,
      players: resetPlayers, turnOrder: [pid], turnIndex: 0, winnerId: null, ...soloUpdates,
    });
    return;
  }
  await db.ref(`rooms/${currentRoomCode}`).update({
    status: "lobby", players: resetPlayers, turn: null, turnIndex: 0, turnOrder: null, startedAt: null, winnerId: null,
  });
});

$("backHomeBtn").addEventListener("click", async () => {
  try { if (myPlayerRef) await myPlayerRef.onDisconnect().cancel(); } catch (e) {}
  try { await db.ref(`rooms/${currentRoomCode}/players/${myPlayerId}`).remove(); } catch (e) {}
  detachRoomListener();
  currentRoomCode = null;
  myPlayerRef = null;
  showScreen("homeScreen");
});

setInterval(() => {
  if (latestRoom && latestRoom.status === "playing") {
    renderPlayerTimers(latestRoom);
    // Keep timeout / turn advancement alive even if no Firebase write happens
    try { checkTurnProgress(latestRoom); } catch (e) {}
  }
}, 1000);

// Sound toggle
const muteToggleBtn = $("muteToggleBtn");
if (muteToggleBtn) {
  muteToggleBtn.addEventListener("click", () => setMuted(!isMuted));
}

// Info modal
const showInfoBtn = $("showInfoBtn");
const infoModal = $("infoModal");
const closeInfoBtn = $("closeInfoBtn");
if (showInfoBtn && infoModal) {
  showInfoBtn.addEventListener("click", () => infoModal.classList.remove("hidden"));
  if (closeInfoBtn) closeInfoBtn.addEventListener("click", () => infoModal.classList.add("hidden"));
  infoModal.addEventListener("click", (e) => {
    if (e.target === infoModal) infoModal.classList.add("hidden");
  });
}

initHome();


/* ---------------------------------------------------------------
   Re-sync when the player comes back to the tab. Mobile browsers
   throttle timers in the background, so the countdown bar could be
   badly out of date on return; re-render from the authoritative
   room snapshot instead of trusting the local interval.
   --------------------------------------------------------------- */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && latestRoom) {
    try {
      if (latestRoom.status === "playing") renderGame(latestRoom);
      else if (latestRoom.status === "lobby") renderLobby(latestRoom);
      else if (latestRoom.status === "finished") renderResults(latestRoom);
    } catch (e) {}
  }
});
