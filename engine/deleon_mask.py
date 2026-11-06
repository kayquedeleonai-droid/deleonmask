#!/usr/bin/env python3
"""DeLeon Mask — máscaras preto e branco de vídeo a partir de um prompt de texto.

Exemplo:
    python3 deleon_mask.py video.mp4 --prompt "pessoa, -microfone" --out saida/

O prompt é uma lista separada por vírgula. Cada item é um alvo (em inglês ou português;
termos comuns em PT são traduzidos). Prefixo "-" subtrai o alvo da máscara
("pessoa, -microfone" = a pessoa sem o microfone).

Saídas (pasta --out): máscara em MP4 (H.264), MOV (ProRes 422 HQ), sequência PNG 8-bit
(numerada a partir de 00000, 1 PNG por frame do original), prévia com overlay, folha de
contato e relatório JSON. Mesmo número de frames, mesmo fps e mesma resolução do original.
Opcional: --recorte gera o vídeo original com a máscara como canal alfa (ProRes 4444).
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from fractions import Fraction
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
MODELS_DIR = Path(os.environ.get("DELEON_MASK_MODELS", HERE / "models"))
ASSET_URL = "https://github.com/ultralytics/assets/releases/download/v8.3.0/"

# --------------------------------------------------------------------------------------
# Prompt: português -> inglês (o detector entende inglês)
# --------------------------------------------------------------------------------------
PT_EN = {
    "pessoa": "person", "pessoas": "person", "gente": "person", "homem": "person", "mulher": "person",
    "criança": "person", "crianca": "person", "bebê": "person", "bebe": "person", "menino": "person", "menina": "person",
    "rosto": "face", "cara": "face", "cabeça": "head", "cabeca": "head", "cabelo": "hair", "olho": "eye",
    "olhos": "eye", "boca": "mouth", "mão": "hand", "mao": "hand", "mãos": "hand", "maos": "hand",
    "braço": "arm", "braco": "arm", "perna": "leg", "pé": "foot", "pe": "foot", "corpo": "person",
    "roupa": "clothing", "camisa": "shirt", "camiseta": "t-shirt", "calça": "pants", "calca": "pants",
    "bermuda": "shorts", "short": "shorts", "vestido": "dress", "jaqueta": "jacket", "casaco": "coat",
    "sapato": "shoe", "tênis": "sneaker", "tenis": "sneaker", "chinelo": "sandal", "chapéu": "hat",
    "chapeu": "hat", "boné": "cap", "bone": "cap", "óculos": "glasses", "oculos": "glasses",
    "bolsa": "bag", "mochila": "backpack", "relógio": "watch", "relogio": "watch",
    "carro": "car", "carros": "car", "moto": "motorcycle", "motocicleta": "motorcycle",
    "bicicleta": "bicycle", "bike": "bicycle", "ônibus": "bus", "onibus": "bus", "caminhão": "truck",
    "caminhao": "truck", "avião": "airplane", "aviao": "airplane", "barco": "boat", "trem": "train",
    "roda": "wheel", "pneu": "tire", "cachorro": "dog", "cão": "dog", "cao": "dog", "gato": "cat",
    "cavalo": "horse", "pássaro": "bird", "passaro": "bird", "ave": "bird", "peixe": "fish", "vaca": "cow",
    "árvore": "tree", "arvore": "tree", "árvores": "tree", "planta": "plant", "flor": "flower",
    "flores": "flower", "grama": "grass", "folha": "leaf", "céu": "sky", "ceu": "sky", "nuvem": "cloud",
    "nuvens": "cloud", "mar": "sea", "água": "water", "agua": "water", "praia": "beach", "areia": "sand",
    "montanha": "mountain", "chão": "floor", "chao": "floor", "parede": "wall", "teto": "ceiling",
    "prédio": "building", "predio": "building", "casa": "house", "janela": "window", "porta": "door",
    "rua": "road", "estrada": "road", "calçada": "sidewalk", "placa": "sign", "letreiro": "sign",
    "logo": "logo", "logotipo": "logo", "texto": "text", "tela": "screen", "monitor": "monitor",
    "televisão": "television", "televisao": "television", "tv": "television", "celular": "cell phone",
    "telefone": "phone", "notebook": "laptop", "computador": "computer", "teclado": "keyboard",
    "câmera": "camera", "camera": "camera", "microfone": "microphone", "caixa de som": "speaker",
    "alto-falante": "speaker", "fone": "headphones", "violão": "guitar", "violao": "guitar",
    "guitarra": "electric guitar", "cadeira": "chair", "mesa": "table", "sofá": "sofa", "sofa": "sofa",
    "cama": "bed", "garrafa": "bottle", "copo": "cup", "xícara": "mug", "xicara": "mug", "prato": "plate",
    "comida": "food", "bola": "ball", "luminária": "lamp", "luminaria": "lamp", "lâmpada": "light bulb",
    "lampada": "light bulb", "cortina": "curtain", "vaso": "vase", "tripé": "tripod", "tripe": "tripod",
    "bandeira": "flag", "guarda-chuva": "umbrella", "guarda-sol": "umbrella", "fogo": "fire",
    "fumaça": "smoke", "fumaca": "smoke", "produto": "product", "caixa": "box", "lata": "can",
    "cartão": "card", "cartao": "card", "dinheiro": "money", "moeda": "coin", "ímã": "magnet", "ima": "magnet",
}


def translate_term(term: str) -> str:
    t = term.strip().lower()
    if t in PT_EN:
        return PT_EN[t]
    words = t.split()
    if any(w in PT_EN for w in words):  # "camisa vermelha" -> "shirt vermelha" (avisa)
        return " ".join(PT_EN.get(w, w) for w in words)
    return t


def parse_prompt(prompt: str):
    """Retorna lista de dicts {label, query, sign}."""
    targets = []
    for raw in prompt.replace(";", ",").split(","):
        raw = raw.strip()
        if not raw:
            continue
        sign = -1 if raw.startswith("-") else 1
        label = raw.lstrip("-+ ").strip()
        targets.append({"label": label, "query": translate_term(label), "sign": sign})
    if not any(t["sign"] > 0 for t in targets):
        raise SystemExit("O prompt precisa de pelo menos um alvo positivo (sem '-').")
    return targets


# --------------------------------------------------------------------------------------
# Vídeo: leitura/escrita com ffmpeg (ordem exata dos frames, sem duplicar nem descartar)
# --------------------------------------------------------------------------------------
def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,codec_name,pix_fmt,"
         "color_primaries,color_transfer,color_space,sample_aspect_ratio:stream_tags=timecode,rotate"
         ":stream_side_data=rotation:format=duration:format_tags=timecode",
         "-of", "json", path], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    rot = 0
    for sd in s.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if "rotate" in (s.get("tags") or {}):
        rot = int(float(s["tags"]["rotate"]))
    w, h = int(s["width"]), int(s["height"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    r = Fraction(s.get("r_frame_rate", "30/1"))
    a = Fraction(s.get("avg_frame_rate", "0/1")) if s.get("avg_frame_rate", "0/0") != "0/0" else r
    tc = (s.get("tags") or {}).get("timecode") or (j.get("format", {}).get("tags") or {}).get("timecode")
    return {"width": w, "height": h, "fps": r, "avg_fps": a, "vfr": abs(float(r) - float(a)) / max(float(r), 1e-6) > 0.02 and float(a) > 0,
            "nb_frames": int(s["nb_frames"]) if str(s.get("nb_frames", "")).isdigit() else None,
            "duration": float(j.get("format", {}).get("duration", 0) or 0), "timecode": tc,
            "codec": s.get("codec_name"), "sar": s.get("sample_aspect_ratio"),
            "color": {k: s.get(k) for k in ("color_primaries", "color_transfer", "color_space")}}


def count_frames(path: str) -> int:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
                          "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout
    return int(out.strip().split(",")[0])


def read_frames(path: str, w: int, h: int, vf: str | None = None):
    """Gera frames BGR em ordem de decodificação, 1 por frame do arquivo (fps_mode passthrough)."""
    cmd = ["ffmpeg", "-v", "error", "-i", path]
    if vf:
        cmd += ["-vf", vf]
    cmd += ["-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=w * h * 3 * 2)
    n = w * h * 3
    try:
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.wait()


class Writer:
    """Pipe rawvideo -> ffmpeg."""

    def __init__(self, path, w, h, fps: Fraction, pix_in, codec_args, timecode=None):
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", pix_in, "-s", f"{w}x{h}",
               "-r", f"{fps.numerator}/{fps.denominator}", "-i", "-"] + codec_args
        if timecode:
            cmd += ["-timecode", timecode]
        cmd += [str(path)]
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        self.path = path

    def write(self, arr: np.ndarray):
        self.p.stdin.write(np.ascontiguousarray(arr).tobytes())

    def close(self):
        self.p.stdin.close()
        if self.p.wait() != 0:
            raise RuntimeError(f"ffmpeg falhou ao escrever {self.path}")


BT709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]


# --------------------------------------------------------------------------------------
# Modelos
# --------------------------------------------------------------------------------------
def ensure_weight(name: str) -> str:
    p = MODELS_DIR / name
    if not p.exists():
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Baixando {name}…", flush=True)
        subprocess.run(["curl", "-sSLf", "-o", str(p), ASSET_URL + name], check=True)
    return str(p)


def device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    return "cpu"


class Detector:
    def __init__(self, targets, size="l", conf=0.3):
        from ultralytics import YOLOE
        # o encoder de texto (mobileclip) é baixado pelo próprio ultralytics para a pasta de pesos
        ensure_weight("mobileclip_blt.ts")
        os.environ.setdefault("YOLO_OFFLINE", "1")
        from ultralytics.utils import WEIGHTS_DIR
        Path(WEIGHTS_DIR).mkdir(parents=True, exist_ok=True)
        link = Path(WEIGHTS_DIR) / "mobileclip_blt.ts"
        if not link.exists():
            link.symlink_to(MODELS_DIR / "mobileclip_blt.ts")
        self.model = YOLOE(ensure_weight(f"yoloe-11{size}-seg.pt"))
        self.queries = sorted({t["query"] for t in targets})
        self.model.set_classes(self.queries, self.model.get_text_pe(self.queries))
        self.conf = conf
        self.dev = device()

    def __call__(self, frame, want_masks=False):
        r = self.model.predict(frame, conf=self.conf, verbose=False, retina_masks=want_masks,
                               device=self.dev)[0]
        dets = []
        if r.boxes is None or len(r.boxes) == 0:
            return dets
        masks = r.masks.data.cpu().numpy() if (want_masks and r.masks is not None) else None
        for i, (b, c, k) in enumerate(zip(r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy(),
                                          r.boxes.cls.cpu().numpy().astype(int))):
            dets.append({"query": self.queries[k], "box": b.astype(float), "conf": float(c),
                         "mask": masks[i] if masks is not None else None})
        return dets


class Segmenter:
    def __init__(self, quality="alta"):
        from ultralytics import SAM
        self.weight = "sam2.1_b.pt" if quality == "max" else "sam2.1_t.pt"
        self.model = SAM(ensure_weight(self.weight))
        self.dev = device()

    def __call__(self, frame, boxes):
        r = self.model.predict(frame, bboxes=[list(map(float, b)) for b in boxes], verbose=False,
                               device=self.dev)[0]
        return r.masks.data.cpu().numpy().astype(np.float32)


# --------------------------------------------------------------------------------------
# Pós-processamento
# --------------------------------------------------------------------------------------
def postprocess(m: np.ndarray, a) -> np.ndarray:
    """m: float 0..1 (H,W). Retorna float 0..1."""
    h, w = m.shape
    hard = (m >= 0.5).astype(np.uint8)
    if a.min_area > 0:
        n, lab, stats, _ = cv2.connectedComponentsWithStats(hard, 8)
        keep = np.zeros(n, bool)
        keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= a.min_area * h * w
        hard = keep[lab].astype(np.uint8)
    if a.fill_holes:
        inv = (1 - hard).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, 4)
        border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])).tolist())
        holes = np.isin(lab, [i for i in range(1, n) if i not in border])
        hard[holes] = 1
    if a.grow:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * abs(a.grow) + 1,) * 2)
        hard = cv2.dilate(hard, k) if a.grow > 0 else cv2.erode(hard, k)
    out = hard.astype(np.float32)
    if a.feather > 0:
        out = cv2.GaussianBlur(out, (0, 0), a.feather)
    return out


def box_iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0


def select_dets(dets, targets, top):
    """Agrupa detecções por rótulo do usuário; mantém as `top` de maior confiança (0 = todas)."""
    out = {}
    for t in targets:
        d = sorted([x for x in dets if x["query"] == t["query"]], key=lambda x: -x["conf"])
        # remove caixas quase idênticas (mesmo objeto detectado duas vezes)
        kept = []
        for x in d:
            if all(box_iou(x["box"], y["box"]) < 0.85 for y in kept):
                kept.append(x)
        out[t["label"]] = kept[:top] if top > 0 else kept
    return out


# --------------------------------------------------------------------------------------
# Motores
# --------------------------------------------------------------------------------------
def engine_frame(a, info, targets):
    """Detecta + segmenta em cada frame. Lida com objetos que entram/saem de cena."""
    det = Detector(targets, a.detector, a.conf)
    seg = None if a.quality == "rapido" else Segmenter(a.quality)
    W, H = info["width"], info["height"]
    last = {t["label"]: (None, 0) for t in targets}  # (dets, idade) para segurar por --hold frames
    for i, frame in enumerate(read_frames(a.video, W, H)):
        dets = select_dets(det(frame, want_masks=(seg is None)), targets, a.top)
        for t in targets:
            lab = t["label"]
            if dets[lab]:
                last[lab] = (dets[lab], 0)
            elif last[lab][0] is not None and last[lab][1] < a.hold:
                dets[lab] = last[lab][0]
                last[lab] = (last[lab][0], last[lab][1] + 1)
        masks = {}
        if seg is None:
            for lab, ds in dets.items():
                m = np.zeros((H, W), np.float32)
                for d in ds:
                    if d["mask"] is not None:
                        mm = d["mask"]
                        if mm.shape != (H, W):
                            mm = cv2.resize(mm, (W, H), interpolation=cv2.INTER_LINEAR)
                        m = np.maximum(m, mm)
                masks[lab] = m
        else:
            allb = [(lab, d["box"]) for lab, ds in dets.items() for d in ds]
            ms = seg(frame, [b for _, b in allb]) if allb else []
            for lab in dets:
                masks[lab] = np.zeros((H, W), np.float32)
            for (lab, _), m in zip(allb, ms):
                masks[lab] = np.maximum(masks[lab], m)
        yield i, frame, masks, {k: [round(d["conf"], 3) for d in v] for k, v in dets.items()}


def engine_video(a, info, targets):
    """SAM 2.1 com memória: semeia no melhor frame e propaga para frente e para trás.
    Mais estável no tempo para 1–poucos objetos que ficam em cena."""
    from ultralytics.models.sam import SAM2VideoPredictor
    W, H = info["width"], info["height"]
    if a.box:
        seeds, best = parse_boxes(a.box, targets)
        print(f"Sementes manuais no frame {best}: {len(seeds)} caixa(s)", flush=True)
    else:
        seeds, best = find_seeds(a, info, targets)
    yield from propagate(a, info, targets, seeds, best)


def parse_boxes(specs, targets):
    lab = next(t["label"] for t in targets if t["sign"] > 0)
    seeds, frames = [], set()
    for sp in specs:
        lab_i = lab
        if "=" in sp:
            lab_i, sp = sp.split("=", 1)
        fr = 0
        if "@" in sp:
            sp, fr = sp.split("@")
            fr = int(fr)
        frames.add(fr)
        seeds.append((lab_i.strip(), np.array([float(v) for v in sp.split(",")])))
    if len(frames) > 1:
        raise SystemExit("Todas as caixas --box precisam estar no mesmo frame (@N).")
    known = {t["label"] for t in targets}
    for l, _ in seeds:
        if l not in known:
            raise SystemExit(f"Rótulo '{l}' do --box não está no prompt.")
    return seeds, frames.pop()


def numbered(dets_by_label):
    """Lista estável [(id, label, det)] — a mesma numeração do --listar e do --pick."""
    out, k = [], 1
    for lab, ds in dets_by_label.items():
        for d in ds:
            out.append((k, lab, d))
            k += 1
    return out


def find_seeds(a, info, targets):
    W, H = info["width"], info["height"]
    det = Detector(targets, a.detector, a.conf)
    # 1) frame-chave: maior soma de confiança dos alvos (varre a cada --stride frames)
    best, best_score, best_dets, n = 0, -1, None, 0
    for i, frame in enumerate(read_frames(a.video, W, H)):
        n = i + 1
        if a.keyframe is not None and i != a.keyframe:
            continue
        if a.keyframe is None and i % a.stride:
            continue
        d = select_dets(det(frame), targets, a.top)
        sc = sum(x["conf"] for v in d.values() for x in v)
        if sc > best_score:
            best, best_score, best_dets = i, sc, d
    if not best_dets or best_score <= 0:
        raise SystemExit("Nenhum alvo do prompt foi encontrado no vídeo. Tente outro termo ou --conf menor.")
    lst = numbered(best_dets)
    if getattr(a, "pick", None):
        ids = {int(x) for x in a.pick.split(",")}
        lst = [x for x in lst if x[0] in ids]
    seeds = [(lab, d["box"]) for _, lab, d in lst]
    print(f"Frame-chave {best}: " + ", ".join(f"#{k} {lab} ({d['conf']:.2f})" for k, lab, d in lst), flush=True)
    a._best_dets = best_dets
    return seeds, best


def propagate(a, info, targets, seeds, best):
    from ultralytics.models.sam import SAM2VideoPredictor
    W, H = info["width"], info["height"]
    weight = ensure_weight("sam2.1_b.pt" if a.quality == "max" else "sam2.1_t.pt")
    tmp = Path(tempfile.mkdtemp(prefix="dlmask_"))
    store: dict[int, dict[str, np.ndarray]] = {}

    def run(clip, order):
        p = SAM2VideoPredictor(overrides=dict(conf=0.25, task="segment", mode="predict", imgsz=1024,
                                              model=weight, verbose=False, save=False, device=device()))
        for j, r in enumerate(p(source=str(clip), bboxes=[list(map(float, b)) for _, b in seeds], stream=True)):
            fi = order(j)
            md = r.masks.data.cpu().numpy() if r.masks is not None else np.zeros((len(seeds), H, W))
            per = {}
            for (lab, _), m in zip(seeds, md):
                cur = per.get(lab)
                mm = (m > 0.5)
                per[lab] = mm if cur is None else (cur | mm)
            store[fi] = {k: np.packbits(v) for k, v in per.items()}
            if (j + 1) % 10 == 0:
                print(f"  propagação: {j + 1} frames", flush=True)

    enc = ["-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv444p"]
    fwd = tmp / "fwd.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.video, "-vf", f"select='gte(n\\,{best})'",
                    "-fps_mode", "passthrough"] + enc + [str(fwd)], check=True)
    run(fwd, lambda j: best + j)
    if best > 0:
        bwd = tmp / "bwd.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.video, "-vf",
                        f"select='lte(n\\,{best})',reverse", "-fps_mode", "passthrough"] + enc + [str(bwd)],
                       check=True)
        run(bwd, lambda j: best - j)
    shutil.rmtree(tmp, ignore_errors=True)
    for i, frame in enumerate(read_frames(a.video, W, H)):
        masks = {}
        for t in targets:
            pk = store.get(i, {}).get(t["label"])
            masks[t["label"]] = (np.unpackbits(pk)[: H * W].reshape(H, W).astype(np.float32)
                                 if pk is not None else np.zeros((H, W), np.float32))
        yield i, frame, masks, {"keyframe": best}


# --------------------------------------------------------------------------------------
# Principal
# --------------------------------------------------------------------------------------
def combine(masks, targets, only=None):
    H, W = next(iter(masks.values())).shape
    pos = np.zeros((H, W), np.float32)
    neg = np.zeros((H, W), np.float32)
    for t in targets:
        if t["sign"] > 0 and (only is None or t["label"] == only):
            pos = np.maximum(pos, masks[t["label"]])
        elif t["sign"] < 0:
            neg = np.maximum(neg, masks[t["label"]])
    return np.clip(pos - neg, 0, 1)


def slug(s):
    keep = "".join(c if c.isalnum() else "_" for c in s.lower()).strip("_")
    return keep or "alvo"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--prompt", required=True, help='ex.: "pessoa, -microfone" ou "car, road"')
    ap.add_argument("--out", default=None, help="pasta de saída (padrão: <video>_mascaras)")
    ap.add_argument("--engine", choices=["frame", "video"], default="frame",
                    help="frame = detecta em cada frame (padrão); video = SAM 2 com memória (mais estável)")
    ap.add_argument("--quality", choices=["rapido", "alta", "max"], default="alta")
    ap.add_argument("--detector", choices=["s", "l"], default="l", help="YOLOE small ou large")
    ap.add_argument("--conf", type=float, default=0.3, help="confiança mínima da detecção")
    ap.add_argument("--top", type=int, default=0, help="máx. de objetos por alvo (0 = todos)")
    ap.add_argument("--hold", type=int, default=4, help="frames para segurar a última detecção se ela falhar")
    ap.add_argument("--stride", type=int, default=5, help="(engine video) busca do frame-chave a cada N frames")
    ap.add_argument("--keyframe", type=int, default=None, help="(engine video) força o frame-chave")
    ap.add_argument("--grow", type=int, default=0, help="px para expandir (+) ou contrair (-) a máscara")
    ap.add_argument("--feather", type=float, default=0, help="suavização da borda (sigma em px)")
    ap.add_argument("--smooth", type=int, default=0, help="média temporal ±N frames (anti-tremido)")
    ap.add_argument("--fill-holes", action="store_true")
    ap.add_argument("--min-area", type=float, default=0.0005, help="descarta ilhas menores que esta fração do quadro")
    ap.add_argument("--invert", action="store_true", help="inverte (fundo branco, alvo preto)")
    ap.add_argument("--separar", action="store_true", help="além da máscara combinada, uma máscara por alvo")
    ap.add_argument("--recorte", action="store_true", help="original com a máscara como alfa (ProRes 4444)")
    ap.add_argument("--formatos", default="mp4,mov,png", help="mp4,mov,png (qualquer combinação)")
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--listar", action="store_true",
                    help="só mostra o frame-chave com os objetos numerados (#1, #2…) e sai")
    ap.add_argument("--pick", default=None, help='usa só estes objetos do --listar, ex.: "1,3" (engine video)')
    ap.add_argument("--box", action="append", default=[],
                    help='caixa manual "x1,y1,x2,y2@frame" ou "rotulo=x1,y1,x2,y2@frame" (repetível; engine video)')
    a = ap.parse_args(argv)

    t0 = time.time()
    targets = parse_prompt(a.prompt)
    info = probe(a.video)
    W, H, fps = info["width"], info["height"], info["fps"]
    src = Path(a.video)
    out = Path(a.out or f"{src.with_suffix('')}_mascaras")
    out.mkdir(parents=True, exist_ok=True)
    base = slug(src.stem)
    fmts = {f.strip() for f in a.formatos.split(",")}
    print(f"Vídeo: {W}x{H} @ {float(fps):.3f} fps, {info['nb_frames'] or '?'} frames"
          + (" (VFR: saída em fps constante)" if info["vfr"] else ""), flush=True)
    print("Alvos: " + ", ".join(("−" if t["sign"] < 0 else "+") + f"{t['label']} → '{t['query']}'"
                                for t in targets), flush=True)

    layers = [("mascara", None)]
    if a.separar:
        layers += [(slug(t["label"]), t["label"]) for t in targets if t["sign"] > 0]
    writers = {}
    for name, _ in layers:
        d = out if name == "mascara" else out / name
        d.mkdir(parents=True, exist_ok=True)
        ws = []
        stem = f"{base}_{name}"
        if "mp4" in fmts:
            ws.append(Writer(d / f"{stem}.mp4", W, H, fps, "gray",
                             ["-c:v", "libx264", "-crf", "8", "-preset", "medium", "-pix_fmt", "yuv420p",
                              "-tune", "grain"] + BT709 + ["-movflags", "+faststart"], info["timecode"]))
        if "mov" in fmts:
            ws.append(Writer(d / f"{stem}_prores.mov", W, H, fps, "gray",
                             ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0",
                              "-pix_fmt", "yuv422p10le"] + BT709, info["timecode"]))
        png_dir = None
        if "png" in fmts:
            png_dir = d / f"{stem}_png"
            png_dir.mkdir(exist_ok=True)
        writers[name] = (ws, png_dir, stem)
    alpha_w = None
    if a.recorte:
        alpha_w = Writer(out / f"{base}_recorte_alpha.mov", W, H, fps, "bgra",
                         ["-c:v", "prores_ks", "-profile:v", "4444", "-vendor", "apl0",
                          "-pix_fmt", "yuva444p10le", "-alpha_bits", "16"] + BT709, info["timecode"])
    pw = None
    if not a.no_preview:
        sc = min(1.0, 960 / max(W, H))
        pW, pH = int(W * sc) // 2 * 2, int(H * sc) // 2 * 2
        pw = Writer(out / f"{base}_previa_overlay.mp4", pW * 2, pH, fps, "bgr24",
                    ["-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                     "-movflags", "+faststart"])

    if a.listar:
        seeds, best = find_seeds(a, info, targets)
        frame = next(f for i, f in enumerate(read_frames(a.video, W, H)) if i == best).copy()
        lw = max(2, round(max(W, H) / 600))
        rows = []
        for k, lab, d in numbered(a._best_dets):
            x1, y1, x2, y2 = d["box"].astype(int)
            col = (60, 220, 60) if any(t["label"] == lab and t["sign"] > 0 for t in targets) else (60, 60, 230)
            cv2.rectangle(frame, (x1, y1), (x2, y2), col, lw)
            cv2.putText(frame, f"#{k} {lab} {d['conf']:.2f}", (x1 + 4, max(y1 - 8, 24)),
                        cv2.FONT_HERSHEY_SIMPLEX, lw * 0.45, col, lw)
            rows.append({"id": k, "alvo": lab, "conf": round(d["conf"], 3), "box": [int(v) for v in d["box"]]})
        cv2.imwrite(str(out / f"{base}_deteccoes_f{best}.jpg"), frame)
        (out / f"{base}_deteccoes.json").write_text(json.dumps({"frame": best, "objetos": rows}, ensure_ascii=False, indent=1))
        print(json.dumps({"frame": best, "objetos": rows}, ensure_ascii=False))
        for ws, _, _ in writers.values():
            for w in ws:
                w.p.stdin.close(); w.p.wait(); Path(w.path).unlink(missing_ok=True)
        for x in (alpha_w, pw):
            if x:
                x.p.stdin.close(); x.p.wait(); Path(x.path).unlink(missing_ok=True)
        for _, png_dir, _ in writers.values():
            if png_dir:
                shutil.rmtree(png_dir, ignore_errors=True)
        return 0
    if a.box or a.pick:
        a.engine = "video"
    gen = (engine_video if a.engine == "video" else engine_frame)(a, info, targets)
    report = {"video": str(src.name), "width": W, "height": H, "fps": f"{fps.numerator}/{fps.denominator}",
              "prompt": a.prompt, "alvos": targets, "engine": a.engine, "quality": a.quality,
              "frames": [], "args": {k: v for k, v in vars(a).items() if k != "video"}}
    sheet = []
    n_out = 0

    def emit(i, frame, masks, meta):
        nonlocal n_out
        for name, only in layers:
            m = postprocess(combine(masks, targets, only), a)
            if a.invert:
                m = 1 - m
            m8 = np.clip(m * 255 + 0.5, 0, 255).astype(np.uint8)
            ws, png_dir, stem = writers[name]
            for w in ws:
                w.write(m8)
            if png_dir is not None:
                cv2.imwrite(str(png_dir / f"{stem}_{i:05d}.png"), m8)
            if name == "mascara":
                cov = float(m8.mean() / 255)
                report["frames"].append({"i": i, "cobertura": round(cov, 4), "det": meta})
                if alpha_w is not None:
                    alpha_w.write(np.dstack([frame, m8]))
                if pw is not None:
                    small = cv2.resize(frame, (pW, pH), interpolation=cv2.INTER_AREA)
                    ms = cv2.resize(m8, (pW, pH), interpolation=cv2.INTER_AREA).astype(np.float32)[..., None] / 255
                    tint = small.astype(np.float32) * (1 - 0.55 * ms) + np.array([40, 40, 255], np.float32) * 0.55 * ms
                    edge = cv2.Canny(cv2.resize(m8, (pW, pH)), 60, 120) > 0
                    tint[edge] = (255, 255, 255)
                    pw.write(np.hstack([tint.astype(np.uint8), cv2.cvtColor(cv2.resize(m8, (pW, pH)), cv2.COLOR_GRAY2BGR)]))
                if len(sheet) < 400:
                    sheet.append((i, cv2.resize(frame, (320, int(320 * H / W))), cv2.resize(m8, (320, int(320 * H / W)))))
        n_out += 1
        if n_out % 10 == 0:
            el = time.time() - t0
            tot = info["nb_frames"] or 0
            eta = f", faltam ~{el / n_out * (tot - n_out) / 60:.1f} min" if tot else ""
            print(f"  {n_out}/{tot or '?'} frames ({el / n_out:.1f} s/frame{eta})", flush=True)

    N = max(0, a.smooth)
    buf = collections.OrderedDict()  # índice -> (frame, masks, meta)
    nxt = 0

    def flush_upto(limit):
        nonlocal nxt
        while nxt in buf and nxt <= limit:
            win = [buf[j][1] for j in range(nxt - N, nxt + N + 1) if j in buf]
            fr, ms, me = buf[nxt]
            avg = ms if N == 0 else {k: np.mean([w[k] for w in win], 0) for k in ms}
            emit(nxt, fr, avg, me)
            nxt += 1
            for j in [j for j in buf if j < nxt - N]:
                del buf[j]

    for i, frame, masks, meta in gen:
        buf[i] = (frame, masks, meta)
        flush_upto(i - N)
    flush_upto(10 ** 12)

    for ws, png_dir, stem in writers.values():
        for w in ws:
            w.close()
        if png_dir is not None:
            zp = png_dir.with_suffix(".zip")
            with zipfile.ZipFile(zp, "w", zipfile.ZIP_STORED) as z:
                for f in sorted(png_dir.glob("*.png")):
                    z.write(f, f"{png_dir.name}/{f.name}")
    if alpha_w:
        alpha_w.close()
    if pw:
        pw.close()

    # folha de contato (8 frames distribuídos)
    if sheet:
        idx = np.linspace(0, len(sheet) - 1, min(8, len(sheet))).round().astype(int)
        cols = [np.vstack([sheet[k][1], cv2.cvtColor(sheet[k][2], cv2.COLOR_GRAY2BGR)]) for k in idx]
        for k, c in zip(idx, cols):
            cv2.putText(c, f"f{sheet[k][0]}", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        cv2.imwrite(str(out / f"{base}_folha_contato.jpg"), np.hstack(cols))

    # verificação: mesmo nº de frames, fps e resolução
    src_n = count_frames(a.video)
    checks = {"frames_original": src_n, "frames_mascara": n_out, "ok": n_out == src_n}
    first = writers["mascara"][0][0].path if writers["mascara"][0] else None
    if first:
        pi = probe(str(first))
        checks.update({"frames_arquivo": count_frames(str(first)), "resolucao_ok": (pi["width"], pi["height"]) == (W, H),
                       "fps_ok": pi["fps"] == fps})
        checks["ok"] = checks["ok"] and checks["frames_arquivo"] == src_n and checks["resolucao_ok"] and checks["fps_ok"]
    report["verificacao"] = checks
    report["tempo_s"] = round(time.time() - t0, 1)
    (out / f"{base}_relatorio.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str))
    print(json.dumps(checks, ensure_ascii=False), flush=True)
    print(f"Pronto em {report['tempo_s']} s → {out}", flush=True)
    return 0 if checks["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
