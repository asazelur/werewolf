const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};
let nightData = {}; // 全域變數，存放各房間夜晚行動
let votes = {}; // 新增：存放房號對應的投票數據 { ROOMID: { playerId: targetId } }

// 洗牌函式
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function startNightFlow(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // 初始化該房間的夜晚數據（預防萬一）
  if (!nightData[roomId]) {
    nightData[roomId] = { killed: null, usedAntidote: false, usedPoison: null };
  }

  // --- 1. 狼人時間 ---
  room.phase = "NIGHT_WOLF";
  io.to(roomId).emit("update", room);
  io.to(roomId).emit("systemMsg", "狼人請殺人");
  
  countdown(roomId, 10, () => {
    // --- 2. 預言家時間 ---
    room.phase = "NIGHT_SEER";
    io.to(roomId).emit("update", room);
    io.to(roomId).emit("systemMsg", "預言家請驗人");

    countdown(roomId, 10, () => {
      // --- 3. 女巫時間 ---
      room.phase = "NIGHT_WITCH";
      io.to(roomId).emit("update", room);

      const witch = room.players.find(p => p.role === 'witch');
      if (witch && witch.alive) {
        io.to(witch.id).emit("witchKnowledge", nightData[roomId].killed);
        io.to(roomId).emit("systemMsg", "女巫請用藥");
      } else {
        io.to(roomId).emit("systemMsg", "上帝等待中...");
      }

      countdown(roomId, 10, () => {
        processDaybreak(roomId);
      });
    });
  });
}

// 黎明結算邏輯
function processDaybreak(roomId) {
  const room = rooms[roomId];
  const data = nightData[roomId]; // 這裡之前寫錯了，一定要加 [roomId]
  if (!room || !data) return;

  let killedName = "無人死亡";
  
  if (data.killed && !data.usedAntidote) {
    const target = room.players.find(p => p.id === data.killed);
    if (target) {
      target.alive = false; 
      killedName = target.name;
    }
  }

  room.phase = "DAY";
  nightData[roomId] = { killed: null, usedAntidote: false, usedPoison: null }; // 重置資料

  io.to(roomId).emit("update", room);
  io.to(roomId).emit("systemMsg", `天亮了！昨晚死亡的是：${killedName}`);

  // 新增：檢查有沒有人死掉後直接結束遊戲
  checkGameOver(roomId);
}

// 輔助函式：動態倒數並切換階段
function countdown(roomId, seconds, nextStep) {
  let count = seconds;
  const timer = setInterval(() => {
    io.to(roomId).emit("timer", count); // 廣播秒數給前端
    count--;
    if (count < 0) {
      clearInterval(timer);
      nextStep();
    }
  }, 1000);
}

function checkGameOver(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const alivePlayers = room.players.filter(p => p.alive);
  const wolves = alivePlayers.filter(p => p.role === 'wolf');
  const gods = alivePlayers.filter(p => ['seer', 'witch', 'hunter', 'idiot'].includes(p.role));
  const villagers = alivePlayers.filter(p => p.role === 'villager');

  let winner = null;

  // 1. 狼人全滅 -> 好人勝利
  if (wolves.length === 0) {
    winner = "好人陣營 (預言家/女巫/平民)";
  } 
  // 2. 屠邊局：神職全滅 或 平民全滅 -> 狼人勝利
  else if (gods.length === 0 || villagers.length === 0) {
    winner = "狼人陣營";
  }

  if (winner) {
    io.to(roomId).emit("gameOver", winner);
    // 5秒後重置房間狀態回到等待階段
    setTimeout(() => {
      room.phase = "WAIT";
      room.players.forEach(p => { p.role = null; p.alive = true; });
      io.to(roomId).emit("update", room);
    }, 5000);
    return true; // 代表遊戲結束了
  }
  return false;
}

io.on("connection", (socket) => {
  // 建立房間
  socket.on("createRoom", ({ name, maxPlayers }) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomId] = {
      host: socket.id,
      phase: "WAIT",
      players: [],
      maxPlayers: parseInt(maxPlayers) || 12
    };
    rooms[roomId].players.push({ id: socket.id, name, alive: true, role: null });
    socket.join(roomId);
    socket.emit("roomCreated", roomId);
    io.to(roomId).emit("update", rooms[roomId]);
  });

  // 加入房間
  socket.on("joinRoom", ({ roomId, name }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (!room) return socket.emit("error", "找不到該房間！");
    if (room.players.length >= room.maxPlayers) return socket.emit("error", "房間已滿！");

    room.players.push({ id: socket.id, name, alive: true, role: null });
    socket.join(id);
    io.to(id).emit("update", room);
  });

  // 開始遊戲
  socket.on("startGame", (roomId) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (!room) return;

    let roles = [];
    const playerCount = room.players.length;

    // 4人、10人、12人配置
    if (playerCount === 4) {
      roles = ["wolf", "seer", "witch", "villager"];
    } else if (room.maxPlayers === 10) {
      roles = ["wolf", "wolf", "seer", "witch", "villager", "villager", "villager", "villager", "villager", "villager"];
    } else {
      roles = ["wolf", "wolf", "wolf", "wolf", "seer", "witch", "hunter", "idiot", "villager", "villager", "villager", "villager"];
    }

    shuffle(roles);

    room.players.forEach((p, i) => {
      p.role = roles[i];
      p.alive = true;
      io.to(p.id).emit("role", p.role);
    });

    // 初始化該房間的夜晚數據
    nightData[id] = { killed: null, usedAntidote: false, usedPoison: null };
    startNightFlow(id);
  });

  // 狼人殺人
  socket.on("wolfKill", ({ roomId, targetId }) => {
    const id = roomId.toUpperCase();
    if (nightData[id]) {
      nightData[id].killed = targetId;
      socket.emit("systemMsg", "已確認目標");
    }
  });

  // 預言家驗人
  socket.on("seerAction", ({ roomId, targetId }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (!room) return;
    const target = room.players.find(p => p.id === targetId);
    if (target) {
      socket.emit("seerResult", target.role === 'wolf');
    }
  });

  // 女巫救人
  socket.on("witchSave", ({ roomId }) => {
    const id = roomId.toUpperCase();
    if (nightData[id]) {
      nightData[id].usedAntidote = true; // 修正這裡！
      socket.emit("systemMsg", "你使用了藥水");
    }
  });

    // server.js 中的 castVote 監聽
  socket.on("castVote", ({ roomId, targetId }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    const player = room.players.find(p => p.id === socket.id);

    // 防呆：只有活著的人才能投票
    if (room && player && player.alive && room.phase === "DAY") {
      if (!votes[id]) votes[id] = {};
      votes[id][socket.id] = targetId;
      io.to(id).emit("systemMsg", `一名玩家已投票`);
    }
  });

    // 結算投票
  socket.on("finishVote", (roomId) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    const currentVotes = votes[id] || {};
    
    if (!room || Object.keys(currentVotes).length === 0) {
      io.to(id).emit("systemMsg", "無人投票，進入下一個夜晚。");
    } else {
      // 計算票數
      const tally = {};
      Object.values(currentVotes).forEach(targetId => {
        tally[targetId] = (tally[targetId] || 0) + 1;
      });

      // 找出最高票
      let maxVotes = 0;
      let expelledId = null;
      for (const [pId, count] of Object.entries(tally)) {
        if (count > maxVotes) {
          maxVotes = count;
          expelledId = pId;
        } else if (count === maxVotes) {
          expelledId = null; // 平票，無人出局
        }
      }

      if (expelledId) {
        const target = room.players.find(p => p.id === expelledId);
        target.alive = false;
        io.to(id).emit("systemMsg", `投票結果：${target.name} 以 ${maxVotes} 票被處決了！`);
      } else {
        io.to(id).emit("systemMsg", "投票結果：平票，無人出局。");
      }
    }

    // 清空投票數據並進入下一晚
    votes[id] = {};
    io.to(id).emit("update", room);
    
    // 新增：檢查投票出人後是否結束
  if (!checkGameOver(id)) {
    // 如果遊戲沒結束，才在 3 秒後進入下一晚
    setTimeout(() => {
      startNightFlow(id);
    }, 3000);
  }
});


  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      io.to(roomId).emit("update", rooms[roomId]);
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
        delete nightData[roomId];
      }
    }
  });
});

const PORT = 8080; // 建議改回 3000 與 local 測試一致，或維持 8080
server.listen(PORT, () => {
  console.log(`伺服器運行中：http://localhost:${PORT}`);
});