"""Render final de um projeto salvo no app (DeLeon Mask → "Salvar projeto").

Usa o SAM 2.1 em modo vídeo (memória completa entre frames): cada grupo de objetos é semeado
no frame onde foi marcado e propagado para frente e para trás. Gera, por camada, ProRes 422 HQ,
MP4 e sequência PNG 8-bit, mais a máscara combinada — mesmo número de frames, fps e resolução.

    python3 engine/deleon_mask.py VIDEO.mp4 --projeto VIDEO_projeto.json --sam l --out saida/
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

import cv2
import numpy as np

import deleon_mask as dm


def _slug(s):
    import unicodedata
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    return dm.slug(s) or "camada"


def render(video: str, projfile: str, out: str | None, sam: str = "b", formatos: str = "mov,mp4,png") -> int:
    from ultralytics.models.sam import SAM2VideoPredictor
    t0 = time.time()
    proj = json.loads(Path(projfile).read_text())
    info = dm.probe(video)
    W, H, fps = info["width"], info["height"], info["fps"]
    if (W, H) != (proj["video"]["largura"], proj["video"]["altura"]):
        raise SystemExit(f"O projeto é de um vídeo {proj['video']['largura']}×{proj['video']['altura']}, este é {W}×{H}.")
    N = dm.count_frames(video)
    layers = [L for L in proj["camadas"] if L.get("ligada", True)]
    lid = {L["id"]: L for L in layers}
    objs = [o for o in proj["objetos"] if o.get("ligado", True) and o["camada"] in lid]
    if not objs:
        raise SystemExit("O projeto não tem objetos marcados. Analise um frame ou marque com pins/caixas no app.")
    weight = dm.ensure_weight({"t": "sam2.1_t.pt", "s": "sam2.1_s.pt", "b": "sam2.1_b.pt", "l": "sam2.1_l.pt"}[sam])
    print(f"Projeto: {len(layers)} camada(s), {len(objs)} objeto(s), {N} frames {W}x{H} · {Path(weight).name}", flush=True)

    # acumuladores por camada: positivos e negativos (bits empacotados por frame)
    acc = {L["id"]: {"pos": [None] * N, "neg": [None] * N} for L in layers}

    def add(layer, key, fi, m):
        pk = np.packbits(m.reshape(-1))
        cur = acc[layer][key][fi]
        acc[layer][key][fi] = pk if cur is None else (cur | pk)

    tmp = Path(tempfile.mkdtemp(prefix="dlmask_proj_"))
    enc = ["-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv444p"]
    groups: dict[int, list] = {}
    for o in objs:
        groups.setdefault(int(o["nascimento"]), []).append(o)
    try:
        for f, group in sorted(groups.items()):
            boxes = [list(map(float, o["caixa"])) for o in group]
            print(f"Frame {f}: {len(group)} objeto(s) → propagando", flush=True)
            for direction in (1, -1):
                if direction < 0 and f == 0:
                    continue
                clip = tmp / f"f{f}_{'fwd' if direction > 0 else 'bwd'}.mp4"
                vf = f"select='gte(n\\,{f})'" if direction > 0 else f"select='lte(n\\,{f})',reverse"
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", video, "-vf", vf, "-fps_mode", "passthrough"] + enc + [str(clip)], check=True)
                p = SAM2VideoPredictor(overrides=dict(conf=0.25, task="segment", mode="predict", imgsz=1024, model=weight,
                                                      verbose=False, save=False, device=dm.device()))
                for j, r in enumerate(p(source=str(clip), bboxes=boxes, stream=True)):
                    fi = f + j * direction
                    if not (0 <= fi < N) or r.masks is None:
                        continue
                    md = r.masks.data.cpu().numpy() > 0.5
                    for o, m in zip(group, md):
                        add(o["camada"], "neg" if o.get("subtrai") else "pos", fi, m)
                    if (j + 1) % 20 == 0:
                        print(f"  {'frente' if direction > 0 else 'trás'}: {j + 1} frames · {time.time() - t0:.0f} s", flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # saídas
    P = proj.get("parametros", {})
    out_dir = Path(out or f"{Path(video).with_suffix('')}_render")
    out_dir.mkdir(parents=True, exist_ok=True)
    base = _slug(Path(video).stem)
    fmts = {x.strip() for x in formatos.split(",")}
    names = {L["id"]: _slug(L["nome"]) for L in layers}
    outputs = list(layers) + ([{"id": "__all", "nome": "tudo"}] if len(layers) > 1 else [])
    writers = {}
    for L in outputs:
        nm = names.get(L["id"], "tudo")
        ws, png = [], None
        if "mov" in fmts:
            ws.append(dm.Writer(out_dir / f"{base}_{nm}_prores.mov", W, H, fps, "gray",
                                ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"] + dm.BT709, info["timecode"]))
        if "mp4" in fmts:
            ws.append(dm.Writer(out_dir / f"{base}_{nm}.mp4", W, H, fps, "gray",
                                ["-c:v", "libx264", "-crf", "8", "-preset", "medium", "-pix_fmt", "yuv420p"] + dm.BT709 + ["-movflags", "+faststart"], info["timecode"]))
        if "png" in fmts:
            png = out_dir / f"{base}_{nm}_png"; png.mkdir(exist_ok=True)
        writers[L["id"]] = (ws, png, nm)

    def unpack(pk):
        return np.unpackbits(pk)[: W * H].reshape(H, W).astype(np.float32) if pk is not None else np.zeros((H, W), np.float32)

    grow, feather, invert = int(P.get("grow", 0)), float(P.get("feather", 0)), bool(P.get("invert", False))
    for i in range(N):
        finals = {}
        for L in layers:
            q = unpack(acc[L["id"]]["pos"][i]) * (1 - unpack(acc[L["id"]]["neg"][i]))
            par = L.get("parte_de")
            if par and par in acc:  # partes só dentro do inteiro
                pm = unpack(acc[par]["pos"][i])
                q *= cv2.dilate(pm, np.ones((7, 7), np.uint8))
            if grow:
                k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * abs(grow) + 1,) * 2)
                q = cv2.dilate(q, k) if grow > 0 else cv2.erode(q, k)
            if feather > 0:
                q = cv2.GaussianBlur(q, (0, 0), feather)
            finals[L["id"]] = q
        if len(layers) > 1:
            finals["__all"] = np.max(np.stack(list(finals.values())), 0)
        for key, q in finals.items():
            m8 = np.clip((1 - q if invert else q) * 255 + 0.5, 0, 255).astype(np.uint8)
            ws, png, nm = writers[key]
            for w in ws:
                w.write(m8)
            if png is not None:
                cv2.imwrite(str(png / f"{base}_{nm}_{i:05d}.png"), m8)
    for ws, png, nm in writers.values():
        for w in ws:
            w.close()
        if png is not None:
            with zipfile.ZipFile(png.with_suffix(".zip"), "w", zipfile.ZIP_STORED) as z:
                for f in sorted(png.glob("*.png")):
                    z.write(f, f"{png.name}/{f.name}")
    # conferência
    first = next((w.path for ws, _, _ in writers.values() for w in ws), None)
    ok = True
    if first:
        n2 = dm.count_frames(str(first)); pi = dm.probe(str(first))
        ok = n2 == N and (pi["width"], pi["height"]) == (W, H) and pi["fps"] == fps
        print(json.dumps({"frames_original": N, "frames_saida": n2, "resolucao_ok": (pi["width"], pi["height"]) == (W, H), "fps_ok": pi["fps"] == fps}), flush=True)
    print(f"Pronto em {time.time() - t0:.0f} s → {out_dir}", flush=True)
    return 0 if ok else 2
