#!/bin/bash
# Puts up a local kimmi full of data to click through: http://localhost:8700
#   make demo
# It REPLACES the compose stack's database and recordings. Three projects: a shop with analytics on and
# months of history, the same shop recording only, and an empty one. The data comes in through the real
# ingest routes: `kimmi seed` for volume, and a browser acting as a few hundred visitors of the example shop.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
: "${DEV_ACCOUNT_EMAIL:?set DEV_ACCOUNT_EMAIL and DEV_ACCOUNT_PASSWORD in .env}"
COMPOSE=(docker compose -f docker-compose.yml -f scripts/demo.compose.yml)
RICH=km_pub_$(printf 'de30%.0s' 1 2 3 4)
REPLAY=km_pub_$(printf 'de31%.0s' 1 2 3 4)
LOGS=${DEMO_LOGS:-/tmp/kimmi-demo}
mkdir -p "$LOGS"

echo "== a fresh stack"
"${COMPOSE[@]}" down -v --remove-orphans
"${COMPOSE[@]}" up --build -d
for _ in $(seq 1 120); do curl -sf localhost:8700/healthz >/dev/null && break; sleep 1; done
make server >/dev/null

echo "== projects"
kimmi() { docker exec kimmi-kimmi-1 kimmi "$@"; }
kimmi admin project create --name "Fernhill Goods" --slug fernhill-goods --platform react --origin http://localhost:5225 --key "$RICH" >/dev/null
kimmi admin project create --name "Fernhill Trade" --slug fernhill-trade --platform react --origin http://localhost:5226 --key "$REPLAY" >/dev/null
pkill -f "demo-webhook.mjs" 2>/dev/null || true
nohup node scripts/demo-webhook.mjs 5290 "$LOGS/webhook.log" > "$LOGS/webhook.out" 2>&1 &
node scripts/demo-setup.mjs before
sleep 6 # ingest reloads projects within 5 seconds

echo "== history: visits, events and recordings over the past weeks"
bin/kimmi seed --host http://localhost:8700 --key "$RICH" --days "${DEMO_DAYS:-75}" --visits "${DEMO_VISITS:-250000}" --recorded "${DEMO_RECORDED:-20000}"
bin/kimmi seed --host http://localhost:8700 --key "$REPLAY" --days 60 --visits "${DEMO_REPLAY_RECORDED:-6000}" --recorded "${DEMO_REPLAY_RECORDED:-6000}" --analytics=false --seed 2

echo "== the example shop, once per project"
pkill -f "vite preview --outDir .demo" 2>/dev/null || true
(
  cd examples/react-spa
  VITE_KIMMI_KEY=$RICH VITE_KIMMI_HOST=http://localhost:8700 pnpm exec vite build --outDir .demo-rich >/dev/null
  VITE_KIMMI_KEY=$REPLAY VITE_KIMMI_HOST=http://localhost:8700 pnpm exec vite build --outDir .demo-replay >/dev/null
  nohup pnpm exec vite preview --outDir .demo-rich --port 5225 --strictPort > "$LOGS/shop-rich.out" 2>&1 &
  nohup pnpm exec vite preview --outDir .demo-replay --port 5226 --strictPort > "$LOGS/shop-replay.out" 2>&1 &
)
for _ in $(seq 1 60); do curl -sf localhost:5225 >/dev/null && curl -sf localhost:5226 >/dev/null && break; sleep 1; done

echo "== real visitors in a browser"
(cd sdk/browser && pnpm exec playwright test --config test/demo/playwright.config.ts) || echo "some visitors did not finish; the rest are in"

node scripts/demo-setup.mjs after
echo
echo "kimmi is at http://localhost:8700 (sign in with DEV_ACCOUNT_EMAIL from .env)"
echo "the shop it records is at http://localhost:5225; webhook deliveries are in $LOGS/webhook.log"
