"""Incremental anti-aliased stroke rendering and streaming H.264/AAC assembly."""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageFont, features

from .canvas_camera import CanvasCamera
from .nlp_engine import Scene, Script
from .tts_audio import AudioClip, AudioGenerator, assemble_audio
from .vector_manager import INK, ROOT, VectorAsset, VectorDrawing, VectorManager, parse_svg

LOGGER = logging.getLogger(__name__)


@dataclass
class RenderConfig:
    width: int = 1920
    height: int = 1080
    fps: int = 30
    language: str = "en"
    tts: str = "local"
    rate: float = 1
    offline: bool = False
    hand: bool = True
    hatching: bool = True
    camera: bool = True
    accent: str = "#648650"
    paper: str = "#fcfbf5"
    assets: Path = ROOT / "assets"
    font: Path | None = None
    strict_assets: bool = False
    crf: int = 18
    preset: str = "medium"

    def validate(self) -> None:
        if not 320 <= self.width <= 3840 or not 180 <= self.height <= 2160 or self.width % 2 or self.height % 2:
            raise ValueError("Use even dimensions from 320x180 through 3840x2160.")
        if abs(self.width / self.height - 16 / 9) > .05:
            raise ValueError("This studio uses a 16:9 output canvas.")
        if self.fps not in {24, 25, 30, 60}:
            raise ValueError("Frame rate must be 24, 25, 30, or 60.")
        if self.language not in {"en", "hi"} or self.tts not in {"local", "gtts", "none"}:
            raise ValueError("Unsupported narration configuration.")
        if not .7 <= self.rate <= 1.4:
            raise ValueError("Narration rate must be from 0.7 to 1.4.")
        if not 0 <= self.crf <= 35 or self.preset not in {"ultrafast", "veryfast", "fast", "medium", "slow"}:
            raise ValueError("Invalid encoder quality settings.")
        for color in (self.accent, self.paper):
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                raise ValueError("Colors must be six-digit hexadecimal strings.")
        if self.offline and self.tts == "gtts":
            raise ValueError("gTTS cannot run offline. Choose local or none.")


@dataclass
class PreparedScene:
    scene: Scene
    asset: VectorAsset
    drawing: VectorDrawing
    audio: AudioClip
    duration: float
    lead: float
    frames: int


def _font_path(config: RenderConfig, heading: bool) -> str:
    if config.language == "hi" and not features.check_feature("raqm"):
        raise RuntimeError("Hindi requires Pillow's RAQM text shaping support; install a wheel with libraqm.")
    if config.font:
        if not config.font.is_file():
            raise ValueError(f"Font not found: {config.font}")
        return str(config.font)
    if config.language == "hi":
        candidate = config.assets / "fonts" / "NotoSansDevanagari.ttf"
        if not candidate.is_file() or not features.check_feature("raqm"):
            raise RuntimeError("Hindi needs NotoSansDevanagari.ttf and Pillow with RAQM shaping. Run setup_engine.py and install libraqm, or pass --font with a suitable font.")
        return str(candidate)
    names = ["Caveat.ttf", "NotoSans.ttf"] if heading else ["NotoSans.ttf", "Caveat.ttf"]
    for name in names:
        candidate = config.assets / "fonts" / name
        if candidate.is_file():
            return str(candidate)
    for candidate in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "C:/Windows/Fonts/arial.ttf"):
        if Path(candidate).is_file():
            return candidate
    raise RuntimeError("No usable font found. Run setup_engine.py or provide --font /path/to/font.ttf.")


@lru_cache(maxsize=64)
def _font(path: str, size: int):
    return ImageFont.truetype(path, max(9, size))


def _wrap(text: str, font, width: float) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if font.getlength(candidate) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            if font.getlength(word) > width:
                # Keep overlong tokens intact; the caller scales their font down.
                lines.append(word)
                current = ""
            else:
                current = word
    if current:
        lines.append(current)
    return lines or [""]


def load_hand(path: Path) -> Image.Image:
    if not path.is_file():
        raise FileNotFoundError(f"Drawing hand is missing: {path}. Use --no-hand if intentionally omitted.")
    image = Image.open(path).convert("RGBA")
    rgba = np.array(image)
    if rgba[:, :, 3].min() < 250:
        return image
    # Remove only near-white regions connected to the image boundary, not nails
    # or highlights enclosed by the hand. The pen tip is at (0.17w, 0.25h).
    white = (rgba[:, :, :3].min(axis=2) > 239).astype(np.uint8)
    _, labels = cv2.connectedComponents(white, connectivity=8)
    border = np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1])))
    border = border[border != 0]
    rgba[np.isin(labels, border), 3] = 0
    return Image.fromarray(rgba, "RGBA")


class ScenePainter:
    def __init__(self, prepared: PreparedScene, config: RenderConfig):
        self.prepared, self.config = prepared, config
        w, h = config.width, config.height
        rgb = np.array(ImageColor.getrgb(config.paper), dtype=np.int16)
        noise = np.random.default_rng(42).normal(0, .42, (h, w, 1))
        self.background = np.clip(rgb + noise, 0, 255).astype(np.uint8)
        self.board = self.background.copy()
        art_box = (w * .12, h * .245, w * .76, h * .53)
        if prepared.scene.layout == "illustration_left":
            art_box = (w * .065, h * .255, w * .62, h * .52)
        drawing = prepared.drawing.fit(*art_box)
        self.segments = []
        for stroke in drawing.strokes:
            color = ImageColor.getrgb(stroke.color)
            width = max(1, round(stroke.width * w / 900))
            for start, end in zip(stroke.points[:-1], stroke.points[1:]):
                length = float(np.linalg.norm(end - start))
                if length > 1e-8:
                    self.segments.append((start, end, length, color, width))
        self.total_length = sum(item[2] for item in self.segments)
        self.index, self.partial, self.drawn = 0, 0.0, 0.0
        self.tip: tuple[float, float] | None = None
        heading_path, body_path = _font_path(config, True), _font_path(config, False)
        size = max(18, round(w * .047))
        heading_font = _font(heading_path, size)
        heading_lines = _wrap(prepared.scene.heading, heading_font, w * .8)
        while (len(heading_lines) > 2 or max(heading_font.getlength(line) for line in heading_lines) > w * .8) and size > 14:
            size -= 2
            heading_font = _font(heading_path, size)
            heading_lines = _wrap(prepared.scene.heading, heading_font, w * .8)
        self.heading = Image.new("RGBA", (w, round(h * .245)), (0, 0, 0, 0))
        draw = ImageDraw.Draw(self.heading)
        line_height = size * 1.05
        top = h * .113 - (len(heading_lines) - 1) * line_height / 2
        for i, line in enumerate(heading_lines):
            draw.text((w / 2, top + i * line_height), line, font=heading_font, fill=INK, anchor="mm")
        y = min(h * .222, top + (len(heading_lines) - 1) * line_height + size * .6)
        draw.line([(w * .38, y), (w * .5, y - h * .004), (w * .62, y)], fill=config.accent, width=max(1, round(w / 500)))
        body_size = max(12, round(w * .017))
        self.body_font = _font(body_path, body_size)
        lines = _wrap(prepared.scene.text, self.body_font, w * .82)
        while max(self.body_font.getlength(line) for line in lines) > w * .84 and body_size > 9:
            body_size -= 1
            self.body_font = _font(body_path, body_size)
            lines = _wrap(prepared.scene.text, self.body_font, w * .82)
        self.caption_pages = [lines[i:i + 2] for i in range(0, len(lines), 2)]

    def advance(self, progress: float) -> None:
        target = max(0, min(1, progress)) * self.total_length
        if target < self.drawn:
            self.board = self.background.copy()
            self.index, self.partial, self.drawn = 0, 0.0, 0.0
        while self.index < len(self.segments) and target > self.drawn:
            start, end, length, color, width = self.segments[self.index]
            take = min(target - self.drawn, length - self.partial)
            a = start + (end - start) * (self.partial / length)
            b = start + (end - start) * ((self.partial + take) / length)
            cv2.line(self.board, tuple(int(n) for n in np.round(a * 16)), tuple(int(n) for n in np.round(b * 16)), color, width, cv2.LINE_AA, shift=4)
            self.tip = (float(b[0]), float(b[1]))
            self.partial += take
            self.drawn += take
            if self.partial >= length - 1e-7:
                self.index += 1; self.partial = 0

    def frame(self, local_time: float, complete: bool = False) -> tuple[Image.Image, tuple[float, float] | None]:
        duration, lead = self.prepared.duration, self.prepared.lead
        trace_duration = max(1.0, duration - lead - 1.3)
        if self.config.tts != "none":
            trace_duration = min(trace_duration, max(1.0, self.prepared.audio.duration - .45))
        progress = 1.0 if complete else min(1.0, max(0.0, (local_time - lead - .45) / trace_duration))
        self.advance(progress)
        frame = Image.fromarray(self.board.copy(), "RGB")
        reveal = 1 if complete else min(1.0, max(0.0, (local_time - lead) / .45))
        if reveal:
            crop = self.heading.crop((0, 0, round(self.config.width * reveal), self.heading.height))
            frame.paste(crop, (0, 0), crop)
        if local_time >= lead or complete:
            page_index = min(len(self.caption_pages) - 1, max(0, int((local_time - lead) / max(.1, duration - lead) * len(self.caption_pages))))
            lines = self.caption_pages[page_index]
            draw = ImageDraw.Draw(frame)
            size = self.body_font.size
            for index, line in enumerate(lines):
                y = self.config.height * .866 + index * size * 1.5
                draw.text((self.config.width / 2, y), line, font=self.body_font, fill="#646d5c", anchor="mm")
        return frame, self.tip if 0 < progress < 1 and not complete else None


def render(script: Script, output: Path, config: RenderConfig | None = None, progress: Callable[[float, str], None] | None = None) -> dict:
    config = config or RenderConfig()
    config.validate()
    if not script.scenes:
        raise ValueError("There are no scenes to render.")
    report = progress or (lambda value, message: LOGGER.info("%3d%% %s", round(value * 100), message))
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is not installed or is not on PATH.")
    _font_path(config, True); _font_path(config, False)
    hand = load_hand(config.assets / "hand_marker.png") if config.hand else None
    output = output.expanduser().resolve()
    if output.suffix.lower() != ".mp4":
        raise ValueError("The output path must end in .mp4.")
    output.parent.mkdir(parents=True, exist_ok=True)
    manager = VectorManager(config.assets, offline=config.offline, strict=config.strict_assets)
    audio_generator = AudioGenerator(config.assets / "cache" / "audio", config.language, config.tts, config.rate, config.offline, ffmpeg)
    started = time.monotonic()
    prepared: list[PreparedScene] = []
    try:
        for i, scene in enumerate(script.scenes):
            report(.15 * i / len(script.scenes), f"Preparing scene {i + 1}: vectors and narration")
            asset = manager.get_svg(scene.primary_visual)
            drawing = parse_svg(asset.path, config.accent, config.hatching)
            audio = audio_generator.generate(scene.text)
            lead = .8 if config.camera and i and scene.camera != "none" else .25
            estimated = max(4.0, len(scene.text.split()) / (2.4 * config.rate) + 1)
            requested = scene.duration if scene.duration is not None else estimated
            duration = max(requested, lead + audio.duration + .9, lead + 2.5)
            frames = math.ceil(duration * config.fps)
            duration = frames / config.fps
            if scene.duration and duration > scene.duration + .1:
                LOGGER.info("Extending scene %d to %.2fs to preserve narration and camera lead-in.", i + 1, duration)
            prepared.append(PreparedScene(scene, asset, drawing, audio, duration, lead, frames))
    finally:
        manager.close()
    total_frames = sum(scene.frames for scene in prepared)
    total_duration = total_frames / config.fps
    camera = CanvasCamera(len(prepared), config.width, config.height, movements=[s.scene.camera for s in prepared], enabled=config.camera)
    temporary_video = output.with_name(f".{output.stem}-{uuid.uuid4().hex}.partial.mp4")
    try:
        with tempfile.TemporaryDirectory(prefix="scribble-render-", dir=output.parent) as work_name:
            work = Path(work_name)
            soundtrack = work / "narration.wav"
            assemble_audio([(s.audio, s.lead, s.duration) for s in prepared], soundtrack)
            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{config.width}x{config.height}", "-framerate", str(config.fps), "-i", "pipe:0", "-i", str(soundtrack), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", config.preset, "-crf", str(config.crf), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", f"{total_duration:.6f}", "-movflags", "+faststart", str(temporary_video)]
            log_path = work / "ffmpeg.log"
            @lru_cache(maxsize=3)
            def completed_tile(index: int) -> Image.Image | None:
                path = work / f"tile-{index:03d}.png"
                if not path.exists():
                    return None
                with Image.open(path) as image:
                    return image.convert("RGB")
            @lru_cache(maxsize=24)
            def sized_hand(width: int) -> Image.Image:
                assert hand is not None
                return hand.resize((width, round(width * hand.height / hand.width)), Image.Resampling.LANCZOS)
            with log_path.open("wb") as error_log:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=error_log)
                frame_index = 0
                try:
                    assert process.stdin is not None
                    for i, scene in enumerate(prepared):
                        painter = ScenePainter(scene, config)
                        for j in range(scene.frames):
                            local_time = j / config.fps
                            tile, tip = painter.frame(local_time)
                            pose = camera.at(i, local_time, scene.duration)
                            frame = camera.composite(pose, lambda index: tile if index == i else completed_tile(index), i, config.paper)
                            if hand is not None and tip is not None:
                                world = (tip[0] + camera.origins[i][0], tip[1] + camera.origins[i][1])
                                x, y = camera.world_to_view(world, pose)
                                hand_width = max(20, round(config.width * .355 * config.width / pose.width / 4) * 4)
                                overlay = sized_hand(hand_width)
                                frame.paste(overlay, (round(x - hand_width * .17), round(y - overlay.height * .25)), overlay)
                            process.stdin.write(frame.tobytes())
                            frame_index += 1
                            if frame_index % config.fps == 0:
                                report(.15 + .82 * frame_index / total_frames, f"Drawing scene {i + 1} of {len(prepared)}")
                        final, _ = painter.frame(scene.duration, complete=True)
                        final.save(work / f"tile-{i:03d}.png")
                        completed_tile.cache_clear()
                    process.stdin.close()
                    result = process.wait(timeout=180)
                    if result:
                        raise RuntimeError(f"FFmpeg encoding failed: {log_path.read_text(errors='replace')[-3000:]}")
                except BaseException as exc:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait()
                    if isinstance(exc, BrokenPipeError):
                        raise RuntimeError(f"FFmpeg stopped accepting frames: {log_path.read_text(errors='replace')[-3000:]}") from exc
                    raise
                finally:
                    if process.stdin and not process.stdin.closed:
                        try:
                            process.stdin.close()
                        except (BrokenPipeError, OSError):
                            pass
                    completed_tile.cache_clear(); sized_hand.cache_clear()
            if not temporary_video.is_file() or temporary_video.stat().st_size < 1000:
                raise RuntimeError("FFmpeg produced an empty or incomplete output file.")
            os.replace(temporary_video, output)
    finally:
        temporary_video.unlink(missing_ok=True)
    manifest = {"title": script.title, "output": str(output), "width": config.width, "height": config.height, "fps": config.fps, "frames": total_frames, "duration": total_duration, "virtual_canvas": camera.virtual_size, "tts": config.tts, "offline": config.offline, "render_seconds": round(time.monotonic() - started, 2), "scenes": [{"text": s.scene.text, "heading": s.scene.heading, "visual": s.scene.primary_visual, "duration": s.duration, "narration_duration": s.audio.duration, "narration_start": s.lead, "source": s.asset.source, "license": s.asset.license, "fallback": s.asset.fallback, "layers": {layer: sum(stroke.layer == layer for stroke in s.drawing.strokes) for layer in ("outline", "detail", "hatch")}} for s in prepared]}
    output.with_suffix(".manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    report(1, "Your whiteboard video is ready.")
    return manifest