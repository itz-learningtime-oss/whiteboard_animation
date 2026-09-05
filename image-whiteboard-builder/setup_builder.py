#!/usr/bin/env python3
"""Install this workflow's Python requirements and check real encoder support."""

from __future__ import annotations

import argparse
import importlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser(description="Install and check the offline image whiteboard builder")
    parser.add_argument("--check-only", action="store_true", help="Check, without changing the environment")
    parser.add_argument("--test", action="store_true", help="Run the actual test suite, including FFmpeg renders")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        print("Use Python 3.11 or newer.", file=sys.stderr)
        return 1
    try:
        if not args.check_only:
            subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], check=True)
        for name in ("cv2", "numpy", "moviepy", "PIL", "pydub"):
            module = importlib.import_module(name)
            print(f"OK: {name} {getattr(module, '__version__', '')}")
        missing = [tool for tool in ("ffmpeg", "ffprobe") if not shutil.which(tool)]
        if missing:
            raise RuntimeError(f"Install the FFmpeg system package and add these commands to PATH: {', '.join(missing)}")
        encoders = subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-encoders"], capture_output=True, text=True, check=True, timeout=15).stdout
        if "libx264" not in encoders or " aac " not in encoders:
            raise RuntimeError("FFmpeg must include libx264 and AAC encoders.")
        from src.sketch_animator import load_hand
        hand_path = ROOT / "assets" / "hand_marker.png"
        hand = load_hand(hand_path)
        if not args.check_only:
            hand.save(hand_path, format="PNG")
        print("OK: FFmpeg H.264/AAC, FFprobe, and marker asset")
        if args.test:
            subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=ROOT, check=True)
        print('Ready: python main.py --image input_diagram.png --audio narration.mp3 --output final_video.mp4')
        return 0
    except Exception as exc:
        print(f"Setup needs attention: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())