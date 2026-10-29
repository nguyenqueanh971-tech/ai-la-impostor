const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

const rooms = new Map();
const MIN_PLAYERS = 6;
const MAX_PLAYERS = 15;
const NIGHT_SECONDS = 45;
const DAY_SECONDS = 180;
const MEETING_SECONDS = 90;

const ROLES = {
  wolf: "Sói",
  seer: "Tiên tri",
  witch: "Phù thủy",
  guard: "Bảo vệ",
  hunter: "Thợ săn",
  villager: "Dân làng"
};

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function findPlayer(room, socket) {
  return room.players.find(p => p.id === socket.id);
}

function getPlayer(room, id) {
  return room.players.find(p => p.id === id);
}

function alivePlayers(room) {
  return room.players.filter(p => p.alive);
}

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      connected: p.connected,
      isHost: p.id === room.hostId
    })),
    nightEndsAt: room.nightEndsAt || null,
    dayEndsAt: room.dayEndsAt || null,
    meeting: room.meeting ? {
      reason: room.meeting.reason,
      endsAt: room.meeting.endsAt,
      votes: room.meeting.votes.size
    } : null,
    hunterId: room.hunterId || null,
    result: room.result || null
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}

function privateInfo(player, extra = {}) {
  return {
    role: player.role,
    roleName: ROLES[player.role],
    alive: player.alive,
    tasks: [],
    ...extra
  };
}

function sendPrivateRoles(room) {
  for (const p of room.players) {
    const wolves = room.players
      .filter(x => x.role === "wolf")
      .map(x => ({ id: x.id, name: x.name }));

    io.to(p.id).emit("game:private", privateInfo(p, {
      wolves: p.role === "wolf" ? wolves : [],
      witchSaveAvailable: p.role === "witch" && room.witchSaveAvailable,
      witchPoisonAvailable: p.role === "witch" && room.witchPoisonAvailable
    }));
  }
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function endGame(room, winner, reason) {
  clearTimer(room);
  room.phase = "ended";
  room.hunterId = null;
  room.result = {
    winner,
    reason,
    roles: room.players.map(p => ({
      name: p.name,
      role: p.role,
      roleName: ROLES[p.role],
      alive: p.alive
    }))
  };

  emitRoom(room);
  io.to(room.code).emit("game:ended", room.result);
}

function checkWin(room) {
  if (room.phase === "ended") return true;

  const alive = alivePlayers(room);
  const wolves = alive.filter(p => p.role === "wolf").length;
  const villagers = alive.length - wolves;

  if (wolves === 0) {
    endGame(room, "villagers", "Tất cả Sói đã bị loại!");
    return true;
  }

  if (wolves >= villagers) {
    endGame(room, "wolves", "Số Sói đã bằng hoặc nhiều hơn phe Dân!");
    return true;
  }

  return false;
}

function createRoleList(count) {
  const wolves = count >= 12 ? 3 : count >= 8 ? 2 : 1;

  const roles = [
    ...Array(wolves).fill("wolf"),
    "seer",
    "witch",
    "guard",
    "hunter"
  ];

  while (roles.length < count) roles.push("villager");
  return shuffle(roles);
}

function startGame(room) {
  if (room.players.length < MIN_PLAYERS) {
    throw new Error(`Cần ít nhất ${MIN_PLAYERS} người chơi.`);
  }

  clearTimer(room);

  const roles = createRoleList(room.players.length);

  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.connected = true;
    p.votes = null;
  });

  room.phase = "night";
  room.round = 1;
  room.result = null;
  room.meeting = null;
  room.lastProtectedId = null;
  room.witchSaveAvailable = true;
  room.witchPoisonAvailable = true;
  room.nightActions = {};
  room.hunterId = null;

  sendPrivateRoles(room);
  startNight(room);
}

function startNight(room) {
  if (room.phase === "ended") return;

  clearTimer(room);
  room.phase = "night";
  room.nightActions = {};
  room.meeting = null;
  room.nightEndsAt = Date.now() + NIGHT_SECONDS * 1000;

  io.to(room.code).emit("night:started", {
    round: room.round,
    endsAt: room.nightEndsAt,
    seconds: NIGHT_SECONDS
  });

  emitRoom(room);

  room.timer = setTimeout(() => resolveNight(room.code), NIGHT_SECONDS * 1000);
}

function requiredNightRoles(room) {
  const roles = ["wolf", "seer", "witch", "guard"];
  return roles.filter(role =>
    room.players.some(p => p.alive && p.role === role)
  );
}

function allNightActionsDone(room) {
  return requiredNightRoles(room).every(role =>
    Object.prototype.hasOwnProperty.call(room.nightActions, role)
  );
}

function resolveNight(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== "night") return;

  clearTimer(room);

  const actions = room.nightActions;
  const wolfTarget = getPlayer(room, actions.wolf);
  const guardTarget = getPlayer(room, actions.guard);

  let attacked = wolfTarget && wolfTarget.alive ? wolfTarget : null;

  if (
    attacked &&
    guardTarget &&
    guardTarget.alive &&
    guardTarget.id === attacked.id
  ) {
    attacked = null;
  }

  if (
    attacked &&
    actions.witch &&
    actions.witch.save === true &&
    room.witchSaveAvailable
  ) {
    attacked = null;
    room.witchSaveAvailable = false;
  }

  let poisoned = null;
  const poisonTarget = actions.witch &&
    getPlayer(room, actions.witch.poisonTargetId);

  if (
    poisonTarget &&
    poisonTarget.alive &&
    actions.witch.poison === true &&
    room.witchPoisonAvailable
  ) {
    poisoned = poisonTarget;
    room.witchPoisonAvailable = false;
  }

  const deaths = [];

  if (attacked && attacked.alive) {
    attacked.alive = false;
    deaths.push(attacked);
  }

  if (poisoned && poisoned.alive) {
    poisoned.alive = false;
    deaths.push(poisoned);
  }

  const seerTarget = getPlayer(room, actions.seer);
  if (seerTarget && seerTarget.alive) {
    const seer = room.players.find(p => p.alive && p.role === "seer");
    if (seer) {
      io.to(seer.id).emit("seer:result", {
        playerId: seerTarget.id,
        name: seerTarget.name,
        role: seerTarget.role,
        roleName: ROLES[seerTarget.role]
      });
    }
  }

  io.to(room.code).emit("night:result", {
    deaths: deaths.map(p => ({ id: p.id, name: p.name }))
  });

  emitRoom(room);

  const hunter = deaths.find(p => p.role === "hunter");
  if (hunter) {
    beginHunterTurn(room, hunter, "night");
    return;
  }

  if (checkWin(room)) return;
  startDay(room, deaths);
}

function startDay(room, deaths = []) {
  clearTimer(room);
  room.phase = "day";
  room.dayEndsAt = Date.now() + DAY_SECONDS * 1000;

  io.to(room.code).emit("day:started", {
    round: room.round,
    deaths: deaths.map(p => ({ id: p.id, name: p.name })),
    endsAt: room.dayEndsAt,
    seconds: DAY_SECONDS
  });

  emitRoom(room);

  room.timer = setTimeout(() => {
    if (room.phase === "day") startMeeting(room, "Hết thời gian thảo luận");
  }, DAY_SECONDS * 1000);
}

function startMeeting(room, reason) {
  if (room.phase === "ended") return;

  clearTimer(room);
  room.phase = "meeting";
  room.meeting = {
    reason: String(reason || "Cuộc họp").slice(0, 100),
    endsAt: Date.now() + MEETING_SECONDS * 1000,
    votes: new Map()
  };

  io.to(room.code).emit("meeting:started", {
    reason: room.meeting.reason,
    endsAt: room.meeting.endsAt,
    seconds: MEETING_SECONDS
  });

  emitRoom(room);

  room.timer = setTimeout(
    () => resolveMeeting(room.code),
    MEETING_SECONDS * 1000
  );
}

function resolveMeeting(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== "meeting" || !room.meeting) return;

  clearTimer(room);

  const counts = {};
  for (const vote of room.meeting.votes.values()) {
    counts[vote] = (counts[vote] || 0) + 1;
  }

  const entries = Object.entries(counts)
    .filter(([id]) => id !== "skip")
    .sort((a, b) => b[1] - a[1]);

  let ejected = null;
  const top = entries[0];
  const second = entries[1];
  const skipVotes = counts.skip || 0;

  if (
    top &&
    top[1] > skipVotes &&
    (!second || top[1] > second[1])
  ) {
    ejected = getPlayer(room, top[0]);
    if (ejected && ejected.alive) ejected.alive = false;
    else ejected = null;
  }

  room.meeting = null;

  io.to(room.code).emit("meeting:result", {
    ejected: ejected ? {
      id: ejected.id,
      name: ejected.name,
      role: ejected.role,
      roleName: ROLES[ejected.role]
    } : null,
    counts
  });

  emitRoom(room);

  if (ejected && ejected.role === "hunter") {
    beginHunterTurn(room, ejected, "day");
    return;
  }

  if (checkWin(room)) return;

  room.round++;
  startNight(room);
}

function beginHunterTurn(room, hunter, returnTo) {
  clearTimer(room);
  room.phase = "hunter";
  room.hunterId = hunter.id;
  room.hunterReturnTo = returnTo;

  io.to(room.code).emit("hunter:turn", {
    hunterId: hunter.id,
    hunterName: hunter.name,
    seconds: 20
  });

  emitRoom(room);

  room.timer = setTimeout(() => {
    finishHunterTurn(room, null);
  }, 20000);
}

function finishHunterTurn(room, target) {
  clearTimer(room);

  if (target && target.alive) {
    target.alive = false;
    io.to(room.code).emit("hunter:shot", {
      name: target.name,
      roleName: ROLES[target.role]
    });

    if (target.role === "hunter") {
      beginHunterTurn(room, target, room.hunterReturnTo);
      return;
    }
  }

  room.hunterId = null;
  if (checkWin(room)) return;

  if (room.hunterReturnTo === "day") {
    room.round++;
    startNight(room);
  } else {
    startDay(room, []);
  }
}

io.on("connection", socket => {
  socket.on("room:create", ({ name } = {}, cb = () => {}) => {
    name = String(name || "").trim().slice(0, 18);
    if (!name) return cb({ error: "Vui lòng nhập tên." });

    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      phase: "lobby",
      round: 0,
      players: [],
      meeting: null,
      result: null,
      timer: null,
      settings: { maxPlayers: MAX_PLAYERS },
      witchSaveAvailable: true,
      witchPoisonAvailable: true,
      nightActions: {}
    };

    room.players.push({
      id: socket.id,
      name,
      alive: true,
      connected: true,
      role: null,
      votes: null
    });

    rooms.set(code, room);
    socket.join(code);
    cb({ code });
    emitRoom(room);
  });

  socket.on("room:join", ({ code, name } = {}, cb = () => {}) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 18);

    const room = rooms.get(code);
    if (!room) return cb({ error: "Không tìm thấy phòng." });
    if (!name) return cb({ error: "Vui lòng nhập tên." });
    if (room.phase !== "lobby") return cb({ error: "Ván chơi đã bắt đầu." });
    if (room.players.length >= MAX_PLAYERS) return cb({ error: "Phòng đã đủ 15 người." });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ error: "Tên này đã được sử dụng." });
    }

    room.players.push({
      id: socket.id,
      name,
      alive: true,
      connected: true,
      role: null,
      votes: null
    });

    socket.join(code);
    cb({ code });
    emitRoom(room);
  });

  socket.on("game:start", ({ code } = {}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb({ error: "Không tìm thấy phòng." });
    if (room.hostId !== socket.id) return cb({ error: "Chỉ chủ phòng mới được bắt đầu." });
    if (room.phase !== "lobby") return cb({ error: "Phòng không ở trạng thái chờ." });

    try {
      startGame(room);
      cb({ ok: true });
    } catch (err) {
      cb({ error: err.message });
    }
  });

  socket.on("night:action", ({ code, action, targetId, save, poisonTargetId } = {}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && findPlayer(room, socket);

    if (!room || !p || room.phase !== "night" || !p.alive) {
      return cb({ error: "Bạn không thể hành động lúc này." });
    }

    if (action === "wolf" && p.role === "wolf") {
      const target = getPlayer(room, targetId);
      if (!target || !target.alive || target.role === "wolf") {
        return cb({ error: "Mục tiêu không hợp lệ." });
      }
      room.nightActions.wolf = target.id;
    } else if (action === "seer" && p.role === "seer") {
      const target = getPlayer(room, targetId);
      if (!target || !target.alive || target.id === p.id) {
        return cb({ error: "Mục tiêu không hợp lệ." });
      }
      room.nightActions.seer = target.id;
    } else if (action === "guard" && p.role === "guard") {
      const target = getPlayer(room, targetId);
      if (!target || !target.alive || target.id === room.lastProtectedId) {
        return cb({ error: "Không thể bảo vệ mục tiêu này." });
      }
      room.nightActions.guard = target.id;
      room.lastProtectedId = target.id;
    } else if (action === "witch" && p.role === "witch") {
      const poisonTarget = poisonTargetId ? getPlayer(room, poisonTargetId) : null;

      if (save && !room.witchSaveAvailable) {
        return cb({ error: "Bạn đã dùng bình cứu." });
      }
      if (poisonTargetId && (!room.witchPoisonAvailable || !poisonTarget || !poisonTarget.alive)) {
        return cb({ error: "Không thể dùng bình độc lên mục tiêu này." });
      }

      const previousWitchAction = room.nightActions.witch || {};

room.nightActions.witch = {
  save: !!save || previousWitchAction.save === true,
  poison: !!poisonTargetId || previousWitchAction.poison === true,
  poisonTargetId: poisonTarget
    ? poisonTarget.id
    : previousWitchAction.poisonTargetId || null
};
    } else if (action === "skip" && ["seer", "guard", "witch"].includes(p.role)) {
      room.nightActions[p.role] = p.role === "witch"
        ? { save: false, poison: false }
        : null;
    } else {
      return cb({ error: "Hành động không đúng với vai trò của bạn." });
    }

    cb({ ok: true });
    if (allNightActionsDone(room)) resolveNight(room.code);
  });

  socket.on("meeting:call", ({ code, reason } = {}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && findPlayer(room, socket);

    if (!room || !p || !p.alive || room.phase !== "day") {
      return cb({ error: "Hiện không thể gọi họp." });
    }

    startMeeting(room, reason || `${p.name} gọi cuộc họp`);
    cb({ ok: true });
  });

  socket.on("meeting:vote", ({ code, targetId } = {}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && findPlayer(room, socket);

    if (!room || !p || room.phase !== "meeting" || !p.alive) {
      return cb({ error: "Bạn không thể bỏ phiếu." });
    }

    if (
      targetId !== "skip" &&
      (!getPlayer(room, targetId) || !getPlayer(room, targetId).alive)
    ) {
      return cb({ error: "Người được chọn không hợp lệ." });
    }

    room.meeting.votes.set(p.id, targetId);
    emitRoom(room);

    if (alivePlayers(room).every(x => room.meeting.votes.has(x.id))) {
      resolveMeeting(room.code);
    }

    cb({ ok: true });
  });

  socket.on("hunter:shoot", ({ code, targetId } = {}, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && findPlayer(room, socket);

    if (!room || room.phase !== "hunter" || room.hunterId !== socket.id || !p) {
      return cb({ error: "Bạn không có lượt bắn." });
    }

    const target = getPlayer(room, targetId);
    if (!target || !target.alive || target.id === p.id) {
      return cb({ error: "Mục tiêu không hợp lệ." });
    }

    cb({ ok: true });
    finishHunterTurn(room, target);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = findPlayer(room, socket);
      if (!p) continue;
      p.connected = false;
      emitRoom(room);
      break;
    }
  });
});

server.listen(PORT, () => {
  console.log(`AI LÀ SÓI running on port ${PORT}`);
});
