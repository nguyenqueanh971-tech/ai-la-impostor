const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

const rooms = new Map();
const MAX_PLAYERS = 15;
const MIN_PLAYERS = 4;

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from({length: 6}, () => chars[Math.floor(Math.random()*chars.length)]).join(""); }
  while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return {
    code: room.code, phase: room.phase, hostId: room.hostId,
    maxPlayers: MAX_PLAYERS, minPlayers: MIN_PLAYERS,
    players: room.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive, connected: p.connected,
      ready: p.ready, isHost: p.id === room.hostId,
      tasksDone: p.tasksDone.length, tasksTotal: p.tasks.length
    })),
    settings: room.settings,
    meeting: room.meeting ? {
      reason: room.meeting.reason, endsAt: room.meeting.endsAt,
      votes: room.meeting.votes.size,
      eligible: room.players.filter(p => p.alive).length
    } : null,
    result: room.result || null
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", publicRoom(room)); }
function sendPrivateRoles(room) {
  room.players.forEach(p => io.to(p.id).emit("game:private", {
    role: p.role, tasks: p.tasks, alive: p.alive
  }));
}
function endGame(room, winner, reason) {
  room.phase = "ended";
  room.result = { winner, reason, roles: room.players.map(p => ({name:p.name, role:p.role, alive:p.alive})) };
  emitRoom(room);
  io.to(room.code).emit("game:ended", room.result);
}
function checkWin(room) {
  const alive = room.players.filter(p => p.alive);
  const impostors = alive.filter(p => p.role === "impostor").length;
  const crew = alive.length - impostors;
  if (impostors === 0) return endGame(room, "crew", "All impostors have been found!");
  if (impostors >= crew) return endGame(room, "impostor", "Impostors have reached parity.");
  if (room.players.filter(p => p.role !== "impostor").every(p => p.tasksDone.length >= p.tasks.length))
    return endGame(room, "crew", "All crew tasks are complete!");
}
function startGame(room) {
  if (room.players.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players.`);
  room.phase = "playing"; room.result = null; room.meeting = null;
  const count = room.players.length >= 10 ? 3 : room.players.length >= 7 ? 2 : 1;
  const shuffled = [...room.players].sort(() => Math.random() - 0.5);
  shuffled.forEach((p, i) => {
    p.role = i < count ? "impostor" : "crew";
    p.alive = true; p.tasksDone = [];
    p.tasks = p.role === "crew" ? [...room.taskPool].sort(() => Math.random()-0.5).slice(0, 4) : [];
  });
  sendPrivateRoles(room); emitRoom(room);
}
function findPlayer(socket, room) { return room.players.find(p => p.id === socket.id); }

io.on("connection", socket => {
  socket.on("room:create", ({name}, cb = () => {}) => {
    name = String(name || "").trim().slice(0, 18);
    if (!name) return cb({error:"Enter a nickname."});
    const code = makeCode();
    const room = {
      code, hostId: socket.id, phase:"lobby", players:[], meeting:null, result:null,
      settings:{maxPlayers:MAX_PLAYERS, impostors:"auto", discussionSeconds:90},
      taskPool:["Calibrate the antenna","Route power","Sort space samples","Repair the signal","Align navigation","Clean the air filter","Upload research","Stabilize reactor","Scan star map","Refill oxygen"],
      logs:[]
    };
    room.players.push({id:socket.id,name,alive:true,connected:true,ready:true,role:null,tasks:[],tasksDone:[],votes:null});
    rooms.set(code, room); socket.join(code); cb({code}); emitRoom(room);
  });
  socket.on("room:join", ({code,name}, cb = () => {}) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0,18);
    const room = rooms.get(code);
    if (!room) return cb({error:"Room not found."});
    if (!name) return cb({error:"Enter a nickname."});
    if (room.phase !== "lobby") return cb({error:"Game already started."});
    if (room.players.length >= MAX_PLAYERS) return cb({error:"Room is full (15 players max)."});
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return cb({error:"Nickname already used."});
    room.players.push({id:socket.id,name,alive:true,connected:true,ready:true,role:null,tasks:[],tasksDone:[],votes:null});
    socket.join(code); cb({code}); emitRoom(room);
  });
  socket.on("game:start", ({code}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb({error:"Room not found."});
    if (room.hostId !== socket.id) return cb({error:"Only the host can start."});
    if (room.phase !== "lobby") return cb({error:"Game is not in the lobby."});
    try { startGame(room); cb({ok:true}); } catch(e) { cb({error:e.message}); }
  });
  socket.on("task:complete", ({code, task}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && findPlayer(socket, room);
    if (!room || !p || room.phase !== "playing" || !p.alive || p.role !== "crew") return cb({error:"Task unavailable."});
    if (!p.tasks.includes(task)) return cb({error:"Invalid task."});
    if (!p.tasksDone.includes(task)) p.tasksDone.push(task);
    io.to(p.id).emit("game:private", {role:p.role,tasks:p.tasks,tasksDone:p.tasksDone,alive:p.alive});
    emitRoom(room); checkWin(room); cb({ok:true});
  });
  socket.on("meeting:call", ({code, reason}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && findPlayer(socket, room);
    if (!room || !p || room.phase !== "playing" || !p.alive) return cb({error:"Cannot call a meeting now."});
    room.phase = "meeting";
    room.meeting = {reason:String(reason || "Emergency meeting").slice(0,100), endsAt:Date.now()+90000, votes:new Map()};
    room.players.forEach(x => x.votes = null);
    io.to(room.code).emit("meeting:started", {reason:room.meeting.reason, calledBy:p.name, endsAt:room.meeting.endsAt});
    emitRoom(room); cb({ok:true});
    setTimeout(() => resolveMeeting(room.code), 90000);
  });
  socket.on("meeting:vote", ({code, targetId}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && findPlayer(socket, room);
    if (!room || !p || room.phase !== "meeting" || !p.alive) return cb({error:"Voting is closed."});
    if (targetId !== "skip" && !room.players.some(x => x.id === targetId && x.alive)) return cb({error:"Invalid vote."});
    room.meeting.votes.set(p.id, targetId);
    emitRoom(room);
    if (room.players.filter(x=>x.alive).every(x=>room.meeting.votes.has(x.id))) resolveMeeting(room.code);
    cb({ok:true});
  });
  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = findPlayer(socket, room);
      if (!p) continue;
      p.connected = false;
      // Keep disconnected players in the room to preserve their secret role and reconnect-safe state.
      emitRoom(room);
      break;
    }
  });
});
function resolveMeeting(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== "meeting" || !room.meeting) return;
  const counts = {};
  for (const vote of room.meeting.votes.values()) counts[vote] = (counts[vote] || 0) + 1;
  const entries = Object.entries(counts).filter(([id]) => id !== "skip").sort((a,b)=>b[1]-a[1]);
  let ejected = null;
  if (entries.length && (!counts.skip || entries[0][1] > counts.skip) && (!entries[1] || entries[0][1] > entries[1][1])) {
    ejected = room.players.find(p=>p.id===entries[0][0] && p.alive);
    if (ejected) ejected.alive = false;
  }
  const summary = {ejected: ejected ? {name:ejected.name, role:ejected.role} : null, skipped: !ejected, counts};
  room.meeting = null; room.phase = "playing";
  io.to(room.code).emit("meeting:result", summary);
  checkWin(room); emitRoom(room);
}
server.listen(PORT, () => console.log(`AI LÀ IMPOSTOR running on port ${PORT}`));