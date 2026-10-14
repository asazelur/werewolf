/**
 * 依 boardType 決定夜晚階段順序、秒數、系統訊息，以及進入夜晚／處決後延遲。
 * 修改此檔即可調整各板子 flow，無需改動核心邏輯。
 *
 * nightSteps 每一項：
 * - phase: 須與前端 public/index.html 辨識的 phase 一致
 * - seconds: 倒數秒數
 * - systemMsg: 該階段提示（可省略，由伺服器用 phase 預設字）
 * - sendWitchKnowledge: 若為 true，進入此步時對存活女巫發狼刀資訊（僅 NIGHT_WITCH 有意義）
 * - skipIfNoRole: 若設定為角色字串（如 "witch"），房內無存活該角色則略過此步（秒數 0）
 */

const STANDARD_NIGHT = [
  { phase: "NIGHT_GUARD", seconds: 10, systemMsg: "守衛請守護一位玩家", skipIfNoRole: "guard" },
  { phase: "NIGHT_WOLF", seconds: 12, systemMsg: "狼人請殺人" },
  { phase: "NIGHT_SEER", seconds: 10, systemMsg: "預言家請驗人" },
  {
    phase: "NIGHT_WITCH",
    seconds: 10,
    systemMsg: "女巫請用藥",
    sendWitchKnowledge: true,
  },
];

const DEFAULT_FLOW = {
  enterNightDelayMs: 4000,
  lastWordsSeconds: 30,
  nightSteps: STANDARD_NIGHT,
};

/** 只寫與 DEFAULT_FLOW 不同的欄位；未列出的 boardType 使用 DEFAULT_FLOW */
const BOARD_OVERRIDES = {
  "5": {
    enterNightDelayMs: 3000,
    nightSteps: [
      { phase: "NIGHT_GUARD", seconds: 8, systemMsg: "守衛請守護一位玩家", skipIfNoRole: "guard" },
      { phase: "NIGHT_WOLF", seconds: 8, systemMsg: "【5人測試】狼人請殺人" },
      { phase: "NIGHT_SEER", seconds: 8, systemMsg: "預言家請驗人" },
      {
        phase: "NIGHT_WITCH",
        seconds: 8,
        systemMsg: "女巫請用藥",
        sendWitchKnowledge: true,
      },
    ],
  },
  "10": {
    nightSteps: [
      { phase: "NIGHT_GUARD", seconds: 10, systemMsg: "守衛請守護一位玩家", skipIfNoRole: "guard" },
      { phase: "NIGHT_WOLF", seconds: 10, systemMsg: "【10人】狼人請殺人" },
      { phase: "NIGHT_SEER", seconds: 10, systemMsg: "預言家請驗人" },
      {
        phase: "NIGHT_WITCH",
        seconds: 10,
        systemMsg: "女巫請用藥",
        sendWitchKnowledge: true,
      },
    ],
  },
  "12_whitewolf_guard": {
    enterNightDelayMs: 5000,
    nightSteps: [
      { phase: "NIGHT_GUARD", seconds: 10, systemMsg: "守衛請守護一位玩家", skipIfNoRole: "guard" },
      { phase: "NIGHT_WOLF", seconds: 15, systemMsg: "狼人請殺人" },
      { phase: "NIGHT_SEER", seconds: 12, systemMsg: "預言家請驗人" },
      { phase: "NIGHT_WITCH", seconds: 12, systemMsg: "女巫請用藥", sendWitchKnowledge: true },
    ],
  },
  "12_standard": {
    enterNightDelayMs: 5000,
    nightSteps: [
      { phase: "NIGHT_GUARD", seconds: 10, systemMsg: "守衛請守護一位玩家", skipIfNoRole: "guard" },
      { phase: "NIGHT_WOLF", seconds: 15, systemMsg: "狼人請殺人" },
      { phase: "NIGHT_SEER", seconds: 12, systemMsg: "預言家請驗人" },
      {
        phase: "NIGHT_WITCH",
        seconds: 12,
        systemMsg: "女巫請用藥",
        sendWitchKnowledge: true,
      },
    ],
  },
  "12_knight": {
    enterNightDelayMs: 4000,
    nightSteps: [
      { phase: "NIGHT_GUARD", seconds: 10, systemMsg: "守衛請守護一位玩家", skipIfNoRole: "guard" },
      { phase: "NIGHT_WOLF", seconds: 14, systemMsg: "狼人請殺人" },
      { phase: "NIGHT_SEER", seconds: 10, systemMsg: "預言家請驗人" },
      {
        phase: "NIGHT_WITCH",
        seconds: 10,
        systemMsg: "女巫請用藥",
        sendWitchKnowledge: true,
      },
    ],
  },
};

const PHASE_DEFAULT_MSG = {
  NIGHT_GUARD: "守衛請守護一位玩家",
  NIGHT_WOLF: "狼人請殺人",
  NIGHT_SEER: "預言家請驗人",
  NIGHT_WITCH: "女巫請用藥",
};

function getBoardFlow(boardType) {
  const o = BOARD_OVERRIDES[boardType];
  if (!o) return { ...DEFAULT_FLOW, nightSteps: [...DEFAULT_FLOW.nightSteps] };
  return {
    enterNightDelayMs: o.enterNightDelayMs ?? DEFAULT_FLOW.enterNightDelayMs,
    lastWordsSeconds: o.lastWordsSeconds ?? DEFAULT_FLOW.lastWordsSeconds,
    nightSteps: o.nightSteps
      ? o.nightSteps.map((s) => ({ ...s }))
      : [...DEFAULT_FLOW.nightSteps],
  };
}

function phaseSystemMsg(phase, explicit) {
  if (explicit) return explicit;
  return PHASE_DEFAULT_MSG[phase] || phase;
}

module.exports = {
  getBoardFlow,
  phaseSystemMsg,
};
