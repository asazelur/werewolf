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
  "seer",
  "witch",
  "hunter",
  "villager",
  "idiot",
  "knight",
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
  const isWolf = player && ["wolf", "wolfking"].includes(player.role);
  const wolfPhase = room.phase === "NIGHT_WOLF";
  const nightPhase = String(room.phase || "").startsWith("NIGHT_");
  payload.canSpeak = !nightPhase || !!(wolfPhase && isWolf && player.alive);
  const canJoinWolfConversation = !!(wolfPhase && isWolf && player.alive);
  payload.voicePeerIds = nightPhase
    ? canJoinWolfConversation
      ? room.players
          .filter((p) => p.id !== socketId && p.alive && ["wolf", "wolfking"].includes(p.role))
          .map((p) => p.peerId)
          .filter(Boolean)
      : []
    : room.players.filter((p) => p.id !== socketId).map((p) => p.peerId).filter(Boolean);
  payload.visibleSpeakingIds = nightPhase
    ? canJoinWolfConversation
      ? room.players
          .filter((p) => p.alive && ["wolf", "wolfking"].includes(p.role))
          .map((p) => p.id)
      : []
    : room.players.map((p) => p.id);
  payload.wolfTeamIds = wolfPhase && isWolf && player.alive
    ? room.players
        .filter((p) => p.id !== socketId && p.alive && ["wolf", "wolfking"].includes(p.role))
        .map((p) => p.id)
    : [];
  payload.players = room.players.map((p) => {
    const { peerId: _peerId, role: _role, ...publicPlayer } = p;
    return p.id === socketId ? { ...publicPlayer, role: p.role } : publicPlayer;
  });
  return payload;
}

function roomPayloadForSocket(room, socketId) {
  const count = effectiveConfigRoleCount(room);
  const configReady =
    count === room.players.length && room.players.length > 0;
  const isHost = room.host === socketId;
  if (room.phase !== "WAIT" || isHost) {
    const out = { ...room, configReady };
    if (room.phase === "DAY") {
      out.daySubPhase = room.daySubPhase;
      out.speechIndex = room.speechIndex;
      out.speechOrder = room.speechOrder ? [...room.speechOrder] : [];
      out.currentSpeechId = room.currentSpeechId ?? null;
    }
    return attachVoicePolicy(out, room, socketId);
  }
  const { customRoles: _omit, ...rest } = room;
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
