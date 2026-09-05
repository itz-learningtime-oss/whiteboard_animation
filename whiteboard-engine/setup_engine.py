#!/usr/bin/env python3
"""Explicit one-time installation; rendering never downloads models or fonts."""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FONTS = {
    "Caveat.ttf": ("caveat", "Caveat%5Bwght%5D.ttf"),
    "NotoSans.ttf": ("notosans", "NotoSans%5Bwdth,wght%5D.ttf"),
    "NotoSansDevanagari.ttf": ("notosansdevanagari", "NotoSansDevanagari%5Bwdth,wght%5D.ttf"),
}


def download_fonts() -> None:
    import requests
    from PIL import ImageFont

    directory = ROOT / "assets" / "fonts"
    directory.mkdir(parents=True, exist_ok=True)
    for filename, (family, remote) in FONTS.items():
        target = directory / filename
        if target.exists():
            ImageFont.truetype(str(target), 24)
            continue
        url = f"https://raw.githubusercontent.com/google/fonts/main/ofl/{family}/{remote}"
        print(f"Downloading open-license font: {filename}")
        response = requests.get(url, timeout=(5, 60))
        response.raise_for_status()
        if len(response.content) > 20_000_000:
            raise RuntimeError("Font exceeds the 20 MB safety limit.")
        with tempfile.NamedTemporaryFile(dir=directory, suffix=".ttf", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(response.content)
        try:
            ImageFont.truetype(str(temporary), 24)
            license_response = requests.get(f"https://raw.githubusercontent.com/google/fonts/main/ofl/{family}/OFL.txt", timeout=(5, 30))
            license_response.raise_for_status()
            (directory / f"{family}-OFL.txt").write_text(license_response.text, encoding="utf-8")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Set up the free, local Scribble renderer")
    parser.add_argument("--skip-install", action="store_true", help="Use already installed Python dependencies")
    parser.add_argument("--skip-model", action="store_true", help="Use an already installed spaCy model")
    parser.add_argument("--skip-fonts", action="store_true", help="Use fonts you have installed manually")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        print("Python 3.11 or newer is required.", file=sys.stderr)
        return 1
    try:
        if not args.skip_install:
            subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], check=True)
        if not args.skip_model and importlib.util.find_spec("en_core_web_sm") is None:
            subprocess.run([sys.executable, "-m", "spacy", "download", "en_core_web_sm"], check=True)
        if not args.skip_fonts:
            download_fonts()
        for folder in ("cache", "cache/audio", "custom"):
            (ROOT / "assets" / folder).mkdir(parents=True, exist_ok=True)
        from src.renderer import load_hand
        hand_path = ROOT / "assets" / "hand_marker.png"
        hand = load_hand(hand_path)
        hand.save(hand_path, format="PNG")
        missing = [tool for tool in ("ffmpeg", "ffprobe") if not shutil.which(tool)]
        if missing:
            print(f"System dependencies still needed: {', '.join(missing)}. Install FFmpeg and add its bin directory to PATH.", file=sys.stderr)
            return 1
        if not (shutil.which("espeak-ng") or shutil.which("espeak")) and sys.platform not in {"win32", "darwin"}:
            print("Install eSpeak NG for offline narration (Ubuntu: sudo apt install espeak-ng libespeak1).", file=sys.stderr)
        print("Setup complete. Try: python run_studio.py --json examples/rainwater.json --offline")
        print("Tests: python -m unittest discover -s tests -v")
        return 0
    except Exception as exc:
        print(f"Setup failed: {exc}\nRe-run setup after resolving the dependency or connection issue.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())