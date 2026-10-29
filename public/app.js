
const socket = io();

let roomCode = "";
let myRole = null;
let myTasks = [];
let currentRoom = null;
let selectedTarget = "";
let witchSaveAvailable = true;
let witchPoisonAvailable = true;
let witchSaveChoice = false;
let witchPoisonTargetId = "";
let audioEnabled = true;
let language = "vi";

const $ = id => document.getElementById(id);

function say(message) {
  const el = $("message");
  if (el) el.textContent = message;
}

function show(id) {
  document.querySelectorAll(".screen").forEach(x => {
    x.hidden = true;
  });

  if ($(id)) {
    $(id).hidden = false;
  }
}

function roleName(role) {
  const names = {
    wolf: "🐺 Sói",
    seer: "🔮 Tiên tri",
    witch: "🧙 Phù thủy",
    guard: "🛡️ Bảo vệ",
    hunter: "🏹 Thợ săn",
    villager: "👨‍🌾 Dân làng"
  };
  return names[role] || role;
}

function playTone(frequency = 440, duration = 0.15) {
  if (!audioEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
    oscillator.onended = () => ctx.close();
  } catch (e) {}
}

function emit(event, data) {
  socket.emit(event, { code: roomCode, ...data }, result => {
    if (result && result.error) say("⚠️ " + result.error);
    else if (result && result.ok) say("✅ Thành công!");
  });
}

function createRoom() {
  const name = $("name")?.value.trim();
  if (!name) return say("Bạn hãy nhập tên trước nhé!");

  socket.emit("room:create", { name }, result => {
    if (result.error) return say(result.error);
    roomCode = result.code;
    enterRoom();
  });
}

function joinRoom() {
  const name = $("name")?.value.trim();
  const code = $("code")?.value.trim();
  if (!name || !code) return say("Nhập tên và mã phòng nhé!");

  socket.emit("room:join", { name, code }, result => {
    if (result.error) return say(result.error);
    roomCode = result.code;
    enterRoom();
  });
}

function enterRoom() {
  show("room");
  $("roomCode").textContent = roomCode;
  say("Đang chờ người chơi...");
}

function startGame() {
  emit("game:start", {});
}

function renderPlayers(room) {
  const list = $("players");
  if (!list) return;
  list.innerHTML = "";

  room.players.forEach(p => {
    const item = document.createElement("div");
    item.className = "player-card";
    item.textContent =
      (p.alive ? "🟢 " : "💀 ") +
      p.name +
      (p.id === room.hostId ? " 👑" : "") +
      (!p.connected ? " (mất kết nối)" : "") +
      (!p.alive ? " (đã chết)" : "");
    list.appendChild(item);
  });
}

function renderPrivate() {
  if (!myRole) return;
  const box = $("role");
  if (!box) return;

  box.innerHTML = `
    <div class="role-card">
      <div class="role-icon">${roleName(myRole.role)}</div>
      <h2>${roleName(myRole.role)}</h2>
      <p>${myRole.alive ? "Bạn còn sống!" : "Bạn đã bị loại."}</p>
    </div>
  `;
}

function getTargets(excludeSelf = false) {
  if (!currentRoom) return [];
  return currentRoom.players.filter(p =>
    p.alive && (!excludeSelf || p.id !== socket.id)
  );
}

function makeButton(label, callback) {
  const button = document.createElement("button");
  button.textContent = label;
  button.onclick = callback;
  return button;
}


function renderNightActions() {
  const box = $("tasks");
  if (!box) return;

  box.innerHTML = "";

  if (!myRole || !myRole.alive || currentRoom?.phase !== "night") {
    return;
  }

  const title = document.createElement("h3");
  title.textContent = "🌙 Hành động ban đêm";
  box.appendChild(title);

  const role = myRole.role;

  // 🐺 SÓI
  if (role === "wolf") {
    box.appendChild(makeButton("🐺 Chọn người cắn", () => {
      renderTargetChoices("wolf", true);
    }));
  }

  // 🔮 TIÊN TRI
  if (role === "seer") {
    box.appendChild(makeButton("🔮 Soi một người", () => {
      renderTargetChoices("seer", true);
    }));

    box.appendChild(makeButton("⏭️ Bỏ qua lượt", () => {
      emit("night:action", { action: "skip" });
    }));
  }

  // 🛡️ BẢO VỆ
  if (role === "guard") {
    box.appendChild(makeButton("🛡️ Chọn người bảo vệ", () => {
      renderTargetChoices("guard", true);
    }));

    box.appendChild(makeButton("⏭️ Bỏ qua lượt", () => {
      emit("night:action", { action: "skip" });
    }));
  }

  // 🧙 PHÙ THỦY
  if (role === "witch") {
    if (witchSaveAvailable) {
      box.appendChild(makeButton(
        witchSaveChoice
          ? "💚 Đã chọn bình cứu ✓"
          : "💚 Chọn bình cứu",
        () => {
          witchSaveChoice = !witchSaveChoice;
          renderNightActions();
        }
      ));
    }

    if (witchPoisonAvailable) {
      box.appendChild(makeButton(
        witchPoisonTargetId
          ? "☠️ Đã chọn mục tiêu độc ✓"
          : "☠️ Chọn người dùng bình độc",
        () => {
          renderTargetChoices("witch", true);
        }
      ));
    }

    box.appendChild(makeButton("✅ Xác nhận hành động", () => {
      emit("night:action", {
        action: "witch",
        save: witchSaveChoice,
        poisonTargetId: witchPoisonTargetId || undefined
      });
    }));

    box.appendChild(makeButton("⏭️ Bỏ qua lượt", () => {
      witchSaveChoice = false;
      witchPoisonTargetId = "";
      emit("night:action", { action: "skip" });
    }));
  }
}


function renderTargetChoices(action, excludeSelf) {
  const box = $("tasks");
  if (!box) return;

  box.innerHTML = `<h3>Chọn người chơi</h3>`;

  getTargets(excludeSelf).forEach(p => {
    if (action === "wolf" && p.id === socket.id) return;

    box.appendChild(makeButton(p.name, () => {
      if (action === "witch") {
        emit("night:action", {
          action: "witch",
          poisonTargetId: p.id
        });
        witchPoisonAvailable = false;
      } else {
        emit("night:action", {
          action,
          targetId: p.id
        });
      }
    }));
  });
}

function renderMeeting() {
  const box = $("votes");
  if (!box) return;
  box.innerHTML = "";

  if (!currentRoom || currentRoom.phase !== "meeting") return;
  if (!myRole?.alive) return;

  box.innerHTML = "<h3>🗳️ Chọn người muốn treo cổ</h3>";

  getTargets(false).forEach(p => {
    box.appendChild(makeButton("🗳️ " + p.name, () => {
      emit("meeting:vote", { targetId: p.id });
    }));
  });

  box.appendChild(makeButton("Bỏ phiếu trắng", () => {
    emit("meeting:vote", { targetId: "skip" });
  }));
}

function renderDay() {
  const box = $("tasks");
  if (!box) return;
  box.innerHTML = "";

  if (currentRoom?.phase !== "day" || !myRole?.alive) return;

  box.appendChild(makeButton("📢 Gọi cuộc họp", () => {
    emit("meeting:call", { reason: "Người chơi yêu cầu họp" });
  }));
}

function renderHunter() {
  const box = $("tasks");
  if (!box) return;
  box.innerHTML = "";

  if (currentRoom?.phase !== "hunter" || !myRole?.role || myRole.role !== "hunter") return;

  box.innerHTML = "<h3>🏹 Bạn là Thợ săn! Chọn một người để bắn.</h3>";

  getTargets(true).forEach(p => {
    box.appendChild(makeButton("🎯 Bắn " + p.name, () => {
      emit("hunter:shoot", { targetId: p.id });
    }));
  });
}

function renderPhase() {
  if (!currentRoom) return;

  const phase = $("phase");
  if (phase) {
    const labels = {
      lobby: "🏠 Phòng chờ",
      night: "🌙 Ban đêm",
      day: "☀️ Ban ngày",
      meeting: "🗳️ Họp và bỏ phiếu",
      hunter: "🏹 Lượt Thợ săn",
      ended: "🏆 Kết thúc"
    };
    phase.textContent = labels[currentRoom.phase] || currentRoom.phase;
  }

  if (currentRoom.phase === "night") renderNightActions();
  else if (currentRoom.phase === "day") renderDay();
  else if (currentRoom.phase === "meeting") renderMeeting();
  else if (currentRoom.phase === "hunter") renderHunter();
  else if (currentRoom.phase === "lobby") {
    const box = $("tasks");
    if (box) box.innerHTML = "";
  }
}

function showResult(result) {
  const box = $("role");
  if (!box) return;

  const winner = result.winner === "wolves" ? "🐺 PHE SÓI THẮNG!" : "🏡 PHE DÂN THẮNG!";

  box.innerHTML = `
    <div class="result-card">
      <h1>${winner}</h1>
      <p>${result.reason}</p>
      <h3>Danh sách vai trò</h3>
      ${result.roles.map(p =>
        `<p>${p.alive ? "🟢" : "💀"} ${p.name}: ${roleName(p.role)}</p>`
      ).join("")}
    </div>
  `;

  playTone(660, 0.5);
}

socket.on("room:update", room => {
  currentRoom = room;
  renderPlayers(room);
  renderPhase();

  const start = $("start");
  if (start) {
    start.style.display =
      room.phase === "lobby" && room.hostId === socket.id ? "block" : "none";
  }

  if (room.phase === "ended" && room.result) showResult(room.result);
});

socket.on("game:private", data => {
  myRole = data;
  witchSaveAvailable = data.witchSaveAvailable !== false;
  witchPoisonAvailable = data.witchPoisonAvailable !== false;
  renderPrivate();
  renderPhase();
  playTone(520);
});

socket.on("night:started", data => {
  say(`🌙 Đêm ${data.round} bắt đầu. Hãy thực hiện hành động bí mật!`);
  playTone(180, 0.5);
});

socket.on("night:result", data => {
  if (data.deaths.length) {
    say("💀 Người chết đêm qua: " + data.deaths.map(p => p.name).join(", "));
  } else {
    say("🌟 Đêm qua không có ai chết!");
  }
  playTone(260);
});

socket.on("seer:result", data => {
  say(`🔮 ${data.name} có vai trò: ${data.roleName}`);
});

socket.on("day:started", data => {
  say(data.deaths.length
    ? "☀️ Trời sáng! Người chết: " + data.deaths.map(p => p.name).join(", ")
    : "☀️ Trời sáng! Mọi người hãy thảo luận.");
  playTone(600);
});

socket.on("meeting:started", data => {
  say("🔔 Cuộc họp bắt đầu: " + data.reason);
  playTone(800);
  renderMeeting();
});


socket.on("meeting:result", data => {
  const box = $("votes");

  if (box) {
    box.innerHTML = "<h3>📊 KẾT QUẢ BỎ PHIẾU</h3>";

    const counts = data.counts || {};

    currentRoom.players.forEach(player => {
      const votes = counts[player.id] || 0;

      const line = document.createElement("p");
      line.textContent = `👤 ${player.name}: ${votes} phiếu`;
      box.appendChild(line);
    });

    const skipLine = document.createElement("p");
    skipLine.textContent = `⏭️ Bỏ phiếu trắng: ${counts.skip || 0} phiếu`;
    box.appendChild(skipLine);

    const resultLine = document.createElement("h3");
    resultLine.textContent = data.ejected
      ? `⚖️ ${data.ejected.name} bị treo cổ! Vai trò: ${data.ejected.roleName}`
      : "⚖️ Không ai bị treo cổ!";
    box.appendChild(resultLine);
  }

  say(data.ejected
    ? `⚖️ ${data.ejected.name} đã bị loại!`
    : "⚖️ Không ai bị loại.");

  playTone(350);
});


socket.on("hunter:turn", data => {
  say(`🏹 ${data.hunterName} được chọn một người bắn!`);
  renderHunter();
});

socket.on("hunter:shot", data => {
  say(`💥 Thợ săn đã bắn ${data.name}! Vai trò: ${data.roleName}`);
});

socket.on("game:ended", showResult);

const createButton = $("create");
const joinButton = $("join");
const startButton = $("start");

if (createButton) createButton.addEventListener("click", createRoom);
if (joinButton) joinButton.addEventListener("click", joinRoom);
if (startButton) startButton.addEventListener("click", startGame);

const soundButton = $("sound");
if (soundButton) {
  soundButton.addEventListener("click", () => {
    audioEnabled = !audioEnabled;
    soundButton.textContent = audioEnabled ? "🔊 Âm thanh: Bật" : "🔇 Âm thanh: Tắt";
  });
}

const languageButton = $("language");
if (languageButton) {
  languageButton.addEventListener("click", () => {
    language = language === "vi" ? "en" : "vi";
    languageButton.textContent = language === "vi" ? "🇻🇳 Tiếng Việt" : "🇬🇧 English";
    say(language === "vi" ? "Đã chuyển sang tiếng Việt." : "Language switched to English.");
  });
}
