import http.server, json, sys
LOG = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n)
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
        if self.path.startswith("/carbon"):
            ok = self.headers.get("auth-token") == "test-key"
            self.send_response(200 if ok else 401); self._cors()
            self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"zone": "IN-SO", "carbonIntensity": 650} if ok else {"message": "Invalid auth-token"}).encode())
            return
        self.send_response(404); self.end_headers()
http.server.ThreadingHTTPServer(("127.0.0.1", 8812), H).serve_forever()
