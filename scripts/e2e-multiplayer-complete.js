/**
 * End-to-end multiplayer scenario with real Socket.IO clients:
 * sheriff election and runoff, all implemented role actions, first-night
 * last words, vote finalization, hunter shots, and white wolf king explosion.
 *
 * Run with: npm run test:e2e:multiplayer
 */
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const { io } = require("socket.io-client");

const ROOT = path.join(__dirname, "..");
const TIMEOUT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntil(predicate, label, timeoutMs = TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`等待逾時：${label}`);
}

function connectClient(url, label) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ["polling", "websocket"], reconnection: false, timeout: 5000 });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`連線逾時：${label}`));
    }, 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const port = Number(process.env.TEST_PORT) || await findFreePort();
  const url = `http://127.0.0.1:${port}`;
  let child;
  const clients = [];
  try {
    child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), WEREWOLF_E2E_FAST: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverOutput = "";
    let serverError = "";
    child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    child.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
    await waitUntil(() => serverOutput.includes("伺服器運行中"), "本機測試伺服器啟動");

    for (let index = 0; index < 14; index++) {
      clients.push(await connectClient(url, `玩家${index + 1}`));
    }
    const [host, ...joiners] = clients;
    const states = new Map();
    const shots = new Set();
    const seerResults = [];
    const seerErrors = [];
    const voteCounts = [];
    let witchKnowledge = null;
    clients.forEach((socket) => {
      socket.on("update", (room) => states.set(socket.id, room));
      socket.on("hunterCanShoot", () => shots.add(socket.id));
      socket.on("voteUpdate", ({ count }) => voteCounts.push(count));
    });

    const roomCreated = new Promise((resolve) => host.once("roomCreated", resolve));
    host.emit("createRoom", {
      name: "測試房主",
      boardType: "custom",
      peerId: "e2e-host",
      sheriffEnabled: true,
    });
    const roomId = await roomCreated;

    for (let index = 0; index < joiners.length; index++) {
      const socket = joiners[index];
      const requiredPlayers = index + 2;
      socket.emit("joinRoom", {
        roomId,
        name: `測試玩家${requiredPlayers}`,
        peerId: `e2e-player-${requiredPlayers}`,
      });
      await waitUntil(
        () => (states.get(host.id)?.players.length || 0) >= requiredPlayers,
        `第 ${requiredPlayers} 位玩家加入`,
      );
    }

    const roles = [
      "wolf", "wolf", "wolfking", "whitewolfking",
      "seer", "witch", "hunter", "guard", "knight", "idiot",
      "villager", "villager", "villager", "villager",
    ];
    host.emit("setGameConfig", { roomId, customRoles: roles, nightFlowKey: "5" });
    await waitUntil(() => states.get(host.id)?.configReady, "自訂角色配置");

    const assignedRoles = new Map();
    const roleReady = Promise.all(clients.map((socket) => new Promise((resolve) => {
      socket.once("role", (role) => {
        assignedRoles.set(socket.id, role);
        if (role === "seer") socket.on("seerResult", (isWolf, targetId) => seerResults.push({ isWolf, targetId }));
        if (role === "seer") socket.on("actionError", (message) => seerErrors.push(message));
        if (role === "witch") socket.on("witchKnowledge", (targetId) => { witchKnowledge = targetId; });
        resolve();
      });
    })));
    host.emit("startGame", roomId);
    await roleReady;

    const playerWithRole = (role, index = 0) => {
      const matching = clients.filter((socket) => assignedRoles.get(socket.id) === role);
      const socket = matching[index];
      if (!socket) throw new Error(`角色缺少：${role} #${index + 1}`);
      return socket;
    };
    const wolf = playerWithRole("wolf", 0);
    const otherWolf = playerWithRole("wolf", 1);
    const wolfking = playerWithRole("wolfking");
    const whitewolf = playerWithRole("whitewolfking");
    const seer = playerWithRole("seer");
    const witch = playerWithRole("witch");
    const hunter = playerWithRole("hunter");
    const guard = playerWithRole("guard");
    const knight = playerWithRole("knight");
    const idiot = playerWithRole("idiot");
    const villagers = clients.filter((socket) => assignedRoles.get(socket.id) === "villager");
    const room = () => states.get(host.id);
    const waitPhase = (phase, label = phase) =>
      waitUntil(() => room()?.phase === phase, label);
    const waitFor = (predicate, label) => waitUntil(() => predicate(room()), label);
    const finishSheriffSpeeches = async (expectedPhase) => {
      let safety = 0;
      while (room()?.phase === expectedPhase && safety++ < 10) {
        const oldIndex = room().sheriffSpeechIndex;
        host.emit("nextSheriffSpeech", roomId);
        await waitUntil(
          () => room()?.phase !== expectedPhase || room()?.sheriffSpeechIndex > oldIndex,
          "候選人發言推進",
        );
      }
    };
    const reachDayVote = async () => {
      let safety = 0;
      while (room()?.phase === "DAY" && room()?.daySubPhase === "speech" && safety++ < 25) {
        host.emit("nextSpeech", { roomId });
        await sleep(10);
      }
      await waitFor((state) => state?.phase === "DAY" && state?.daySubPhase === "vote", "白天投票階段");
    };

    expect(room()?.players.length === 14, "房間玩家數不符");
    expect(new Set(assignedRoles.values()).size === 10, "未抽到預期的全部職業種類");
    console.log("PASS 14 位 Socket.IO 玩家連線並取得 10 種職業");

    await waitPhase("NIGHT_GUARD", "第一夜守衛階段");
    guard.emit("guardAction", { roomId, targetId: villagers[1].id });
    await waitUntil(() => states.get(guard.id)?.guardActionDone, "守衛完成守護");
    await waitPhase("NIGHT_WOLF", "第一夜狼人階段");
    wolf.emit("wolfKill", { roomId, targetId: villagers[0].id });
    await waitPhase("NIGHT_SEER", "第一夜預言家階段");
    seer.emit("seerAction", { roomId, targetId: wolf.id });
    await waitUntil(() => seerResults.length === 1, "第一次預言家查驗");
    const duplicateCheck = new Promise((resolve) => seer.once("actionError", resolve));
    seer.emit("seerAction", { roomId, targetId: otherWolf.id });
    const duplicateError = await duplicateCheck;
    expect(duplicateError.includes("今晚已經查驗過"), "預言家每夜查驗限制未生效");
    expect(seerResults.length === 1, "同一晚預言家收到多次查驗結果");
    await waitPhase("NIGHT_WITCH", "第一夜女巫階段");
    witch.emit("witchPoison", { roomId, targetId: wolfking.id });
    await waitFor((state) => state?.phase === "SHERIFF_SIGNUP", "首夜後警長上警");
    expect(witchKnowledge === villagers[0].id, "女巫沒有收到正確的狼刀資訊");
    console.log("PASS 第一夜：守衛、狼人、預言家單次查驗、女巫毒藥");

    const sheriffA = villagers[2];
    const sheriffB = villagers[3];
    guard.emit("setSheriffCandidate", { roomId, running: true });
    sheriffA.emit("setSheriffCandidate", { roomId, running: true });
    sheriffB.emit("setSheriffCandidate", { roomId, running: true });
    await waitUntil(() => room()?.sheriffCandidateIds?.length === 3, "三人上警");
    guard.emit("setSheriffCandidate", { roomId, running: false });
    await waitUntil(() => room()?.sheriffCandidateIds?.length === 2, "候選人退水");
    host.emit("startSheriffSpeeches", roomId);
    await waitPhase("SHERIFF_SPEECH", "警上發言");
    await finishSheriffSpeeches("SHERIFF_SPEECH");
    await waitPhase("SHERIFF_VOTE", "警長投票");
    let sheriffVoters = clients.filter((socket) =>
      !room().sheriffVotingCandidateIds.includes(socket.id)
    );
    expect(sheriffVoters.length === 12, "警長投票資格人數錯誤");
    sheriffVoters.slice(0, 6).forEach((socket) =>
      socket.emit("castSheriffVote", { roomId, targetId: sheriffA.id })
    );
    sheriffVoters.slice(6).forEach((socket) =>
      socket.emit("castSheriffVote", { roomId, targetId: sheriffB.id })
    );
    await waitPhase("SHERIFF_RUNOFF_SPEECH", "警長平票後再次發言");
    await finishSheriffSpeeches("SHERIFF_RUNOFF_SPEECH");
    await waitPhase("SHERIFF_RUNOFF_VOTE", "警長平票重投");
    sheriffVoters = clients.filter((socket) =>
      !room().sheriffVotingCandidateIds.includes(socket.id)
    );
    sheriffVoters.forEach((socket) =>
      socket.emit("castSheriffVote", { roomId, targetId: sheriffA.id })
    );
    await waitFor((state) => state?.sheriffId === sheriffA.id, "警長當選");
    console.log("PASS 上警、退水、警上發言、平票重投與警長當選");

    await waitUntil(() => shots.has(wolfking.id), "狼王死亡後開槍");
    const wolfKingTarget = idiot;
    wolfking.emit("hunterAction", { roomId, targetId: wolfKingTarget.id });
    await waitFor(
      (state) => state?.phase === "DAY" && state?.daySubPhase === "lastWords" && state?.lastWordsPlayerId === villagers[0].id,
      "首夜狼刀死者的遺言",
    );
    expect(room().players.find((player) => player.id === villagers[0].id)?.alive === false, "首夜狼刀目標尚未死亡");
    expect(states.get(villagers[0].id)?.canSpeak === true, "首夜被狼刀的玩家沒有遺言發言權");
    expect(states.get(host.id)?.canSpeak === false, "首夜遺言時其他玩家仍可發言");
    villagers[0].emit("finishLastWords", { roomId });
    await waitUntil(() => room()?.phase === "DAY" && room()?.daySubPhase === "speech", "遺言後白天發言");
    console.log("PASS 狼王開槍與首夜狼刀死者遺言");

    while (room()?.daySubPhase === "speech" && room()?.currentSpeechId !== knight.id) {
      host.emit("nextSpeech", { roomId });
      await sleep(10);
    }
    expect(room()?.currentSpeechId === knight.id, "白天發言輪沒有輪到騎士");
    knight.emit("knightCharge", { roomId, targetId: wolf.id });
    await waitPhase("NIGHT_TRANSITION", "騎士撞中狼人後入夜");
    expect(room().players.find((player) => player.id === wolf.id)?.alive === false, "騎士沒有撞出狼人");
    console.log("PASS 騎士白天撞中狼人並推進入夜");

    await waitPhase("NIGHT_GUARD", "第二夜守衛階段");
    guard.emit("guardAction", { roomId, targetId: villagers[2].id });
    await waitUntil(() => states.get(guard.id)?.guardActionDone, "第二夜守衛完成守護");
    await waitPhase("NIGHT_WOLF", "第二夜狼人階段");
    otherWolf.emit("wolfKill", { roomId, targetId: villagers[1].id });
    await waitPhase("NIGHT_SEER", "第二夜預言家階段");
    const resultCountBeforeNightTwo = seerResults.length;
    seer.emit("seerAction", { roomId, targetId: whitewolf.id });
    await waitUntil(() => seerResults.length === resultCountBeforeNightTwo + 1, "第二夜預言家再次查驗");
    await waitPhase("NIGHT_WITCH", "第二夜女巫階段");
    const savedNotice = new Promise((resolve) => witch.once("witchActionLocked", resolve));
    witch.emit("witchSave", { roomId });
    await savedNotice;
    await waitPhase("DAY", "第二夜天亮");
    expect(room().players.find((player) => player.id === villagers[1].id)?.alive, "女巫救人後狼刀目標仍死亡");
    expect(room().players.find((player) => player.id === villagers[2].id)?.alive, "守衛守護目標意外死亡");
    expect(seerResults.length === 2, "預言家每晚使用一次的限制沒有在新夜晚重置");
    console.log("PASS 第二夜：預言家次夜重置、女巫救人與守衛防刀");

    await reachDayVote();
    expect(
      clients.every((socket) => states.get(socket.id)?.canSpeak === false),
      "白天投票期間有玩家仍能發言",
    );
    const firstVoter = clients.find((socket) =>
      socket.id !== hunter.id && room().players.some((player) => player.id === socket.id && player.alive)
    );
    expect(firstVoter, "找不到存活玩家作為投票者");
    firstVoter.emit("castVote", { roomId, targetId: hunter.id });
    await waitUntil(() => voteCounts.length > 0, "收到獵人出局票");
    host.emit("finishVote", roomId);
    await waitFor((state) => state?.dayVoteFinalized === true, "房主結算後鎖票");
    const finalizedCount = voteCounts[voteCounts.length - 1];
    const lateVoter = clients.find((socket) =>
      socket.id !== hunter.id && socket.id !== firstVoter.id &&
      room().players.some((player) => player.id === socket.id && player.alive)
    );
    if (lateVoter) {
      lateVoter.emit("castVote", { roomId, targetId: hunter.id });
      await sleep(30);
      expect(voteCounts[voteCounts.length - 1] === finalizedCount, "房主結算後仍接受遲到投票");
    }
    await waitUntil(() => shots.has(hunter.id), "不等待全員投票即觸發獵人開槍");
    hunter.emit("hunterAction", { roomId, targetId: otherWolf.id });
    await waitFor(
      (state) => state?.phase === "DAY" && state?.daySubPhase === "lastWords" && state?.lastWordsPlayerId === hunter.id,
      "獵人遺言",
    );
    expect(room().players.find((player) => player.id === otherWolf.id)?.alive === false, "獵人沒有帶走狼人");
    hunter.emit("finishLastWords", { roomId });
    await waitPhase("NIGHT_GUARD", "獵人遺言後進入夜晚");
    console.log("PASS 房主提早結算鎖票、獵人立即開槍與獵人遺言");

    guard.emit("guardAction", { roomId, targetId: villagers[3].id });
    await waitUntil(() => states.get(guard.id)?.guardActionDone, "第三夜守衛完成守護");
    await waitPhase("NIGHT_WOLF", "第三夜狼人階段");
    whitewolf.emit("wolfKill", { roomId, targetId: villagers[1].id });
    await waitPhase("NIGHT_SEER", "第三夜預言家階段");
    seer.emit("seerAction", { roomId, targetId: whitewolf.id });
    await waitUntil(() => seerResults.length === 3, "第三夜預言家查驗");
    await waitPhase("NIGHT_WITCH", "第三夜女巫階段");
    await waitPhase("DAY", "第三夜天亮");
    await waitFor((state) => state?.daySubPhase === "speech", "第三天白天發言");
    const explosionTarget = guard;
    expect(explosionTarget, "找不到白狼王自爆目標");
    whitewolf.emit("whiteWolfKingExplode", { roomId, targetId: explosionTarget.id });
    await waitUntil(() => room()?.gameOver, "白狼王自爆後判定遊戲結束");
    expect(room().gameWinner === "好人陣營", "白狼王出局後勝負判定錯誤");
    expect(room().players.find((player) => player.id === whitewolf.id)?.alive === false, "白狼王自爆後仍存活");
    console.log("PASS 白狼王自爆、帶走玩家與勝負判定");

    console.log("\nPASS：多人完整流程與所有目前已實作的職業技能均通過。");
  } finally {
    clients.forEach((socket) => socket.close());
    if (child && child.exitCode === null) child.kill();
  }
}

main().catch((error) => {
  console.error("\nFAIL:", error.message || error);
  process.exitCode = 1;
});
