#!/bin/bash
# 在 VPS 上為 pig_party 連線伺服器加一個獨立的 Caddy site（不碰 hermes-webui 設定）
# 任何一步失敗 → 自動回滾並離開
set -u

TS=$(date +%Y%m%d_%H%M%S)
CADDYFILE=/etc/caddy/Caddyfile
NEWSITE=/etc/caddy/acli-external.d/pig-party.caddy
BACKUP=/etc/caddy/Caddyfile.bak.${TS}.pigsrv
IMPORT_LINE='import "/etc/caddy/acli-external.d/pig-party.caddy"'

fail() {
  echo "!! 失敗：$1"
  echo "-- 開始回滾 --"
  sudo cp -a "$BACKUP" "$CADDYFILE"
  sudo rm -f "$NEWSITE"
  sudo systemctl reload caddy 2>/dev/null
  sleep 2
  echo "-- 回滾後 WebUI: $(curl -s -o /dev/null -w '%{http_code}' -k https://127.0.0.1:21675/) --"
  exit 1
}

echo "== 1. 備份 Caddyfile =="
sudo cp -a "$CADDYFILE" "$BACKUP" || fail "備份失敗"
echo "   $BACKUP"

echo "== 2. 寫入新 site（只綁 8890，反代到 127.0.0.1:8890）=="
sudo tee "$NEWSITE" > /dev/null <<'CADDY'
# pig_party 連線伺服器（WebSocket 中繼）— 由 default 於 2026-11-11 建立
# 獨立 site，不影響 hermes-webui.caddy 的 21675 入口。
# 憑證：沿用同一個 IP 的 Let's Encrypt 短效期憑證（profile shortlived）。
https://43.128.78.26:8890 {
	tls {
		issuer acme {
			profile shortlived
			disable_tlsalpn_challenge
		}
	}

	# WebSocket 與 /health 都走同一條反代；Caddy 會自動處理 Upgrade
	reverse_proxy 127.0.0.1:8891

	encode zstd gzip
	# 註：不要加 file log —— 這台的 caddy.service 帶 ProtectSystem=full，
	# /var/log 是唯讀的，指定 /var/log/caddy/*.log 會讓 reload 直接失敗（2026-11-11 踩過）。
	# 日誌走 journal：journalctl -u caddy | grep pig
}
CADDY
echo "   $NEWSITE 已寫入"

echo "== 3. 在主 Caddyfile 追加 import（只加一行）=="
if grep -qF "$IMPORT_LINE" "$CADDYFILE"; then
  echo "   import 已存在，跳過"
else
  echo "" | sudo tee -a "$CADDYFILE" > /dev/null
  echo "$IMPORT_LINE" | sudo tee -a "$CADDYFILE" > /dev/null || fail "追加 import 失敗"
  echo "   已追加"
fi

echo "== 4. 驗證語法（不過就回滾）=="
if ! sudo caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -5; then
  fail "caddy validate 失敗"
fi

echo "== 5. reload（只重載設定，不重啟服務、不斷線）=="
sudo systemctl reload caddy || fail "reload 失敗"
sleep 4

echo "== 6. 驗證：新服務 =="
CODE_NEW=$(curl -s -o /dev/null -w '%{http_code}' -k https://127.0.0.1:8890/health)
echo "   https://127.0.0.1:8890/health → $CODE_NEW"
[ "$CODE_NEW" = "200" ] || fail "新 site 沒有回 200（實際 $CODE_NEW）"
echo "   內容：$(curl -s -k https://127.0.0.1:8890/health)"
echo "   憑證：$(echo | openssl s_client -connect 127.0.0.1:8890 -servername 43.128.78.26 2>/dev/null | openssl x509 -noout -issuer -dates 2>/dev/null | tr '\n' ' ')"

echo "== 7. 驗證：原有 WebUI 沒被影響 =="
CODE_WEBUI=$(curl -s -o /dev/null -w '%{http_code}' -k https://127.0.0.1:21675/)
CODE_8787=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/)
echo "   caddy 21675 → $CODE_WEBUI（原本 200）"
echo "   webui 8787  → $CODE_8787（原本 302）"
[ "$CODE_WEBUI" = "200" ] || fail "WebUI 受影響（$CODE_WEBUI）"
[ "$CODE_8787" = "302" ] || fail "WebUI 後端受影響（$CODE_8787）"
echo "   docker: $(docker ps --format '{{.Names}} {{.Status}}' | head -2 | tr '\n' ' ')"

echo ""
echo "== 完成 == 新入口 https://43.128.78.26:8890/ （外部需在騰訊雲開 TCP 8890）"
