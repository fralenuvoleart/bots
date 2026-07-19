#!/bin/bash
# Trigger cache warmer on Sevalla via API exec

APP_ID="73d65fa7-eff3-4382-ab89-aa95f795ffa5"
PROCESS_ID="527976bf-8fc1-4c4f-90e6-d1b81a3fa6d2"
API_KEY="svl_570f93edd991bc4f9c38c00012536840da5b35e61e5fe1b2de26d5b79f62ea26"
TIMEOUT="${1:-300}"

curl -s -X POST "https://api.sevalla.com/v3/applications/${APP_ID}/processes/${PROCESS_ID}/exec" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"command\":[\"npm\",\"run\",\"warmer\"],\"timeout\":${TIMEOUT}}" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stdout','')); print(d.get('stderr',''), end='')"
