#!/bin/bash
# Build the test copy of the extension in tests/ext: the real extension, plus
# the test runner, plus local stand-ins for the call sites and the carbon API.
set -e
T=$(dirname "$(readlink -f "$0")")
ROOT=$(dirname "$T")
rm -rf "$T/ext" && mkdir -p "$T/ext"
(cd "$ROOT" && cp -r manifest.json *.js *.html *.css icons "$T/ext/")
cp "$T/harness/test.html" "$T/harness/test.js" "$T/ext/"
cd "$T/ext"
python3 - <<'PY'
import json
m = json.load(open("manifest.json")); m["host_permissions"] = ["<all_urls>"]; json.dump(m, open("manifest.json", "w"), indent=2)
r = open("rules.js").read()
r = r.replace('"https://whereby.com/*",\n];', '"https://whereby.com/*",\n  "http://127.0.0.1/*",\n];')
r = r.replace('export const CARBON_ORIGIN = "https://api.electricitymap.org/*";', 'export const CARBON_ORIGIN = "http://127.0.0.1/*";')
assert '127.0.0.1/*",\n];' in r and 'CARBON_ORIGIN = "http://127.0.0.1' in r
open("rules.js", "w").write(r)
b = open("background.js").read()
old = "https://api.electricitymap.org/v3/carbon-intensity/latest?zone="
assert b.count(old) == 1
open("background.js", "w").write(b.replace(old, "http://127.0.0.1:8812/carbon?zone="))
PY
# an unpacked extension's id is derived from its folder path
python3 -c "
import hashlib
h = hashlib.sha256('$T/ext'.encode()).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in h))" > "$T/extid"
echo "built tests/ext, extension id $(cat "$T/extid")"
