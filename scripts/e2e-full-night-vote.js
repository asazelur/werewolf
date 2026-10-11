/**
 * 完整流程：5 人房 → 第一夜（狼刀、預查、女巫不動）→ 白天 → 全票點狼 → 好人獲勝。
 * 需 socket.io-client：npm install socket.io-client --no-save
 *
 * node scripts/e2e-full-night-vote.js
 * $env:TEST_URL="https://xxx.ngrok-free.dev"; node scripts/e2e-full-night-vote.js
 */
const { io } = require("socket.io-client");

const URL = process.env.TEST_URL || "http://localhost:8080";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(pred, timeoutMs, step = 80) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

function connectClient(label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("connect timeout: " + label)),
      35000
    );
    const s = io(URL, {
      transports: ["polling", "websocket"],
      reconnection: false,
      timeout: 30000,
      extraHeaders: { "ngrok-skip-browser-warning": "1" },
    });
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("connect_error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function main() {
  console.log("目標:", URL);
  const clients = [];
  for (let i = 1; i <= 5; i++) {
    clients.push(await connectClient("p" + i));
    console.log("已連線", i + "/5");
  }

  const [host, ...joiners] = clients;
  let lastRoom = null;
  clients.forEach((s) =>
    s.on("update", (r) => {
      lastRoom = r;
    })
  );

  const roomId = await new Promise((resolve) => {
    host.once("roomCreated", resolve);
    host.emit("createRoom", {
      name: "房主",
      boardType: "5",
      peerId: "e2e-h",
    });
  });
  console.log("房號:", roomId);

  const roleBySocketId = new Map();
  await Promise.all(
    joiners.map(
      (s, j) =>
        new Promise((resolve, reject) => {
          s.once("error", reject);
          s.emit("joinRoom", {
            roomId,
            name: "P" + (j + 2),
            peerId: "e2e-" + (j + 2),
          });
          const onUp = (room) => {
            if (room.players && room.players.length >= j + 2) {
              s.off("update", onUp);
              resolve();
            }
          };
          s.on("update", onUp);
          setTimeout(() => {
            s.off("update", onUp);
            reject(new Error("join 逾時"));
          }, 20000);
        })
    )
  );
  console.log("5 人進房完成");

  const allRoles = Promise.all(
    clients.map(
      (s) =>
        new Promise((res) => {
          s.once("role", (r) => {
            roleBySocketId.set(s.id, r);
            res();
          });
        })
    )
  );
  host.emit("startGame", roomId);
  await allRoles;
  await sleep(200);
  console.log("角色:", [...roleBySocketId.entries()].map(([id, r]) => r).join(","));

  const wolfId = [...roleBySocketId.entries()].find(([, r]) => r === "wolf")[0];
  const seerId = [...roleBySocketId.entries()].find(([, r]) => r === "seer")[0];
  const wolfSock = clients.find((c) => c.id === wolfId);
  const seerSock = clients.find((c) => c.id === seerId);

  async function waitPhase(phase, ms, label) {
    const ok = await waitUntil(() => lastRoom && lastRoom.phase === phase, ms);
    if (!ok) {
      throw new Error(
        label + "：逾時等待 " + phase + "，目前=" + (lastRoom && lastRoom.phase)
      );
    }
    console.log("  → 階段", phase);
  }

  await waitPhase("NIGHT_WOLF", 8000, "第一夜狼");
  /* 勿刀唯一村民：否則天亮村民數=0 會直接狼勝，不會進入發言／投票 */
  const nightKillTarget =
    (lastRoom.players || []).find(
      (p) =>
        p.id !== wolfId &&
        p.alive &&
        ["hunter", "seer", "witch"].includes(p.role)
    ) || (lastRoom.players || []).find((p) => p.id !== wolfId && p.alive);
  if (!nightKillTarget) throw new Error("找不到狼刀目標");
  wolfSock.emit("wolfKill", {
    roomId,
    targetId: nightKillTarget.id,
  });
  console.log("  狼刀 →", nightKillTarget.role, nightKillTarget.name);

  await waitPhase("NIGHT_SEER", 12000, "預言家");
  seerSock.emit("seerAction", { roomId, targetId: wolfId });
  console.log("  預言家查狼");

  await waitPhase("NIGHT_WITCH", 12000, "女巫");
  /* 不解不毒 */

  await waitPhase("DAY", 20000, "白天");
  const deadAfterNight = (lastRoom.players || []).filter((p) => !p.alive).length;
  console.log("  天亮後出局人數:", deadAfterNight);
  if (deadAfterNight < 1) {
    throw new Error("預期至少 1 人死於夜晚（女巫未救）");
  }

  console.log("  房長快轉發言（E2E）…");
  for (let g = 0; g < 20; g++) {
    if (!lastRoom || lastRoom.daySubPhase !== "speech") break;
    host.emit("nextSpeech", { roomId });
    await sleep(120);
  }
  const okVote = await waitUntil(
    () => lastRoom && lastRoom.daySubPhase === "vote",
    10000
  );
  if (!okVote) {
    throw new Error("無法進入投票階段，daySubPhase=" + (lastRoom && lastRoom.daySubPhase));
  }
  console.log("  → 投票階段");

  for (const p of lastRoom.players.filter((x) => x.alive)) {
    const sock = clients.find((c) => c.id === p.id);
    sock.emit("castVote", { roomId, targetId: wolfId });
  }
  console.log("  存活者全票點狼");

  const gameOverP = new Promise((resolve) => {
    host.once("gameOver", resolve);
  });
  host.emit("finishVote", roomId);

  const winner = await Promise.race([
    gameOverP,
    sleep(25000).then(() => null),
  ]);
  if (!winner) {
    throw new Error("逾時未收到 gameOver（投票或勝負判定可能有誤）");
  }
  console.log("  gameOver:", winner);

  if (winner !== "好人陣營") {
    throw new Error("預期好人獲勝，實際: " + winner);
  }

  const wolfP = (lastRoom.players || []).find((p) => p.id === wolfId);
  if (!wolfP || wolfP.alive) {
    throw new Error("預期狼人已於投票後出局");
  }

  clients.forEach((c) => c.close());
  console.log("\nPASS：完整第一夜 + 白天投票 + 好人勝利");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nFAIL:", e.message || e);
  process.exit(1);
});
