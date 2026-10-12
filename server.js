const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { getBoardFlow, phaseSystemMsg } = require("./boardFlow");
const {
  PRESET_ROLES,
  validateRoleList,
  resolvedRolesList,
  roomPayloadForSocket,
} = require("./roleConfig");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};
let nightData = {}; 
let votes = {};     
let pkPlayers = {}; 

function broadcastRoomUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  attachSpeechMeta(room);
  room.players.forEach((p) => {
    io.to(p.id).emit("update", roomPayloadForSocket(room, p.id));
  });
}

/** 清除夜晚倒數、進夜延遲、處決後進夜、遊戲結束倒數，避免上一局計時器汙染下一局 */
function clearRoomTimers(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.nightPhaseInterval) {
    clearInterval(room.nightPhaseInterval);
    delete room.nightPhaseInterval;
  }
  if (room.enterNightTimeout) {
    clearTimeout(room.enterNightTimeout);
    delete room.enterNightTimeout;
  }
  if (room.execVoteTimeout) {
    clearTimeout(room.execVoteTimeout);
    delete room.execVoteTimeout;
  }
  if (room.gameOverResetTimeout) {
    clearTimeout(room.gameOverResetTimeout);
    delete room.gameOverResetTimeout;
  }
}

function clearDaySpeech(room) {
  delete room.speechOrder;
  delete room.speechIndex;
  delete room.daySubPhase;
  delete room.currentSpeechId;
}

/** 略過已死亡發言者，回傳目前索引是否仍有效 */
function syncSpeechIndex(room) {
  if (!room.speechOrder || !room.speechOrder.length) return;
  while (room.speechIndex < room.speechOrder.length) {
    const pid = room.speechOrder[room.speechIndex];
    const p = room.players.find((x) => x.id === pid);
    if (p && p.alive) return;
    room.speechIndex++;
  }
}

function attachSpeechMeta(room) {
  delete room.currentSpeechId;
  if (
    room.phase !== "DAY" ||
    room.daySubPhase !== "speech" ||
    !room.speechOrder
  ) {
    return;
  }
  syncSpeechIndex(room);
  if (room.speechIndex < room.speechOrder.length) {
    room.currentSpeechId = room.speechOrder[room.speechIndex];
  }
}

/** onlyIds：平票 PK 時僅候選人輪流發言 */
function initDaySpeech(room, roomId, onlyIds) {
  clearDaySpeech(room);
  const ids =
    onlyIds && onlyIds.length
      ? shuffle([...onlyIds])
      : shuffle(room.players.filter((p) => p.alive).map((p) => p.id));
  room.speechOrder = ids;
  room.speechIndex = 0;
  room.daySubPhase = "speech";
  syncSpeechIndex(room);
  if (room.speechIndex >= room.speechOrder.length) {
    room.daySubPhase = "vote";
    io.to(roomId).emit("systemMsg", "無存活發言者，請直接投票。");
  } else {
    const cur = room.players.find(
      (p) => p.id === room.speechOrder[room.speechIndex]
    );
    io.to(roomId).emit(
      "systemMsg",
      `🎤 發言順序已決定，請「${cur.name}」發言（說完按「發言結束」，或由房長按「下一個」）。`
    );
  }
}

function advanceSpeechAfterDayDeath(room, roomId) {
  if (room.phase !== "DAY" || room.daySubPhase !== "speech") return;
  syncSpeechIndex(room);
  if (room.speechIndex >= room.speechOrder.length) {
    room.daySubPhase = "vote";
    io.to(roomId).emit("systemMsg", "發言結束，請投票。");
  } else {
    const cur = room.players.find(
      (p) => p.id === room.speechOrder[room.speechIndex]
    );
    if (cur)
      io.to(roomId).emit("systemMsg", `🎤 請「${cur.name}」發言。`);
  }
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function countdown(roomId, seconds, nextStep) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.nightPhaseInterval) {
    clearInterval(room.nightPhaseInterval);
    delete room.nightPhaseInterval;
  }
  let count = seconds;
  room.nightPhaseInterval = setInterval(() => {
    const r = rooms[roomId];
    if (!r || r.phase === "WAIT") {
      if (r && r.nightPhaseInterval) {
        clearInterval(r.nightPhaseInterval);
        delete r.nightPhaseInterval;
      }
      return;
    }
    io.to(roomId).emit("timer", count);
    count--;
    if (count < 0) {
      if (r.nightPhaseInterval) {
        clearInterval(r.nightPhaseInterval);
        delete r.nightPhaseInterval;
      }
      nextStep();
    }
  }, 1000);
}

function checkGameOver(roomId) {
  const room = rooms[roomId];
  if (!room) return false;

  const alivePlayers = room.players.filter(p => p.alive);
  const wolves = alivePlayers.filter(p => ['wolf', 'wolfking'].includes(p.role));
  const gods = alivePlayers.filter(p => ['seer', 'witch', 'hunter', 'idiot', 'knight'].includes(p.role));
  const villagers = alivePlayers.filter(p => p.role === 'villager');

  let winner = null;
  if (wolves.length === 0) {
    winner = "好人陣營";
  } else if (gods.length === 0 || villagers.length === 0) {
    winner = "狼人陣營";
  }

  if (winner) {
    clearRoomTimers(roomId);
    delete nightData[roomId];
    io.to(roomId).emit("timer", 0);
    io.to(roomId).emit("gameOver", winner);
    if (room.gameOverResetTimeout) {
      clearTimeout(room.gameOverResetTimeout);
      delete room.gameOverResetTimeout;
    }
    room.gameOverResetTimeout = setTimeout(() => {
      delete room.gameOverResetTimeout;
      const r = rooms[roomId];
      if (!r) return;
      r.phase = "WAIT";
      r.players.forEach((p) => {
        p.role = null;
        p.alive = true;
        p.deathReason = null;
        delete p.hasAntidote;
        delete p.hasPoison;
        delete p.knightSkillUsed;
        delete p.knightRevealed;
      });
      delete r.pendingKnightNight;
      clearDaySpeech(r);
      pkPlayers[roomId] = [];
      votes[roomId] = {};
      delete nightData[roomId];
      broadcastRoomUpdate(roomId);
    }, 8000);
    return true;
  }
  return false;
}

function runNightStep(roomId, stepIndex) {
  const room = rooms[roomId];
  if (!room) return;

  const flow = getBoardFlow(room.nightFlowKey);
  const steps = flow.nightSteps;
  if (stepIndex >= steps.length) {
    processDaybreak(roomId);
    return;
  }

  const step = steps[stepIndex];
  if (step.skipIfNoRole) {
    const hasRole = room.players.some(
      (p) => p.alive && p.role === step.skipIfNoRole
    );
    if (!hasRole) {
      runNightStep(roomId, stepIndex + 1);
      return;
    }
  }

  room.phase = step.phase;
  if (step.phase === "NIGHT_WITCH" && step.sendWitchKnowledge) {
    const witch = room.players.find((p) => p.role === "witch");
    if (witch && witch.alive) {
      const targetInfo = witch.hasAntidote ? nightData[roomId].killed : null;
      io.to(witch.id).emit("witchKnowledge", targetInfo);
    }
  }

  broadcastRoomUpdate(roomId);
  io.to(roomId).emit("systemMsg", phaseSystemMsg(step.phase, step.systemMsg));

  countdown(roomId, step.seconds, () => runNightStep(roomId, stepIndex + 1));
}

function startNightFlow(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  nightData[roomId] = { killed: null, usedAntidote: false, usedPoison: null };
  runNightStep(roomId, 0);
}

function processDaybreak(roomId) {
  const room = rooms[roomId];
  const data = nightData[roomId];
  if (!room || !data) return;

  let killedNames = [];
  const newlyDeadPlayers = [];
  
  if (data.usedPoison) {
    const target = room.players.find(p => p.id === data.usedPoison);
    if (target) {
      target.alive = false;
      target.deathReason = "poisoned";
      killedNames.push(target.name);
      newlyDeadPlayers.push(target);
    }
  }

  if (data.killed && !data.usedAntidote) {
    const target = room.players.find(p => p.id === data.killed);
    if (target && target.alive) {
      target.alive = false; 
      target.deathReason = "killed";
      killedNames.push(target.name);
      newlyDeadPlayers.push(target);
    }
  }

  const deathSkillPlayer = newlyDeadPlayers.find((p) => ["hunter", "wolfking"].includes(p.role));
  if (deathSkillPlayer) {
    io.to(roomId).emit("skillProcessing", true);
    io.to(deathSkillPlayer.id).emit("hunterCanShoot", true);
  }

  room.phase = "DAY";
  const resultMsg = killedNames.length > 0 ? `昨晚死亡的是：${killedNames.join(", ")}` : "昨晚是平安夜";

  if (checkGameOver(roomId)) {
    broadcastRoomUpdate(roomId);
    io.to(roomId).emit("systemMsg", `天亮了！${resultMsg}`);
    return;
  }
  initDaySpeech(rooms[roomId], roomId, null);
  broadcastRoomUpdate(roomId);
  io.to(roomId).emit("systemMsg", `天亮了！${resultMsg}`);
}

function enterNight(id) {
  const room = rooms[id];
  if (!room) return;
  clearDaySpeech(room);
  votes[id] = {}; 
  pkPlayers[id] = []; 
  broadcastRoomUpdate(id);
  if (!checkGameOver(id)) {
    if (room.enterNightTimeout) {
      clearTimeout(room.enterNightTimeout);
      delete room.enterNightTimeout;
    }
    const delay = getBoardFlow(room.nightFlowKey).enterNightDelayMs;
    room.enterNightTimeout = setTimeout(() => {
      delete room.enterNightTimeout;
      const r = rooms[id];
      if (!r || r.phase === "WAIT") return;
      startNightFlow(id);
    }, delay);
  }
}

// 統一處理玩家離開邏輯
function handlePlayerExit(socket) {
  for (const rid in rooms) {
    const room = rooms[rid];
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    
    if (playerIndex !== -1) {
      io.to(rid).emit("peerSpeaking", { id: socket.id, active: false });
      const exitingPlayer = room.players[playerIndex];
      room.players.splice(playerIndex, 1);
      
      if (room.players.length === 0) {
        delete rooms[rid];
        delete nightData[rid];
        delete pkPlayers[rid];
        delete votes[rid];
      } else {
        // 如果退出的是房長，轉移權限
        if (room.host === socket.id) {
          room.host = room.players[0].id;
          io.to(rid).emit("systemMsg", `房長已退出，新房長為：${room.players[0].name}`);
        }
        io.to(rid).emit("systemMsg", `${exitingPlayer.name} 已離開房間。`);
        broadcastRoomUpdate(rid);
      }
    }
  }
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name, boardType, peerId }) => {
    const isCustom = boardType === "custom";
    if (!isCustom && !PRESET_ROLES[boardType]) {
      return socket.emit("error", "無效的板子類型");
    }
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const presetList = PRESET_ROLES[boardType];
    const maxPlayers = isCustom ? 99 : presetList.length;
    rooms[roomId] = {
      host: socket.id,
      phase: "WAIT",
      players: [],
      presetId: isCustom ? null : boardType,
      customRoles: isCustom ? null : [...presetList],
      nightFlowKey: isCustom ? "default" : boardType,
      maxPlayers,
    };
    rooms[roomId].players.push({ id: socket.id, name: name.trim(), alive: true, role: null, peerId });
    socket.join(roomId);
    socket.emit("roomCreated", roomId);
    broadcastRoomUpdate(roomId);
  });

  socket.on("setGameConfig", ({ roomId, customRoles, nightFlowKey, loadPresetId, clearRoles }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (!room || room.phase !== "WAIT" || room.host !== socket.id) return;

    if (clearRoles) {
      room.presetId = null;
      room.customRoles = null;
    }
    if (loadPresetId && PRESET_ROLES[loadPresetId]) {
      room.presetId = loadPresetId;
      room.customRoles = [...PRESET_ROLES[loadPresetId]];
      room.nightFlowKey = loadPresetId;
    }
    if (Array.isArray(customRoles)) {
      const v = validateRoleList(customRoles);
      if (!v.ok) return socket.emit("error", v.msg);
      if (customRoles.length === 0) {
        room.customRoles = null;
        room.presetId = null;
      } else {
        room.customRoles = [...customRoles];
        room.presetId = null;
      }
    }
    if (typeof nightFlowKey === "string" && nightFlowKey.length > 0) {
      room.nightFlowKey = nightFlowKey;
    }
    broadcastRoomUpdate(id);
  });

  socket.on("speakingState", ({ roomId, active }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    const speaker = room && room.players.find((p) => p.id === socket.id);
    if (!speaker) return;
    const isActive = !!active;
    const nightPhase = String(room.phase || "").startsWith("NIGHT_");
    if (nightPhase) {
      if (room.phase !== "NIGHT_WOLF") return;
      const isWolf = ["wolf", "wolfking"].includes(speaker.role);
      if (!isWolf || (isActive && !speaker.alive)) return;
      room.players
        .filter((p) => ["wolf", "wolfking"].includes(p.role))
        .forEach((p) => io.to(p.id).emit("peerSpeaking", { id: socket.id, active: isActive }));
      return;
    }
    io.to(id).emit("peerSpeaking", { id: socket.id, active: isActive });
  });

  socket.on("joinRoom", ({ roomId, name, peerId }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (!room || room.phase !== "WAIT") return socket.emit("error", "無法加入！");
    if (room.players.length >= room.maxPlayers) return socket.emit("error", "房間已滿！");

    room.players.push({ id: socket.id, name: name.trim(), alive: true, role: null, peerId });
    socket.join(id);
    socket.to(id).emit("user-connected", peerId);
    broadcastRoomUpdate(id);
  });

  socket.on("leaveRoom", (roomId) => {
    socket.leave(roomId.toUpperCase());
    handlePlayerExit(socket);
  });

  socket.on("startGame", (roomId) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (!room || room.host !== socket.id) return;

    const roles = resolvedRolesList(room);
    if (!roles) {
      return io.to(id).emit("systemMsg", "請房長先設定角色（載入範本或自訂清單）。");
    }
    const v = validateRoleList(roles);
    if (!v.ok) {
      return io.to(id).emit("systemMsg", v.msg);
    }
    if (roles.length !== room.players.length) {
      return io.to(id).emit(
        "systemMsg",
        `角色數 ${roles.length} 與玩家人數 ${room.players.length} 不符，請房長調整。`
      );
    }

    clearRoomTimers(id);
    delete nightData[id];
    votes[id] = {};
    pkPlayers[id] = [];

    shuffle(roles);
    room.players.forEach((p, i) => {
      p.role = roles[i];
      p.alive = true;
      p.deathReason = null;
      delete p.knightSkillUsed;
      delete p.knightRevealed;
      if (p.role === "knight") {
        p.knightSkillUsed = false;
        p.knightRevealed = false;
      }
      if (p.role === 'witch') {
        p.hasAntidote = true;
        p.hasPoison = true;
      }
      io.to(p.id).emit("role", p.role);
    });
    delete room.pendingKnightNight;

    startNightFlow(id);
  });

  socket.on("wolfKill", ({ roomId, targetId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = rooms[id];
    if (!room || !nightData[id] || room.phase !== "NIGHT_WOLF") return;
    const killer = room.players.find((p) => p.id === socket.id);
    const target = room.players.find((p) => p.id === targetId);
    if (!killer || !killer.alive || !["wolf", "wolfking"].includes(killer.role)) {
      socket.emit("actionError", "只有存活的狼人可以在狼人階段擊殺。");
      return;
    }
    if (!target || !target.alive || target.id === killer.id) {
      socket.emit("actionError", "請選擇一位存活的其他玩家。");
      return;
    }
    if (["wolf", "wolfking"].includes(target.role)) {
      socket.emit("actionError", "狼人不能選擇狼人隊友作為擊殺目標。");
      return;
    }

    const lockedId = nightData[id].killed || targetId;
    if (!nightData[id].killed) nightData[id].killed = targetId;
    const lockedTarget = room.players.find((p) => p.id === lockedId);
    const message = `狼人刀已鎖定：${lockedTarget ? lockedTarget.name : "未知"}`;
    room.players
      .filter((p) => ["wolf", "wolfking"].includes(p.role))
      .forEach((p) => {
        io.to(p.id).emit("wolfTargetLocked", { targetId: lockedId, msg: message });
      });
  });

  socket.on("seerAction", ({ roomId, targetId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = rooms[id];
    const seer = room && room.players.find((p) => p.id === socket.id);
    const target = room && room.players.find((p) => p.id === targetId);
    if (!room || room.phase !== "NIGHT_SEER") {
      socket.emit("actionError", "現在不是預言家查驗階段。");
      return;
    }
    if (!seer || !seer.alive || seer.role !== "seer") {
      socket.emit("actionError", "只有存活的預言家可以查驗。");
      return;
    }
    if (!target || !target.alive || target.id === seer.id) {
      socket.emit("actionError", "請選擇一位存活的其他玩家。");
      return;
    }
    socket.emit("seerResult", ["wolf", "wolfking"].includes(target.role));
  });

  socket.on("hunterAction", ({ roomId, targetId }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    const target = room && room.players.find(p => p.id === targetId);
    if (target && target.alive) {
      target.alive = false;
      const shooter = room.players.find(p => p.id === socket.id);
      const roleName = (shooter && shooter.role === 'wolfking') ? "狼王" : "獵人";
      io.to(id).emit("systemMsg", `${roleName}最後一搏，帶走了：${target.name}`);
      io.to(id).emit("skillProcessing", false);
      const pendingKnightNight = !!room.pendingKnightNight;
      room.pendingKnightNight = false;
      broadcastRoomUpdate(id);
      if (checkGameOver(id)) return;
      if (pendingKnightNight) enterNight(id);
    }
  });

  socket.on("knightCharge", ({ roomId, targetId }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (!room || room.phase !== "DAY") return;

    const knight = room.players.find((p) => p.id === socket.id);
    if (
      !knight ||
      knight.role !== "knight" ||
      !knight.alive ||
      knight.knightSkillUsed
    ) {
      return;
    }

    syncSpeechIndex(room);
    const curSid =
      room.daySubPhase === "speech" &&
      room.speechOrder &&
      room.speechIndex < room.speechOrder.length
        ? room.speechOrder[room.speechIndex]
        : null;
    if (curSid !== socket.id) return;

    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive || target.id === knight.id) return;

    knight.knightSkillUsed = true;
    knight.knightRevealed = true;

    const isWolf = ["wolf", "wolfking"].includes(target.role);

    if (isWolf) {
      target.alive = false;
      target.deathReason = "knightCharge";
      io.to(id).emit(
        "systemMsg",
        `⚔️ ${knight.name} 騎士翻牌衝撞 ${target.name}！狼人陣營出局，天黑。`
      );
      broadcastRoomUpdate(id);
      if (target.role === "wolfking") {
        if (checkGameOver(id)) return;
        room.pendingKnightNight = true;
        io.to(id).emit("skillProcessing", true);
        io.to(target.id).emit("hunterCanShoot", true);
        return;
      }
      if (!checkGameOver(id)) enterNight(id);
    } else {
      knight.alive = false;
      knight.deathReason = "knightChargeFail";
      io.to(id).emit(
        "systemMsg",
        `⚔️ ${knight.name} 騎士翻牌衝撞 ${target.name}！撞錯好人，騎士出局，遊戲繼續。`
      );
      if (!checkGameOver(id)) advanceSpeechAfterDayDeath(room, id);
      broadcastRoomUpdate(id);
    }
  });

  socket.on("nextSpeech", ({ roomId }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (
      !room ||
      room.phase !== "DAY" ||
      room.daySubPhase !== "speech" ||
      !room.speechOrder ||
      !room.speechOrder.length
    ) {
      return;
    }
    syncSpeechIndex(room);
    const curId =
      room.speechIndex < room.speechOrder.length
        ? room.speechOrder[room.speechIndex]
        : null;
    const isHost = room.host === socket.id;
    const isSpeaker = curId === socket.id;
    if (!isHost && !isSpeaker) return;

    room.speechIndex++;
    syncSpeechIndex(room);
    if (room.speechIndex >= room.speechOrder.length) {
      room.daySubPhase = "vote";
      io.to(id).emit("systemMsg", "發言結束，請投票。");
    } else {
      const nextP = room.players.find(
        (p) => p.id === room.speechOrder[room.speechIndex]
      );
      if (nextP)
        io.to(id).emit("systemMsg", `🎤 請「${nextP.name}」發言。`);
    }
    broadcastRoomUpdate(id);
  });

  socket.on("witchSave", ({ roomId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    const witch = room && room.players.find((p) => p.id === socket.id);
    const data = id && nightData[id];
    if (!room || room.phase !== "NIGHT_WITCH" || !data) {
      socket.emit("actionError", "現在不是女巫用藥階段。");
      return;
    }
    if (!witch || !witch.alive || witch.role !== "witch" || !witch.hasAntidote) {
      socket.emit("actionError", "你目前不能使用解藥。");
      return;
    }
    if (!data.killed || data.usedAntidote) {
      socket.emit("actionError", "目前沒有可救的狼刀目標，或解藥已使用。");
      return;
    }
    data.usedAntidote = true;
    witch.hasAntidote = false;
    socket.emit("witchActionLocked", "解藥已使用，狼刀目標將獲救。");
    broadcastRoomUpdate(id);
  });

  socket.on("witchPoison", ({ roomId, targetId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    const witch = room && room.players.find((p) => p.id === socket.id);
    const target = room && room.players.find((p) => p.id === targetId);
    const data = id && nightData[id];
    if (!room || room.phase !== "NIGHT_WITCH" || !data) {
      socket.emit("actionError", "現在不是女巫用藥階段。");
      return;
    }
    if (!witch || !witch.alive || witch.role !== "witch" || !witch.hasPoison) {
      socket.emit("actionError", "你目前不能使用毒藥。");
      return;
    }
    if (!target || !target.alive || target.id === witch.id) {
      socket.emit("actionError", "請選擇一位存活的其他玩家。");
      return;
    }
    if (data.usedPoison) {
      socket.emit("actionError", "毒藥已使用，目標不能更改。");
      return;
    }
    data.usedPoison = targetId;
    witch.hasPoison = false;
    socket.emit("witchActionLocked", `毒藥已使用，${target.name} 將於天亮時死亡。`);
    broadcastRoomUpdate(id);
  });

  socket.on("castVote", ({ roomId, targetId }) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    if (room && room.phase === "DAY" && room.daySubPhase === "vote") {
      if (!votes[id]) votes[id] = {};
      votes[id][socket.id] = targetId;
      const voteCount = Object.keys(votes[id]).length;
      const totalEligible = room.players.filter(p => p.alive && !(pkPlayers[id] || []).includes(p.id)).length;
      io.to(id).emit("voteUpdate", { count: voteCount, total: totalEligible });
      io.to(id).emit("systemMsg", `一名玩家已投票 (${voteCount}/${totalEligible})`);
    }
  });

  socket.on("finishVote", (roomId) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    const currentVotes = votes[id] || {};
    if (!room) return;
    if (room.daySubPhase !== "vote") {
      return io.to(id).emit("systemMsg", "請先完成發言階段再結算投票。");
    }

    const finalVoteDetail = Object.entries(currentVotes).map(([voterId, tId]) => {
      const voter = room.players.find(p => p.id === voterId);
      const target = room.players.find(p => p.id === tId);
      return { voterName: voter ? voter.name : "未知", targetName: target ? target.name : "未知" };
    });

    io.to(id).emit("showFinalVotes", finalVoteDetail);

    if (Object.keys(currentVotes).length === 0) {
        io.to(id).emit("systemMsg", "無人投票，直接進入夜晚。");
        enterNight(id);
        return;
    }

    const tally = {};
    Object.values(currentVotes).forEach(tid => tally[tid] = (tally[tid] || 0) + 1);

    let maxVotes = 0;
    let candidates = [];
    for (const [pid, count] of Object.entries(tally)) {
        if (count > maxVotes) { maxVotes = count; candidates = [pid]; } 
        else if (count === maxVotes) { candidates.push(pid); }
    }

    if (candidates.length > 1) {
        if (!pkPlayers[id] || pkPlayers[id].length === 0) {
            pkPlayers[id] = candidates;
            const names = room.players.filter(p => candidates.includes(p.id)).map(p => p.name);
            io.to(id).emit("systemMsg", `【平票 PK】候選人發言：${names.join(", ")}`);
            io.to(id).emit("pkMode", pkPlayers[id]); 
            votes[id] = {}; 
            io.to(id).emit("voteUpdate", { count: 0, total: room.players.filter(p => p.alive && !candidates.includes(p.id)).length });
            initDaySpeech(room, id, candidates);
            broadcastRoomUpdate(id);
            return; 
        } else {
            io.to(id).emit("systemMsg", "再次平票，無人出局，直接進入夜晚。");
            enterNight(id);
        }
    } else {
        const expelledId = candidates[0];
        const target = room.players.find(p => p.id === expelledId);
        if (target) {
            target.alive = false;
            target.deathReason = "voted";
            io.to(id).emit("systemMsg", `投票結果：${target.name} 被處決了！`);
            if (target.role === 'hunter' || target.role === 'wolfking') {
                io.to(id).emit("skillProcessing", true);
                io.to(target.id).emit("hunterCanShoot", true);
                return;
            }
        }
        broadcastRoomUpdate(id);
        const execDelay = getBoardFlow(room.nightFlowKey).afterExecutionDelayMs;
        const sec = Math.round(execDelay / 1000);
        io.to(id).emit("systemMsg", `📣 處決完成，${sec} 秒後進入夜晚...`);
        if (room.execVoteTimeout) {
          clearTimeout(room.execVoteTimeout);
          delete room.execVoteTimeout;
        }
        room.execVoteTimeout = setTimeout(() => {
          delete room.execVoteTimeout;
          const r = rooms[id];
          if (!r || r.phase === "WAIT") return;
          enterNight(id);
        }, execDelay);
    }
  });

  socket.on("disconnect", () => {
    handlePlayerExit(socket);
  });
});

const PORT = Number(process.env.PORT) || 8080;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `連接埠 ${PORT} 已被使用（常見原因：另一個 node server.js 仍在執行）。\n` +
        `請關掉舊程序，或改用：$env:PORT=3000; node server.js`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`伺服器運行中：http://localhost:${PORT}`);
});
