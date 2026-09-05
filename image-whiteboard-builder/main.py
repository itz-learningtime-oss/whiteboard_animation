#!/usr/bin/env python3
"""CLI entry.

Single image:
    python main.py --image diagram.png --audio narration.mp3

Multiple images, drawn in order, sharing one audio track and with subtitles:
    python main.py --image-dir assets --audio final.mp3 --subtitles captions.srt --output final_video.mp4
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
from pathlib import Path

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def _natural_key(path: Path):
    """Sort '2.jpg' before '10.jpg' instead of lexicographic '1,10,2,...' order."""
    return [int(chunk) if chunk.isdigit() else chunk.lower() for chunk in re.split(r"(\d+)", path.stem)]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Animate the contours of your image(s) in sync with your audio, entirely offline.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--image", type=Path, help="Single PNG, JPEG, WebP, BMP, or TIFF input")
    source.add_argument("--images", type=Path, nargs="+", help="Multiple images, drawn in the order given")
    source.add_argument("--image-dir", type=Path, help="Folder of images, drawn in natural filename order (1.jpg, 2.jpg, ... 10.jpg)")
    parser.add_argument("--audio", type=Path, required=True, help="User-supplied narration or soundtrack, shared by every image")
    parser.add_argument("--durations", type=str, default=None, help="Comma-separated seconds per image, multi-image only (e.g. '4,4,6'); default splits the audio evenly")
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
    parser.add_argument("--color-mode", choices=["colorful", "monochrome"], default="colorful", help="Whether strokes sample native colors from the image (colorful) or all use --ink (monochrome)")
    parser.add_argument("--paper", default="#fcfbf5")
    parser.add_argument("--ink", default="#30362d")
    parser.add_argument("--pen-width", type=float, default=2.4, help="Line width in 1920px reference-canvas pixels")
    parser.add_argument("--hand", type=Path, default=Path(__file__).resolve().parent / "assets" / "hand_marker.png")
    parser.add_argument("--no-hand", action="store_true")
    parser.add_argument("--hand-scale", type=float, default=.28)
    parser.add_argument("--tip-x", type=float, default=.279, help="Normalized marker-tip x within the hand image")
    parser.add_argument("--tip-y", type=float, default=.278, help="Normalized marker-tip y within the hand image")
    parser.add_argument("--lead", type=float, default=0, help="Initial blank-canvas pause (within the audio, or within each image's own slice for multi-image)")
    parser.add_argument("--hold", type=float, default=0, help="Completed-sketch pause (within the audio, or within each image's own slice for multi-image)")
    parser.add_argument("--preset", choices=["ultrafast", "veryfast", "fast", "medium", "slow"], default="medium")
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--save-sketch", action="store_true", help="Also write the edge map and clean pencil sketch for every image")
    parser.add_argument("--subtitles", type=Path, default=None, help="Bottom-of-frame captions: an .srt file, or a .txt file with one caption per line spread evenly across the audio")
    parser.add_argument("--subtitle-font", type=Path, default=None, help="TrueType/OpenType font file; defaults to a common system font if omitted")
    parser.add_argument("--subtitle-size", type=int, default=42, help="Reference font size at 1920px frame width")
    parser.add_argument("--subtitle-color", default="#ffffff")
    parser.add_argument("--subtitle-bg", default="#000000")
    parser.add_argument("--subtitle-bg-opacity", type=float, default=.55)
    parser.add_argument("--subtitle-margin", type=float, default=.06, help="Bottom margin as a fraction of frame height")
    parser.add_argument("--overwrite", action="store_true", help="Allow replacing an existing output")
    parser.add_argument("--progress-json", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser


def _collect_images(args: argparse.Namespace) -> list[Path]:
    if args.image:
        return [args.image]
    if args.images:
        return list(args.images)
    directory = args.image_dir
    if not directory.is_dir():
        raise ValueError(f"Not a directory: {directory}")
    found = sorted((p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES), key=_natural_key)
    if not found:
        raise ValueError(f"No PNG/JPEG/WebP/BMP/TIFF images were found in {directory}")
    return found


def _parse_durations(raw: str | None, count: int) -> list[float] | None:
    if raw is None:
        return None
    values = [float(chunk.strip()) for chunk in raw.split(",") if chunk.strip()]
    if len(values) != count:
        raise ValueError(f"--durations must list exactly {count} comma-separated seconds values, one per image (got {len(values)}).")
    return values


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        from src.contour_processor import ContourOptions
        from src.sketch_animator import AnimationOptions
        from src.subtitles import SubtitleOptions
        from src.video_exporter import export_multi_image_video, export_video

        images = _collect_images(args)
        durations = _parse_durations(args.durations, len(images))

        contours = ContourOptions(width=args.width, height=args.height, low_threshold=args.canny_low, high_threshold=args.canny_high, blur_size=args.blur, min_length=args.min_length, sort=args.sort, margin=args.margin, processing_limit=args.processing_limit, color_mode=args.color_mode)
        animation = AnimationOptions(paper=args.paper, ink=args.ink, pen_width=args.pen_width, hand=not args.no_hand, hand_path=args.hand, hand_scale=args.hand_scale, tip_x=args.tip_x, tip_y=args.tip_y)
        subtitle_options = SubtitleOptions(font_path=args.subtitle_font, font_size=args.subtitle_size, color=args.subtitle_color, background=args.subtitle_bg, background_opacity=args.subtitle_bg_opacity, margin=args.subtitle_margin)

        def progress(fraction: float, message: str):
            if args.progress_json:
                print(json.dumps({"progress": round(fraction, 5), "message": message}), flush=True)
            else:
                print(f"\r{fraction:6.1%}  {message:<70}", end="", file=sys.stderr, flush=True)

        if len(images) == 1 and durations is None:
            manifest = export_video(images[0], args.audio, args.output, contours, animation, fps=args.fps, lead=args.lead, hold=args.hold, crf=args.crf, preset=args.preset, overwrite=args.overwrite, save_sketch=args.save_sketch, subtitle_path=args.subtitles, subtitle_options=subtitle_options, progress=progress)
        else:
            manifest = export_multi_image_video(images, args.audio, args.output, contours, animation, fps=args.fps, durations=durations, lead=args.lead, hold=args.hold, crf=args.crf, preset=args.preset, overwrite=args.overwrite, save_sketch=args.save_sketch, subtitle_path=args.subtitles, subtitle_options=subtitle_options, progress=progress)

        if args.progress_json:
            print(json.dumps({"status": "complete", "output": manifest["output"], "progress": 1}), flush=True)
        else:
            print(f"\nSaved {manifest['output']}\nFrames: {manifest['frame_count']} at {manifest['fps']} FPS.\nAudio: {manifest['audio_duration']:.6f}s; video: {manifest['video_duration']:.6f}s.", file=sys.stderr)
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
