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

## 授權

自有程式碼，跟遊戲本體一致。
