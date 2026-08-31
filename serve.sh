#!/bin/bash
# Serves the tracker over a trusted HTTPS URL so a phone can use geolocation.
cd "$(dirname "$0")"
python3 -m http.server 8787 >/dev/null 2>&1 &
SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
echo "open the https://….trycloudflare.com URL below on your phone:"
cloudflared tunnel --url http://localhost:8787
