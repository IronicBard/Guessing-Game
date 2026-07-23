import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Load .env file
let env = typeof process === "undefined" ? {} : process.env;
try {
  const envFile = await fs.readFile(path.join(ROOT, ".env"), "utf8");
  envFile.split("\n").forEach((line) => {
    const [key, value] = line.split("=");
    if (key && value) env[key.trim()] = value.trim();
  });
} catch {
  // .env not found, use process.env only
}

const PORT = Number(env.PORT || 8765);
const YOUTUBE_API_KEY = env.YOUTUBE_API_KEY || "";
const ROUND_SECONDS = 30;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

const rooms = new Map();
const ROOM_TIMEOUT = 24 * 60 * 60 * 1000; // 24 часа

function cleanupOldRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (!room.lastActivity) {
      room.lastActivity = now;
    } else if (now - room.lastActivity > ROOM_TIMEOUT) {
      rooms.delete(code);
    }
  }
}

// Запуск очистки каждый час
setInterval(cleanupOldRooms, 60 * 60 * 1000);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? roomCode() : code;
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    message: room.message,
    currentRound: room.currentRound,
    clipDuration: room.clipDuration,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isHost: player.id === room.hostId,
      hasSource: Boolean(player.source),
    })),
    rounds: room.rounds.map((round) => ({
      ownerId: round.ownerId,
      start: round.start,
      end: round.end,
      video: room.phase === "answer" || room.phase === "final" ? round.video : safeVideo(round.video),
      answers: round.answers,
    })),
    scoreboard: scoreboard(room),
    messages: room.messages,
  };
}

function safeVideo(video) {
  return {
    id: video.id,
    channelTitle: "Скрыто",
    title: "Скрыто",
    thumbnail: "",
  };
}

function scoreboard(room) {
  return room.players.map((player) => ({
    id: player.id,
    name: player.name,
    score: room.rounds.reduce((sum, round) => sum + (round.answers[player.id]?.score || 0), 0),
  }));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireRoom(code) {
  const room = rooms.get(code);
  if (!room) {
    const error = new Error("Комната не найдена.");
    error.status = 404;
    throw error;
  }
  return room;
}

function requirePlayer(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) {
    const error = new Error("Игрок не найден в комнате.");
    error.status = 403;
    throw error;
  }
  return player;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readBody(req);
      const name = cleanName(body.name, "Player1");
      const clipDuration = Math.min(30, Math.max(15, parseInt(body.clipDuration) || 30));
      const code = roomCode();
      const player = { id: crypto.randomUUID(), name, source: null };
      const room = {
        code,
        hostId: player.id,
        phase: "lobby",
        message: "",
        players: [player],
        rounds: [],
        currentRound: 0,
        clipDuration,
        lastActivity: Date.now(),
        messages: [],
      };
      rooms.set(code, room);
      sendJson(res, 201, { playerId: player.id, room: publicRoom(room) });
      return;
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/join$/);
    if (req.method === "POST" && joinMatch) {
      const room = requireRoom(joinMatch[1]);
      room.lastActivity = Date.now();
      if (room.phase !== "lobby") throw httpError("Игра уже началась.", 409);
      if (room.players.length >= MAX_PLAYERS) throw httpError("В комнате уже 4 игрока.", 409);
      const body = await readBody(req);
      const player = { id: crypto.randomUUID(), name: cleanName(body.name, `Player${room.players.length + 1}`), source: null };
      room.players.push(player);
      sendJson(res, 200, { playerId: player.id, room: publicRoom(room) });
      return;
    }

    const getMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)$/);
    if (req.method === "GET" && getMatch) {
      const room = requireRoom(getMatch[1]);
      room.lastActivity = Date.now();
      requirePlayer(room, url.searchParams.get("playerId"));
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const startMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/start$/);
    if (req.method === "POST" && startMatch) {
      const room = requireRoom(startMatch[1]);
      room.lastActivity = Date.now();
      const body = await readBody(req);
      console.log("/start called, clipDuration from body:", body.clipDuration);
      if (room.hostId !== body.playerId) throw httpError("Начать игру может только Host.", 403);
      if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) {
        throw httpError("Нужно 2-4 игрока.", 409);
      }
      // Обновляем clipDuration если передан
      if (body.clipDuration) {
        room.clipDuration = Math.min(30, Math.max(15, parseInt(body.clipDuration) || 30));
        console.log("Updated room.clipDuration to:", room.clipDuration);
      }
      room.phase = "prepare";
      room.message = "";
      room.players.forEach((player) => {
        player.source = null;
      });
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const prepareMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/prepare$/);
    if (req.method === "POST" && prepareMatch) {
      const room = requireRoom(prepareMatch[1]);
      room.lastActivity = Date.now();
      if (room.phase !== "prepare") throw httpError("Сейчас нельзя менять подготовку.", 409);
      const body = await readBody(req);
      const player = requirePlayer(room, body.playerId);
      const mode = body.mode === "video" ? "video" : "channel";
      const value = String(body.value || "").trim();
      if (!value) throw httpError("Введите канал или ссылку.", 400);
      if (mode === "channel" && !YOUTUBE_API_KEY) {
        throw httpError("Для поиска каналов нужен YOUTUBE_API_KEY. Можно выбрать режим ссылки на ролик.", 400);
      }
      player.source = { mode, value };
      if (room.players.every((item) => item.source)) {
        room.phase = "generating";
        room.message = "Все игроки готовы. Получаем ролики через YouTube.";
        buildRounds(room).catch((error) => {
          room.phase = "prepare";
          room.message = error.message;
          room.players.forEach((item) => {
            item.source = null;
          });
        });
      }
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const guessMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/guess$/);
    if (req.method === "POST" && guessMatch) {
      const room = requireRoom(guessMatch[1]);
      room.lastActivity = Date.now();
      if (room.phase !== "guess") throw httpError("Сейчас не этап ответов.", 409);
      const body = await readBody(req);
      const player = requirePlayer(room, body.playerId);
      const text = String(body.text || "").trim();
      if (!text) throw httpError("Введите ответ.", 400);
      const round = room.rounds[room.currentRound];
      round.answers[player.id] = { text, score: scoreAnswer(text, round.video.title) };
      if (room.players.every((item) => round.answers[item.id])) {
        room.phase = "answer";
      }
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const listenDoneMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/listen-done$/);
    if (req.method === "POST" && listenDoneMatch) {
      const room = requireRoom(listenDoneMatch[1]);
      room.lastActivity = Date.now();
      if (room.phase !== "listen") throw httpError("Сейчас не этап прослушивания.", 409);
      const body = await readBody(req);
      const player = requirePlayer(room, body.playerId);
      player.listeningDone = true;
      if (room.players.every((item) => item.listeningDone)) {
        room.phase = "guess";
        room.players.forEach((item) => {
          item.listeningDone = false;
        });
      }
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const nextMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/next$/);
    if (req.method === "POST" && nextMatch) {
      const room = requireRoom(nextMatch[1]);
      room.lastActivity = Date.now();
      const body = await readBody(req);
      if (room.hostId !== body.playerId) throw httpError("Переключать раунд может только Host.", 403);
      if (room.currentRound >= room.rounds.length - 1) {
        room.phase = "final";
      } else {
        room.currentRound += 1;
        room.phase = "listen";
      }
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const restartMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/restart$/);
    if (req.method === "POST" && restartMatch) {
      const room = requireRoom(restartMatch[1]);
      room.lastActivity = Date.now();
      const body = await readBody(req);
      if (room.hostId !== body.playerId) throw httpError("Перезапустить игру может только Host.", 403);
      room.phase = "lobby";
      room.message = "";
      room.rounds = [];
      room.currentRound = 0;
      room.players.forEach((player) => {
        player.source = null;
        player.listeningDone = false;
      });
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const settingsMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/settings$/);
    if (req.method === "POST" && settingsMatch) {
      const room = requireRoom(settingsMatch[1]);
      room.lastActivity = Date.now();
      const body = await readBody(req);
      if (room.hostId !== body.playerId) throw httpError("Настройки может менять только Host.", 403);
      if (body.clipDuration) {
        room.clipDuration = Math.min(30, Math.max(15, parseInt(body.clipDuration) || 30));
      }
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    const chatMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/chat$/);
    if (req.method === "POST" && chatMatch) {
      const room = requireRoom(chatMatch[1]);
      room.lastActivity = Date.now();
      const body = await readBody(req);
      const player = requirePlayer(room, body.playerId);
      const text = String(body.text || "").trim();
      if (!text) throw httpError("Сообщение не может быть пустым.", 400);
      if (text.length > 500) throw httpError("Сообщение слишком длинное.", 400);
      room.messages.push({
        playerId: player.id,
        playerName: player.name,
        text,
        time: Date.now(),
      });
      // Храним не более 100 последних сообщений
      if (room.messages.length > 100) {
        room.messages = room.messages.slice(-100);
      }
      sendJson(res, 200, { messages: room.messages });
      return;
    }

    const leaveMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/leave$/);
    if (req.method === "POST" && leaveMatch) {
      const room = requireRoom(leaveMatch[1]);
      room.lastActivity = Date.now();
      const body = await readBody(req);
      const playerIndex = room.players.findIndex((p) => p.id === body.playerId);
      if (playerIndex === -1) throw httpError("Игрок не найден в комнате.", 403);
      
      const leavingPlayer = room.players[playerIndex];
      room.players.splice(playerIndex, 1);
      
      // Если хост покинул комнату, передаем хостство следующему игроку
      if (room.hostId === leavingPlayer.id) {
        if (room.players.length > 0) {
          room.hostId = room.players[0].id;
        }
      }
      
      // Если комната пуста, удаляем её
      if (room.players.length === 0) {
        rooms.delete(room.code);
      }
      
      sendJson(res, 200, { room: room.players.length > 0 ? publicRoom(room) : null });
      return;
    }

    sendJson(res, 404, { error: "Маршрут не найден." });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Ошибка сервера." });
  }
}

async function buildRounds(room) {
  const rounds = [];
  const videoPromises = room.players.map(async (player) => {
    room.message = `Получаем ролик для ${player.name}...`;
    const video = player.source.mode === "video" ? await videoFromUrl(player.source.value) : await randomVideoFromChannel(player.source.value, room.clipDuration);
    const maxStart = Math.max(0, video.duration - room.clipDuration - 5);
    const start = Math.floor(Math.random() * Math.max(1, maxStart));
    return {
      ownerId: player.id,
      video,
      start,
      end: start + room.clipDuration,
      answers: {},
    };
  });
  const videos = await Promise.all(videoPromises);
  room.rounds = shuffle(videos);
  room.currentRound = 0;
  room.phase = "listen";
  room.message = "";
}

async function randomVideoFromChannel(query, clipDuration = 30) {
  const found = await youtube("search", {
    part: "snippet",
    type: "channel",
    maxResults: "1",
    q: query,
  });
  const channelId = found.items?.[0]?.snippet?.channelId;
  if (!channelId) throw httpError(`Канал "${query}" не найден.`, 404);

  const channel = await youtube("channels", {
    part: "contentDetails",
    id: channelId,
  });
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw httpError(`Не удалось получить видео канала "${query}".`, 404);

  const playlist = await youtube("playlistItems", {
    part: "contentDetails",
    playlistId: uploads,
    maxResults: "25",
  });
  const ids = playlist.items?.map((item) => item.contentDetails.videoId).filter(Boolean) || [];
  if (!ids.length) throw httpError(`У канала "${query}" не найдены видео.`, 404);

  const videos = await youtube("videos", {
    part: "snippet,contentDetails,status",
    id: ids.join(","),
    maxResults: "25",
  });
  const candidates = videos.items.map(videoFromApi).filter((video) => video.duration >= clipDuration + 10 && video.embeddable);
  if (!candidates.length) throw httpError(`У канала "${query}" нет подходящих доступных видео.`, 404);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function videoFromUrl(value) {
  const id = extractVideoId(value);
  if (!id) throw httpError("Не удалось распознать ссылку на YouTube.", 400);
  if (YOUTUBE_API_KEY) {
    const result = await youtube("videos", {
      part: "snippet,contentDetails,status",
      id,
    });
    const item = result.items?.[0];
    if (!item) throw httpError("Видео не найдено.", 404);
    return videoFromApi(item);
  }

  const meta = await videoOembed(id);
  return {
    id,
    title: meta.title || "Видео по ссылке",
    channelTitle: meta.author_name || "YouTube",
    duration: 180,
    embeddable: true,
    thumbnail: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
  };
}

async function videoOembed(id) {
  try {
    const url = new URL("https://www.youtube.com/oembed");
    url.searchParams.set("url", `https://www.youtube.com/watch?v=${id}`);
    url.searchParams.set("format", "json");
    const response = await fetch(url);
    if (!response.ok) return {};
    return await response.json();
  } catch {
    return {};
  }
}

async function youtube(endpoint, params) {
  if (!YOUTUBE_API_KEY) throw httpError("Не задан YOUTUBE_API_KEY.", 500);
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries({ ...params, key: YOUTUBE_API_KEY }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw httpError(data.error?.message || "YouTube API вернул ошибку.", response.status);
  }
  return data;
}

function videoFromApi(item) {
  return {
    id: item.id,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    duration: parseDuration(item.contentDetails.duration),
    embeddable: item.status?.embeddable !== false,
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
  };
}

function parseDuration(value) {
  const match = String(value).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function extractVideoId(value) {
  try {
    const url = new URL(value);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1);
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const shorts = url.pathname.match(/\/shorts\/([^/?]+)/);
    if (shorts) return shorts[1];
    const embed = url.pathname.match(/\/embed\/([^/?]+)/);
    if (embed) return embed[1];
  } catch {
    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  }
  return "";
}

function scoreAnswer(answer, title) {
  const cleanAnswer = answer.trim().toLowerCase();
  const cleanTitle = title.trim().toLowerCase();
  if (cleanAnswer === cleanTitle) return 100;
  
  const answerWords = normalizeText(answer);
  const titleWords = normalizeText(title);
  if (!answerWords.length || !titleWords.length) return 0;
  
  const titleSet = new Set(titleWords);
  const matches = answerWords.filter((word) => titleSet.has(word)).length;
  return Math.round((matches / titleWords.length) * 100);
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function cleanName(name, fallback) {
  return String(name || "").trim().slice(0, 18) || fallback;
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function serveStatic(req, res, url) {
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }
  await serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Guessing Game: http://127.0.0.1:${PORT}`);
  if (!YOUTUBE_API_KEY) {
    console.log("YOUTUBE_API_KEY is not set. Channel search is disabled; video links still work for local testing.");
  }
});
