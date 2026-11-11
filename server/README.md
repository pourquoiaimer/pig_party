# pig_party 連線伺服器

大廳連線用的 WebSocket 中繼。**伺服器不跑遊戲邏輯**，只做「房間登記 + 狀態轉發」：
每個客戶端送出自己那隻豬的狀態，伺服器轉給對手。小遊戲之後要改成「伺服器權威」時，
在這一層之上加 authority，不動房間機制。

## 本機跑

```bash
cd server && npm install && PORT=8890 node server.mjs
curl http://127.0.0.1:8890/health
```

## 部署（VPS 43.128.78.26）

| 項目 | 值 |
|---|---|
| 程式 | `/home/ubuntu/pig-party-server/` |
| Node 服務 | `systemctl status pig-party`（unit：`/etc/systemd/system/pig-party.service`，開機自啟 enabled） |
| **Node 監聽** | **`127.0.0.1:8891`**（只給本機／Caddy 用） |
| **對外入口** | **`https://43.128.78.26:8890`** ＝ Caddy 終結 TLS 後反代到 8891 |
| Caddy site | `/etc/caddy/acli-external.d/pig-party.caddy`（獨立檔，`Caddyfile` 只有一行 import） |
| 憑證 | 沿用同 IP 的 Let's Encrypt 短效期憑證（`profile shortlived`，約 6 天效期，Caddy 自動續） |
| 記憶體 | 實佔 ~27MB，硬上限 `MemoryMax=160M`、`MemoryHigh=120M` |
| 日誌 | journal：`journalctl -u pig-party -f`、`journalctl -u caddy \| grep pig` |

對外還需要在**騰訊雲控制台 → 防火牆**加一條 `TCP:8890`（雲端那層 SSH 改不到）。

```bash
# 更新程式後
sudo systemctl restart pig-party && curl -s http://127.0.0.1:8891/health
# 整條路徑驗證（TLS → upgrade → 中繼）
cd /home/ubuntu/pig-party-server && node wss-proxy.test.mjs wss://127.0.0.1:8890 43.128.78.26:8890
```

## 三個踩過的坑（別重犯）

1. **Caddy 和 Node 不能同一個 port**：一開始兩者都想綁 8890 → `bind: address already in use` → reload 失敗。對外 8890 / 對內 8891。
2. **不要在 Caddy site 裡寫 `log { output file /var/log/caddy/*.log }`**：這台的 `caddy.service` 帶 `ProtectSystem`，`/var/log` 對 caddy 是唯讀，reload 直接 400 失敗。日誌走 journal。
3. **用 127.0.0.1 測 Caddy site 要覆寫 Host**：site 位址是 `https://43.128.78.26:8890`，`curl https://127.0.0.1:8890/health` 的 Host 不符 → Caddy 落到別的 server，回 **200 但 body 空**（看起來像壞掉）。要加 `-H 'Host: 43.128.78.26:8890'`。外部連進來時 Host 自然是對的。

```bash
# 更新程式後
sudo systemctl restart pig-party && curl -s http://127.0.0.1:8891/health
```

## 協定

| 方向 | 訊息 | 說明 |
|---|---|---|
| C→S | `{t:'create', name}` | 建立房間 |
| S→C | `{t:'room', code, role:'host'}` | 回房間碼 |
| C→S | `{t:'join', code, name}` | 加入房間 |
| S→C | `{t:'room', code, role:'guest', peer}` | 加入成功 |
| S→H | `{t:'peer', on:true, name}` | 通知開房者有人進來 |
| C↔S | `{t:'s', d:{...}}` | 狀態，轉發給對手 |
| S→C | `{t:'peer', on:false}` | 對手離線 |
| C→S | `{t:'bye'}` | 主動離開 |

限制：單則訊息 ≤ 4 KB、單連線 ≤ 90 則/秒、房間存活 2 小時。

## 排球（伺服器權威，05B）

房間裡多一組「比賽」通道，跟大廳的 `s` 完全並存、互不影響。

| 方向 | 訊息 | 說明 |
|---|---|---|
| C→S | `{t:'start', game:'volley'}` | **只有 host 能發**；建立比賽 |
| S→C | `{t:'gstart', game:'volley'}` | 兩邊都收到，前端據此進小遊戲 |
| C→S | `{t:'gi', i:{l,r,u}}` | 自己的輸入，**只作用在自己的 index**（host=0、guest=1） |
| S→C | `{t:'gs', k, s, ev}` | 30Hz 狀態快照（`k` = tick 序號，遞增） |
| S→C | `{t:'gend', win, reason?}` | 比賽結束（對手斷線時帶 `reason`） |

錯誤：非 host 發 `start` → `only host can start`；未知 `game` → `unknown game`；
沒有比賽時收到 `gi` → **靜默忽略**（不報錯，避免洗頻）。
對手斷線 → 中止比賽、另一方收到 `gend {win:-1, reason}`，房間照原流程處理。

### 邏輯從哪來

`game-host.mjs` 啟動時讀 `server/index.html`（部署時一起複製）→ 沒有就退回 `../index.html`，
切出 `/* ===== VOLLEY 邏輯 BEGIN` 到 `END` 那一段、`new Function` 編譯。
**跟瀏覽器跑的是同一份程式**，所以改玩法只改 `index.html` 一處。
找不到就只停用排球（`/health` 會寫原因），大廳中繼照常。

```bash
curl -s http://127.0.0.1:8891/health | jq .volley
# {"ok":true,"source":".../index.html","lines":128,"winPts":7}
```

### 狀態快照長怎樣（實測 ≤ 220 bytes）

```json
{"t":"gs","k":108,"s":{"p":[[211.2,492],[748.8,492]],"b":[345.6,150],"live":0,
 "cool":0,"sc":[1,1],"ov":0,"win":-1,"st":1,"ms":"P1 紅 得分　1 : 1","mt":1.4,
 "ra":0,"sh":12,"fa":1},"ev":[{"t":"point","p":0}]}
```

| 欄位 | 意義 |
|---|---|
| `p` | 兩位玩家腳底座標 `[[x,y],[x,y]]`（2 位小數） |
| `b` / `live` / `cool` | 球座標、是否已發球、擊球冷卻（畫擊球姿勢用） |
| `sc` / `ov` / `win` | 比分、是否結束、勝者 |
| `st` / `ms` / `mt` | 發球倒數、得分訊息、訊息剩餘時間 |
| `ra` / `sh` / `fa` | 連續擊球數（音高）、震動、白閃 |
| `ev` | 這一 tick 的事件 `{t,p}`（`hit`／`point`／`win`） |

**實測（2026-11-11，7 分制整場 703 tick）**：平均 **186 bytes**、最大 **209 bytes**
（得分那一 tick＋4 位數 tick 序號）；一般 tick（無訊息無事件）**167 bytes**。
一場 30 秒實戰：每個客戶端 **749 則 / 133 KB ≈ 4.4 KB/s（35 kbit/s）**，
換算 2 小時/天 ≈ **0.95 GB/月**（整包 `JSON.stringify(S)` 是 997 bytes ≈ 60 KB/s ≈ 13 GB/月）。

為了壓在 220 以內，有兩件事跟「整包狀態」不同：
- `bv`（球速）**沒送** —— canvas 的 `drawBall` 只用 x/y/trail/cool，vx/vy 一格都沒用到。
- 最後一分同時有 `point`＋`win` 事件時只送 `win`（比分已在 `sc`，前端播一次音就好）。

### 固定步長

`server.mjs` 用 10ms 的細 tick ＋ 每場自己的累積時間 `acc`，固定扣 `1/30` 秒。
不要用 `setInterval(33)` 的間隔直接當 dt —— 事件迴圈會拉長間隔，物理會變慢。
一次最多補 8 tick、單次累積上限 0.25 秒，避免卡頓後雪球。

### 測試

```bash
node tests/relay.volley.test.mjs      # 自己 spawn 伺服器（8895）、跑完關掉
node tests/relay.test.mjs ws://127.0.0.1:8895   # 大廳中繼回歸
node tools/bench-volley-host.mjs 30 8896        # rss / 流量基準
```

## 授權

自有程式碼，跟遊戲本體一致。
