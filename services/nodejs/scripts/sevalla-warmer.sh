#!/bin/bash
# Trigger cache warmer on Sevalla via API exec

APP_ID="73d65fa7-eff3-4382-ab89-aa95f795ffa5"
PROCESS_ID="527976bf-8fc1-4c4f-90e6-d1b81a3fa6d2"
API_KEY="svl_570f93edd991bc4f9c38c00012536840da5b35e61e5fe1b2de26d5b79f62ea26"
# Run warmer in background via shell (exec API has 60s max timeout; warmer takes ~18min)
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "https://api.sevalla.com/v3/applications/${APP_ID}/processes/${PROCESS_ID}/exec" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"command":["sh","-c","nohup npm run warmer >/tmp/warmer-output.log 2>&1 &"],"timeout":5}')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "✓ Warmer triggered successfully (HTTP ${HTTP_CODE})"
  echo "$BODY" | python3 -c "
import sys,json
d=json.load(sys.stdin)
out = d.get('stdout','') or d.get('output','')
err = d.get('stderr','') or d.get('error','')
if out: print(out)
if err: print('stderr:', err)
"
else
  echo "✗ Failed to trigger warmer (HTTP ${HTTP_CODE})"
  echo "$BODY"
fi
