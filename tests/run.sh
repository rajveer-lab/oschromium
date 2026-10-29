#!/bin/bash
# Run the test suite in real Chromium under Xvfb (Linux).
#   tests/build.sh && tests/run.sh
# Set CHROME to a Chromium or Chrome for Testing binary (branded Google Chrome
# no longer loads unpacked extensions from the command line).
T=$(dirname "$(readlink -f "$0")")
CHROME=${CHROME:-$(command -v chromium || command -v chromium-browser || ls /opt/pw-browsers/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)}
cd "$T"
rm -rf prof log.jsonl chrome.log
: > log.jsonl
pgrep -f "Xvfb :9[9]" >/dev/null || (Xvfb :99 -screen 0 1600x2400x24 >xvfb.log 2>&1 &)
python3 collector.py "$T/log.jsonl" >collector.log 2>&1 & C=$!
python3 -m http.server 8813 --bind 127.0.0.1 --directory "$T/site" >site.log 2>&1 & S=$!
sleep 1.5
DISPLAY=:99 "$CHROME" --user-data-dir="$T/prof" --no-first-run --no-default-browser-check \
  --no-sandbox --test-type --disable-extensions-except="$T/ext" --load-extension="$T/ext" \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
  --enable-logging=stderr --v=0 --window-size=1400,1300 --window-position=0,0 \
  "chrome-extension://$(cat extid)/test.html" >chrome.log 2>&1 & B=$!
for i in $(seq 1 ${1:-480}); do grep -q '"done"' log.jsonl 2>/dev/null && break; sleep 1; done
sleep 1
kill $B $C $S 2>/dev/null; sleep 1
python3 -c "
import json
for l in open('$T/log.jsonl'):
    l = l.strip()
    if l and 'log' in json.loads(l): print(json.loads(l)['log'][:400])
"
echo '--- extension errors in the browser log:'
grep -aE 'CONSOLE|Uncaught' chrome.log | grep -aiE 'error|uncaught' | head -30
