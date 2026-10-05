#!/bin/bash
# Double-click this file (macOS) to start the ALDAcon Karaoke player.
# It serves this folder on http://localhost:8765 and opens it in Chrome.
# Close this window (or press Ctrl+C) to stop.
cd "$(dirname "$0")" || exit 1
PORT=8765
URL="http://localhost:$PORT/index.html"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found — opening the player directly from disk instead."
  echo "(Click 'Choose the songs folder…' in the player when asked.)"
  open -a "Google Chrome" "index.html" 2>/dev/null || open "index.html"
  exit 0
fi

if ! curl -s -o /dev/null "$URL"; then
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null "$URL" && break; sleep 0.3; done
fi

open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
echo "ALDAcon Karaoke is running at $URL"
echo "Leave this window open while singing. Close it to stop."
wait
