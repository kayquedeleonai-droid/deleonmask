#!/usr/bin/env python3
"""Gera as duas versões do app a partir de app/index.src.html:
- public/index.html  → site próprio (Cloudflare, mask.kayquedeleon.app): libs em /vendor, sem CDN
- artifact/index.html → artefato do Claude (libs pelos CDNs permitidos; o esqueleto HTML é posto pelo Claude)
"""
from pathlib import Path
R = Path(__file__).resolve().parent.parent
src = (R / "app/index.src.html").read_text()

CDN = {
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js": "vendor/ort.webgpu.min.js",
    "https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js": "vendor/mp4box.all.min.js",
    "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.js": "vendor/mp4-muxer.js",
    "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js": "vendor/jszip.min.js",
}
site = src
for a, b in CDN.items():
    assert a in site, a
    site = site.replace(f'src="{a}"', f'src="{b}"')
head = ('<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="description" content="Máscaras preto e branco de vídeo por prompt, frame a frame, no seu navegador.">\n'
        '<script>window.DLM_STANDALONE=true;</script>\n'
        '<style>:root{padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n'
        '</head>\n<body>\n')
(R / "public/index.html").write_text(head + site + "\n</body>\n</html>\n")
(R / "artifact").mkdir(exist_ok=True)
(R / "artifact/index.html").write_text(src)
print("ok: public/index.html, artifact/index.html")
