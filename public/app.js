
const socket = io();

let roomCode = "";
let isHost = false;
let myRole = null;
let myTasks = [];
let currentRoom = null;

const $ = id => document.getElementById(id);

function message(text) {
  $("message").textContent = text;
}

function showRoom(code) {
  roomCode = code;
  $("home").hidden = true;
  $("room").hidden = false;
  $("roomCode").textContent = code;
}

function createRoom() {
  const name = $("name").value.trim();
  if (!name) return alert("Nhập tên của bạn nhé!");

  socket.emit("room:create", { name }, result => {
    if (result.error) return alert(result.error);
    isHost = true;
    showRoom(result.code);
    message("Đã tạo phòng! Gửi mã cho bạn bè.");
  });
}

function joinRoom() {
  const name = $("name").value.trim();
  const code = $("code").value.trim().toUpperCase();
  if (!name || !code) return alert("Nhập tên và mã phòng!");

  socket.emit("room:join", { name, code }, result => {
    if (result.error) return alert(result.error);
    isHost = false;
    showRoom(result.code);
    message("Đã vào phòng!");
  });
}

$("create").onclick = createRoom;
$("join").onclick = joinRoom;

$("start").onclick = () => {
  socket.emit("game:start", { code: roomCode }, result => {
    if (result.error) alert(result.error);
  });
};

$("meeting").onclick = () => {
  socket.emit("meeting:call", {
    code: roomCode,
    reason: "Cuộc họp khẩn cấp!"
  }, result => {
    if (result.error) alert(result.error);
  });
};

socket.on("room:update", room => {
  if (room.code !== roomCode) return;
  currentRoom = room;

  $("players").innerHTML = "";
  room.players.forEach(player => {
    const li = document.createElement("li");
    li.textContent =
      player.name +
      (player.isHost ? " 👑" : "") +
      (!player.alive ? " 💀" : "") +
      (!player.connected ? " (Mất kết nối)" : "");
    $("players").appendChild(li);
  });

  $("start").hidden =
    !isHost || room.phase !== "lobby";

  $("meeting").hidden =
    room.phase !== "playing" || !myRole || myRole.alive === false;

  if (room.phase === "meeting") {
    $("votes").innerHTML = "<h3>Hãy chọn người bạn nghi ngờ!</h3>";

    room.players.filter(p => p.alive).forEach(player => {
      const button = document.createElement("button");
      button.textContent = "Bỏ phiếu: " + player.name;
      button.onclick = () => vote(player.id);
      $("votes").appendChild(button);
    });

    const skip = document.createElement("button");
    skip.textContent = "Bỏ qua";
    skip.onclick = () => vote("skip");
    $("votes").appendChild(skip);
  } else {
    $("votes").innerHTML = "";
  }
});

socket.on("game:private", data => {
  myRole = data;
  myTasks = data.tasks || [];

  $("role").textContent =
    data.role === "impostor"
      ? "🔪 BẠN LÀ IMPOSTOR!"
      : "🧑‍🚀 BẠN LÀ CREW!";

  $("tasks").innerHTML = "";

  if (data.role === "crew") {
    myTasks.forEach(task => {
      const button = document.createElement("button");
      button.textContent = task;
      button.onclick = () => completeTask(task);
      $("tasks").appendChild(button);
    });
  } else {
    $("tasks").textContent = "Hãy giả vờ thực hiện nhiệm vụ!";
  }
});

function completeTask(task) {
  socket.emit("task:complete", {
    code: roomCode,
    task
  }, result => {
    if (result.error) return alert(result.error);
    message("Đã hoàn thành: " + task);
  });
}

function vote(targetId) {
  socket.emit("meeting:vote", {
    code: roomCode,
    targetId
  }, result => {
    if (result.error) alert(result.error);
    else message("Đã gửi phiếu bầu!");
  });
}

socket.on("meeting:started", data => {
  message("🚨 HỌP KHẨN CẤP! Người gọi: " + data.calledBy);
});

socket.on("meeting:result", data => {
  message(
    data.ejected
      ? "Người bị loại: " + data.ejected.name +
        " — " + data.ejected.role
      : "Không có ai bị loại!"
  );
});

socket.on("game:ended", result => {
  $("role").textContent =
    result.winner === "crew"
      ? "🎉 CREW CHIẾN THẮNG!"
      : "🔪 IMPOSTOR CHIẾN THẮNG!";

  $("message").textContent = result.reason;
  $("votes").innerHTML = "";

  result.roles.forEach(player => {
    const p = document.createElement("p");
    p.textContent = player.name + ": " + player.role;
    $("votes").appendChild(p);
  });
});

socket.on("connect_error", () => {
  message("Không kết nối được máy chủ. Hãy tải lại trang.");
});
