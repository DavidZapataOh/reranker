"""Plate con gpt-image-2.5-sunburst /v1/images/edits, fondo transparente. Uso: gen_plate.py <ref.png> <prompt.txt> <out.png> <size>"""
import base64, json, os, sys, uuid, urllib.request
KEY = next(l.split("=",1)[1].strip().strip('"') for l in open("/home/david/reranker/.env") if l.startswith("OPENAI_API_KEY="))
ref, pf, out, size = sys.argv[1:5]
b = uuid.uuid4().hex; parts=[]
def f(n,v): parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{n}"\r\n\r\n{v}\r\n'.encode())
for k,v in [("model","gpt-image-2.5-sunburst"),("prompt",open(pf).read()),("size",size),("quality","high"),("background","transparent"),("output_format","png"),("n","1")]: f(k,v)
parts.append(f'--{b}\r\nContent-Disposition: form-data; name="image[]"; filename="ref.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+open(ref,"rb").read()+b"\r\n")
parts.append(f"--{b}--\r\n".encode())
req=urllib.request.Request("https://api.openai.com/v1/images/edits",data=b"".join(parts),headers={"Authorization":f"Bearer {KEY}","Content-Type":f"multipart/form-data; boundary={b}"})
try:
    d=json.load(urllib.request.urlopen(req,timeout=900))
except urllib.error.HTTPError as e: sys.exit(f"HTTP {e.code} {e.read()[:400]!r}")
open(out,"wb").write(base64.b64decode(d["data"][0]["b64_json"])); print("ok",out)
