#!/usr/bin/env python3
"""CLI entry: python main.py --image diagram.png --audio narration.mp3."""

from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Animate the contours of your image in sync with your audio, entirely offline.")
    parser.add_argument("--image", type=Path, required=True, help="PNG, JPEG, WebP, BMP, or TIFF input")
    parser.add_argument("--audio", type=Path, required=True, help="User-supplied narration or soundtrack")
    parser.add_argument("--output", type=Path, default=Path("whiteboard_sketch_output.mp4"))
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=int, choices=[24, 25, 30, 60], default=30)
    parser.add_argument("--sort", choices=["spatial", "length"], default="spatial")
    parser.add_argument("--canny-low", type=int, default=50)
    parser.add_argument("--canny-high", type=int, default=140)
    parser.add_argument("--blur", type=int, choices=[3, 5, 7, 9], default=5)
    parser.add_argument("--min-length", type=float, default=12)
    parser.add_argument("--margin", type=float, default=.075)
    parser.add_argument("--processing-limit", type=int, default=1600)
    parser.add_argument("--paper", default="#fcfbf5")
    parser.add_argument("--ink", default="#30362d")
    parser.add_argument("--pen-width", type=float, default=2.4, help="Line width in 1920px reference-canvas pixels")
    parser.add_argument("--hand", type=Path, default=Path(__file__).resolve().parent / "assets" / "hand_marker.png")
    parser.add_argument("--no-hand", action="store_true")
    parser.add_argument("--hand-scale", type=float, default=.28)
    parser.add_argument("--tip-x", type=float, default=.279, help="Normalized marker-tip x within the hand image")
    parser.add_argument("--tip-y", type=float, default=.278, help="Normalized marker-tip y within the hand image")
    parser.add_argument("--lead", type=float, default=0, help="Initial blank-canvas pause within the audio duration")
    parser.add_argument("--hold", type=float, default=0, help="Completed-sketch pause within the audio duration")
    parser.add_argument("--preset", choices=["ultrafast", "veryfast", "fast", "medium", "slow"], default="medium")
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--save-sketch", action="store_true", help="Also write the edge map and clean pencil sketch")
    parser.add_argument("--overwrite", action="store_true", help="Allow replacing an existing output")
    parser.add_argument("--progress-json", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    def stop(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        from src.contour_processor import ContourOptions
        from src.sketch_animator import AnimationOptions
        from src.video_exporter import export_video

        contours = ContourOptions(width=args.width, height=args.height, low_threshold=args.canny_low, high_threshold=args.canny_high, blur_size=args.blur, min_length=args.min_length, sort=args.sort, margin=args.margin, processing_limit=args.processing_limit)
        animation = AnimationOptions(paper=args.paper, ink=args.ink, pen_width=args.pen_width, hand=not args.no_hand, hand_path=args.hand, hand_scale=args.hand_scale, tip_x=args.tip_x, tip_y=args.tip_y)
        def progress(fraction: float, message: str):
            if args.progress_json:
                print(json.dumps({"progress": round(fraction, 5), "message": message}), flush=True)
            else:
                print(f"\r{fraction:6.1%}  {message:<70}", end="", file=sys.stderr, flush=True)
        manifest = export_video(args.image, args.audio, args.output, contours, animation, fps=args.fps, lead=args.lead, hold=args.hold, crf=args.crf, preset=args.preset, overwrite=args.overwrite, save_sketch=args.save_sketch, progress=progress)
        if args.progress_json:
            print(json.dumps({"status": "complete", "output": manifest["output"], "progress": 1}), flush=True)
        else:
            print(f"\nSaved {manifest['output']}\n{manifest['contours']} contours, {manifest['frame_count']} frames at {manifest['fps']} FPS.\nAudio: {manifest['audio_duration']:.6f}s; video: {manifest['video_duration']:.6f}s.", file=sys.stderr)
        return 0
    except ModuleNotFoundError as exc:
        print(f"Missing Python dependency: {exc.name}. Run python setup_builder.py or python -m pip install -r requirements.txt.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCancelled. No incomplete MP4 was published; the input files are unchanged.", file=sys.stderr)
        return 130
    except Exception as exc:
        if args.verbose:
            import traceback
            traceback.print_exc()
        else:
            print(f"\nError: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())