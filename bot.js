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
  intervalAlone:  15_000,
  intervalActive:  1_000,
  server: "https://classic.talkomatic.co",
};
// ============================================================

const startTime = Date.now();
let currentUserCount = 0;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

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

function reschedule(socket) {
  if (socket._interval) clearInterval(socket._interval);
  const interval = currentUserCount <= 1 ? CONFIG.intervalAlone : CONFIG.intervalActive;
  console.log(`[${new Date().toISOString()}] Update rate: ${interval / 1000}s (${currentUserCount} user(s))`);
  socket._interval = setInterval(() => sendMessage(socket, buildMessage()), interval);
}

// ── Single connection does everything ────────────────────────
async function run(argRoomId) {
  console.log(`Connecting to ${CONFIG.server} …`);

  const socket = io(CONFIG.server, {
    auth:  { token: CONFIG.token },
    query: { token: CONFIG.token },
    transports: ["websocket"],
    reconnectionAttempts: Infinity,
    reconnectionDelay: 5_000,
  });

  socket.on("connect_error", (err) => {
    console.error(`Connection error: ${err.message}`);
  });

  socket.on("disconnect", (reason) => {
    console.warn(`Disconnected: ${reason} — reconnecting…`);
    if (socket._interval) { clearInterval(socket._interval); socket._interval = null; }
  });

  socket.onAny((event, ...args) => {
    if (!["chat update", "ping", "pong", "lobby update"].includes(event))
      console.log(`[EVENT] ${event}`, JSON.stringify(args).slice(0, 120));
  });

  // Wait for connection
  await new Promise((res, rej) => {
    socket.once("connect", res);
    socket.once("connect_error", rej);
  });

  console.log("Connected ✓");
  socket.emit("join lobby", { username: CONFIG.username, location: CONFIG.location, token: CONFIG.token });

  let roomId = argRoomId;
  let accessCode = null;

  if (!roomId) {
    // Request room list
    socket.emit("get rooms");

    const rooms = await new Promise(res => socket.once("lobby update", res));
    const visible = rooms.filter(r => r.type === "public" || r.type === "semi-private");

    if (visible.length === 0) {
      console.log("No public or semi-private rooms found.");
      const id = await ask("Enter Room ID manually: ");
      roomId = id.trim();
    } else {
      console.log("\n┌─────────────────────────────────────────────────────┐");
      console.log("│                   Available Rooms                   │");
      console.log("├──────┬──────────────────────────────┬───────┬───────┤");
      console.log("│  #   │ Name                         │ Users │ Type  │");
      console.log("├──────┼──────────────────────────────┼───────┼───────┤");
      visible.forEach((r, i) => {
        const num  = String(i + 1).padEnd(4);
        const name = (r.name || "Unnamed").substring(0, 28).padEnd(28);
        const users = `${r.users?.length ?? 0}/5`.padEnd(5);
        const type = r.type === "semi-private" ? "🔒 semi" : "public";
        console.log(`│  ${num}│ ${name} │ ${users} │ ${type} │`);
      });
      console.log("└──────┴──────────────────────────────┴───────┴───────┘");

      const choice = await ask("\nEnter number or room ID: ");
      const num = parseInt(choice.trim(), 10);
      const room = (!isNaN(num) && num >= 1 && num <= visible.length)
        ? visible[num - 1]
        : visible.find(r => r.id === choice.trim());

      if (room) {
        roomId = room.id;
        if (room.type === "semi-private") {
          accessCode = (await ask(`🔒 "${room.name}" requires a password: `)).trim();
        }
      } else {
        roomId = choice.trim();
      }
    }
  }

  rl.close();

  // Join the room on the same connection
  const joinData = { roomId };
  if (accessCode) joinData.accessCode = accessCode;
  console.log(`\nJoining room ${roomId}…`);
  socket.emit("join room", joinData);

  socket.on("room joined", (data) => {
    currentUserCount = data.users?.length ?? 0;
    console.log(`[${new Date().toISOString()}] Joined! Users: ${currentUserCount}`);
    sendMessage(socket, buildMessage());
    reschedule(socket);
  });

  socket.on("user joined", () => { currentUserCount++; reschedule(socket); });
  socket.on("user left",   () => { currentUserCount = Math.max(0, currentUserCount - 1); reschedule(socket); });
}

// ── Boot ─────────────────────────────────────────────────────
const argRoomId = process.argv[2] ?? null;
run(argRoomId).catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
