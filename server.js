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
    const payload = roomPayloadForSocket(room, p.id);
    if (room.phase === "DAY" && room.daySubPhase === "vote") {
      const dayVotes = votes[roomId] || {};
      const pk = pkPlayers[roomId] || [];
      payload.dayVoteSubmitted = Object.prototype.hasOwnProperty.call(dayVotes, p.id);
      payload.dayVoteCount = Object.keys(dayVotes).length;
      payload.dayVoteTotal = room.players.filter((player) => player.alive && !pk.includes(player.id)).length;
      payload.dayVoteFinalized = !!room.dayVoteFinalized;
      payload.canDayVote = !!(p.alive && !pk.includes(p.id) && !room.dayVoteFinalized);
    }
    if (room.phase === "NIGHT_SEER" && p.role === "seer") {
      payload.seerActionDone = !!(nightData[roomId] && nightData[roomId].seerUsed);
    }
    io.to(p.id).emit("update", payload);
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
  delete room.lastWordsPlayerId;
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
  room.dayVoteFinalized = false;
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
  if (room.gameOver) return true;

  const alivePlayers = room.players.filter(p => p.alive);
  const wolves = alivePlayers.filter(p => ['wolf', 'wolfking', 'whitewolfking'].includes(p.role));
  const gods = alivePlayers.filter(p => ['seer', 'witch', 'hunter', 'idiot', 'knight', 'guard'].includes(p.role));
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
    room.gameOver = true;
    room.gameWinner = winner;
    io.to(roomId).emit("timer", 0);
    broadcastRoomUpdate(roomId);
    io.to(roomId).emit("gameOver", winner);
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

  nightData[roomId] = { killed: null, usedAntidote: false, usedPoison: null, protected: null, seerUsed: false };
  room.guardActionDone = false;
  runNightStep(roomId, 0);
}

function continueAfterDaybreak(roomId, resultMsg, newlyDeadPlayers) {
  const room = rooms[roomId];
  if (!room) return;
  if (checkGameOver(roomId)) {
    broadcastRoomUpdate(roomId);
    io.to(roomId).emit("systemMsg", `天亮了！${resultMsg}`);
    return;
  }
  const firstNightVictim = !room.firstNightDaybreak
    ? newlyDeadPlayers.find((player) => player.deathReason === "killed")
    : null;
  room.firstNightDaybreak = true;
  const deathSkillPlayer = newlyDeadPlayers.find((p) => ["hunter", "wolfking"].includes(p.role));
  if (deathSkillPlayer) {
    if (firstNightVictim) {
      room.pendingLastWordsPlayerId = firstNightVictim.id;
      room.lastWordsContinueDay = true;
    }
    if (room.skipDayAfterWolfExplode) {
      room.pendingNightAfterShot = true;
      delete room.skipDayAfterWolfExplode;
    }
    io.to(roomId).emit("skillProcessing", true);
    io.to(deathSkillPlayer.id).emit("hunterCanShoot", true);
    initDaySpeech(room, roomId, null);
    broadcastRoomUpdate(roomId);
    io.to(roomId).emit("systemMsg", `天亮了！${resultMsg}`);
    return;
  }
  if (room.skipDayAfterWolfExplode) {
    delete room.skipDayAfterWolfExplode;
    enterNight(roomId);
    return;
  }
  if (firstNightVictim) {
    room.lastWordsContinueDay = true;
    startLastWords(room, roomId, firstNightVictim);
    io.to(roomId).emit("systemMsg", `天亮了！${resultMsg}`);
    return;
  }
  initDaySpeech(room, roomId, null);
  broadcastRoomUpdate(roomId);
  io.to(roomId).emit("systemMsg", `天亮了！${resultMsg}`);
}

function resumeAfterBadge(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const callback = room.sheriffHandoffCallback;
  if (room.sheriffHandoffReturnPhase) room.phase = room.sheriffHandoffReturnPhase;
  delete room.sheriffHandoffCallback;
  delete room.sheriffHandoffReturnPhase;
  delete room.pendingSheriffId;
  if (callback) callback();
}

function beginSheriffHandoff(room, roomId, sheriff, callback) {
  if (!room.sheriffEnabled || !sheriff || room.sheriffId !== sheriff.id) {
    callback();
    return false;
  }
  room.sheriffHandoffReturnPhase = room.phase;
  room.phase = "SHERIFF_HANDOFF";
  room.pendingSheriffId = sheriff.id;
  room.sheriffHandoffCallback = callback;
  io.to(roomId).emit("systemMsg", `警長 ${sheriff.name} 出局，請移交警徽或撕毀警徽。`);
  broadcastRoomUpdate(roomId);
  countdown(roomId, 20, () => resolveSheriffBadge(roomId, null));
  return true;
}

function finishSheriffElection(roomId, sheriffId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.nightPhaseInterval) {
    clearInterval(room.nightPhaseInterval);
    delete room.nightPhaseInterval;
  }
  room.sheriffElectionDone = true;
  room.sheriffId = sheriffId || null;
  room.phase = "SHERIFF_RESULT";
  room.sheriffCandidateIds = [];
  room.sheriffVotingCandidateIds = [];
  room.sheriffVotes = {};
  room.sheriffSpeechOrder = [];
  room.sheriffSpeechIndex = 0;
  const selected = room.players.find((player) => player.id === room.sheriffId);
  io.to(roomId).emit("systemMsg", selected ? `👮 ${selected.name} 當選警長，白天投票權重為 1.5 票。` : "本局無人當選警長，繼續公布昨夜結果。", "action");
  broadcastRoomUpdate(roomId);
  processDaybreak(roomId);
}

function startSheriffSignup(roomId) {
  const room = rooms[roomId];
  if (!room || room.sheriffElectionDone) return;
  room.phase = "SHERIFF_SIGNUP";
  room.sheriffCandidateIds = [];
  io.to(roomId).emit("systemMsg", "首夜結束，開始警長競選：想競選的玩家請按「上警」。");
  broadcastRoomUpdate(roomId);
  countdown(roomId, 20, () => startSheriffSpeeches(roomId, false));
}

function startSheriffSpeeches(roomId, runoff) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.nightPhaseInterval) {
    clearInterval(room.nightPhaseInterval);
    delete room.nightPhaseInterval;
  }
  const candidates = runoff ? room.sheriffVotingCandidateIds : room.sheriffCandidateIds;
  const candidateSet = new Set(candidates);
  const aliveCandidates = room.players.filter((player) => candidateSet.has(player.id) && player.alive).map((player) => player.id);
  if (!aliveCandidates.length) {
    finishSheriffElection(roomId, null);
    return;
  }
  room.sheriffSpeechOrder = [...aliveCandidates];
  room.sheriffSpeechIndex = 0;
  room.phase = runoff ? "SHERIFF_RUNOFF_SPEECH" : "SHERIFF_SPEECH";
  const first = room.players.find((player) => player.id === room.sheriffSpeechOrder[0]);
  io.to(roomId).emit("systemMsg", `${runoff ? "警長競選平票，再次" : "警上"}發言開始，請 ${first ? first.name : "候選人"} 發言。`);
  broadcastRoomUpdate(roomId);
}

function advanceSheriffSpeech(roomId) {
  const room = rooms[roomId];
  if (!room || !["SHERIFF_SPEECH", "SHERIFF_RUNOFF_SPEECH"].includes(room.phase)) return;
  room.sheriffSpeechIndex = (room.sheriffSpeechIndex || 0) + 1;
  const order = room.sheriffSpeechOrder || [];
  if (room.sheriffSpeechIndex >= order.length) {
    startSheriffVote(roomId, room.phase === "SHERIFF_RUNOFF_SPEECH");
    return;
  }
  const next = room.players.find((player) => player.id === order[room.sheriffSpeechIndex]);
  io.to(roomId).emit("systemMsg", `🎤 請 ${next ? next.name : "下一位候選人"} 發言。`);
  broadcastRoomUpdate(roomId);
}

function startSheriffVote(roomId, runoff) {
  const room = rooms[roomId];
  if (!room) return;
  const candidates = runoff ? room.sheriffVotingCandidateIds : room.sheriffCandidateIds;
  room.sheriffVotingCandidateIds = candidates.filter((id) => room.players.some((player) => player.id === id && player.alive));
  if (!room.sheriffVotingCandidateIds.length) {
    finishSheriffElection(roomId, null);
    return;
  }
  room.sheriffEligibleVoterIds = room.players
    .filter((player) => player.alive && !room.sheriffVotingCandidateIds.includes(player.id))
    .map((player) => player.id);
  room.sheriffVotes = {};
  room.phase = runoff ? "SHERIFF_RUNOFF_VOTE" : "SHERIFF_VOTE";
  io.to(roomId).emit("systemMsg", "警長競選投票開始，警上候選人不可投票。", "action");
  broadcastRoomUpdate(roomId);
  if (!room.sheriffEligibleVoterIds.length) finishSheriffVote(roomId);
}

function finishSheriffVote(roomId) {
  const room = rooms[roomId];
  if (!room || !["SHERIFF_VOTE", "SHERIFF_RUNOFF_VOTE"].includes(room.phase)) return;
  const isRunoff = room.phase === "SHERIFF_RUNOFF_VOTE";
  const totals = {};
  Object.entries(room.sheriffVotes || {}).forEach(([voterId, targetId]) => {
    if (targetId && room.sheriffVotingCandidateIds.includes(targetId)) {
      totals[targetId] = (totals[targetId] || 0) + 1;
    }
  });
  let maxVotes = 0;
  let winners = [];
  Object.entries(totals).forEach(([targetId, count]) => {
    if (count > maxVotes) { maxVotes = count; winners = [targetId]; }
    else if (count === maxVotes) winners.push(targetId);
  });
  if (winners.length === 1) {
    finishSheriffElection(roomId, winners[0]);
  } else if (!isRunoff && winners.length > 1) {
    room.sheriffVotingCandidateIds = winners;
    room.sheriffCandidateIds = [...winners];
    room.sheriffElectionRound = 1;
    startSheriffSpeeches(roomId, true);
  } else {
    finishSheriffElection(roomId, null);
  }
}

function resolveSheriffBadge(roomId, targetId) {
  const room = rooms[roomId];
  if (!room || room.phase !== "SHERIFF_HANDOFF") return;
  if (room.nightPhaseInterval) {
    clearInterval(room.nightPhaseInterval);
    delete room.nightPhaseInterval;
  }
  const target = room.players.find((player) => player.id === targetId && player.alive);
  room.sheriffId = target ? target.id : null;
  io.to(roomId).emit("systemMsg", target ? `👮 警徽已移交給 ${target.name}。` : "警徽已撕毀，本局不再有警長。", "action");
  broadcastRoomUpdate(roomId);
  resumeAfterBadge(roomId);
}

function processDaybreak(roomId) {
  const room = rooms[roomId];
  const data = nightData[roomId];
  if (!room || !data) return;
  if (room.sheriffEnabled && !room.sheriffElectionDone) {
    startSheriffSignup(roomId);
    return;
  }

  let killedNames = [];
  const newlyDeadPlayers = [];
  
  if (data.usedPoison) {
    const target = room.players.find(p => p.id === data.usedPoison);
    if (target && target.alive) {
      target.alive = false;
      target.deathReason = "poisoned";
      killedNames.push(target.name);
      newlyDeadPlayers.push(target);
    }
  }

  const protectedWolfTarget = data.killed && data.protected === data.killed;
  const guardAndAntidoteConflict = protectedWolfTarget && data.usedAntidote;
  if (data.killed && ((!data.usedAntidote && !protectedWolfTarget) || guardAndAntidoteConflict)) {
    const target = room.players.find(p => p.id === data.killed);
    if (target && target.alive) {
      target.alive = false; 
      target.deathReason = "killed";
      killedNames.push(target.name);
      newlyDeadPlayers.push(target);
    }
  }

  room.phase = "DAY";
  const resultMsg = killedNames.length > 0 ? `昨晚死亡的是：${killedNames.join(", ")}` : "昨晚是平安夜";
  const deadSheriff = newlyDeadPlayers.find((player) => player.id === room.sheriffId);
  const continueDay = () => continueAfterDaybreak(roomId, resultMsg, newlyDeadPlayers);
  if (deadSheriff && !checkGameOver(roomId)) beginSheriffHandoff(room, roomId, deadSheriff, continueDay);
  else continueDay();
}

function enterNight(id) {
  const room = rooms[id];
  if (!room) return;
  clearDaySpeech(room);
  room.phase = "NIGHT_TRANSITION";
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

function startLastWords(room, roomId, player) {
  clearDaySpeech(room);
  room.phase = "DAY";
  room.daySubPhase = "lastWords";
  room.lastWordsPlayerId = player.id;
  const seconds = getBoardFlow(room.nightFlowKey).lastWordsSeconds;
  io.to(roomId).emit("systemMsg", `🕯️ ${player.name} 出局，開始遺言（${seconds} 秒）。`);
  broadcastRoomUpdate(roomId);
  countdown(roomId, seconds, () => finishLastWords(roomId));
}

function finishLastWords(roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== "DAY" || room.daySubPhase !== "lastWords") return;
  if (room.nightPhaseInterval) {
    clearInterval(room.nightPhaseInterval);
    delete room.nightPhaseInterval;
  }
  if (room.lastWordsContinueDay) {
    delete room.lastWordsContinueDay;
    io.to(roomId).emit("systemMsg", "首夜遺言結束，繼續白天發言。");
    initDaySpeech(room, roomId, null);
    broadcastRoomUpdate(roomId);
    return;
  }
  io.to(roomId).emit("systemMsg", "遺言結束，準備進入夜晚。");
  enterNight(roomId);
}

// 統一處理玩家離開邏輯
function handlePlayerExit(socket) {
  for (const rid in rooms) {
    const room = rooms[rid];
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    
    if (playerIndex !== -1) {
      io.to(rid).emit("peerSpeaking", { id: socket.id, active: false });
      const exitingPlayer = room.players[playerIndex];
      if (room.sheriffId === exitingPlayer.id) {
        room.sheriffId = null;
        io.to(rid).emit("systemMsg", "警長離開房間，警徽失效，本局不再有警長。", "action");
      }
      room.players.splice(playerIndex, 1);
      if (room.pendingSheriffId === exitingPlayer.id) resolveSheriffBadge(rid, null);
      
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
  socket.on("createRoom", ({ name, boardType, peerId, sheriffEnabled = false }) => {
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
      gameOver: false,
      players: [],
      presetId: isCustom ? null : boardType,
      customRoles: isCustom ? null : [...presetList],
      nightFlowKey: isCustom ? "default" : boardType,
      sheriffEnabled: !!sheriffEnabled,
      sheriffId: null,
      sheriffElectionDone: !sheriffEnabled,
      sheriffCandidateIds: [],
      sheriffVotingCandidateIds: [],
      sheriffVotes: {},
      sheriffSpeechOrder: [],
      sheriffSpeechIndex: 0,
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
    if (["SHERIFF_SIGNUP", "SHERIFF_VOTE", "SHERIFF_RUNOFF_VOTE"].includes(room.phase)) return;
    if (
      ["SHERIFF_SPEECH", "SHERIFF_RUNOFF_SPEECH"].includes(room.phase) &&
      room.sheriffSpeechOrder?.[room.sheriffSpeechIndex] !== socket.id
    ) return;
    if (room.phase === "SHERIFF_HANDOFF" && room.pendingSheriffId !== socket.id) return;
    if (room.gameOver) {
      io.to(id).emit("peerSpeaking", { id: socket.id, active: isActive });
      return;
    }
    const nightPhase = String(room.phase || "").startsWith("NIGHT_");
    if (nightPhase) {
      if (room.phase !== "NIGHT_WOLF") return;
      const isWolf = ["wolf", "wolfking", "whitewolfking"].includes(speaker.role);
      if (!isWolf || (isActive && !speaker.alive)) return;
      room.players
        .filter((p) => ["wolf", "wolfking", "whitewolfking"].includes(p.role))
        .forEach((p) => io.to(p.id).emit("peerSpeaking", { id: socket.id, active: isActive }));
      return;
    }
    if (room.phase === "DAY") {
      const isLastWords = room.daySubPhase === "lastWords";
      if (isLastWords && room.lastWordsPlayerId !== socket.id) return;
      if (!isLastWords && !speaker.alive) return;
      if (
        speaker.alive &&
        room.daySubPhase === "speech" &&
        room.currentSpeechId !== socket.id
      ) {
        return;
      }
    } else if (!speaker.alive) {
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

  socket.on("setSheriffCandidate", ({ roomId, running }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    const player = room && room.players.find((entry) => entry.id === socket.id);
    if (!room || !room.sheriffEnabled || room.phase !== "SHERIFF_SIGNUP" || !player || !player.alive) return;
    const candidates = new Set(room.sheriffCandidateIds || []);
    if (running) candidates.add(socket.id);
    else candidates.delete(socket.id);
    room.sheriffCandidateIds = [...candidates];
    broadcastRoomUpdate(id);
  });

  socket.on("startSheriffSpeeches", (roomId) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    if (!room || room.host !== socket.id || room.phase !== "SHERIFF_SIGNUP") return;
    if (!(room.sheriffCandidateIds || []).length) {
      io.to(id).emit("systemMsg", "目前沒有人上警，直接進入警長競選投票。", "action");
      finishSheriffElection(id, null);
      return;
    }
    startSheriffSpeeches(id, false);
  });

  socket.on("withdrawSheriff", (roomId) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    if (!room || !["SHERIFF_SIGNUP", "SHERIFF_SPEECH", "SHERIFF_RUNOFF_SPEECH"].includes(room.phase)) return;
    const candidates = room.phase === "SHERIFF_RUNOFF_SPEECH" ? room.sheriffVotingCandidateIds : room.sheriffCandidateIds;
    if (!candidates.includes(socket.id)) return;
    const currentId = room.sheriffSpeechOrder && room.sheriffSpeechOrder[room.sheriffSpeechIndex];
    room.sheriffCandidateIds = (room.sheriffCandidateIds || []).filter((id) => id !== socket.id);
    room.sheriffVotingCandidateIds = (room.sheriffVotingCandidateIds || []).filter((id) => id !== socket.id);
    const remainingCandidates = room.phase === "SHERIFF_RUNOFF_SPEECH" ? room.sheriffVotingCandidateIds : room.sheriffCandidateIds;
    if (!remainingCandidates.length) {
      finishSheriffElection(id, null);
      return;
    }
    if (room.sheriffSpeechOrder) {
      const oldIndex = room.sheriffSpeechOrder.indexOf(socket.id);
      room.sheriffSpeechOrder = room.sheriffSpeechOrder.filter((id) => id !== socket.id);
      if (oldIndex >= 0 && oldIndex < room.sheriffSpeechIndex) room.sheriffSpeechIndex--;
      else if (currentId === socket.id) {
        if (room.sheriffSpeechIndex >= room.sheriffSpeechOrder.length) {
          startSheriffVote(id, room.phase === "SHERIFF_RUNOFF_SPEECH");
          return;
        }
      }
    }
    const withdrawingPlayer = room.players.find((player) => player.id === socket.id);
    io.to(id).emit("systemMsg", `${withdrawingPlayer ? withdrawingPlayer.name : "玩家"} 退水。`);
    if (room.phase === "SHERIFF_SIGNUP" && !room.sheriffCandidateIds.length) {
      broadcastRoomUpdate(id);
      return;
    }
    broadcastRoomUpdate(id);
  });

  socket.on("nextSheriffSpeech", (roomId) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    if (!room || !["SHERIFF_SPEECH", "SHERIFF_RUNOFF_SPEECH"].includes(room.phase)) return;
    const currentId = room.sheriffSpeechOrder && room.sheriffSpeechOrder[room.sheriffSpeechIndex];
    if (room.host !== socket.id && currentId !== socket.id) return;
    advanceSheriffSpeech(id);
  });

  socket.on("castSheriffVote", ({ roomId, targetId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    if (!room || !["SHERIFF_VOTE", "SHERIFF_RUNOFF_VOTE"].includes(room.phase)) return;
    if (!(room.sheriffEligibleVoterIds || []).includes(socket.id)) return;
    if (targetId && !room.sheriffVotingCandidateIds.includes(targetId)) return;
    room.sheriffVotes[socket.id] = targetId || null;
    const submitted = Object.keys(room.sheriffVotes).length;
    io.to(id).emit("sheriffVoteUpdate", { count: submitted, total: room.sheriffEligibleVoterIds.length });
    broadcastRoomUpdate(id);
    if (submitted >= room.sheriffEligibleVoterIds.length) finishSheriffVote(id);
  });

  socket.on("finishSheriffVote", (roomId) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    if (!room || room.host !== socket.id) return;
    finishSheriffVote(id);
  });

  socket.on("sheriffBadgeAction", ({ roomId, targetId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    if (!room || room.phase !== "SHERIFF_HANDOFF" || room.pendingSheriffId !== socket.id) return;
    if (targetId && !room.players.some((player) => player.id === targetId && player.alive)) return;
    resolveSheriffBadge(id, targetId || null);
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
    room.gameOver = false;
    delete room.gameWinner;
    room.lastGuardTarget = null;
    room.guardActionDone = false;
    delete room.pendingLastWordsPlayerId;
    room.sheriffId = null;
    room.sheriffElectionDone = !room.sheriffEnabled;
    room.sheriffCandidateIds = [];
    room.sheriffVotingCandidateIds = [];
    room.sheriffVotes = {};
    delete room.skipDayAfterWolfExplode;
    room.sheriffSpeechOrder = [];
    room.sheriffSpeechIndex = 0;
    delete room.pendingSheriffId;
    delete room.sheriffHandoffCallback;

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
    delete room.pendingNightAfterShot;
    room.firstNightDaybreak = false;
    delete room.lastWordsContinueDay;
    room.guardActionDone = false;

    startNightFlow(id);
  });

  socket.on("returnToLobby", (roomId) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    if (!room || room.host !== socket.id || !room.gameOver) return;

    room.phase = "WAIT";
    room.gameOver = false;
    delete room.gameWinner;
    room.players.forEach((p) => {
      p.role = null;
      p.alive = true;
      p.deathReason = null;
      delete p.hasAntidote;
      delete p.hasPoison;
      delete p.knightSkillUsed;
      delete p.knightRevealed;
    });
    delete room.pendingNightAfterShot;
    delete room.lastGuardTarget;
    delete room.pendingLastWordsPlayerId;
    room.sheriffId = null;
    room.sheriffElectionDone = !room.sheriffEnabled;
    room.sheriffCandidateIds = [];
    room.sheriffVotingCandidateIds = [];
    room.sheriffVotes = {};
    delete room.skipDayAfterWolfExplode;
    room.sheriffSpeechOrder = [];
    room.sheriffSpeechIndex = 0;
    delete room.pendingSheriffId;
    delete room.sheriffHandoffCallback;
    clearDaySpeech(room);
    pkPlayers[id] = [];
    votes[id] = {};
    delete nightData[id];
    broadcastRoomUpdate(id);
    io.to(id).emit("systemMsg", "房長已返回房間大廳，可以重新開始遊戲。");
  });

  socket.on("guardAction", ({ roomId, targetId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    const data = id && nightData[id];
    const guard = room && room.players.find((p) => p.id === socket.id);
    if (!room || room.phase !== "NIGHT_GUARD" || !data) {
      socket.emit("actionError", "現在不是守衛守護階段。");
      return;
    }
    if (!guard || !guard.alive || guard.role !== "guard") {
      socket.emit("actionError", "只有存活的守衛可以選擇守護目標。");
      return;
    }
    if (room.guardActionDone) {
      socket.emit("actionError", "你今晚已經選擇守護目標。");
      return;
    }
    const target = targetId ? room.players.find((p) => p.id === targetId) : null;
    if (targetId && (!target || !target.alive)) {
      socket.emit("actionError", "請選擇一位存活玩家，或選擇不守護。");
      return;
    }
    if (targetId && targetId === room.lastGuardTarget) {
      socket.emit("actionError", "守衛不能連續兩晚守護同一位玩家。");
      return;
    }
    data.protected = targetId || null;
    room.lastGuardTarget = targetId || null;
    room.guardActionDone = true;
    socket.emit("guardActionLocked", target ? `今晚守護：${target.name}` : "今晚不選擇守護目標。");
    broadcastRoomUpdate(id);
  });

  socket.on("wolfKill", ({ roomId, targetId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = rooms[id];
    if (!room || !nightData[id] || room.phase !== "NIGHT_WOLF") return;
    const killer = room.players.find((p) => p.id === socket.id);
    const target = room.players.find((p) => p.id === targetId);
    if (!killer || !killer.alive || !["wolf", "wolfking", "whitewolfking"].includes(killer.role)) {
      socket.emit("actionError", "只有存活的狼人可以在狼人階段擊殺。");
      return;
    }
    if (!target || !target.alive || target.id === killer.id) {
      socket.emit("actionError", "請選擇一位存活的其他玩家。");
      return;
    }
    if (["wolf", "wolfking", "whitewolfking"].includes(target.role)) {
      socket.emit("actionError", "狼人不能選擇狼人隊友作為擊殺目標。");
      return;
    }

    const lockedId = nightData[id].killed || targetId;
    if (!nightData[id].killed) nightData[id].killed = targetId;
    const lockedTarget = room.players.find((p) => p.id === lockedId);
    const message = `狼人刀已鎖定：${lockedTarget ? lockedTarget.name : "未知"}`;
    room.players
      .filter((p) => ["wolf", "wolfking", "whitewolfking"].includes(p.role))
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
    if (!nightData[id] || nightData[id].seerUsed) {
      socket.emit("actionError", "你今晚已經查驗過了。");
      return;
    }
    if (!target || !target.alive || target.id === seer.id) {
      socket.emit("actionError", "請選擇一位存活的其他玩家。");
      return;
    }
    nightData[id].seerUsed = true;
    socket.emit("seerResult", ["wolf", "wolfking", "whitewolfking"].includes(target.role), target.id);
    broadcastRoomUpdate(id);
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
      const finishShot = () => {
        io.to(id).emit("skillProcessing", false);
        const pendingNightAfterShot = !!room.pendingNightAfterShot;
        room.pendingNightAfterShot = false;
        const lastWordsPlayerId = room.pendingLastWordsPlayerId;
        delete room.pendingLastWordsPlayerId;
        broadcastRoomUpdate(id);
        if (checkGameOver(id)) return;
        if (pendingNightAfterShot) enterNight(id);
        else if (lastWordsPlayerId) {
          const lastWordsPlayer = room.players.find((p) => p.id === lastWordsPlayerId);
          if (lastWordsPlayer) startLastWords(room, id, lastWordsPlayer);
        }
      };
      beginSheriffHandoff(room, id, target, finishShot);
    }
  });

  socket.on("whiteWolfKingExplode", ({ roomId, targetId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    const sheriffElectionPhase = room && ["SHERIFF_SIGNUP", "SHERIFF_SPEECH", "SHERIFF_VOTE", "SHERIFF_RUNOFF_SPEECH", "SHERIFF_RUNOFF_VOTE"].includes(room.phase);
    if (!room || (!sheriffElectionPhase && !(room.phase === "DAY" && room.daySubPhase === "speech"))) return;
    const whiteWolfKing = room.players.find((p) => p.id === socket.id);
    const target = room.players.find((p) => p.id === targetId);
    if (!whiteWolfKing || !whiteWolfKing.alive || whiteWolfKing.role !== "whitewolfking") {
      socket.emit("actionError", "只有存活的白狼王可以白天自爆。");
      return;
    }
    if (!target || !target.alive || target.id === whiteWolfKing.id) {
      socket.emit("actionError", "請選擇一位存活的其他玩家作為帶走目標。");
      return;
    }

    whiteWolfKing.alive = false;
    whiteWolfKing.deathReason = "whiteWolfKingExplode";
    target.alive = false;
    target.deathReason = "whiteWolfKingShot";
    clearRoomTimers(id);
    clearDaySpeech(room);
    votes[id] = {};
    pkPlayers[id] = [];
    if (sheriffElectionPhase) {
      room.sheriffElectionDone = true;
      room.sheriffId = null;
      room.sheriffCandidateIds = [];
      room.sheriffVotingCandidateIds = [];
      room.sheriffVotes = {};
      room.skipDayAfterWolfExplode = true;
      room.phase = "NIGHT_TRANSITION";
      io.to(id).emit("systemMsg", `💥 白狼王 ${whiteWolfKing.name} 在警長競選時自爆，帶走了 ${target.name}！競選中止、警徽流失。`);
    }
    if (!sheriffElectionPhase) io.to(id).emit("systemMsg", `💥 白狼王 ${whiteWolfKing.name} 自爆，帶走了 ${target.name}！`);
    broadcastRoomUpdate(id);
    const finishExplosion = () => {
      if (target.role === "hunter") {
        room.pendingNightAfterShot = true;
        delete room.skipDayAfterWolfExplode;
        io.to(id).emit("skillProcessing", true);
        io.to(target.id).emit("hunterCanShoot", true);
        return;
      }
      if (sheriffElectionPhase) {
        processDaybreak(id);
        return;
      }
      if (!checkGameOver(id)) startNightFlow(id);
    };
    const deadSheriff = !sheriffElectionPhase && (room.sheriffId === whiteWolfKing.id ? whiteWolfKing : room.sheriffId === target.id ? target : null);
    if (deadSheriff) beginSheriffHandoff(room, id, deadSheriff, finishExplosion);
    else finishExplosion();
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

    const isWolf = ["wolf", "wolfking", "whitewolfking"].includes(target.role);

    if (isWolf) {
      target.alive = false;
      target.deathReason = "knightCharge";
      io.to(id).emit(
        "systemMsg",
        `⚔️ ${knight.name} 騎士翻牌衝撞 ${target.name}！狼人陣營出局，天黑。`
      );
      broadcastRoomUpdate(id);
      const finishCharge = () => {
        if (target.role === "wolfking") {
          if (checkGameOver(id)) return;
          room.pendingNightAfterShot = true;
          io.to(id).emit("skillProcessing", true);
          io.to(target.id).emit("hunterCanShoot", true);
          return;
        }
        if (!checkGameOver(id)) enterNight(id);
      };
      beginSheriffHandoff(room, id, target, finishCharge);
    } else {
      knight.alive = false;
      knight.deathReason = "knightChargeFail";
      io.to(id).emit(
        "systemMsg",
        `⚔️ ${knight.name} 騎士翻牌衝撞 ${target.name}！撞錯好人，騎士出局，遊戲繼續。`
      );
      broadcastRoomUpdate(id);
      beginSheriffHandoff(room, id, knight, () => {
        if (!checkGameOver(id)) advanceSpeechAfterDayDeath(room, id);
      });
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
      room.dayVoteFinalized = false;
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

  socket.on("finishLastWords", ({ roomId }) => {
    const id = roomId && String(roomId).toUpperCase();
    const room = id && rooms[id];
    if (!room || room.phase !== "DAY" || room.daySubPhase !== "lastWords") return;
    if (room.host !== socket.id && room.lastWordsPlayerId !== socket.id) return;
    finishLastWords(id);
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
    socket.emit("witchActionLocked", "解藥已使用，狼刀與守衛守護效果將於天亮時結算。");
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
    if (room && room.phase === "DAY" && room.daySubPhase === "vote" && !room.dayVoteFinalized) {
      const voter = room.players.find((player) => player.id === socket.id);
      const pk = pkPlayers[id] || [];
      const target = targetId ? room.players.find((player) => player.id === targetId) : null;
      if (!voter || !voter.alive || pk.includes(voter.id)) return;
      if (targetId && (!target || !target.alive || (pk.length > 0 && !pk.includes(target.id)))) return;
      if (!votes[id]) votes[id] = {};
      if (Object.prototype.hasOwnProperty.call(votes[id], socket.id)) return;
      votes[id][socket.id] = targetId || null;
      const voteCount = Object.keys(votes[id]).length;
      const totalEligible = room.players.filter(p => p.alive && !pk.includes(p.id)).length;
      io.to(id).emit("voteUpdate", { count: voteCount, total: totalEligible });
      io.to(id).emit("systemMsg", (targetId ? "一名玩家已投票" : "一名玩家已棄票") + " (" + voteCount + "/" + totalEligible + ")");
      broadcastRoomUpdate(id);
    }
  });

  socket.on("finishVote", (roomId) => {
    const id = roomId.toUpperCase();
    const room = rooms[id];
    const currentVotes = votes[id] || {};
    if (!room || room.host !== socket.id || room.dayVoteFinalized) return;
    if (room.daySubPhase !== "vote") {
      return io.to(id).emit("systemMsg", "請先完成發言階段再結算投票。");
    }
    room.dayVoteFinalized = true;
    broadcastRoomUpdate(id);

    const finalVoteDetail = Object.entries(currentVotes).map(([voterId, tId]) => {
      const voter = room.players.find(p => p.id === voterId);
      const target = room.players.find(p => p.id === tId);
      return {
        voterName: voter ? voter.name : "未知",
        targetName: tId ? (target ? target.name : "未知") : "棄票",
        weight: voter && voter.id === room.sheriffId ? 1.5 : 1,
      };
    });

    io.to(id).emit("showFinalVotes", finalVoteDetail);

    const countedVotes = Object.entries(currentVotes).filter(([, targetId]) => !!targetId);
    if (countedVotes.length === 0) {
        io.to(id).emit("systemMsg", Object.keys(currentVotes).length ? "全體棄票，無人出局，直接進入夜晚。" : "無人投票，直接進入夜晚。");
        enterNight(id);
        return;
    }

    const tally = {};
    countedVotes.forEach(([voterId, targetId]) => {
      const voter = room.players.find((player) => player.id === voterId);
      const weight = voter && voter.id === room.sheriffId ? 1.5 : 1;
      tally[targetId] = (tally[targetId] || 0) + weight;
    });

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
            const continueExpulsion = () => {
              if (target.role === 'hunter' || target.role === 'wolfking') {
                  room.pendingLastWordsPlayerId = target.id;
                  io.to(id).emit("skillProcessing", true);
                  io.to(target.id).emit("hunterCanShoot", true);
                  return;
              }
              startLastWords(room, id, target);
            };
            beginSheriffHandoff(room, id, target, continueExpulsion);
            return;
        }
        enterNight(id);
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
