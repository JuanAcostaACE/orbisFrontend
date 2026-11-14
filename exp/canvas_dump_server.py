import http.server, os, sys
IMG, OUT, SITE = sys.argv[1:4]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.lstrip('/')
        f = os.path.join(SITE, p) if p in ('page.html','dataset.json') else os.path.join(IMG, os.path.basename(p))
        if not os.path.isfile(f): self.send_error(404); return
        b = open(f,'rb').read()
        self.send_response(200); self.send_header('Content-Type','text/html' if f.endswith('.html') else 'application/octet-stream'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers['Content-Length']); b = self.rfile.read(n)
        open(os.path.join(OUT, os.path.basename(self.path)+'.rgba'),'wb').write(b)
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',8765),H).serve_forever()
