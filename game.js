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
  return QUESTION_SECONDS + (category === "Σπαζοκεφαλιές" ? QUESTION_SECONDS_EXTRA_PUZZLES : QUESTION_SECONDS_EXTRA_DEFAULT);
}
const PLAYER_SECONDS = 260;
const CATEGORY_CHOICE_SECONDS = 8;
const DIFFICULTY_CHOICE_SECONDS = 6;
const AVATAR_COUNT = 11;
const COLOR_DELTA = { green: 1, blue: 2, orange: 3 };
const COLOR_TO_DIFF = { green: "easy", blue: "medium", orange: "hard" };
const RESULT_PAUSE_MS = 2200;

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }
  return audioCtx;
}
function playTone(freqStart, freqEnd, durationMs, type) {
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
  if (isSolo) await startSoloGame();
  else enterLobby();
});

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

function renderLobby(room) {
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
  try { await db.ref(`rooms/${currentRoomCode}/players/${myPlayerId}`).remove(); } catch (e) {}
  detachRoomListener();
  currentRoomCode = null;
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
    else if (room.status === "playing") { showScreen("gameScreen"); renderGame(room); }
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
// Climb mapping: leave room at bottom so avatar at step 0 is fully visible
// above the question panel. Compress rungs toward the upper band.
const STEP_BASE_BOTTOM = 18;   // % — player start sits clearly above panel
const STEP_TOP_BOTTOM = 88;    // % — step 30 near top of climbZone
const PEAK_BOTTOM_OFFSET = 0;  // flag sits on step 30

function buildStaircase() {
  if (staircaseBuilt) return;
  staircaseBuilt = true;
  const peakLabel = $("peakStepLabel");
  if (peakLabel) peakLabel.textContent = MAX_STEPS;
  const wrap = $("stairLines");
  wrap.innerHTML = "";
  // Only label 10, 20, 30 (0 is the ground marker)
  const labelSteps = new Set([10, 20, 30]);
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

function stepPosition(step, orderIndex) {
  const s = Math.max(0, Math.min(MAX_STEPS, step));
  const bottom = STEP_BASE_BOTTOM + (s / MAX_STEPS) * (STEP_TOP_BOTTOM - STEP_BASE_BOTTOM);
  const jitter = (orderIndex - 2) * 12;
  const left = Math.min(86, Math.max(14, 50 + jitter));
  // Slightly smaller tokens so they fit better in the band
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


function renderPlayerStrip(room, order) {
  const strip = $("playerStrip");
  if (!strip) return;
  const turn = room.turn || {};
  const activeId = turn.colorPickerId;
  strip.innerHTML = "";
  order.forEach(([pid, p]) => {
    const cell = document.createElement("div");
    const isActive = pid === activeId;
    cell.className = "stripPlayer"
      + (isActive ? " stripActive" : "")
      + (pid === myPlayerId ? " stripMe" : "")
      + (p.eliminated ? " stripOut" : "");
    cell.innerHTML = `
      <div class="stripAvatar"><img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.opacity=0.3"></div>
      <div class="stripName">${escapeHtml(p.name)}</div>
      <div class="stripStep">${p.step || 0}</div>`;
    strip.appendChild(cell);
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
  // Flag sits exactly on the same vertical as step 30
  $("peakMarker").style.bottom = STEP_TOP_BOTTOM + "%";

  const tokenWrap = $("playerTokens");
  tokenWrap.innerHTML = "";
  order.forEach(([pid, p], idx) => {
    const step = p.step || 0;
    const pos = stepPosition(step, idx);
    const tok = document.createElement("div");
    const isActive = room.turn && room.turn.colorPickerId === pid;
    tok.className = "playerToken"
      + (p.eliminated ? " eliminated" : "")
      + (step < 3 ? " lowStep" : "")
      + (pid === myPlayerId ? " is-me" : "")
      + (isActive ? " active-turn" : "");
    tok.dataset.pid = pid;
    tok.style.left = pos.left + "%";
    tok.style.bottom = pos.bottom + "%";
    tok.style.width = pos.size + "px";
    tok.style.height = pos.size + "px";
    // Compact token: no turn text (turn is shown in bottom playerStrip)
    tok.innerHTML = `
      <div class="tokenTimer">${formatTimeLeft(computeLiveTimeLeft(pid, p, room))}</div>
      <div class="tokenAvatarWrap"><img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.opacity=0.3"></div>
      <div class="tokenName">${escapeHtml(p.name)}</div>
      <div class="tokenStep">${step}</div>`;
    tokenWrap.appendChild(tok);
  });

  // Bottom strip: all players — active one in gold circle
  renderPlayerStrip(room, order);

  const turn = room.turn || {};

  // hide all phase panels
  ["categoryChoiceRow","selectedCategoryLabel","colorChoiceRow","waitingNote","questionRectangle","questionImage","answerRectangle","allAnswersStatus","qTimerWrap","choiceTimerWrap"].forEach((id) => {
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
    $("selectedCategoryLabel").textContent = (turn.category || "") + (turn.color ? " · " + ({green:"Εύκολο",blue:"Μέτριο",orange:"Δύσκολο"}[turn.color]||"") : "");
    $("selectedCategoryLabel").classList.remove("hidden");
    renderQuestion(turn, turn.phase === "result");
    $("answerRectangle").classList.remove("hidden");
    $("allAnswersStatus").classList.remove("hidden");
    if (turn.phase === "question") startLocalQuestionTimer(turn);
    renderAnswerStatuses(room);
  }

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

function renderQuestion(turn, showResult) {
  const q = turn.question || {};
  const img = $("questionImage");
  const rect = $("questionRectangle");
  if (q.img) {
    img.src = q.img;
    img.classList.remove("hidden");
    rect.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    rect.textContent = q.text || "";
    rect.classList.remove("hidden");
  }
  const opts = q.options || ["", "", ""];
  document.querySelectorAll(".answerOption").forEach((el) => {
    const letter = el.dataset.option;
    const i = letter.charCodeAt(0) - 65;
    el.textContent = (letter + ". " + (opts[i] || "")).trim();
    el.classList.remove("picked", "correct", "wrong", "disabled");
    if (showResult || (turn.answers && turn.answers[myPlayerId])) {
      el.classList.add("disabled");
      if (letter === q.correct) el.classList.add("correct");
      const myAns = turn.answers && turn.answers[myPlayerId];
      if (myAns && myAns.option === letter && !myAns.correct) el.classList.add("wrong");
    }
  });
}

function renderAnswerStatuses(room) {
  const wrap = $("allAnswersStatus");
  wrap.innerHTML = "";
  const answers = (room.turn && room.turn.answers) || {};
  Object.entries(room.players || {}).forEach(([pid, p]) => {
    const chip = document.createElement("div");
    let cls = "answerStatusChip", mark = "…";
    if (p.eliminated) { cls += " eliminated-chip"; mark = "—"; }
    else if (answers[pid]) { cls += answers[pid].correct ? " correct" : " wrong"; mark = answers[pid].correct ? "✓" : "✗"; }
    else cls += " waiting";
    chip.className = cls;
    chip.innerHTML = `<img src="${avatarSrc(p.avatar, "front")}" alt="" onerror="this.style.display='none'"><span>${escapeHtml(p.name)} ${mark}</span>`;
    wrap.appendChild(chip);
  });
}

function fisherYatesShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickFromShuffledQueue(category, color, queueState) {
  const diffKey = COLOR_TO_DIFF[color] || "easy";
  const pool = (window.QUESTION_BANK && window.QUESTION_BANK[category] && window.QUESTION_BANK[category][diffKey]) || [];
  if (!pool.length) {
    return { item: { text: "Δεν βρέθηκαν ερωτήσεις.", options: ["-", "-", "-"], correct: "A", img: null }, newQueueState: queueState || null };
  }
  let order = queueState && queueState.order;
  let pos = queueState && queueState.pos;
  if (!Array.isArray(order) || order.length !== pool.length || typeof pos !== "number" || pos >= order.length) {
    order = fisherYatesShuffle(pool.map((_, i) => i));
    pos = 0;
  }
  const item = pool[order[pos]];
  return {
    item: { text: item.q, options: item.o, correct: item.a, img: item.img || null },
    newQueueState: { order, pos: pos + 1 },
  };
}

function applyTimeDeduction(updates, pid, currentTimeLeft, alreadyEliminated, elapsedSeconds) {
  const newTimeLeft = Math.max(0, (currentTimeLeft ?? PLAYER_SECONDS) - elapsedSeconds);
  updates[`players/${pid}/timeLeft`] = newTimeLeft;
  if (newTimeLeft <= 0 && !alreadyEliminated) updates[`players/${pid}/eliminated`] = true;
  return newTimeLeft;
}

async function buildQuestionTurnUpdates(category, color) {
  const qSnap = await db.ref(`rooms/${currentRoomCode}/shuffledQueues/${category}/${color}`).once("value");
  const { item: q, newQueueState } = pickFromShuffledQueue(category, color, qSnap.val());
  return {
    [`shuffledQueues/${category}/${color}`]: newQueueState,
    "turn/phase": "question",
    "turn/color": color,
    "turn/category": category,
    "turn/question": { text: q.text, options: q.options, correct: q.correct, img: q.img || null },
    "turn/deadline": Date.now() + questionSecondsFor(category) * 1000,
    "turn/answers": {},
  };
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
    if (remainMs <= 0) { clearInterval(localQuestionTimerHandle); localQuestionTimerHandle = null; }
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
  const correct = pickedOption === turn.question.correct;
  if (correct) playSuccessSound(); else playFailureSound();
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
    const timedOut = Date.now() >= turn.deadline + 1200;
    if (answered >= active.length || timedOut) {
      const updates = {};
      const totalSeconds = questionSecondsFor(turn.category);
      active.forEach((pid) => {
        if (!answers[pid]) {
          const delta = -COLOR_DELTA[turn.color];
          updates[`players/${pid}/step`] = Math.max(0, Math.min(MAX_STEPS, (players[pid].step || 0) + delta));
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

function renderResults(room) {
  const players = room.players || {};
  const ranked = rankPlayers(players);
  const winnerEntry = room.winnerId && players[room.winnerId] ? [room.winnerId, players[room.winnerId]] : ranked[0];
  const winner = winnerEntry ? winnerEntry[1] : null;
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
  try { await db.ref(`rooms/${currentRoomCode}/players/${myPlayerId}`).remove(); } catch (e) {}
  detachRoomListener();
  currentRoomCode = null;
  showScreen("homeScreen");
});

setInterval(() => {
  if (latestRoom && latestRoom.status === "playing") renderPlayerTimers(latestRoom);
}, 1000);

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
