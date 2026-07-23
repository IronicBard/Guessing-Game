const ROUND_SECONDS = 30;
const POLL_MS = 900;

const state = {
  roomCode: localStorage.getItem("gg_room_code") || "",
  playerId: localStorage.getItem("gg_player_id") || "",
  room: null,
  timerId: null,
  pollId: null,
  remaining: ROUND_SECONDS,
  answerShownForRound: null,
  currentVideoId: null,
  currentStart: null,
  clipDoneSent: false,
  mode: "create", // "create" or "join"
  clipDuration: 30, // в секундах
  answerVideoPlayed: false, // был ли уже проигран плеер на экране ответов
  answerVideoTimerId: null, // таймер для автовозврата к превью
  lastChatCount: 0,
};

const $ = (selector) => document.querySelector(selector);

// Подавляем CORS ошибки от сторонних доменов
const originalConsoleError = console.error;
console.error = function(...args) {
  const msg = args.join(' ');
  if (msg.includes('googleads.g.doubleclick.net') || msg.includes('Blocked a frame with origin') || msg.includes('CORS')) {
    // Игнорируем CORS ошибки от сторонних доменов
    return;
  }
  originalConsoleError.apply(console, args);
};

const screens = {
  home: $("#homeScreen"),
  lobby: $("#lobbyScreen"),
  prepare: $("#prepareScreen"),
  generating: $("#generatingScreen"),
  listen: $("#listenScreen"),
  guess: $("#guessScreen"),
  answer: $("#answerScreen"),
  final: $("#finalScreen"),
};

const activeRoomCode = $("#activeRoomCode");
const homeMessage = $("#homeMessage");
const lobbyMessage = $("#lobbyMessage");
const prepareMessage = $("#prepareMessage");
const guessMessage = $("#guessMessage");
const generationText = $("#generationText");

const sourceInput = $("#sourceInput");
const timeLeft = $("#timeLeft");
const timeBar = $("#timeBar");
const disc = $("#disc");
const youtubeMount = $("#youtubeMount");

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("screen-active"));
  screens[name].classList.add("screen-active");
}

function createYoutubePlayer(videoId, startSeconds) {
  // Простой iframe для Firefox - без IFrame Player API
  // Используем allow="autoplay" для автозапуска (если не блокируется корпоративной политикой)
  // Добавлен allowfullscreen для полноценной работы
  const params = new URLSearchParams({
    autoplay: "1",
    controls: "1",
    start: startSeconds,
    rel: "0",
    modestbranding: "1",
    iv_load_policy: "3",
    enablejsapi: "1", // Включаем JS API для лучшего контроля
  });
  youtubeMount.innerHTML = `<iframe title="YouTube audio" width="100%" height="100%" src="https://www.youtube.com/embed/${videoId}?${params}" allow="autoplay; encrypted-media" allowfullscreen style="border:none; width:100%; height:100%; position:absolute; top:0; left:0;"></iframe>`;
  
  console.log("YouTube player created with videoId:", videoId, "start:", startSeconds);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMsg = data.error || "Запрос не выполнен";
    const error = new Error(errorMsg);
    error.status = response.status;
    throw error;
  }
  return data;
}

function setMessage(element, text = "", kind = "") {
  element.textContent = text;
  element.className = `message ${kind}`.trim();
}

function saveSession(roomCode, playerId) {
  state.roomCode = roomCode;
  state.playerId = playerId;
  localStorage.setItem("gg_room_code", roomCode);
  localStorage.setItem("gg_player_id", playerId);
}

function clearSession() {
  stopPolling();
  stopTimer();
  state.roomCode = "";
  state.playerId = "";
  state.room = null;
  localStorage.removeItem("gg_room_code");
  localStorage.removeItem("gg_player_id");
  activeRoomCode.textContent = "----";
  youtubeMount.innerHTML = "";
  showScreen("home");
}

async function leaveLobby() {
  if (!state.roomCode || !state.playerId) return;
  try {
    await api(`/api/rooms/${state.roomCode}/leave`, {
      method: "POST",
      body: { playerId: state.playerId },
    });
    clearSession();
  } catch (error) {
    // Если комната удалена, все равно очищаем сессию
    clearSession();
  }
}

function startPolling() {
  stopPolling();
  fetchRoom();
  state.pollId = setInterval(fetchRoom, POLL_MS);
}

function stopPolling() {
  if (state.pollId) {
    clearInterval(state.pollId);
    state.pollId = null;
  }
}

let pollFailureCount = 0;
const MAX_POLL_FAILURES = 5;

async function fetchRoom() {
  if (!state.roomCode || !state.playerId) return;
  try {
    const data = await api(`/api/rooms/${state.roomCode}?playerId=${state.playerId}`);
    state.room = data.room;
    pollFailureCount = 0;
    renderRoom();
  } catch (error) {
    pollFailureCount++;
    if (error.status === 404 || error.status === 403) {
      setMessage(homeMessage, "Комната больше не существует.", "error");
      clearSession();
    } else if (pollFailureCount >= MAX_POLL_FAILURES) {
      setMessage(homeMessage, "Потеряно соединение с сервером. Попробуйте обновить страницу.", "error");
      stopPolling();
    }
  }
}

function renderRoom() {
  const room = state.room;
  if (!room) return;
  activeRoomCode.textContent = room.code;
  
  console.log("renderRoom: clipDuration from server =", room.clipDuration);
  console.log("renderRoom: old state.clipDuration =", state.clipDuration);
  
  // Обновляем clipDuration из комнаты
  const oldClipDuration = state.clipDuration;
  if (room.clipDuration) {
    state.clipDuration = room.clipDuration;
  }
  
  console.log("renderRoom: new state.clipDuration =", state.clipDuration);
  
  // Если clipDuration изменился и таймер работает, сбрасываем его
  if (state.timerId && oldClipDuration !== state.clipDuration) {
    console.log("Clip duration changed, resetting timer");
    stopTimer();
    resetTimer();
  }

  if (room.phase === "lobby") renderLobby(room);
  if (room.phase === "prepare") renderPrepare(room);
  if (room.phase === "generating") renderGenerating(room);
  if (room.phase === "listen") renderListen(room);
  if (room.phase === "guess") renderGuess(room);
  if (room.phase === "answer") renderAnswer(room);
  if (room.phase === "final") renderFinal(room);
}

function me(room = state.room) {
  return room?.players.find((player) => player.id === state.playerId);
}

function isHost(room = state.room) {
  return room?.hostId === state.playerId;
}

function statusClass(status) {
  if (status === "ready" || status === "answered") return "ready";
  if (status === "input") return "input";
  return "";
}

function statusLabel(status) {
  if (status === "ready") return "готов";
  if (status === "input") return "вводит";
  if (status === "answered") return "ответил";
  return "не готов";
}

function renderPlayers(list, players, statusField = "status") {
  list.innerHTML = players
    .map((player) => {
      const status = player[statusField] || "idle";
      return `
        <li class="player-card">
          <span class="status-dot ${statusClass(status)}"></span>
          <div>
            <strong>${escapeHtml(player.name)}</strong>
            <div class="status-label">${statusLabel(status)}</div>
          </div>
          ${player.isHost ? '<span class="host-badge">Host</span>' : ""}
        </li>
      `;
    })
    .join("");
}

function renderChat(room) {
  const messages = room.messages || [];
  const chatList = $("#chatMessages");
  if (!chatList) return;
  
  // Рендерим только новые сообщения
  if (messages.length > state.lastChatCount) {
    const newMessages = messages.slice(state.lastChatCount);
    newMessages.forEach((msg) => {
      const li = document.createElement("li");
      li.className = msg.playerId === state.playerId ? "chat-msg self" : "chat-msg";
      li.innerHTML = `<strong>${escapeHtml(msg.playerName)}</strong><span>${escapeHtml(msg.text)}</span>`;
      chatList.appendChild(li);
    });
    state.lastChatCount = messages.length;
    chatList.scrollTop = chatList.scrollHeight;
  }
}

async function sendChatMessage() {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await api(`/api/rooms/${state.roomCode}/chat`, {
      method: "POST",
      body: { playerId: state.playerId, text },
    });
    fetchRoom();
  } catch (error) {
    setMessage(lobbyMessage, "Ошибка отправки сообщения", "error");
  }
}

function renderLobby(room) {
  showScreen("lobby");
  $("#lobbyTitle").textContent = `#${room.code}`;
  $("#lobbyTitleCode").textContent = `#${room.code}`;
  $("#playerCount").textContent = `${room.players.length} / 4`;
  renderPlayers($("#lobbyPlayers"), room.players.map((player) => ({ ...player, status: "ready" })));
  $("#startPrepBtn").disabled = !isHost(room) || room.players.length < 2 || room.players.length > 4;
  $("#settingsBtn").disabled = !isHost(room);
  setMessage(lobbyMessage, isHost(room) ? "" : "Только создатель комнаты может начать игру.");
  
  // Сбрасываем таймер при входе в лобби
  stopTimer();
  resetTimer();
  
  // Рендерим чат
  renderChat(room);
}

function renderPrepare(room) {
  showScreen("prepare");
  const currentPlayer = me(room);
  const submitted = currentPlayer?.hasSource;
  $("#submitSourceBtn").disabled = submitted;
  sourceInput.disabled = submitted;
  if (submitted) {
    setMessage(prepareMessage, "Ваш выбор сохранён. Ждём остальных игроков.", "ok");
  } else if (room.message) {
    setMessage(prepareMessage, room.message, "error");
  } else {
    setMessage(prepareMessage);
  }
  $("#prepareCount").textContent = `${room.players.filter((player) => player.hasSource).length} / ${room.players.length}`;
  renderPlayers(
    $("#preparePlayers"),
    room.players.map((player) => ({
      ...player,
      status: player.hasSource ? "ready" : "input",
    })),
  );
  
  // Сбрасываем таймер при переходе в prepare
  stopTimer();
  resetTimer();
}

function renderGenerating(room) {
  showScreen("generating");
  generationText.textContent = room.message || "Ищем каналы, видео и случайные фрагменты.";
}

function renderListen(room) {
  const round = room.rounds[room.currentRound];
  showScreen("listen");
  $("#listenLabel").textContent = `Раунд ${room.currentRound + 1}`;
  $("#listenProgress").textContent = `${room.currentRound + 1} / ${room.rounds.length}`;
  renderPlayers($("#listenPlayers"), room.players.map((player) => ({ ...player, status: "ready" })));
  
  // Обновляем clipDuration из комнаты если есть
  if (room.clipDuration) {
    state.clipDuration = room.clipDuration;
  }

  // Сбрасываем таймер если не запущен и значение не совпадает
  if (!state.timerId && state.remaining !== state.clipDuration) {
    resetTimer();
  }
}

function renderGuess(room) {
  showScreen("guess");
  stopTimer();
  
  const round = room.rounds[room.currentRound];
  const currentPlayer = me(room);
  const answered = Boolean(round.answers[currentPlayer.id]);
  $("#submitGuessBtn").disabled = answered;
  $("#guessInput").disabled = answered;
  if (answered) {
    setMessage(guessMessage, "Ответ отправлен. Ждём остальных.", "ok");
  } else {
    setMessage(guessMessage);
  }
  $("#guessCount").textContent = `${Object.keys(round.answers).length} / ${room.players.length}`;
  renderPlayers(
    $("#guessPlayers"),
    room.players.map((player) => ({
      ...player,
      status: round.answers[player.id] ? "answered" : "input",
    })),
  );
}

function renderAnswer(room) {
  showScreen("answer");
  stopTimer();
  
  const round = room.rounds[room.currentRound];
  const videoContainer = $("#answerVideoContainer");
  const thumb = $("#answerThumb");

  if (state.answerShownForRound !== room.currentRound) {
    state.answerShownForRound = room.currentRound;
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Сброс состояния плеера для нового раунда
    state.answerVideoPlayed = false;
    if (state.answerVideoTimerId) {
      clearTimeout(state.answerVideoTimerId);
      state.answerVideoTimerId = null;
    }

    // Устанавливаем превьюшку
    thumb.src = round.video.thumbnail;
    thumb.classList.remove("hidden");
    thumb.style.display = "";

    // Удаляем старый плеер и оверлей, создаём заново
    const oldFrame = videoContainer.querySelector(".video-frame");
    if (oldFrame) oldFrame.remove();
    const oldOverlay = videoContainer.querySelector(".play-overlay");
    if (oldOverlay) oldOverlay.remove();

    // Создаём play-оверлей
    const overlay = document.createElement("div");
    overlay.className = "play-overlay";
    overlay.innerHTML = '<div class="play-triangle"></div>';
    videoContainer.appendChild(overlay);
    
    // iframe НЕ создаём заранее — создадим по клику
  }

  // Если видео уже было проиграно — показываем превью и блокируем
  if (state.answerVideoPlayed) {
    thumb.classList.remove("hidden");
    thumb.style.display = "";
    const overlay = videoContainer.querySelector(".play-overlay");
    if (overlay) overlay.classList.add("hidden");
  }

  $("#answerLabel").textContent = `Раунд ${room.currentRound + 1}`;
  $("#answerProgress").textContent = `${room.currentRound + 1} / ${room.rounds.length}`;
  $("#realTitle").textContent = round.video.title;
  $("#videoLink").href = `https://www.youtube.com/watch?v=${round.video.id}&t=${round.start}s`;
  $("#clipInfo").textContent = `${round.video.channelTitle}: ${formatTime(round.start)}-${formatTime(round.end)}`;
  $("#nextRoundBtn").textContent = room.currentRound === room.rounds.length - 1 ? "Итоговая таблица" : "Следующий ролик";
  $("#nextRoundBtn").disabled = !isHost(room);

  $("#roundAnswers").innerHTML = room.players
    .map((player) => {
      const answer = round.answers[player.id]?.text || "Нет ответа";
      const score = round.answers[player.id]?.score || 0;
      return `
        <li class="answer-card">
          <div>
            <strong>${escapeHtml(player.name)}</strong>
            <span>${escapeHtml(answer)}</span>
          </div>
          <div class="score">+${score}</div>
        </li>
      `;
    })
    .join("");
}

// Клик по контейнеру видео — запуск плеера (только если ещё не играли)
$("#answerVideoContainer").addEventListener("click", function () {
  if (state.answerVideoPlayed) return;
  const round = state.room?.rounds[state.room.currentRound];
  if (!round) return;

  const thumb = $("#answerThumb");
  const overlay = this.querySelector(".play-overlay");

  // Создаём iframe прямо по клику (user gesture для autoplay)
  let frame = this.querySelector(".video-frame");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "video-frame";
    frame.title = "YouTube video player";
    frame.width = "100%";
    frame.height = "100%";
    frame.allow = "autoplay; encrypted-media";
    // Блокируем fullscreen через атрибут
    this.appendChild(frame);
  }

  // Прячем превью и оверлей, показываем плеер с автозапуском
  thumb.classList.add("hidden");
  if (overlay) overlay.classList.add("hidden");
  frame.classList.add("active");

  // Запускаем плеер с autoplay=1 — всё взаимодействие заблокировано
  const start = round.start;
  const end = round.end;
  frame.src = `https://www.youtube.com/embed/${round.video.id}?autoplay=1&controls=0&start=${start}&end=${end}&rel=0&modestbranding=1&iv_load_policy=3&disablekb=1&fs=0&playsinline=1&loop=0`;

  state.answerVideoPlayed = true;

  // Таймер на длительность клипа — возвращаем превью
  state.answerVideoTimerId = setTimeout(() => {
    frame.classList.remove("active");
    frame.src = `https://www.youtube.com/embed/${round.video.id}?autoplay=0&controls=1&start=${start}&rel=0&modestbranding=1&iv_load_policy=3`;
    thumb.classList.remove("hidden");
    thumb.style.display = "";
    if (overlay) overlay.classList.add("hidden"); // оверлей не показываем — blocked
    state.answerVideoTimerId = null;
  }, state.clipDuration * 1000);
});

function renderFinal(room) {
  showScreen("final");
  const totals = [...room.scoreboard].sort((a, b) => b.score - a.score);
  $("#winnerTitle").textContent = `Победитель: ${totals[0]?.name || "-"}`;
  $("#scoreTable").innerHTML = totals
    .map(
      (player, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(player.name)}</td>
          <td>${player.score}</td>
        </tr>
      `,
    )
    .join("");
}

function resetTimer() {
  console.log("resetTimer: setting state.remaining to", state.clipDuration);
  state.remaining = state.clipDuration;
  timeLeft.textContent = state.remaining;
  timeBar.style.width = "0%";
  $("#playClipBtn").disabled = false;
  state.clipDoneSent = false;
}

function startTimer() {
  if (state.timerId) return;
  const round = state.room?.rounds[state.room.currentRound];
  if (!round) {
    console.error("No round found for timer start");
    return;
  }
  
  console.log("startTimer: clipDuration =", state.clipDuration, "remaining =", state.remaining);
  console.log("startTimer: videoId =", round.video.id, "start =", round.start);
  
  $("#playClipBtn").disabled = true;
  state.remaining = state.clipDuration;
  
  console.log("startTimer: setting remaining to", state.remaining);
  
  // Создаём YouTube player через simple iframe
  createYoutubePlayer(round.video.id, round.start);
  
  // Небольшая задержка перед запуском таймера, чтобы iframe успел загрузиться
  setTimeout(() => {
    console.log("Starting timer interval");
    tickTimer();
    disc.classList.add("is-playing");
    state.timerId = setInterval(tickTimer, 1000);
  }, 100);
}

function tickTimer() {
  timeLeft.textContent = state.remaining;
  timeBar.style.width = `${((state.clipDuration - state.remaining) / state.clipDuration) * 100}%`;
  if (state.remaining <= 0) {
    stopTimer();
    youtubeMount.innerHTML = "";
    state.currentVideoId = null;
    state.currentStart = null;
    
    finishListening();
    return;
  }
  state.remaining -= 1;
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  disc.classList.remove("is-playing");
}

async function finishListening() {
  if (state.clipDoneSent || !state.roomCode) return;
  state.clipDoneSent = true;
  
  try {
    await api(`/api/rooms/${state.roomCode}/listen-done`, {
      method: "POST",
      body: { playerId: state.playerId },
    });
    fetchRoom();
  } catch {
    state.clipDoneSent = false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

$("#createBtn").addEventListener("click", () => {
  state.mode = "create";
  $("#joinCodeContainer").style.display = "none";
  $("#joinCodeInput").removeAttribute("required");
  $("#submitHomeBtn").style.display = "inline-block";
  
  // Меняем цвета кнопок
  $("#createBtn").classList.remove("secondary-btn");
  $("#createBtn").classList.add("primary-btn");
  $("#joinBtn").classList.remove("primary-btn");
  $("#joinBtn").classList.add("secondary-btn");
  
  setTimeout(() => $("#submitHomeBtn").focus(), 0);
});

$("#joinBtn").addEventListener("click", () => {
  state.mode = "join";
  $("#joinCodeContainer").style.display = "block";
  $("#joinCodeInput").setAttribute("required", "required");
  $("#submitHomeBtn").style.display = "inline-block";
  
  // Меняем цвета кнопок
  $("#joinBtn").classList.remove("secondary-btn");
  $("#joinBtn").classList.add("primary-btn");
  $("#createBtn").classList.remove("primary-btn");
  $("#createBtn").classList.add("secondary-btn");
  
  setTimeout(() => $("#joinCodeInput").focus(), 0);
});

$("#homeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = $("#playerNameInput").value.trim();
    if (!name) throw new Error("Введите имя");
    
    if (state.mode === "create") {
      const data = await api("/api/rooms", { 
        method: "POST", 
        body: { name, clipDuration: state.clipDuration } 
      });
      saveSession(data.room.code, data.playerId);
      setMessage(homeMessage);
      startPolling();
    } else {
      const code = $("#joinCodeInput").value.trim().toUpperCase();
      if (!code) throw new Error("Введите код комнаты");
      const data = await api(`/api/rooms/${code}/join`, { 
        method: "POST", 
        body: { name } 
      });
      saveSession(data.room.code, data.playerId);
      setMessage(homeMessage);
      startPolling();
    }
  } catch (error) {
    setMessage(homeMessage, error.message, "error");
  }
});

$("#copyCodeBtn").addEventListener("click", async () => {
  try {
    if (!navigator.clipboard) {
      throw new Error("Копирование не поддерживается");
    }
    await navigator.clipboard.writeText(state.roomCode);
    setMessage(lobbyMessage, "✓ Код скопирован!", "ok");
    setTimeout(() => setMessage(lobbyMessage), 3000);
  } catch (error) {
    // Fallback для браузеров без Clipboard API
    try {
      const input = document.createElement("input");
      input.value = state.roomCode;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setMessage(lobbyMessage, "✓ Код скопирован!", "ok");
      setTimeout(() => setMessage(lobbyMessage), 3000);
    } catch {
      setMessage(lobbyMessage, "Ошибка: не удалось скопировать код", "error");
    }
  }
});

$("#chatSendBtn").addEventListener("click", sendChatMessage);
$("#chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

$("#startPrepBtn").addEventListener("click", async () => {
  try {
    await api(`/api/rooms/${state.roomCode}/start`, {
      method: "POST",
      body: { playerId: state.playerId, clipDuration: state.clipDuration },
    });
    fetchRoom();
  } catch (error) {
    setMessage(lobbyMessage, error.message, "error");
  }
});

document.querySelectorAll('input[name="sourceMode"]').forEach((input) => {
  input.addEventListener("change", () => {
    sourceInput.placeholder = input.value === "video" ? "https://www.youtube.com/watch?v=..." : "MrBeast";
  });
});

$("#prepareForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = document.querySelector('input[name="sourceMode"]:checked').value;
  const value = sourceInput.value.trim();
  try {
    await api(`/api/rooms/${state.roomCode}/prepare`, {
      method: "POST",
      body: { playerId: state.playerId, mode, value },
    });
    sourceInput.value = "";
    fetchRoom();
  } catch (error) {
    setMessage(prepareMessage, error.message, "error");
  }
});

$("#playClipBtn").addEventListener("click", () => startTimer());

$("#guessForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const text = $("#guessInput").value.trim();
    await api(`/api/rooms/${state.roomCode}/guess`, {
      method: "POST",
      body: { playerId: state.playerId, text },
    });
    $("#guessInput").value = "";
    fetchRoom();
  } catch (error) {
    setMessage(guessMessage, error.message, "error");
  }
});

$("#nextRoundBtn").addEventListener("click", async () => {
  try {
    await api(`/api/rooms/${state.roomCode}/next`, {
      method: "POST",
      body: { playerId: state.playerId },
    });
    state.remaining = state.clipDuration;
    state.answerShownForRound = null;
    state.currentVideoId = null;
    state.currentStart = null;
    state.clipDoneSent = false;
    state.answerVideoPlayed = false;
    if (state.answerVideoTimerId) {
      clearTimeout(state.answerVideoTimerId);
      state.answerVideoTimerId = null;
    }
    youtubeMount.innerHTML = "";
    fetchRoom();
  } catch (error) {
    setMessage(guessMessage, error.message, "error");
  }
});

$("#settingsBtn").addEventListener("click", () => {
  $("#settingsModal").style.display = "flex";
  const duration = state.clipDuration.toString();
  document.querySelector(`input[name="clipDuration"][value="${duration}"]`).checked = true;
});

$("#closeSettingsBtn").addEventListener("click", () => {
  $("#settingsModal").style.display = "none";
});

$("#saveSettingsBtn").addEventListener("click", async () => {
  const newDuration = parseInt(document.querySelector('input[name="clipDuration"]:checked').value);
  state.clipDuration = newDuration;
  $("#settingsModal").style.display = "none";
  setMessage(lobbyMessage, "✓ Длительность клипа: " + state.clipDuration + " сек", "ok");
  setTimeout(() => setMessage(lobbyMessage), 2000);
  // Обновляем clipDuration на сервере без запуска игры
  if (state.roomCode) {
    try {
      await api(`/api/rooms/${state.roomCode}/settings`, {
        method: "POST",
        body: { playerId: state.playerId, clipDuration: newDuration },
      });
    } catch (error) {
      setMessage(lobbyMessage, "Ошибка при обновлении настроек", "error");
    }
  }
});

$("#settingsModal").addEventListener("click", (e) => {
  if (e.target === $("#settingsModal")) {
    $("#settingsModal").style.display = "none";
  }
});

$("#leaveBtn").addEventListener("click", clearSession);

$("#leaveLobbyBtn").addEventListener("click", () => {
  $("#confirmLeaveLobbyBtn").style.display = "inline-block";
});

$("#confirmLeaveLobbyBtn").addEventListener("click", () => {
  $("#confirmLeaveLobbyBtn").style.display = "none";
  leaveLobby();
});

$("#playAgainBtn").addEventListener("click", async () => {
  try {
    await api(`/api/rooms/${state.roomCode}/restart`, {
      method: "POST",
      body: { playerId: state.playerId },
    });
    state.remaining = state.clipDuration;
    state.answerShownForRound = null;
    state.currentVideoId = null;
    state.currentStart = null;
    state.clipDoneSent = false;
    state.answerVideoPlayed = false;
    if (state.answerVideoTimerId) {
      clearTimeout(state.answerVideoTimerId);
      state.answerVideoTimerId = null;
    }
    youtubeMount.innerHTML = "";
    fetchRoom();
  } catch (error) {
    setMessage(lobbyMessage, error.message, "error");
  }
});

if (state.roomCode && state.playerId) {
  startPolling();
}
