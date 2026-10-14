/** 預設板角色清單（與原本 server startGame 一致） */
const PRESET_ROLES = {
  "5": ["wolf", "seer", "witch", "hunter", "villager"],
  "9": [
    "wolf",
    "wolf",
    "wolfking",
    "seer",
    "witch",
    "hunter",
    "villager",
    "villager",
    "villager",
  ],
  "10": [
    "wolf",
    "wolf",
    "seer",
    "witch",
    "villager",
    "villager",
    "villager",
    "villager",
    "villager",
    "villager",
  ],
  "12_whitewolf_guard": [
    "wolf", "wolf", "wolf", "whitewolfking",
    "seer", "witch", "hunter", "guard",
    "villager", "villager", "villager", "villager",
  ],
  "12_standard": [
    "wolf",
    "wolf",
    "wolf",
    "wolfking",
    "seer",
    "witch",
    "hunter",
    "idiot",
    "villager",
    "villager",
    "villager",
    "villager",
  ],
  "12_knight": [
    "wolf",
    "wolf",
    "wolf",
    "wolf",
    "seer",
    "witch",
    "hunter",
    "knight",
    "villager",
    "villager",
    "villager",
    "villager",
  ],
};

const ALLOWED_ROLES = new Set([
  "wolf",
  "wolfking",
  "whitewolfking",
  "seer",
  "witch",
  "hunter",
  "villager",
  "idiot",
  "knight",
  "guard",
]);

const MAX_ROLES = 24;

function validateRoleList(roles) {
  if (!Array.isArray(roles)) {
    return { ok: false, msg: "角色必須為陣列" };
  }
  if (roles.length > MAX_ROLES) {
    return { ok: false, msg: `角色數不可超過 ${MAX_ROLES}` };
  }
  for (const r of roles) {
    if (typeof r !== "string" || !ALLOWED_ROLES.has(r)) {
      return { ok: false, msg: `不支援的角色：${r}` };
    }
  }
  return { ok: true };
}

/** 開局用：有自訂清單用清單，否則用預設板 */
function resolvedRolesList(room) {
  if (room.customRoles && room.customRoles.length > 0) {
    return room.customRoles.slice();
  }
  if (room.presetId && PRESET_ROLES[room.presetId]) {
    return PRESET_ROLES[room.presetId].slice();
  }
  return null;
}

function effectiveConfigRoleCount(room) {
  const list = resolvedRolesList(room);
  return list ? list.length : 0;
}

function attachVoicePolicy(payload, room, socketId) {
  const player = room.players.find((p) => p.id === socketId);
  const isWolf = player && ["wolf", "wolfking", "whitewolfking"].includes(player.role);
  const wolfPhase = room.phase === "NIGHT_WOLF";
  const nightPhase = String(room.phase || "").startsWith("NIGHT_");
  const gameOver = !!room.gameOver;
  const daySpeechPhase = room.phase === "DAY" && room.daySubPhase === "speech";
  const lastWordsPhase = room.phase === "DAY" && room.daySubPhase === "lastWords";
  const isLastWordsSpeaker = !!(player && player.id === room.lastWordsPlayerId);
  const isCurrentSpeaker = !!(player && player.alive && room.currentSpeechId === socketId);
  payload.canSpeak = gameOver
    ? true
    : nightPhase
      ? !!(wolfPhase && isWolf && player.alive)
      : room.phase === "DAY"
        ? lastWordsPhase
          ? isLastWordsSpeaker
          : player && player.alive && (!daySpeechPhase || isCurrentSpeaker)
        : !!(player && player.alive);
  const canJoinWolfConversation = !!(wolfPhase && isWolf && player.alive);
  payload.voicePeerIds = gameOver
    ? room.players.filter((p) => p.id !== socketId).map((p) => p.peerId).filter(Boolean)
    : nightPhase
    ? canJoinWolfConversation
      ? room.players
          .filter((p) => p.id !== socketId && p.alive && ["wolf", "wolfking", "whitewolfking"].includes(p.role))
          .map((p) => p.peerId)
          .filter(Boolean)
      : []
    : room.players.filter((p) => p.id !== socketId).map((p) => p.peerId).filter(Boolean);
  payload.visibleSpeakingIds = gameOver
    ? room.players.map((p) => p.id)
    : nightPhase
    ? canJoinWolfConversation
      ? room.players
          .filter((p) => p.alive && ["wolf", "wolfking", "whitewolfking"].includes(p.role))
          .map((p) => p.id)
      : []
    : room.players.map((p) => p.id);
  payload.wolfTeamIds = wolfPhase && isWolf && player.alive
    ? room.players
        .filter((p) => p.id !== socketId && p.alive && ["wolf", "wolfking", "whitewolfking"].includes(p.role))
        .map((p) => p.id)
    : [];
  payload.players = room.players.map((p) => {
    const { peerId: _peerId, role: _role, ...publicPlayer } = p;
    return p.id === socketId || gameOver ? { ...publicPlayer, role: p.role } : publicPlayer;
  });
  payload.gameOver = gameOver;
  payload.guardActionDone = !!(
    player && player.role === "guard" && player.alive && room.guardActionDone
  );
  if (gameOver) payload.gameWinner = room.gameWinner;
  return payload;
}

function roomPayloadForSocket(room, socketId) {
  const count = effectiveConfigRoleCount(room);
  const configReady =
    count === room.players.length && room.players.length > 0;
  const isHost = room.host === socketId;
  const {
    nightPhaseInterval: _nightPhaseInterval,
    enterNightTimeout: _enterNightTimeout,
    execVoteTimeout: _execVoteTimeout,
    gameOverResetTimeout: _gameOverResetTimeout,
    lastGuardTarget: _lastGuardTarget,
    pendingLastWordsPlayerId: _pendingLastWordsPlayerId,
    ...clientRoom
  } = room;
  if (room.phase !== "WAIT" || isHost) {
    const out = { ...clientRoom, configReady };
    if (room.phase === "DAY") {
      out.daySubPhase = room.daySubPhase;
      out.speechIndex = room.speechIndex;
      out.speechOrder = room.speechOrder ? [...room.speechOrder] : [];
      out.currentSpeechId = room.currentSpeechId ?? null;
    }
    return attachVoicePolicy(out, room, socketId);
  }
  const { customRoles: _omit, ...rest } = clientRoom;
  return attachVoicePolicy({
    ...rest,
    configRoleCount: count,
    configReady,
  }, room, socketId);
}

module.exports = {
  PRESET_ROLES,
  ALLOWED_ROLES,
  validateRoleList,
  resolvedRolesList,
  effectiveConfigRoleCount,
  roomPayloadForSocket,
};
