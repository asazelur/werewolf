/**
 * Starts five Socket.IO players without browser tabs and checks the voted-out
 * player's last-words phase, voice permissions, early finish, and town win.
 * Run with: npm run test:e2e:last-words
 */
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_PORT) || 19818;
const URL = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 90000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, label, timeout = TIMEOUT_MS) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`等待逾時：${label}`);
}

function connectClient(label) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 3000,
    });
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

function waitForLocalServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("本機伺服器在 10 秒內未啟動")), 10000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("伺服器運行中")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`測試伺服器提早結束（${code}）`));
    });
  });
}

async function main() {
  let child = null;
  const clients = [];
  try {
    child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForLocalServer(child);

    for (let index = 1; index <= 5; index++) {
      clients.push(await connectClient(`玩家${index}`));
    }
    const [host, ...joiners] = clients;
    const states = new Map();
    let voteCount = 0;
    clients.forEach((socket) => socket.on("update", (room) => states.set(socket.id, room)));
    host.on("voteUpdate", ({ count }) => { voteCount = count; });

    const roomCreated = new Promise((resolve) => host.once("roomCreated", resolve));
    host.emit("createRoom", { name: "測試房主", boardType: "5", peerId: "test-host" });
    const roomId = await roomCreated;

    for (let index = 0; index < joiners.length; index++) {
      const socket = joiners[index];
      const playerCount = index + 2;
      const joined = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("玩家加入逾時")), 5000);
        const onUpdate = (room) => {
          if (room.players.length >= playerCount) {
            clearTimeout(timer);
            socket.off("update", onUpdate);
            resolve();
          }
        };
        socket.on("update", onUpdate);
      });
      socket.emit("joinRoom", {
        roomId,
        name: `測試玩家${playerCount}`,
        peerId: `test-player-${playerCount}`,
      });
      await joined;
    }

    const rolesReady = Promise.all(
      clients.map((socket) => new Promise((resolve) => socket.once("role", resolve)))
    );
    host.emit("startGame", roomId);
    const roles = await rolesReady;
    const socketByRole = new Map(clients.map((socket, i) => [roles[i], socket]));
    const wolf = socketByRole.get("wolf");
    const seer = socketByRole.get("seer");
    if (!wolf || !seer) throw new Error("測試局沒有分到狼人或預言家");

    const phase = (name) => [...states.values()].some((room) => room.phase === name);
    await waitUntil(() => phase("NIGHT_WOLF"), "狼人夜晚階段");
    const room = states.get(host.id);
    const nightVictim = clients.find((socket, index) =>
      socket.id !== wolf.id && socket.id !== seer.id && ["hunter", "witch"].includes(roles[index])
    );
    if (!nightVictim) throw new Error("找不到適合的夜晚測試目標");
    wolf.emit("wolfKill", { roomId, targetId: nightVictim.id });

    await waitUntil(() => phase("NIGHT_SEER"), "預言家夜晚階段");
    seer.emit("seerAction", { roomId, targetId: wolf.id });
    await waitUntil(() => phase("DAY"), "白天階段");
    await waitUntil(
      () => [...states.values()].some((r) => r.phase === "DAY" && r.daySubPhase === "speech"),
      "白天輪流發言"
    );

    for (let step = 0; step < 10; step++) {
      if ([...states.values()].some((r) => r.daySubPhase === "vote")) break;
      host.emit("nextSpeech", { roomId });
      await sleep(100);
    }
    await waitUntil(
      () => [...states.values()].some((r) => r.phase === "DAY" && r.daySubPhase === "vote"),
      "投票階段"
    );

    const hostRoom = states.get(host.id);
    const alivePlayers = hostRoom.players.filter((entry) => entry.alive);
    for (const player of alivePlayers) {
      clients.find((socket) => socket.id === player.id).emit("castVote", {
        roomId,
        targetId: wolf.id,
      });
    }
    await waitUntil(() => voteCount === alivePlayers.length, "收到所有投票", 5000);
    host.emit("finishVote", roomId);

    await waitUntil(
      () => [...states.values()].some(
        (r) => r.phase === "DAY" && r.daySubPhase === "lastWords" && r.lastWordsPlayerId === wolf.id
      ),
      "狼人出局後的遺言階段",
      5000
    );

    if (states.get(wolf.id).canSpeak !== true) {
      throw new Error("出局玩家在遺言階段沒有發言權");
    }
    for (const socket of clients.filter((entry) => entry.id !== wolf.id)) {
      if (states.get(socket.id).canSpeak !== false) {
        throw new Error("遺言階段有其他玩家的麥克風未關閉");
      }
    }

    const gameOver = new Promise((resolve) => host.once("gameOver", resolve));
    wolf.emit("finishLastWords", { roomId });
    const winner = await Promise.race([
      gameOver,
      sleep(5000).then(() => null),
    ]);
    if (winner !== "好人陣營") throw new Error("遺言結束後未正確進入遊戲結束狀態");

    console.log("PASS：五名虛擬玩家完成夜晚、投票、遺言發言權與提早結束流程。");
  } finally {
    clients.forEach((socket) => socket.close());
    if (child) child.kill();
  }
}

main().catch((error) => {
  console.error("FAIL:", error.message || error);
  process.exitCode = 1;
});
