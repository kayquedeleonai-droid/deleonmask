#!/usr/bin/env bash
# Instala o DeLeon Mask (Linux/macOS). Uso: bash setup_mascara.sh [pasta_dos_modelos]
set -e
M="${1:-$(dirname "$0")/models}"; mkdir -p "$M"
PIP="pip install -q"; python3 -m pip --version >/dev/null 2>&1 && PIP="python3 -m pip install -q"
$PIP torch torchvision 2>/dev/null || $PIP --break-system-packages torch torchvision
$PIP ultralytics openai-clip opencv-python-headless 2>/dev/null || $PIP --break-system-packages ultralytics openai-clip opencv-python-headless
U=https://github.com/ultralytics/assets/releases/download/v8.3.0
for f in yoloe-11l-seg.pt yoloe-11s-seg.pt sam2.1_t.pt sam2.1_b.pt mobileclip_blt.ts; do
  [ -s "$M/$f" ] || { echo "baixando $f"; curl -sSLf -o "$M/$f" "$U/$f"; }
done
command -v ffmpeg >/dev/null || echo "ATENÇÃO: instale o ffmpeg (macOS: brew install ffmpeg)"
echo "ok — modelos em $M (exporte DELEON_MASK_MODELS=$M se mudar de pasta)"
