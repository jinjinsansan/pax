# 運用手順（XServer VPS）

## サーバー

- ホスト: `pax-vps` / 162.43.29.102（XServer VPS 4GB、Ubuntu 26.04 LTS）
- SSH: 鍵認証のみ（パスワード認証無効）。鍵: 開発機の `~/.ssh/pax_vps`
- ファイアウォール: XServerパケットフィルター（SSHのみ許可）+ UFW（OpenSSHのみ許可）
- fail2ban / chrony / unattended-upgrades 有効

## 配置

```
/opt/arbitrage/app/              リポジトリ（git clone）
/opt/arbitrage/secrets/monitor.env  本番環境変数（600、git管理外）
```

## 基本操作

```bash
ssh -i ~/.ssh/pax_vps root@162.43.29.102

cd /opt/arbitrage/app
COMPOSE="docker compose -f infrastructure/docker/docker-compose.yml"

$COMPOSE ps                 # 状態確認（healthy になっているか）
$COMPOSE logs -f --tail 50 monitor-worker   # ログ追尾
$COMPOSE restart monitor-worker             # 再起動
```

## デプロイ（更新反映）

```bash
cd /opt/arbitrage/app
git pull
docker compose -f infrastructure/docker/docker-compose.yml build monitor-worker
docker compose -f infrastructure/docker/docker-compose.yml up -d monitor-worker
```

## 環境変数の変更

`/opt/arbitrage/secrets/monitor.env` を編集後、`up -d` で再作成。
**PRIVATE_KEYは絶対に設定しない**（設定するとWorkerは起動を拒否する — Phase 1/2ガード）。

## 監視の見方

- Telegram（@tokenkanshibot → chat 197618639）: SYSTEM通知（起動/停止/RPC切替/リーダー変更）
- Supabase `arb.worker_heartbeats`: `xserver-main-01` の `last_seen_at` が15秒間隔で更新
- コンテナHEALTHCHECK: health.jsonが90秒更新されないとunhealthy → `restart: unless-stopped`

## 障害時

1. `$COMPOSE logs --tail 200 monitor-worker` でエラー確認
2. RPC問題ならSYSTEM通知（POLLING_FALLBACK / PROVIDER_SWITCHED）が先に出ているはず
3. コンテナ再起動で解消しない場合は `git pull` + rebuild
4. Supabase書込失敗はログ `DbError` を確認（RLS/キー期限）

## Cloudflare Tunnel（未設定・将来）

Tunnel token取得後:
```bash
echo "CLOUDFLARE_TUNNEL_TOKEN=..." >> /opt/arbitrage/secrets/compose.env
docker compose --env-file /opt/arbitrage/secrets/compose.env \
  -f infrastructure/docker/docker-compose.yml --profile tunnel up -d
```
