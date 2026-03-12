const { io } = require("socket.io-client");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// ============================================================
//  CONFIGURATION
// ============================================================
const CONFIG = {
  token:    "TOKEN_HERE",
  username: "KeepBot",
  location: "The Internet",
  messageInterval: 1_000,
  server: "https://classic.talkomatic.co",
};
// ============================================================

const startTime = Date.now();
let currentUserCount = 0;

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function buildMessage() {
  const template = fs.readFileSync(path.join(__dirname, "main.txt"), "utf8").trim();
  return template
    .replace(/{uptime}/g, formatUptime(Date.now() - startTime))
    .replace(/{date}/g,   new Date().toLocaleDateString("en-GB"))
    .replace(/{time}/g,   new Date().toLocaleTimeString("en-GB"))
    .replace(/{users}/g,  currentUserCount);
}

function sendMessage(socket, text) {
  socket.emit("chat update", { diff: { type: "full-replace", text } });
}

function startBot(roomId) {
  console.log(`[${new Date().toISOString()}] Connecting to ${CONFIG.server} …`);

  const socket = io(CONFIG.server, {
    auth:  { token: CONFIG.token },
    query: { token: CONFIG.token },
    transports: ["websocket"],
    reconnectionAttempts: Infinity,
    reconnectionDelay: 5_000,
  });

  let postInterval = null;

  socket.on("connect", () => {
    console.log(`[${new Date().toISOString()}] Connected ✓`);
    socket.emit("join lobby", { username: CONFIG.username, location: CONFIG.location, token: CONFIG.token });
    socket.emit("join room", { roomId });
  });

  socket.on("room joined", (data) => {
    currentUserCount = data.users?.length ?? 0;
    console.log(`[${new Date().toISOString()}] Joined room! Users: ${currentUserCount}`);
    sendMessage(socket, buildMessage());
    if (postInterval) clearInterval(postInterval);
    postInterval = setInterval(() => sendMessage(socket, buildMessage()), CONFIG.messageInterval);
  });

  socket.on("user joined", () => { currentUserCount++; });
  socket.on("user left",   () => { currentUserCount = Math.max(0, currentUserCount - 1); });

  socket.on("disconnect", (reason) => {
    console.warn(`[${new Date().toISOString()}] Disconnected: ${reason} — reconnecting…`);
    if (postInterval) { clearInterval(postInterval); postInterval = null; }
  });

  socket.on("connect_error", (err) => {
    console.error(`[${new Date().toISOString()}] Connection error: ${err.message}`);
  });

  socket.onAny((event, ...args) => {
    if (!["chat update", "ping", "pong"].includes(event))
      console.log(`[EVENT] ${event}`, JSON.stringify(args).slice(0, 120));
  });
}

// ── Boot ─────────────────────────────────────────────────────
const argRoomId = process.argv[2];

if (argRoomId) {
  startBot(argRoomId);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Enter Room ID: ", (answer) => {
    rl.close();
    startBot(answer.trim());
  });
}
