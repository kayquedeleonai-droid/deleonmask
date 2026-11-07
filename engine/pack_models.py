#!/usr/bin/env python3
"""Empacota os modelos do app em partes de 14 MB com o hash no nome (cache nunca mistura versões).
Uso: python3 engine/pack_models.py <pasta_com_os_modelos> public
Cada arquivo <nome>.onnx|.bin vira public/m/<nome>.<hash8>.p<N>.wasm e entra em public/models.json
({nome: {hash, size, parts}}). Partes antigas que não estão no manifesto são apagadas."""
import hashlib, json, sys
from pathlib import Path
src, pub = Path(sys.argv[1]), Path(sys.argv[2]); out = pub / "m"; out.mkdir(parents=True, exist_ok=True)
PART = 14_000_000; man = {}; keep = set()
for f in sorted(src.iterdir()):
    if f.suffix not in (".onnx", ".bin"): continue
    data = f.resolve().read_bytes(); h = hashlib.sha256(data).hexdigest()[:8]; name = f.stem; parts = []
    for i in range(0, len(data), PART):
        p = out / f"{name}.{h}.p{i // PART}.wasm"; parts.append(f"m/{p.name}"); keep.add(p.name)
        if not p.exists() or p.stat().st_size != len(data[i:i + PART]): p.write_bytes(data[i:i + PART])
    man[name] = {"hash": h, "size": len(data), "parts": parts}
for p in out.glob("*.wasm"):
    if p.name not in keep and p.name.split(".")[0] != "ortjsep": p.unlink()
(out / "models.json").unlink(missing_ok=True)
(pub / "models.json").write_text(json.dumps(man, indent=1))
print({k: (v["hash"], len(v["parts"])) for k, v in man.items()})
