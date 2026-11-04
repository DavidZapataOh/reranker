"""Genera comps con gpt-image-2.5-sunburst (/v1/images/edits) usando el logo como referencia.
Uso: ~/.venvs/brand/bin/python gen_comp.py <out.png> <prompt.txt> [size]
Lee OPENAI_API_KEY de /home/david/reranker/.env (nunca lo imprime).
"""
import base64, json, os, sys, uuid, urllib.request

ENV = "/home/david/reranker/.env"
KEY = next(l.split("=", 1)[1].strip().strip('"') for l in open(ENV) if l.startswith("OPENAI_API_KEY="))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REFS = [os.path.join(ROOT, "apps/web/public/brand/reranker-horizontal-black-1200.png")]

out, prompt_file = sys.argv[1], sys.argv[2]
size = sys.argv[3] if len(sys.argv) > 3 else "1536x1024"
prompt = open(prompt_file).read()

boundary = uuid.uuid4().hex
parts = []
def field(name, value):
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
for k, v in [("model", "gpt-image-2.5-sunburst"), ("prompt", prompt), ("size", size), ("quality", "high"), ("n", "1")]:
    field(k, v)
for p in REFS:
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="{os.path.basename(p)}"\r\nContent-Type: image/png\r\n\r\n'.encode() + open(p, "rb").read() + b"\r\n")
parts.append(f"--{boundary}--\r\n".encode())
req = urllib.request.Request("https://api.openai.com/v1/images/edits", data=b"".join(parts),
                             headers={"Authorization": f"Bearer {KEY}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
try:
    with urllib.request.urlopen(req, timeout=900) as r:
        d = json.load(r)
except urllib.error.HTTPError as e:
    sys.exit(f"HTTP {e.code} {e.read()[:400]!r}")
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
open(out, "wb").write(base64.b64decode(d["data"][0]["b64_json"]))
print("ok", out)
