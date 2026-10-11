# 遊戲流程（對應目前 `server.js` 行為）

> 修改此檔可當作「規格草稿」；實作仍以程式碼為準，改規格後記得同步改 `server.js` / `public/index.html`。

---

## 1. 房間與玩家

| 項目 | 說明 |
|------|------|
| 房號 | 4 位英數字（大寫），建立房間時隨機產生 |
| 房長 | 建立者；若房長離線，權限轉給清單第一位玩家 |
| 加入時機 | 僅在 `phase === "WAIT"` 可加入，否則伺服器回 `error` |
| 玩家資料 | `id`（socket）、`name`、`alive`、`role`、`peerId`（語音用）、女巫另有 `hasAntidote` / `hasPoison` |

---

## 2. 板子與角色

### 2.0 建立房間時的 `boardType`

| `boardType` | 說明 |
|-------------|------|
| `"custom"` | 房內人數上限 99；角色清單由房長用 `setGameConfig` 設定（須與實際人數一致才可開始）。 |
| 上述預設板鍵（`5` / `9` / …） | 建立時會複製該預設 **完整角色陣列** 到 `customRoles`，房長仍可在等待階段修改；`nightFlowKey` 預設與板型相同。 |

開局時角色 **洗牌後** 依玩家順序分配；各玩家只收到自己的 `role` 事件。

### 2.0.1 預設範本（`roleConfig.js` 的 `PRESET_ROLES`）

| 鍵 | 人數（角色數） | 角色組成 |
|----|----------------|----------|
| `"5"` | 5 | 狼、預、女、獵、民 |
| `"9"` | 9 | 狼×2、狼王、預、女、獵、民×3 |
| `"10"` | 10 | 狼×2、預、女、民×6 |
| `"12_standard"` | 12 | 狼×3、狼王、預、女、獵、白痴、民×4 |
| `"12_knight"` | 12 | 狼×4、預、女、獵、騎士、民×4 |

開局條件：**`resolvedRolesList(room)` 的長度必須等於 `players.length`**，且每個角色字串在允許清單內（見 `roleConfig.js`）。

### 2.1 各板子的夜晚／延遲（`boardFlow.js`）

房間的 **`nightFlowKey`**（房長可與角色範本脫鉤調整）決定 **夜晚步驟**（`nightSteps`：階段名、秒數、提示文字、是否發女巫資訊）以及：

- **`enterNightDelayMs`**：白天結束後延遲多久再開下一晚（預設 4000）。
- **`afterExecutionDelayMs`**：投票處決後延遲多久進夜晚（預設 8000）；訊息會顯示對應秒數。

未在 `BOARD_OVERRIDES` 列出的板型（例如未來新增）會使用 `DEFAULT_FLOW`（與舊版相同：**狼 12s → 預 10s → 女 10s**）。

單一步驟可設 **`skipIfNoRole`**：房內無存活該角色時略過該步（用於日後「無女巫板」等）。新增夜間 `phase` 時須同步在 `public/index.html` 加上對應 UI 與事件處理。

---

## 3. 階段狀態機（`room.phase`）

```
WAIT
  └─ startGame（人數足）→ 進入夜晚流程

NIGHT_WOLF → NIGHT_SEER → NIGHT_WITCH → processDaybreak → DAY
                                              ↑                │
                                              │                ├─ 投票結算 → 可能進入夜晚
                                              │                └─ PK / 處決 / 獵人狼王帶人
```

### 3.1 夜晚流程（`startNightFlow` → `runNightStep`）

1. 重置該房 `nightData`：`killed`、`usedAntidote`、`usedPoison`。
2. 依 **`boardFlow.js`** 的 `nightSteps` **依序**執行每一步：設 `room.phase`、廣播 `update` 與 `systemMsg`、倒數 `seconds` 秒後進入下一步。  
   - **`NIGHT_WOLF`**：狼人／狼王可送出擊殺目標；**第一位成功鎖定的目標** 即為當晚狼刀。其他狼人會收到 `wolfTargetLocked`。  
   - **`NIGHT_SEER`**：預言家查人 → 伺服器只對該玩家回 `seerResult`（狼／狼王為狼陣營）。  
   - **`NIGHT_WITCH`**：若步驟帶 `sendWitchKnowledge` 且女巫存活且有解藥，對女巫發 `witchKnowledge`（狼刀目標 id 或 `null`）。女巫可 `witchSave` / `witchPoison`。  
3. 步驟跑完 → **`processDaybreak`**。

### 3.2 天亮結算（`processDaybreak`）

處理順序（程式順序）：

1. **毒**：若有 `usedPoison`，該目標死亡，`deathReason = "poisoned"`。
2. **刀**：若有狼刀且 **未** 使用解藥，該目標死亡，`deathReason = "killed"`。  
   - 若死者為 **獵人** 或 **狼王**：全房 `skillProcessing: true`，死者收到 `hunterCanShoot`（最後帶人）。

然後 `phase = "DAY"`，廣播昨晚死訊或「平安夜」，並 **`checkGameOver`**。

### 3.3 白天投票（`DAY`）

- 玩家可 `castVote`（客戶端通常每人只能投一次 UI 邏輯）；伺服器統計 `votes[roomId]`。  
- **可投票人數**（`totalEligible`）：存活且 **不在** `pkPlayers` 名單內的玩家（PK 輪時候選人不投票）。  
- 房長按「結算」→ `finishVote`：

| 情況 | 結果 |
|------|------|
| 無人投票 | 訊息後 **`enterNight`** |
| 最高票 **唯一** | 該玩家出局；若為獵人／狼王 → 觸發帶人；否則訊息「8 秒後進夜晚」→ `enterNight` |
| 最高票 **多人平票** 且 **尚未** 進過 PK | 設 `pkPlayers` 為平票者 id 列表，廣播 PK、清空票、`voteUpdate` 重算（非候選的存活者可投） |
| 平票且 **已經在 PK** | 「再次平票」→ **`enterNight`**（無人出局） |

### 3.4 進入夜晚（`enterNight`）

- 清空該房 `votes`、`pkPlayers`。  
- 若未因 `checkGameOver` 結束遊戲，延遲 **`enterNightDelayMs`**（依板子，見 `boardFlow.js`）後再次 `startNightFlow`。

---

## 4. 勝負（`checkGameOver`）

在 `processDaybreak` 天亮後會檢查；獵人／狼王帶人後也會檢查。

| 條件 | 勝方（`gameOver` 字串） |
|------|-------------------------|
| 存活狼人數 = 0 | `好人陣營` |
| 存活「神職」= 0 **或** 存活村民 = 0 | `狼人陣營` |

**神職**（程式定義）：`seer`、`witch`、`hunter`、`idiot`、`knight`。

結束後約 **8 秒** 重置該房：`phase = "WAIT"`、清空角色與生死狀態、清票與 PK，並 `update` 全房。

---

## 5. 計時器

- `countdown(roomId, seconds, nextStep)` 每秒對房間 `emit("timer", count)`，`count` 從 `seconds` 倒到 0 後執行 `nextStep`。  
- 客戶端用 `timer` 顯示倒數；**階段切換** 完全由這些倒數接龍觸發，與客戶端按鈕無關（按鈕只影響當階段資料）。

---

## 6. 與前端 `index.html` 的差異（實務備註）

- 下拉選單目前只有 **5 / 9 / 12_standard**；`10`、`12_knight` 後端支援但 UI 未暴露。  
- 伺服器會發 `wolfTargetLocked`、`skillProcessing`；目前 HTML **未** 監聽這些事件（若改流程可補上）。  
- `joinRoom` 失敗時伺服器 `socket.emit("error", ...)`；前端 **未** 監聽 `error`。

---

## 7. 修改此檔的建議用法

1. 先改這裡的文字／表格當成「目標行為」。  
2. 再改 `docs/SOCKET_PROTOCOL.md` 若新增／變更事件。  
3. 最後改 `server.js` 與 `public/index.html` 對齊。
