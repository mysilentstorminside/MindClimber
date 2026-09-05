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

const MAX_STEPS = 20;
const MAX_PLAYERS = 5;
const QUESTION_SECONDS = 15;
const QUESTION_SECONDS_EXTRA_DEFAULT = 3; // +3s for every category
const QUESTION_SECONDS_EXTRA_PUZZLES = 6; // +6s for Σπαζοκεφαλιές specifically
function questionSecondsFor(category) {
  return QUESTION_SECONDS + (category === "Σπαζοκεφαλιές" ? QUESTION_SECONDS_EXTRA_PUZZLES : QUESTION_SECONDS_EXTRA_DEFAULT);
}
const MOUNTAIN_SECONDS = 270;
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
      players: {
        [myPlayerId]: { name, avatar: selectedAvatar, step: 0, order: 0, joinedAt: firebase.database.ServerValue.TIMESTAMP },
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
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  if (takenAvatarsRef) { takenAvatarsRef.off(); takenAvatarsRef = null; }
  enterLobby();
});

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

  await db.ref(`rooms/${currentRoomCode}`).update({
    status: "playing",
    startedAt: firebase.database.ServerValue.TIMESTAMP,
    turnOrder,
    turnIndex: 0,
    shuffledQueues,
    turn: {
      colorPickerId: turnOrder[0],
      phase: "category",
      key: uid(),
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
  const labelSteps = new Set([1, 5, 10, 15, 20]);
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

function renderGame(room) {
  buildStaircase();
  $("stepInfo").textContent = "";
  const players = room.players || {};
  const order = Object.entries(players).sort((a, b) => a[1].order - b[1].order);

  // Single flag at the peak.
  $("peakFlags").textContent = "🚩";
  $("peakMarker").style.bottom = `${STEP_TOP_BOTTOM + PEAK_BOTTOM_OFFSET}%`;

  // Mountain timer
  renderMountainTimer(room);

  // Player tokens
  const tokenWrap = $("playerTokens");
  tokenWrap.innerHTML = "";
  const turn = room.turn || {};
  order.forEach(([pid, p], idx) => {
    const pos = stepPosition(p.step || 0, idx);
    const pose = "front";
    const el = document.createElement("div");
    const step = p.step || 0;
    el.className = "playerToken" + (turn.colorPickerId === pid ? " active-turn" : "") + (step <= 2 ? " lowStep" : "");
    el.style.bottom = pos.bottom + "%";
    el.style.left = pos.left + "%";
    el.style.width = pos.size + "px";
    el.style.height = pos.size + "px";
    el.innerHTML = `<div class="tokenAvatarWrap"><img src="${avatarSrc(p.avatar, pose)}" alt=""></div><span class="tokenName">${escapeHtml(p.name)}</span><span class="tokenStep">${step}/${MAX_STEPS}</span>`;
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
  } else if (turn.phase === "question" || turn.phase === "result") {
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

  // Only the player who picked the color drives turn progression / timeouts.
  if (isColorPicker) checkTurnProgress(room);
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

function renderMountainTimer(room) {
  if (!room.startedAt) return;
  const now = Date.now();
  const elapsed = Math.floor((now - room.startedAt) / 1000);
  const remaining = Math.max(0, MOUNTAIN_SECONDS - elapsed);
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");
  $("mountainTimer").textContent = `⏱ ${mm}:${ss}`;

  if (isHost && remaining <= 0 && room.status === "playing") {
    finishGame(room, null);
  }
}
setInterval(() => {
  if (latestRoom && latestRoom.status === "playing") {
    renderMountainTimer(latestRoom);
    if (latestRoom.turn && latestRoom.turn.colorPickerId === myPlayerId) checkTurnProgress(latestRoom);
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
    if (turn.phase === "result" && ans) {
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

async function chooseCategory(category) {
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.colorPickerId !== myPlayerId) return;
  if (latestRoom.turn.phase !== "category") return;
  await db.ref(`rooms/${currentRoomCode}/turn`).update({
    phase: "difficulty",
    category,
  });
}

async function chooseColor(color) {
  if (!latestRoom || !latestRoom.turn || latestRoom.turn.colorPickerId !== myPlayerId) return;
  if (latestRoom.turn.phase !== "difficulty") return;
  const category = latestRoom.turn.category;

  // Always read the freshest queue state right before picking, so we never
  // draw against a stale position even if the local cache lagged behind.
  const snap = await db.ref(`rooms/${currentRoomCode}/shuffledQueues/${category}/${color}`).once("value");
  const queueState = snap.val();
  const { item: q, newQueueState } = pickFromShuffledQueue(category, color, queueState);

  await db.ref(`rooms/${currentRoomCode}`).update({
    [`shuffledQueues/${category}/${color}`]: newQueueState,
    "turn/phase": "question",
    "turn/color": color,
    "turn/question": { text: q.text, options: q.options, correct: q.correct, img: q.img || null },
    "turn/deadline": Date.now() + questionSecondsFor(category) * 1000,
    "turn/answers": {},
  });
}
$("greenButton").addEventListener("click", () => chooseColor("green"));
$("blueButton").addEventListener("click", () => chooseColor("blue"));
$("orangeButton").addEventListener("click", () => chooseColor("orange"));

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

async function checkTurnProgress(room) {
  const turn = room.turn;
  if (!turn || room.status !== "playing") return;

  if (turn.phase === "question") {
    const players = room.players || {};
    const totalPlayers = Object.keys(players).length;
    const answers = turn.answers || {};
    const answeredCount = Object.keys(answers).length;
    const timedOut = Date.now() >= turn.deadline + 1200;

    if (answeredCount >= totalPlayers || timedOut) {
      // Fill in anyone who never answered (e.g. a stalled tab) as a timeout/wrong.
      const updates = {};
      Object.keys(players).forEach((pid) => {
        if (!answers[pid]) {
          const delta = -COLOR_DELTA[turn.color];
          const newStep = Math.max(0, Math.min(MAX_STEPS, (players[pid].step || 0) + delta));
          updates[`players/${pid}/step`] = newStep;
          updates[`turn/answers/${pid}`] = { option: null, correct: false };
        }
      });
      updates["turn/phase"] = "result";
      if (Object.keys(updates).length) await db.ref(`rooms/${currentRoomCode}`).update(updates);
    }
  } else if (turn.phase === "result" && resultScheduledForKey !== turn.key) {
    resultScheduledForKey = turn.key;
    setTimeout(() => advanceTurnIfNeeded(turn.key), RESULT_PAUSE_MS);
  }
}

async function advanceTurnIfNeeded(turnKey) {
  if (advancedForKey === turnKey) return;
  const snap = await db.ref(`rooms/${currentRoomCode}`).once("value");
  const room = snap.val();
  if (!room || room.status !== "playing") return;
  if (!room.turn || room.turn.key !== turnKey || room.turn.colorPickerId !== myPlayerId) return;
  advancedForKey = turnKey;

  const order = room.turnOrder || [];
  const currentIdx = order.indexOf(room.turn.colorPickerId);
  const nextIndex = (currentIdx + 1) % order.length;
  await db.ref(`rooms/${currentRoomCode}`).update({
    turnIndex: nextIndex,
    turn: {
      colorPickerId: order[nextIndex],
      phase: "category",
      key: uid(),
    },
  });
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
  await db.ref(`rooms/${currentRoomCode}`).update({
    status: "lobby",
    players: resetPlayers,
    turn: null,
    turnIndex: 0,
    turnOrder: null,
    startedAt: null,
    winnerId: null,
  });
  resultScheduledForKey = null;
  advancedForKey = null;
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
