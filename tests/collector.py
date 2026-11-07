import http.server, json, os, sys, time, urllib.parse
LOG = sys.argv[1]
SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")
RELAY = []      # stand-in for the ntfy relay: every message published, oldest first
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def _json(self, obj, lines=False):
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(("".join(json.dumps(o) + "\n" for o in obj) if lines else json.dumps(obj)).encode())
    def _publish(self, topic, message, age=0):
        m = {"id": "m%d" % (len(RELAY) + 1), "time": int(time.time()) - age, "event": "message", "topic": topic, "message": message}
        RELAY.append(m)
        return m
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n)
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/relay/"):
            age = int(urllib.parse.parse_qs(u.query).get("age", ["0"])[0])
            self._json(self._publish(u.path.split("/")[2], body.decode(), age)); return
        try:
            o = json.loads(body)
            if "png" in o:
                import base64, os
                open(os.path.join(os.path.dirname(LOG), o["name"]), "wb").write(base64.b64decode(o["png"].split(",", 1)[1]))
                body = json.dumps({"saved": o["name"]}).encode()
        except Exception:
            pass
        with open(LOG, "ab") as f: f.write(body + b"\n")
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b"ok")
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/relay/"):       # /relay/<topic>/json?poll=1 or /relay/<topic>/trigger
            parts = u.path.split("/")
            if parts[-1] == "trigger":
                self._json(self._publish(parts[2], "triggered")); return
            if parts[-1] == "json":            # every message, however old: the extension must skip stale ones
                self._json([m for m in RELAY if m["topic"] == parts[2]], lines=True); return
            self.send_response(404); self.end_headers(); return
        if u.path == "/watch":                 # a video page at YouTube's address shape, for t=
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
            self.wfile.write(open(os.path.join(SITE, "tube.html"), "rb").read()); return
        if self.path.startswith("/carbon"):
            ok = self.headers.get("auth-token") == "test-key"
            self.send_response(200 if ok else 401); self._cors()
            self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"zone": "IN-SO", "carbonIntensity": 650} if ok else {"message": "Invalid auth-token"}).encode())
            return
        self.send_response(404); self.end_headers()
http.server.ThreadingHTTPServer(("127.0.0.1", 8812), H).serve_forever()
