/**
 * 模擬 5 位玩家連線（不含瀏覽器 / 語音 / PeerJS）。
 * 用法: node scripts/e2e-five-ngrok.js
 * 或:   set TEST_URL=https://你的網址 && node scripts/e2e-five-ngrok.js
 */
const { io } = require("socket.io-client");

const URL =
  process.env.TEST_URL || "https://myron-unparceling-comfily.ngrok-free.dev";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connectClient(label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("connect timeout: " + label)),
      30000
    );
    const s = io(URL, {
      transports: ["polling", "websocket"],
      reconnection: false,
      timeout: 25000,
      extraHeaders: { "ngrok-skip-browser-warning": "1" },
    });
    s.once("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function main() {
  console.log("目標:", URL);
  const clients = [];
  for (let i = 1; i <= 5; i++) {
    const s = await connectClient("p" + i);
    clients.push(s);
    console.log("已連線", i + "/5", "socket.id=", s.id);
  }

  const [host, ...joiners] = clients;

  const roomIdPromise = new Promise((resolve) => {
    host.once("roomCreated", resolve);
  });
  host.emit("createRoom", {
    name: "房主",
    boardType: "5",
    peerId: "fake-peer-host",
  });
  const roomId = await roomIdPromise;
  console.log("房號:", roomId);

  let joinN = 0;
  for (let j = 0; j < joiners.length; j++) {
    const s = joiners[j];
    await new Promise((resolve, reject) => {
      s.once("error", reject);
      s.emit("joinRoom", {
        roomId,
        name: "玩家" + (j + 2),
        peerId: "fake-peer-" + (j + 2),
      });
      const onUpdate = (room) => {
        if (room.players && room.players.length >= j + 2) {
          s.off("update", onUpdate);
          joinN++;
          resolve();
        }
      };
      s.on("update", onUpdate);
      setTimeout(() => {
        s.off("update", onUpdate);
        reject(new Error("join 等待 update 逾時 (玩家" + (j + 2) + ")"));
      }, 15000);
    });
    console.log("加入完成", j + 2 + "/5");
  }

  await sleep(300);

  const roleResults = clients.map(
    (s) =>
      new Promise((resolve) => {
        s.once("role", (r) => resolve({ id: s.id, role: r }));
        setTimeout(() => resolve({ id: s.id, role: null }), 20000);
      })
  );

  host.emit("startGame", roomId);
  const got = await Promise.all(roleResults);

  clients.forEach((c) => c.close());

  console.log("配發結果:", got.map((x) => x.id.slice(0, 8) + "…=" + x.role).join(" | "));

  if (got.some((x) => !x.role)) {
    console.error("FAIL：有人未收到 role");
    process.exit(1);
  }

  const multiset = got.map((x) => x.role).sort();
  const want = ["hunter", "seer", "villager", "witch", "wolf"];
  if (JSON.stringify(multiset) !== JSON.stringify(want)) {
    console.error("FAIL：角色組合應為 5 人板一組，實際:", multiset.join(","));
    process.exit(1);
  }

  console.log("PASS：5 人連線、開局、角色配發正確（未測語音／PeerJS／夜間計時）");
  process.exit(0);
}

main().catch((e) => {
  console.error("錯誤:", e.message || e);
  process.exit(1);
});
