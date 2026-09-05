/* ==========================================================================
   MindClimber Online — multiplayer rewrite
   --------------------------------------------------------------------------
   Requires a free Firebase Realtime Database project so that players on
   different phones can see the same live game state. Fill in
   FIREBASE_CONFIG below with your own project's config (see the setup
   instructions you were given alongside this file).
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
const QUESTION_SECONDS_EXTRA_DEFAULT = 3; // +3s for every category
const QUESTION_SECONDS_EXTRA_PUZZLES = 6; // +6s for Σπαζοκεφαλιές specifically
function questionSecondsFor(category) {
  return QUESTION_SECONDS + (category === "Σπαζοκεφαλιές" ? QUESTION_SECONDS_EXTRA_PUZZLES : QUESTION_SECONDS_EXTRA_DEFAULT);
}
const PLAYER_SECONDS = 260; // each player's own personal time bank for the whole game
const CATEGORY_CHOICE_SECONDS = 8;   // seconds allowed to pick a category
const DIFFICULTY_CHOICE_SECONDS = 6; // seconds allowed to pick a difficulty
const AVATAR_COUNT = 11;
const COLOR_DELTA = { green: 1, blue: 2, orange: 3 };
const RESULT_PAUSE_MS = 2200;

// ---------------------------------------------------------------------------
// Success / failure sound effects (correct answer = climbing up, wrong
// answer = slipping down). Generated with the Web Audio API so there's no
// dependency on sound asset files that may or may not exist in this
// project's assets folder.
// ---------------------------------------------------------------------------
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      audioCtx = null;
    }
  }
  return audioCtx;
}
function playTone(freqStart, freqEnd, durationMs, type) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
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
  // Bright, rising two-note "ding" — climbing up a step.
  playTone(523, 784, 90, "sine");
  setTimeout(() => playTone(784, 1046, 140, "sine"), 90);
}
function playFailureSound() {
  // Low, falling buzzy tone — slipping down a step.
  playTone(260, 110, 320, "sawtooth");
}

// ---------------------------------------------------------------------------
// Firebase init
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

// ---------------------------------------------------------------------------
// Local identity (per browser tab)
// ---------------------------------------------------------------------------
function uid() {
  return "p" + Math.random().toString(36).slice(2, 10);
}
let myPlayerId = sessionStorage.getItem("mc_playerId");
if (!myPlayerId) {
  myPlayerId = uid();
  sessionStorage.setItem("mc_playerId", myPlayerId);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const screens = ["desktopBlock", "homeScreen", "setupScreen", "lobbyScreen", "gameScreen", "resultsScreen"];
function showScreen(id) {
  screens.forEach((s) => $(s).classList.toggle("active", s === id));
}

function avatarSrc(n, pose) {
  return `assets/Avatars/avatar${n}_${pose}.png`;
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let currentRoomCode = null;
let isHost = false;
let isSolo = false;
let roomRef = null;
let roomListenerAttached = false;
let latestRoom = null;
let selectedAvatar = null;
let localQuestionTimerHandle = null;

// ===========================================================================
// Screen 0: mobile-only guard
// ===========================================================================
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
// Home screen
// ===========================================================================
function initHome() {
  if (!checkMobile()) return;
  if (!firebaseReady) {
    $("homeError").textContent =
      "Το online multiplayer χρειάζεται σύνδεση Firebase. Δες τις οδηγίες ρύθμισης στην αρχή του game.js.";
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
  const snap = await db.ref(`rooms/${code}`).once("value");
  if (!snap.exists()) {
    $("homeError").textContent = "Δεν βρέθηκε δωμάτιο με αυτόν τον κωδικό.";
    return;
  }
  const room = snap.val();
  if (room.status !== "lobby") {
    $("homeError").textContent = "Το παιχνίδι σε αυτό το δωμάτιο έχει ήδη ξεκινήσει.";
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
    const snap = await db.ref(`rooms/${code}`).once("value");
    if (!snap.exists()) return code;
  }
  return uid().toUpperCase().slice(0, 5);
}

// ===========================================================================
// Setup screen (name + avatar)
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
    div.innerHTML = `<img src="${avatarSrc(i, "front")}" alt="avatar${i}">`;
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
    const taken = new Set(
      Object.entries(players)
        .filter(([pid]) => pid !== myPlayerId)
        .map(([, p]) => p.avatar)
    );
    document.querySelectorAll("#avatarGrid .avatarOption").forEach((el) => {
      const n = Number(el.dataset.avatar);
      el.classList.toggle("taken", taken.has(n) && Number(el.dataset.avatar) !== selectedAvatar);
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
    if (order >= MAX_PLAYERS) {
      $("setupError").textContent = "Το δωμάτιο είναι γεμάτο.";
      return;
    }
    await db.ref(`${roomBase}/players/${myPlayerId}`).set({
      name,
      avatar: selectedAvatar,
      step: 0,
      order,
      timeLeft: PLAYER_SECONDS,
      eliminated: false,
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

// Solo games skip the lobby (nobody to wait for) and skip category/
// difficulty picking entirely — the very first question is built and
// dropped straight into "question" phase.
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

// ===========================================================================
// Lobby / waiting room
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
      <img src="${avatarSrc(p.avatar, "front")}" alt="">
      <span class="pname">${escapeHtml(p.name)}</span>
      ${pid === room.hostId ? '<span class="hostTag">HOST</span>' : ""}
      ${pid === myPlayerId ? '<span class="youTag">Εσύ</span>' : ""}
    `;
    container.appendChild(row);
  });

  const count = list.length;
  $("lobbyHint").textContent =
    count < 2
      ? "Χρειάζονται τουλάχιστον 2 παίκτες για έναρξη."
      : `${count}/${MAX_PLAYERS} παίκτες συνδεδεμένοι.`;

  const canStart = isHost && count >= 2;
  $("startGameBtn").classList.toggle("hidden", !canStart);
}

$("startGameBtn").addEventListener("click", async () => {
  if (!latestRoom) return;
  const players = latestRoom.players || {};
  const turnOrder = Object.entries(players)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([pid]) => pid);

  // Preserve shuffledQueues across "Play Again" rematches so the next game
  // continues walking through each pool instead of starting over — only a
  // brand new room gets fresh (empty) queues, built lazily on first pick.
  const shuffledQueues = latestRoom.shuffledQueues || {};

  // Every game (including rematches) starts each player fresh with their
  // own full personal time bank — nobody carries over a depleted clock
  // from a previous match.
  const resetPlayers = {};
  Object.entries(players).forEach(([pid, p]) => {
    resetPlayers[pid] = { ...p, timeLeft: PLAYER_SECONDS, eliminated: false };
  });

  await db.ref(`rooms/${currentRoomCode}`).update({
    status: "playing",
    startedAt: firebase.database.ServerValue.TIMESTAMP,
    turnOrder,
    turnIndex: 0,
    shuffledQueues,
    players: resetPlayers,
    turn: {
      colorPickerId: turnOrder[0],
      phase: "category",
      key: uid(),
      phaseDeadline: Date.now() + CATEGORY_CHOICE_SECONDS * 1000,
    },
  });
});

$("leaveLobbyBtn").addEventListener("click", async () => {
  try {
    await db.ref(`rooms/${currentRoomCode}/players/${myPlayerId}`).remove();
  } catch (e) { /* ignore */ }
  detachRoomListener();
  currentRoomCode = null;
  showScreen("homeScreen");
});

// ===========================================================================
// Room listener — drives lobby / game / results depending on room.status
// ===========================================================================
function attachRoomListener() {
  if (roomListenerAttached) return;
  roomRef = db.ref(`rooms/${currentRoomCode}`);
  roomRef.on("value", (snap) => {
    const room = snap.val();
    if (!room) return;
    latestRoom = room;

    if (room.status === "lobby") {
      if ($("lobbyScreen").classList.contains("active") === false && $("gameScreen").classList.contains("active") === false) {
        // still on setup, ignore until user confirms
      }
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
// GAME SCREEN — simple 27-step staircase graphic (no photo background)
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
    const pos = stepPosition(step, 2); // centered reference line
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

const STEP_TOP_BOTTOM = 80; // % position (from bottom of climbZone) of the final step
const PEAK_BOTTOM_OFFSET = 12; // gap between top step and the flags, so the player's head touches them

function stepPosition(step, orderIndex) {
  const baseBottom = 4;
  const topBottom = STEP_TOP_BOTTOM;
  const bottom = baseBottom + (step / MAX_STEPS) * (topBottom - baseBottom);
  const jitter = (orderIndex - 2) * 15; // spread up to 5 tokens sideways
  const left = Math.min(90, Math.max(10, 50 + jitter));
  const size = 34;
  return { bottom, left, size };
}

function formatTimeLeft(seconds) {
  const t = Math.max(0, Math.round(seconds ?? PLAYER_SECONDS));
  const mm = Math.floor(t / 60);
  const ss = String(t % 60).padStart(2, "0");
  return `⏱ ${mm}:${ss}`;
}

// Estimates a player's remaining personal time RIGHT NOW, between Firebase
// writes: their stored timeLeft only updates at the end of each action
// (picking a category/difficulty, or answering), so while that action is
// still in progress we subtract the time elapsed so far locally, purely
// for a smooth-looking live countdown. The database is always the source
// of truth once the action actually completes.
function computeLiveTimeLeft(pid, p, room) {
  if (!p || p.eliminated) return 0;
  const stored = p.timeLeft ?? PLAYER_SECONDS;
  const turn = room.turn || {};
  if (turn.phase === "question" && turn.colorPickerId != null && turn.deadline && !(turn.answers && turn.answers[pid])) {
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
  const players = room.players || {};
  Object.keys(players).forEach((pid) => {
    const badge = document.querySelector(`.playerToken[data-pid="${pid}"] .tokenTimer`);
    if (!badge) return;
    badge.textContent = formatTimeLeft(computeLiveTimeLeft(pid, players[pid], room));
  });
}

function renderGame(room) {
  buildStaircase();
  $("stepInfo").textContent = "";
  const players = room.players || {};
  const order = Object.entries(players).sort((a, b) => a[1].order - b[1].order);

  // One flag per player, each positioned directly above that player's own
  // horizontal lane (same left offset stepPosition gives their token) so
  // every player sees their own finish flag right where they'll stand.
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

  // Player tokens
  const tokenWrap = $("playerTokens");
  tokenWrap.innerHTML = "";
  const turn = room.turn || {};
  order.forEach(([pid, p], idx) => {
    const pos = stepPosition(p.step || 0, idx);
    const pose = "front";
    const el = document.createElement("div");
    const step = p.step || 0;
    const eliminated = !!p.eliminated;
    el.className = "playerToken" + (turn.colorPickerId === pid ? " active-turn" : "") + (step <= 2 ? " lowStep" : "") + (eliminated ? " eliminated" : "");
    el.dataset.pid = pid;
    el.style.bottom = pos.bottom + "%";
    el.style.left = pos.left + "%";
    el.style.width = pos.size + "px";
    el.style.height = pos.size + "px";
    el.innerHTML = `<span class="tokenTimer">${formatTimeLeft(p.timeLeft)}</span><div class="tokenAvatarWrap"><img src="${avatarSrc(p.avatar, pose)}" alt=""></div><span class="tokenName">${escapeHtml(p.name)}</span><span class="tokenStep">${step}/${MAX_STEPS}</span>`;
    tokenWrap.appendChild(el);
  });

  // Turn banner
  const turnPlayer = players[turn.colorPickerId];
  if (turnPlayer) {
    $("turnAvatarMini").innerHTML = `<img src="${avatarSrc(turnPlayer.avatar, "front")}" alt="">`;
    const youText = turn.colorPickerId === myPlayerId ? " (Εσύ!)" : "";
    const label = turn.phase === "category" ? "Επιλογή κατηγορίας" : turn.phase === "difficulty" ? "Επιλογή δυσκολίας" : "Σειρά";
    $("turnText").textContent = `${label}: ${turnPlayer.name}${youText}`;
  }

  const isColorPicker = turn.colorPickerId === myPlayerId;

  if (turn.phase === "category") {
    stopLocalQuestionTimer();
    buildCategoryButtons(isColorPicker);
    $("categoryChoiceRow").classList.remove("hidden");
    $("selectedCategoryLabel").classList.add("hidden");
    $("colorChoiceRow").classList.add("hidden");
    $("questionRectangle").classList.add("hidden");
    $("questionImage").classList.add("hidden");
    $("answerRectangle").classList.add("hidden");
    $("qTimerWrap").classList.add("hidden");
    $("allAnswersStatus").classList.add("hidden");
    $("waitingNote").classList.toggle("hidden", isColorPicker);
    if (isColorPicker) startLocalChoiceTimer(turn, "category"); else stopLocalChoiceTimer();
  } else if (turn.phase === "difficulty") {
    stopLocalQuestionTimer();
    $("categoryChoiceRow").classList.add("hidden");
    $("selectedCategoryLabel").textContent = `Κατηγορία: ${turn.category || ""}`;
    $("selectedCategoryLabel").classList.remove("hidden");
    $("colorChoiceRow").classList.remove("hidden");
    $("questionRectangle").classList.add("hidden");
    $("questionImage").classList.add("hidden");
    $("answerRectangle").classList.add("hidden");
    $("qTimerWrap").classList.add("hidden");
    $("allAnswersStatus").classList.add("hidden");
    $("waitingNote").classList.toggle("hidden", isColorPicker);
    ["greenButton", "blueButton", "orangeButton"].forEach((id) => ($(id).disabled = !isColorPicker));
    if (isColorPicker) startLocalChoiceTimer(turn, "difficulty"); else stopLocalChoiceTimer();
  } else if (turn.phase === "question" || turn.phase === "result") {
    stopLocalChoiceTimer();
    $("categoryChoiceRow").classList.add("hidden");
    const diffLabel = { green: "Εύκολο", blue: "Μέτριο", orange: "Δύσκολο" }[turn.color] || "";
    $("selectedCategoryLabel").textContent = `${turn.category || ""} · ${diffLabel}`;
    $("selectedCategoryLabel").classList.remove("hidden");
    $("colorChoiceRow").classList.add("hidden");
    $("waitingNote").classList.add("hidden");
    $("questionRectangle").classList.remove("hidden");
    $("answerRectangle").classList.remove("hidden");
    $("qTimerWrap").classList.remove("hidden");
    renderQuestion(room, turn);
  }

  // Turn progression / timeouts: the active color-picker drives normal
  // advancement, but the stalled-picker safety net inside checkTurnProgress
  // needs to run on everyone's client, since it exists precisely for the
  // case where the picker's own device is the one that's unresponsive.
  checkTurnProgress(room);
}

function buildCategoryButtons(enabled) {
  const wrap = $("categoryChoiceRow");
  if (wrap.dataset.built === "1") {
    wrap.querySelectorAll("button").forEach((b) => (b.disabled = !enabled));
    return;
  }
  wrap.dataset.built = "1";
  wrap.innerHTML = "";
  (window.QUESTION_CATEGORIES || []).forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = "categoryBtn";
    btn.textContent = cat;
    btn.disabled = !enabled;
    btn.addEventListener("click", () => chooseCategory(cat));
    wrap.appendChild(btn);
  });
}


setInterval(() => {
  if (latestRoom && latestRoom.status === "playing") {
    renderPlayerTimers(latestRoom);
    checkTurnProgress(latestRoom);
    if (latestRoom.turn && latestRoom.turn.phase === "result") {
      advanceTurnIfNeeded(latestRoom.turn.key);
    }
  }
}, 1000);

function renderQuestion(room, turn) {
  const q = turn.question;
  if (!q) return;
  $("questionRectangle").textContent = q.text;
  const imgEl = $("questionImage");
  if (q.img) {
    imgEl.src = q.img;
    imgEl.classList.remove("hidden");
  } else {
    imgEl.classList.add("hidden");
    imgEl.removeAttribute("src");
  }
  const optsWrap = $("answerRectangle");
  const letters = ["A", "B", "C"];
  const answers = turn.answers || {};
  const myAnswer = answers[myPlayerId];
  const alreadyAnswered = !!myAnswer;

  letters.forEach((letter, i) => {
    const el = optsWrap.querySelector(`[data-option="${letter}"]`);
    el.textContent = `${letter}. ${q.options[i]}`;
    el.classList.remove("correct", "wrong", "picked");
    el.classList.toggle("disabled", alreadyAnswered || turn.phase === "result");
    if (turn.phase === "result") {
      if (letter === q.correct) el.classList.add("correct");
      else if (myAnswer && letter === myAnswer.option) el.classList.add("wrong");
    } else if (myAnswer && letter === myAnswer.option) {
      el.classList.add("picked");
    }
  });

  renderAnswersStatus(room, turn);

  if (turn.phase === "question") {
    startLocalQuestionTimer(turn, alreadyAnswered);
  } else {
    stopLocalQuestionTimer();
    $("qTimerFill").style.width = "0%";
    $("qTimerNum").textContent = "";
  }
}

function renderAnswersStatus(room, turn) {
  const players = room.players || {};
  const order = Object.entries(players).sort((a, b) => a[1].order - b[1].order);
  const answers = turn.answers || {};
  const wrap = $("allAnswersStatus");
  wrap.classList.remove("hidden");
  wrap.innerHTML = "";
  order.forEach(([pid, p]) => {
    const ans = answers[pid];
    const chip = document.createElement("div");
    let stateClass = "waiting";
    let icon = "…";
    if (p.eliminated) {
      stateClass = "eliminated-chip";
      icon = "⏱ εκτός";
    } else if (turn.phase === "result" && ans) {
      stateClass = ans.correct ? "correct" : "wrong";
      icon = ans.correct ? "✓" : "✗";
    } else if (ans) {
      stateClass = "waiting";
      icon = "✓";
    }
    chip.className = "answerStatusChip " + stateClass;
    chip.innerHTML = `<img src="${avatarSrc(p.avatar, "front")}" alt="">${escapeHtml(p.name)} ${icon}`;
    wrap.appendChild(chip);
  });
}

function startLocalQuestionTimer(turn, alreadyAnswered) {
  stopLocalQuestionTimer();
  const deadline = turn.deadline;
  const totalSeconds = questionSecondsFor(turn.category);
  function tick() {
    const remainMs = deadline - Date.now();
    const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
    $("qTimerNum").textContent = remainSec;
    $("qTimerFill").style.width = `${Math.max(0, (remainMs / (totalSeconds * 1000)) * 100)}%`;
    if (remainMs <= 0) {
      stopLocalQuestionTimer();
      if (!alreadyAnswered) submitAnswer(null); // timeout = counts as wrong, for myself only
      return;
    }
  }
  tick();
  localQuestionTimerHandle = setInterval(tick, 200);
}
function stopLocalQuestionTimer() {
  if (localQuestionTimerHandle) {
    clearInterval(localQuestionTimerHandle);
    localQuestionTimerHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Category choice -> then color/difficulty choice -> draw a never-before-used
// question for that category+difficulty -> broadcast to everyone
// ---------------------------------------------------------------------------
function difficultyKey(color) {
  return color === "green" ? "easy" : color === "blue" ? "medium" : "hard";
}

function fisherYatesShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Solo mode: no category/difficulty picking at all. Difficulty is tied to
// how high up the mountain the player currently is (steps 1-10 easy,
// 11-20 medium, 21-30 hard) — so if a wrong answer knocks them back down,
// the next questions naturally get easier again. Category just cycles
// through every category in a fixed rotation, one per question, for
// variety, independent of the difficulty tier.
// ---------------------------------------------------------------------------
function soloColorForStep(step) {
  if (step < 10) return "green";
  if (step < 20) return "blue";
  return "orange";
}

async function buildQuestionTurnUpdates(category, color) {
  // Always read the freshest queue state right before picking, so we never
  // draw against a stale position even if the local cache lagged behind.
  const snap = await db.ref(`rooms/${currentRoomCode}/shuffledQueues/${category}/${color}`).once("value");
  const queueState = snap.val();
  const { item: q, newQueueState } = pickFromShuffledQueue(category, color, queueState);
  return {
    [`shuffledQueues/${category}/${color}`]: newQueueState,
    "turn/phase": "question",
    "turn/category": category,
    "turn/color": color,
    "turn/question": { text: q.text, options: q.options, correct: q.correct, img: q.img || null },
    "turn/deadline": Date.now() + questionSecondsFor(category) * 1000,
    "turn/answers": {},
  };
}

async function buildSoloTurn(pid, step, catIdx) {
  const cats = window.QUESTION_CATEGORIES || [];
  const category = cats[catIdx % cats.length];
  const color = soloColorForStep(step);
  const updates = await buildQuestionTurnUpdates(category, color);
  updates["soloCatIdx"] = (catIdx + 1) % cats.length;
  updates["turn/colorPickerId"] = pid;
  updates["turn/phase"] = "question";
  updates["turn/key"] = uid();
  return updates;
}

// Draws the next question from a per-(category,color) shuffled queue. The
// queue is a full random permutation of every index in that pool; we walk
// through it in order, so every question is served exactly once before the
// queue reshuffles and starts a fresh pass. This gives a stronger, easier
// to verify guarantee than "pick random, exclude used": no question can
// repeat until the entire pool has been shown, and the moment it does
// exhaust, it reshuffles into a brand new order rather than immediately
// replaying the same sequence.
function pickFromShuffledQueue(category, color, queueState) {
  const diffKey = difficultyKey(color);
  const pool = (window.QUESTION_BANK && window.QUESTION_BANK[category] && window.QUESTION_BANK[category][diffKey]) || [];
  if (pool.length === 0) {
    return {
      item: { text: "Δεν βρέθηκαν ερωτήσεις.", options: ["-", "-", "-"], correct: "A", img: null },
      newQueueState: queueState || null,
    };
  }
  let order = queueState && queueState.order;
  let pos = queueState && queueState.pos;
  // Reshuffle when there's no queue yet, the bank size changed since this
  // queue was built, or we've walked off the end of the current pass.
  if (!Array.isArray(order) || order.length !== pool.length || typeof pos !== "number" || pos >= order.length) {
    order = fisherYatesShuffle(pool.map((_, i) => i));
    pos = 0;
  }
  const index = order[pos];
  const item = pool[index];
  return {
    item: { text: item.q, options: item.o, correct: item.a, img: item.img || null },
    newQueueState: { order, pos: pos + 1 },
  };
}

// Deducts elapsed seconds from a player's own personal time bank and
// returns whether that push crossed them into elimination. `elapsedSeconds`
// is already clamped by the caller to the relevant window (5s for a
// category/difficulty pick, or the question's own time budget).
function applyTimeDeduction(updates, pid, currentTimeLeft, alreadyEliminated, elapsedSeconds) {
  const newTimeLeft = Math.max(0, (currentTimeLeft ?? PLAYER_SECONDS) - elapsedSeconds);
  updates[`players/${pid}/timeLeft`] = newTimeLeft;
  if (newTimeLeft <= 0 && !alreadyEliminated) updates[`players/${pid}/eliminated`] = true;
  return newTimeLeft;
}

async function chooseCategory(category, isTimeout) {
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.colorPickerId !== myPlayerId) return;
  if (latestRoom.turn.phase !== "category") return;
  stopLocalChoiceTimer();
  const turn = latestRoom.turn;
  const elapsedSeconds = isTimeout
    ? CATEGORY_CHOICE_SECONDS
    : Math.min(CATEGORY_CHOICE_SECONDS, Math.max(0, (Date.now() - ((turn.phaseDeadline || Date.now()) - CATEGORY_CHOICE_SECONDS * 1000)) / 1000));
  const me = (latestRoom.players || {})[myPlayerId] || {};

  const updates = {
    "turn/phase": "difficulty",
    "turn/category": category,
    "turn/phaseDeadline": Date.now() + DIFFICULTY_CHOICE_SECONDS * 1000,
  };
  applyTimeDeduction(updates, myPlayerId, me.timeLeft, me.eliminated, elapsedSeconds);
  await db.ref(`rooms/${currentRoomCode}`).update(updates);
}

async function chooseColor(color, isTimeout) {
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.colorPickerId !== myPlayerId) return;
  if (latestRoom.turn.phase !== "difficulty") return;
  stopLocalChoiceTimer();
  const turn = latestRoom.turn;
  const category = turn.category;
  const elapsedSeconds = isTimeout
    ? DIFFICULTY_CHOICE_SECONDS
    : Math.min(DIFFICULTY_CHOICE_SECONDS, Math.max(0, (Date.now() - ((turn.phaseDeadline || Date.now()) - DIFFICULTY_CHOICE_SECONDS * 1000)) / 1000));
  const me = (latestRoom.players || {})[myPlayerId] || {};

  const updates = await buildQuestionTurnUpdates(category, color);
  applyTimeDeduction(updates, myPlayerId, me.timeLeft, me.eliminated, elapsedSeconds);
  await db.ref(`rooms/${currentRoomCode}`).update(updates);
}
$("greenButton").addEventListener("click", () => chooseColor("green"));
$("blueButton").addEventListener("click", () => chooseColor("blue"));
$("orangeButton").addEventListener("click", () => chooseColor("orange"));

// ---------------------------------------------------------------------------
// Local 5-second countdown for picking a category, and separately for
// picking a difficulty. Only the active color-picker's own client runs
// this — if it expires with no choice made, that same client auto-picks
// randomly on the picker's behalf (and the full 5s is charged to their
// personal time bank, same as if they'd used the whole window deciding).
// ---------------------------------------------------------------------------
let localChoiceTimerHandle = null;
function stopLocalChoiceTimer() {
  if (localChoiceTimerHandle) {
    clearInterval(localChoiceTimerHandle);
    localChoiceTimerHandle = null;
  }
  $("choiceTimerWrap").classList.add("hidden");
}
function startLocalChoiceTimer(turn, kind) {
  stopLocalChoiceTimer();
  $("choiceTimerWrap").classList.remove("hidden");
  const windowSeconds = kind === "category" ? CATEGORY_CHOICE_SECONDS : DIFFICULTY_CHOICE_SECONDS;
  const deadline = turn.phaseDeadline || Date.now() + windowSeconds * 1000;
  function tick() {
    const remainMs = deadline - Date.now();
    const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
    $("choiceTimerNum").textContent = remainSec;
    $("choiceTimerFill").style.width = `${Math.max(0, (remainMs / (windowSeconds * 1000)) * 100)}%`;
    if (remainMs <= 0) {
      clearInterval(localChoiceTimerHandle);
      localChoiceTimerHandle = null;
      if (kind === "category") {
        const cats = window.QUESTION_CATEGORIES || [];
        chooseCategory(cats[Math.floor(Math.random() * cats.length)], true);
      } else {
        const colors = ["green", "blue", "orange"];
        chooseColor(colors[Math.floor(Math.random() * colors.length)], true);
      }
      return;
    }
  }
  tick();
  localChoiceTimerHandle = setInterval(tick, 200);
}

// Safety net: if the active picker's own device stalled (tab closed,
// connection dropped) and never fired its own local auto-pick, the host's
// client force-picks randomly on their behalf once the deadline has
// clearly passed — mirroring the same pattern used for a stalled question
// answer. Harmless no-op if the normal path already handled it.
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
  const stalledWindowSeconds = turn.phase === "category" ? CATEGORY_CHOICE_SECONDS : DIFFICULTY_CHOICE_SECONDS;
  applyTimeDeduction(updates, pid, me.timeLeft, me.eliminated, stalledWindowSeconds);

  if (turn.phase === "category") {
    const cats = window.QUESTION_CATEGORIES || [];
    updates["turn/phase"] = "difficulty";
    updates["turn/category"] = cats[Math.floor(Math.random() * cats.length)];
    updates["turn/phaseDeadline"] = Date.now() + DIFFICULTY_CHOICE_SECONDS * 1000;
    await db.ref(`rooms/${currentRoomCode}`).update(updates);
  } else {
    const colors = ["green", "blue", "orange"];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const category = room.turn.category;
    const qSnap = await db.ref(`rooms/${currentRoomCode}/shuffledQueues/${category}/${color}`).once("value");
    const { item: q, newQueueState } = pickFromShuffledQueue(category, color, qSnap.val());
    updates[`shuffledQueues/${category}/${color}`] = newQueueState;
    updates["turn/phase"] = "question";
    updates["turn/color"] = color;
    updates["turn/question"] = { text: q.text, options: q.options, correct: q.correct, img: q.img || null };
    updates["turn/deadline"] = Date.now() + questionSecondsFor(category) * 1000;
    updates["turn/answers"] = {};
    await db.ref(`rooms/${currentRoomCode}`).update(updates);
  }
}

$("answerRectangle").addEventListener("click", (e) => {
  const opt = e.target.closest(".answerOption");
  if (!opt || opt.classList.contains("disabled")) return;
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.phase !== "question") return;
  const answers = latestRoom.turn.answers || {};
  if (answers[myPlayerId]) return; // already answered
  submitAnswer(opt.dataset.option);
});

// Every player answers for themselves — this only ever writes to this
// player's own paths, so it's safe even if several players answer at once.
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

  // Only the time THIS player actually took to answer comes off their own
  // personal bank — not the full shared round length, so answering quickly
  // always preserves more of your own time regardless of how long anyone
  // else in the room takes.
  const totalSeconds = questionSecondsFor(turn.category);
  const questionStart = turn.deadline - totalSeconds * 1000;
  const elapsedSeconds = Math.min(totalSeconds, Math.max(0, (Date.now() - questionStart) / 1000));
  applyTimeDeduction(updates, myPlayerId, me.timeLeft, me.eliminated, elapsedSeconds);

  // Record exactly when this player reached the summit (server clock, so
  // it's fair/comparable across everyone's devices) — this is what lets
  // rankPlayers() correctly decide "who got there first" if more than one
  // player reaches the summit in the same round.
  if (reachedSummit && !me.finishedAt) {
    updates[`players/${myPlayerId}/finishedAt`] = firebase.database.ServerValue.TIMESTAMP;
  }

  await db.ref(`rooms/${currentRoomCode}`).update(updates);

  if (reachedSummit) {
    const snap = await db.ref(`rooms/${currentRoomCode}`).once("value");
    const freshRoom = snap.val();
    if (freshRoom && freshRoom.status === "playing") await finishGame(freshRoom, myPlayerId);
  }
}

// ---------------------------------------------------------------------------
// Turn progression — only run on the device of whoever picked the color for
// this turn, so only one client ever advances the game state.
// ---------------------------------------------------------------------------
let resultScheduledForKey = null;
let advancedForKey = null;
let advanceInFlightForKey = null;

async function checkTurnProgress(room) {
  const turn = room.turn;
  if (!turn || room.status !== "playing") return;

  if (turn.phase === "question") {
    const players = room.players || {};
    // Eliminated players are done for the rest of the game — the round
    // never waits on them, and they don't get penalized further.
    const activePids = Object.keys(players).filter((pid) => !players[pid].eliminated);
    const answers = turn.answers || {};
    const answeredCount = activePids.filter((pid) => answers[pid]).length;
    const timedOut = Date.now() >= turn.deadline + 1200;

    if (answeredCount >= activePids.length || timedOut) {
      // Fill in anyone still-active who never answered (e.g. a stalled
      // tab) as a timeout/wrong, and charge them the full question time
      // since they used the whole window without responding.
      const updates = {};
      const totalSeconds = questionSecondsFor(turn.category);
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
      if (Object.keys(updates).length) await db.ref(`rooms/${currentRoomCode}`).update(updates);
    }
  } else if (turn.phase === "result" && resultScheduledForKey !== turn.key) {
    resultScheduledForKey = turn.key;
    setTimeout(() => advanceTurnIfNeeded(turn.key), RESULT_PAUSE_MS);
  }

  // Safety net for a stalled category/difficulty picker — runs on every
  // client (not just the picker's own), since if the picker's device is
  // the one that stalled, their own client obviously can't self-correct.
  if ((turn.phase === "category" || turn.phase === "difficulty") && turn.phaseDeadline && Date.now() >= turn.phaseDeadline + 2000) {
    forceRandomPickForStalledPicker(turn);
  }
}

async function advanceTurnIfNeeded(turnKey) {
  if (advancedForKey === turnKey) return;
  // Guard against this same client calling this function again for the
  // same turn while a previous call is still mid-flight (solo mode calls
  // this very frequently in quick succession — once right after answering,
  // and again every second from the periodic safety-net check). Without
  // this, two overlapping calls could both read the same shuffled-queue
  // position before either write commits: one write wins, and the other
  // question gets silently consumed without ever being shown — which is
  // exactly what caused questions to repeat sooner than they should.
  if (advanceInFlightForKey === turnKey) return;
  advanceInFlightForKey = turnKey;
  try {
    const snap = await db.ref(`rooms/${currentRoomCode}`).once("value");
    const room = snap.val();
    if (!room || room.status !== "playing") return;
    if (!room.turn || room.turn.key !== turnKey) return;
    // Normally only the picker whose turn this was advances it (avoids
    // duplicate writes). But if that specific player became eliminated and
    // then left, nobody else would ever satisfy that check — so after a
    // generous extra delay, let the host's client take over as a fallback.
    const isOwner = room.turn.colorPickerId === myPlayerId;
    const isFallbackHost = isHost && Date.now() >= (room.turn.resultAt || 0) + RESULT_PAUSE_MS * 3;
    if (!isOwner && !isFallbackHost) return;

    // From here on we're committed to actually performing the advancement,
    // so it's now safe to mark this turn as permanently done for this client.
    advancedForKey = turnKey;

    const players = room.players || {};
    const order = room.turnOrder || [];

    // If every player has run out of personal time, the game is over even
    // though nobody reached the summit.
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
      const catIdx = room.soloCatIdx || 0;
      const updates = await buildSoloTurn(pid, step, catIdx);
      await db.ref(`rooms/${currentRoomCode}`).update({ turnIndex: nextIndex, ...updates });
      return;
    }

    await db.ref(`rooms/${currentRoomCode}`).update({
      turnIndex: nextIndex,
      turn: {
        colorPickerId: order[nextIndex],
        phase: "category",
        key: uid(),
        phaseDeadline: Date.now() + CATEGORY_CHOICE_SECONDS * 1000,
      },
    });
  } finally {
    advanceInFlightForKey = null;
  }
}

// ---------------------------------------------------------------------------
// Ranking — this is the single source of truth for "who's 1st/2nd/etc.".
// Priority order (a real climbing race, not a derived score):
//   1. Reaching the summit always beats not reaching it.
//   2. Among players who reached the summit, whoever got there FIRST
//      (earliest finishedAt server timestamp) wins.
//   3. Among players who did NOT reach the summit, whoever climbed
//      HIGHER (bigger step) wins.
// ---------------------------------------------------------------------------
function comparePlayers(a, b) {
  const pa = a[1], pb = b[1];
  const reachedA = (pa.step || 0) >= MAX_STEPS;
  const reachedB = (pb.step || 0) >= MAX_STEPS;
  if (reachedA !== reachedB) return reachedA ? -1 : 1;
  if (reachedA && reachedB) {
    const ta = pa.finishedAt || Infinity;
    const tb = pb.finishedAt || Infinity;
    if (ta !== tb) return ta - tb; // earlier finish time wins
  }
  return (pb.step || 0) - (pa.step || 0); // higher step wins
}
function rankPlayers(players) {
  return Object.entries(players).sort(comparePlayers);
}

async function finishGame(room, forcedWinnerId) {
  const players = room.players || {};
  // Always recompute the winner from the actual shared player data rather
  // than trusting forcedWinnerId — with multiple players, more than one
  // client can race to call finishGame in the same instant, and whichever
  // one's write happened to land first used to become the "winner"
  // regardless of who actually finished first. Recomputing here from the
  // shared finishedAt timestamps makes the result deterministic no matter
  // which client's call actually executes it.
  const ranked = rankPlayers(players);
  const winnerId = ranked[0]?.[0] || forcedWinnerId || null;
  await db.ref(`rooms/${currentRoomCode}`).update({ status: "finished", winnerId });
}

// ===========================================================================
// RESULTS SCREEN
// ===========================================================================
function renderResults(room) {
  const players = room.players || {};
  const ranked = rankPlayers(players);
  const winnerEntry = room.winnerId && players[room.winnerId] ? [room.winnerId, players[room.winnerId]] : ranked[0];
  const winner = winnerEntry ? winnerEntry[1] : null;

  $("resultsTitle").textContent = winner
    ? (ranked.filter(([pid, p]) => pid !== winnerEntry[0] && comparePlayers([pid, p], winnerEntry) === 0).length > 0 ? "Ισοπαλία!" : `Νικητής: ${winner.name}! 🎉`)
    : "Τέλος Παιχνιδιού!";
  $("winnerAvatarImg").src = winner ? avatarSrc(winner.avatar, "front") : "";

  const list = $("rankingList");
  list.innerHTML = "";
  ranked.forEach(([pid, p], i) => {
    const row = document.createElement("div");
    row.className = "rankRow" + (room.winnerId === pid ? " winner" : "");
    row.innerHTML = `
      <span class="rpos">#${i + 1}</span>
      <img src="${avatarSrc(p.avatar, "front")}" alt="">
      <span class="rname">${escapeHtml(p.name)}${pid === myPlayerId ? " (Εσύ)" : ""}</span>
      <span class="rstep">${p.step || 0}/${MAX_STEPS}</span>
    `;
    list.appendChild(row);
  });

  $("playAgainBtn").classList.toggle("hidden", !isHost);
}

$("playAgainBtn").addEventListener("click", async () => {
  if (!isHost || !latestRoom) return;
  const players = latestRoom.players || {};
  const resetPlayers = {};
  Object.entries(players).forEach(([pid, p]) => {
    resetPlayers[pid] = { ...p, step: 0, finishedAt: null };
  });
  resultScheduledForKey = null;
  advancedForKey = null;

  if (latestRoom.solo) {
    const pid = Object.keys(players)[0];
    resetPlayers[pid] = { ...resetPlayers[pid], timeLeft: PLAYER_SECONDS, eliminated: false };
    const soloUpdates = await buildSoloTurn(pid, 0, 0);
    await db.ref(`rooms/${currentRoomCode}`).update({
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

  await db.ref(`rooms/${currentRoomCode}`).update({
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
  try {
    await db.ref(`rooms/${currentRoomCode}/players/${myPlayerId}`).remove();
  } catch (e) { /* ignore */ }
  detachRoomListener();
  currentRoomCode = null;
  showScreen("homeScreen");
});

// ===========================================================================
// Boot
// ===========================================================================
initHome();
