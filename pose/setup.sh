#!/usr/bin/env bash
# One-time setup for the pose rep counter: Python 3.12 venv, pinned packages, and the MediaPipe model.
#   bash pose/setup.sh
set -euo pipefail
cd "$(dirname "$0")"

PY=${PYTHON:-python3.12}
command -v "$PY" >/dev/null || { echo "Need Python 3.12 (set PYTHON=/path/to/python3.12)"; exit 1; }

[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt

mkdir -p models
MODEL=models/pose_landmarker_full.task
[ -f "$MODEL" ] || curl -sSfL -o "$MODEL" \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task

.venv/bin/python -I test_reps.py
echo "Pose counter ready. Start it with: npm run pose"
