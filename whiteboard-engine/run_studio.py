#!/usr/bin/env python3
"""Scribble CLI: text or JSON in, a fully narrated H.264 MP4 out."""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
from pathlib import Path

from src.nlp_engine import ScriptParser
from src.renderer import RenderConfig, render


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate layered whiteboard videos locally, without LLMs or API keys.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--text", help="Explanatory text; blank lines make explicit scene boundaries")
    source.add_argument("--json", type=Path, metavar="FILE", help="Structured UTF-8 JSON script")
    source.add_argument("--file", type=Path, metavar="FILE", help="UTF-8 plain-text or JSON script")
    parser.add_argument("--output", type=Path, default=Path("output_hd_explainer.mp4"))
    parser.add_argument("--title", help="Override the video title")
    parser.add_argument("--lang", choices=["en", "hi"], default=None)
    parser.add_argument("--tts", choices=["local", "gtts", "none"], default=None, help="Default: offline system voice; gTTS explicitly requires internet")
    parser.add_argument("--offline", action="store_true", help="Never fetch assets or send narration online")
    parser.add_argument("--width", type=int, default=None)
    parser.add_argument("--height", type=int, default=None)
    parser.add_argument("--fps", type=int, choices=[24, 25, 30, 60], default=30)
    parser.add_argument("--rate", type=float, default=None)
    parser.add_argument("--accent", default=None, help="Six-digit hex color, e.g. '#648650'")
    parser.add_argument("--paper", default=None, help="Six-digit canvas hex color")
    parser.add_argument("--font", type=Path, help="An installed .ttf font; Hindi requires Devanagari coverage and RAQM")
    parser.add_argument("--assets", type=Path, help="Override the asset directory")
    parser.add_argument("--no-hand", action="store_true")
    parser.add_argument("--no-hatching", action="store_true")
    parser.add_argument("--no-camera", action="store_true")
    parser.add_argument("--strict-assets", action="store_true", help="Fail rather than use an explicitly reported fallback")
    parser.add_argument("--allow-rule-fallback", action="store_true", help="Allow raw text without the downloaded spaCy model")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print scene JSON without rendering or network calls")
    parser.add_argument("--progress-json", action="store_true", help="Emit machine-readable progress on stdout")
    parser.add_argument("--preset", choices=["ultrafast", "veryfast", "fast", "medium", "slow"], default="medium")
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--verbose", action="store_true")
    return parser


def config_from_settings(settings: dict) -> RenderConfig:
    config = RenderConfig()
    if str(settings.get("resolution", "1080")) not in {"1080", "720"}:
        raise ValueError("resolution must be 1080 or 720.")
    if str(settings.get("resolution", "1080")) == "720":
        config.width, config.height = 1280, 720
    for key in ("hand", "hatching", "camera", "narration"):
        if key in settings and not isinstance(settings[key], bool):
            raise ValueError(f"Setting {key} must be true or false.")
    for key in ("hand", "hatching", "camera"):
        setattr(config, key, settings.get(key, getattr(config, key)))
    config.language = settings.get("language", "en")
    config.accent = settings.get("color", config.accent)
    config.paper = settings.get("paper", config.paper)
    rate = settings.get("rate", 1)
    if isinstance(rate, bool) or not isinstance(rate, (int, float)):
        raise ValueError("rate must be a number.")
    config.rate = float(rate)
    config.tts = "local" if settings.get("narration", True) else "none"
    config.validate()
    return config


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s: %(message)s", stream=sys.stderr)
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        parser = ScriptParser(args.lang or "en", args.allow_rule_fallback)
        script = parser.parse_text(args.text, args.title) if args.text is not None else parser.parse_file(args.json or args.file)
        if args.title:
            script.title = args.title[:100]
        config = config_from_settings(script.settings)
        for option, attribute in (("lang", "language"), ("tts", "tts"), ("width", "width"), ("height", "height"), ("rate", "rate"), ("accent", "accent"), ("paper", "paper"), ("font", "font"), ("assets", "assets")):
            value = getattr(args, option)
            if value is not None:
                setattr(config, attribute, value)
        if args.width is not None and args.height is None:
            config.height = round(args.width * 9 / 16 / 2) * 2
        if args.height is not None and args.width is None:
            config.width = round(args.height * 16 / 9 / 2) * 2
        config.offline, config.strict_assets = args.offline, args.strict_assets
        config.fps, config.preset, config.crf = args.fps, args.preset, args.crf
        if args.no_hand: config.hand = False
        if args.no_hatching: config.hatching = False
        if args.no_camera: config.camera = False
        config.validate()
        if args.dry_run:
            print(json.dumps(script.to_dict(), ensure_ascii=False, indent=2))
            return 0
        def progress(value: float, message: str) -> None:
            if args.progress_json:
                print(json.dumps({"progress": round(value, 4), "message": message}), flush=True)
            else:
                print(f"\r{value:6.1%}  {message:<65}", end="", file=sys.stderr, flush=True)
        manifest = render(script, args.output, config, progress)
        if args.progress_json:
            print(json.dumps({"progress": 1, "status": "complete", "output": manifest["output"], "duration": manifest["duration"]}), flush=True)
        else:
            print(f"\nSaved {manifest['output']} ({manifest['duration']:.2f}s, {manifest['width']}x{manifest['height']}).", file=sys.stderr)
        return 0
    except KeyboardInterrupt:
        print("\nRender cancelled. No incomplete MP4 was published.", file=sys.stderr)
        return 130
    except Exception as exc:
        if args.verbose:
            logging.exception("Render failed")
        else:
            print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())