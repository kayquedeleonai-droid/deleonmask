#!/usr/bin/env python3
"""Monta public/index.html a partir de app/ui.html + app/js/*.js (+ dicionário PT→EN)."""
from pathlib import Path
R = Path(__file__).resolve().parent.parent
ui = (R / "app/ui.html").read_text()
js = "\n".join(p.read_text() for p in sorted((R / "app/js").glob("*.js")))
js = js.replace("/*PT_EN*/{}", (R / "app/js/pt_en.json").read_text())
body = ui.replace("/*APP_JS*/", js)
# título, fontes e estilo no <head>
cut = body.index("</style>") + len("</style>")
head, rest = body[:cut], body[cut:]
html = ('<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="description" content="Máscaras preto e branco de vídeo por texto, pins e caixas, frame a frame, no seu navegador.">\n'
        + head + "\n</head>\n<body>\n" + rest + "\n</body>\n</html>\n")
(R / "public/index.html").write_text(html)
print("ok: public/index.html", len(html)//1024, "KB")
