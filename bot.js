const { io: ioClient } = require("socket.io-client");
const { Server }       = require("socket.io");
const http             = require("http");
const fs               = require("fs");
const path             = require("path");
const readline         = require("readline");
const { exec }         = require("child_process");

function openBrowser(url) {
  const cmd = process.platform === "win32" ? `start "" "${url}"`
            : process.platform === "darwin" ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) log(`Could not open browser: ${err.message}`); });
}

// ============================================================
//  CONFIGURATION
// ============================================================
const CONFIG = {
  token:    "TOKEN_HERE",
  username: "KeepBot",
  location: "The Internet",
  intervalAlone:  15_000,
  intervalActive:  1_000,
  server:   "https://classic.talkomatic.co",
  guiPort:  3100,
};
// ============================================================

const startTime = Date.now();
let myUserId     = null;
let users        = {};
let manualMsg    = null;
let currentCount = 0;
let roomName     = "";
let roomId_g     = "";
const mutedIds   = new Set();
let _talkSocket  = null;
const logs       = [];  // kept for GUI log panel

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  guiBroadcast("log", { entry });
}

// ── GUI WebSocket server ──────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/save-template") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { template } = JSON.parse(body);
        fs.writeFileSync(path.join(__dirname, "main.txt"), template, "utf8");
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad"); }
    });
    return;
  }

  // Serve gui.html
  const file = path.join(__dirname, "gui.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

const guiServer = new Server(httpServer, { cors: { origin: "*" } });

guiServer.on("connection", (sock) => {
  // Send full current state immediately so page is never blank
  sock.emit("state", buildState());
  sock.emit("logs",  { entries: logs });

  sock.on("cmd", (cmd) => {
    const t = cmd.type;
    if (t === "send")   handleSend(cmd.text);
    if (t === "unpin")  handleUnpin();
    if (t === "mute")   handleMute(cmd.userId, true);
    if (t === "unmute") handleMute(cmd.userId, false);
    if (t === "reload_template") emitState();
  });
});

function guiBroadcast(event, data) {
  guiServer.emit(event, data);
}

function emitState() {
  guiBroadcast("state", buildState());
}

function buildState() {
  return {
    roomName,
    roomId: roomId_g,
    userCount: currentCount,
    myUserId,
    manualMsg,
    uptime: formatUptime(Date.now() - startTime),
    rate:   currentCount <= 1 ? CONFIG.intervalAlone/1000 : CONFIG.intervalActive/1000,
    mutedIds: [...mutedIds],
    users: Object.values(users).map(u => ({
      id: u.id, username: u.username, location: u.location, text: u.text,
    })),
    template: readTemplate(),
  };
}

// ── Commands from GUI ─────────────────────────────────────────
function handleSend(text) {
  if (!_talkSocket) return;
  manualMsg = text;
  if (_talkSocket._iv) { clearInterval(_talkSocket._iv); _talkSocket._iv = null; }
  sendMessage(_talkSocket, text);
}

function handleUnpin() {
  if (!_talkSocket) return;
  manualMsg = null;
  sendMessage(_talkSocket, buildMessage());
  reschedule(_talkSocket);
}

function handleMute(userId, mute) {
  mute ? mutedIds.add(userId) : mutedIds.delete(userId);
  emitState();
}

// ── Talkomatic helpers ────────────────────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60]
    .map(n => String(n).padStart(2,"0")).join(":");
}

function readTemplate() {
  try { return fs.readFileSync(path.join(__dirname, "main.txt"), "utf8").trim(); }
  catch { return "{uptime}"; }
}

function buildMessage() {
  return readTemplate()
    .replace(/{uptime}/g, formatUptime(Date.now() - startTime))
    .replace(/{date}/g,   new Date().toLocaleDateString("en-GB"))
    .replace(/{time}/g,   new Date().toLocaleTimeString("en-GB"))
    .replace(/{users}/g,  currentCount);
}

function sendMessage(socket, text) {
  socket.emit("chat update", { diff: { type: "full-replace", text } });
  if (myUserId && users[myUserId]) {
    users[myUserId].text = text;
    emitState();
  }
}

function reschedule(socket) {
  if (socket._iv) clearInterval(socket._iv);
  if (manualMsg !== null) return;
  const iv = currentCount <= 1 ? CONFIG.intervalAlone : CONFIG.intervalActive;
  socket._iv = setInterval(() => sendMessage(socket, buildMessage()), iv);
}

function applyDiff(cur, diff) {
  if (!diff) return cur;
  switch (diff.type) {
    case "full-replace": return diff.text ?? "";
    case "add":    return cur.slice(0, diff.index) + diff.text + cur.slice(diff.index);
    case "delete": return cur.slice(0, diff.index) + cur.slice(diff.index + diff.count);
    case "replace":return cur.slice(0, diff.index) + diff.text + cur.slice(diff.index + diff.text.length + 1);
    default:       return cur;
  }
}

// ── Room picker (terminal) ────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

async function pickRoom(argRoomId) {
  if (argRoomId) return { roomId: argRoomId, accessCode: null };

  const tmpSock = ioClient(CONFIG.server, {
    auth: { token: CONFIG.token }, query: { token: CONFIG.token },
    transports: ["websocket"],
  });

  await new Promise((res, rej) => {
    tmpSock.once("connect", res);
    tmpSock.once("connect_error", rej);
  });

  tmpSock.emit("join lobby", { username: CONFIG.username, location: CONFIG.location, token: CONFIG.token });
  tmpSock.emit("get rooms");

  const rooms = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("Timeout")), 5000);
    const h = (d) => { clearTimeout(t); res(Array.isArray(d) ? d : []); };
    tmpSock.once("lobby update", h);
    tmpSock.once("rooms", h);
  });

  tmpSock.disconnect();

  const visible = rooms.filter(r => r.type === "public" || r.type === "semi-private");

  console.log("\n  Available rooms:");
  visible.forEach((r, i) => {
    const lock = r.type === "semi-private" ? "🔒 " : "   ";
    console.log(`  ${i+1}. ${lock}${r.name}  (${r.users?.length ?? 0}/5)`);
  });
  console.log();

  const choice = await ask("  Enter number or room ID: ");
  rl.close();

  const n = parseInt(choice.trim(), 10);
  const room = (!isNaN(n) && n >= 1 && n <= visible.length)
    ? visible[n - 1]
    : visible.find(r => r.id === choice.trim());

  if (room) {
    let accessCode = null;
    if (room.type === "semi-private")
      accessCode = await ask(`  Password for "${room.name}": `);
    return { roomId: room.id, accessCode };
  }
  return { roomId: choice.trim(), accessCode: null };
}

// ── Main ──────────────────────────────────────────────────────
async function run(argRoomId) {
  // Start GUI server first
  httpServer.listen(CONFIG.guiPort, () => {
    const url = `http://localhost:${CONFIG.guiPort}`;
    log(`GUI running at ${url}`);
    openBrowser(url);
  });

  const { roomId, accessCode } = await pickRoom(argRoomId);
  roomId_g = roomId;
  emitState(); // tell GUI we have a room ID now

  log(`Connecting to ${CONFIG.server}…`);

  const socket = ioClient(CONFIG.server, {
    auth: { token: CONFIG.token }, query: { token: CONFIG.token },
    transports: ["websocket"],
    reconnectionAttempts: Infinity, reconnectionDelay: 5_000,
  });

  _talkSocket = socket;

  socket.on("connect_error", (err) => log(`Connection error: ${err.message}`));
  socket.on("disconnect",    ()    => log("Disconnected — reconnecting…"));
  socket.on("connect", () => {
    log("Connected ✓ — joining lobby and room…");
    socket.emit("join lobby", { username: CONFIG.username, location: CONFIG.location, token: CONFIG.token });
    socket.emit("join room", { roomId, ...(accessCode ? { accessCode } : {}) });
  });

  // Log every event for debugging
  socket.onAny((event, ...args) => {
    if (!["chat update", "ping", "pong"].includes(event))
      log(`[event] ${event}: ${JSON.stringify(args).slice(0, 120)}`);
  });

  socket.on("room joined", (data) => {
    roomName     = data.roomName || roomId;
    myUserId     = data.userId ?? null;
    currentCount = data.users?.length ?? 0;
    users = {};
    for (const u of (data.users ?? []))
      users[u.id] = { id: u.id, username: u.username || "Anonymous", location: u.location || "", text: data.currentMessages?.[u.id] ?? "" };
    log(`Joined room "${roomName}" with ${currentCount} user(s)`);
    sendMessage(socket, buildMessage());
    reschedule(socket);
    emitState();
  });

  socket.on("user joined", (u) => {
    currentCount++;
    users[u.id] = { id: u.id, username: u.username || "Anonymous", location: u.location || "", text: "" };
    log(`${u.username} joined`);
    reschedule(socket);
    emitState();
  });

  socket.on("user left", (uid) => {
    const name = users[uid]?.username ?? uid;
    currentCount = Math.max(0, currentCount - 1);
    delete users[uid];
    mutedIds.delete(uid);
    log(`${name} left`);
    reschedule(socket);
    emitState();
  });

  socket.on("chat update", (data) => {
    if (!data.userId || !users[data.userId]) return;
    users[data.userId].text = applyDiff(users[data.userId].text, data.diff);
    emitState();
  });
}

const argRoomId = process.argv[2] ?? null;
run(argRoomId).catch(err => { log(`Fatal: ${err.message}`); process.exit(1); });
