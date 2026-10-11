/**
 * 9 人局整合測試：起臨時伺服器 → 開 9 人房 → 驗證滿員、角色分配與第 10 人拒絕。
 */
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const { PRESET_ROLES } = require("../roleConfig");

const PORT = Number(process.env.TEST_PORT) || 19999;
const ROOT = path.join(__dirname, "..");
const TIMEOUT_MS = 20000;

function sortCopy(arr) {
  return [...arr].sort();
}

function multisetEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = sortCopy(a);
  const sb = sortCopy(b);
  return sa.every((x, i) => x === sb[i]);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const tryConnect = () => {
      const s = io(`http://127.0.0.1:${PORT}`, {
        transports: ["websocket"],
        reconnection: false,
        timeout: 2000,
      });
      s.on("connect", () => {
        s.disconnect();
        resolve();
      });
      s.on("connect_error", () => {
        s.close();
        if (Date.now() > deadline) {
          reject(new Error("伺服器在逾時內未就緒"));
        } else {
          setTimeout(tryConnect, 150);
        }
      });
    };
    tryConnect();
  });
}

function connectClient(name) {
  const socket = io(`http://127.0.0.1:${PORT}`, {
    transports: ["websocket"],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${name} 連線逾時`));
    }, TIMEOUT_MS);
    socket.on("connect", () => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.on("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function main() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString();
  });

  try {
    await waitForServer();

    const host = await connectClient("host");
    let roomId = null;
    const roomCreated = new Promise((res) => {
      host.once("roomCreated", (id) => res(id));
    });
    host.emit("createRoom", {
      name: "房主",
      boardType: "9",
      peerId: "p-host",
    });
    roomId = await roomCreated;

    const whenNineReady = new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("逾時：房主未收到 9 人滿員 update")),
        TIMEOUT_MS
      );
      const onUpdate = (room) => {
        if (room.players.length === 9 && room.configReady) {
          clearTimeout(t);
          host.off("update", onUpdate);
          resolve(room);
        }
      };
      host.on("update", onUpdate);
    });

    const others = [];
    for (let i = 2; i <= 9; i++) {
      const s = await connectClient(`p${i}`);
      others.push(s);
      await new Promise((resolve, reject) => {
        s.once("error", (msg) => reject(new Error(`加入失敗: ${msg}`)));
        s.emit("joinRoom", {
          roomId,
          name: `玩家${i}`,
          peerId: `p${i}`,
        });
        s.once("update", () => resolve());
        setTimeout(() => resolve(), 800);
      });
    }

    const lastRoom = await whenNineReady;

    if (!lastRoom.configReady) {
      throw new Error("預期 configReady 為 true（9 人與 9 角色）");
    }
    if (lastRoom.players.length !== 9) {
      throw new Error(`預期 9 人，實際 ${lastRoom.players.length}`);
    }
    if (lastRoom.maxPlayers !== 9) {
      throw new Error(`預期 maxPlayers=9，實際 ${lastRoom.maxPlayers}`);
    }

    const tenth = await connectClient("p10");
    const fullErr = new Promise((res) => {
      tenth.once("error", (msg) => res(String(msg)));
    });
    tenth.emit("joinRoom", {
      roomId,
      name: "第十人",
      peerId: "p10",
    });
    const errMsg = await Promise.race([
      fullErr,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("第 10 人應收到錯誤")), 3000)
      ),
    ]);
    if (!errMsg.includes("滿")) {
      throw new Error(`預期「房間已滿」類訊息，收到：${errMsg}`);
    }
    tenth.disconnect();

    const roles = [];
    const roleWaiters = [host, ...others].map(
      (s) =>
        new Promise((res) => {
          s.once("role", (r) => res(r));
        })
    );
    host.emit("startGame", roomId);
    for (const w of roleWaiters) {
      roles.push(await w);
    }

    const expected = PRESET_ROLES["9"];
    if (!multisetEqual(roles, expected)) {
      throw new Error(
        `角色 multiset 不符。\n預期（排序）: ${sortCopy(expected)}\n實際（排序）: ${sortCopy(roles)}`
      );
    }

    [host, ...others].forEach((s) => s.disconnect());

    console.log("✓ 9 人局測試通過：滿員、第 10 人拒絕、開局角色與預設 9 人板一致。");
    console.log(`  房號: ${roomId}，角色數: ${roles.length}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error("✗ 9 人局測試失敗:", e.message || e);
  process.exit(1);
});
