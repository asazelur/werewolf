# Socket.IO 協定（對應目前 `server.js` + `public/index.html`）

> 客戶端 → 伺服器用 `socket.emit`；伺服器 → 客戶端用 `io.to(room).emit` 或 `socket.emit`。  
> 房號在伺服器內一律以 **大寫** 鍵存取；客戶端傳入的 `roomId` 會 `toUpperCase()`。  
> 各板子的夜晚階段順序與計時見專案根目錄 **`boardFlow.js`**（非 Socket 事件，但影響 `phase` 與 `timer`）。

---

## 客戶端 → 伺服器

| 事件名稱 | 負載 | 時機 / 備註 |
|----------|------|-------------|
| `createRoom` | `{ name, boardType, peerId }` | 建立新房。`boardType`：`custom` 或 `roleConfig` 內任一預設鍵（`5`/`9`/`10`/`12_standard`/`12_knight`）。無效值會 `error`。 |
| `setGameConfig` | `{ roomId, loadPresetId?, customRoles?, nightFlowKey?, clearRoles? }` | 僅 **房長**、且 `phase === "WAIT"`。`loadPresetId`：覆寫角色為該範本並同步 `nightFlowKey`；`customRoles`：自訂陣列（會清空 `presetId`）；空陣列清空配置；`clearRoles`：清空 `presetId` 與 `customRoles`；`nightFlowKey`：僅改夜晚節奏（`boardFlow.js`）。 |
| `joinRoom` | `{ roomId, name, peerId }` | 僅 `WAIT` 可加入 |
| `leaveRoom` | `roomId` | 離開 socket room 並觸發退房邏輯 |
| `startGame` | `roomId` | 僅 **房長**；角色清單長度須等於玩家人數且皆為合法角色 |
| `wolfKill` | `{ roomId, targetId }` | 僅夜晚狼階段；**先寫入的 `killed` 生效** |
| `seerAction` | `{ roomId, targetId }` | 預言家查驗 |
| `witchSave` | `{ roomId }` | 女巫用解藥（須仍有解藥且 `nightData` 存在） |
| `witchPoison` | `{ roomId, targetId }` | 女巫用毒藥 |
| `hunterAction` | `{ roomId, targetId }` | 獵人／狼王最後帶人 |
| `castVote` | `{ roomId, targetId }` | 僅 `phase === "DAY"` |
| `finishVote` | `roomId` | 房長結算投票（由前端放按鈕） |

---

## 伺服器 → 客戶端（依房廣播為主）

| 事件名稱 | 負載 | 誰收到 | 前端是否有監聽 |
|----------|------|--------|----------------|
| `roomCreated` | `roomId`（字串） | 建立者 | ✅ |
| `update` | `room` 物件（見下：等待階段非房長不含 `customRoles`） | 房內每人可能略有差異 | ✅ |
| `role` | 角色字串（如 `"wolf"`） | 該玩家 socket | ✅ |
| `systemMsg` | 字串 | 房內或全房（依程式） | ✅ |
| `timer` | 數字（剩餘秒數，0 後結束） | 房內 | ✅ |
| `error` | 字串（無法加入、設定錯誤等） | 單一 socket | ✅ `alert` |
| `user-connected` | `peerId`（PeerJS） | 房內「其他」玩家（`socket.to`） | ✅ 用於語音撥號 |
| `witchKnowledge` | 狼刀目標 **socket id** 或 `null` | 女巫 | ✅（存成 `witchKnowledgeId`） |
| `seerResult` | `boolean`（是否狼陣營） | 查驗的預言家 | ✅ |
| `wolfTargetLocked` | `{ targetId, msg }` | 各狼／狼王 | ❌ 目前未處理 |
| `voteUpdate` | `{ count, total }` | 房內 | ✅ |
| `showFinalVotes` | `[{ voterName, targetName }, ...]` | 房內 | ✅ |
| `pkMode` | 候選人 **socket id 陣列** | 房內 | ✅ |
| `hunterCanShoot` | `true`（無負載亦可） | 可開槍的玩家 | ✅ |
| `skillProcessing` | `boolean` | 房內 | ❌ 目前未監聽（前端用本地變數部分模擬） |
| `gameOver` | 勝方字串（如 `好人陣營`） | 房內 | ✅ |

---

## `room` 物件（`update` 事件）重點欄位

| 欄位 | 說明 |
|------|------|
| `host` | 房長 socket id |
| `phase` | `WAIT` / `NIGHT_WOLF` / `NIGHT_SEER` / `NIGHT_WITCH` / `DAY` |
| `players` | `{ id, name, alive, role, peerId?, hasAntidote?, hasPoison?, deathReason? }[]` |
| `presetId` | 最後套用的範本鍵；若房長改過自訂陣列則為 `null` |
| `customRoles` | 開局要洗牌的角色 id 陣列；**僅房長**在 `WAIT` 會收到 |
| `nightFlowKey` | 對應 `boardFlow.js` 的夜晚節奏 |
| `maxPlayers` | 人數上限（自訂房為 99，預設板為該板人數） |
| `configReady` | 角色數是否已等於玩家人數且大於 0 |
| `configRoleCount` | **非房長**在 `WAIT` 可見：已配置角色數（不含清單內容） |

---

## 修改協定時

1. 更新本檔事件表。  
2. 同步 `docs/GAME_FLOW.md` 若行為改變。  
3. 改 `server.js` 與 `public/index.html`（及其他客戶端）。
