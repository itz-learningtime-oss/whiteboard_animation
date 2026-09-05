"""Subtitle parsing and bottom-of-frame caption rendering, entirely offline."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageFont

DEFAULT_FONT_CANDIDATES = [
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\calibri.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


@dataclass(frozen=True)
class SubtitleCue:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class SubtitleOptions:
    font_path: Path | None = None
    font_size: int = 42
    color: str = "#ffffff"
    background: str = "#000000"
    background_opacity: float = .55
    margin: float = .06
    max_width_fraction: float = .86

    def validate(self) -> None:
        if not 8 <= self.font_size <= 200:
            raise ValueError("Subtitle font size must be between 8 and 200 pixels (at 1920px reference width).")
        if not 0 <= self.background_opacity <= 1:
            raise ValueError("Subtitle background opacity must be between 0 and 1.")
        if not 0 <= self.margin <= .3:
            raise ValueError("Subtitle bottom margin must be between 0 and 0.3 of the frame height.")
        if not .3 <= self.max_width_fraction <= .98:
            raise ValueError("Subtitle max width fraction must be between 0.3 and 0.98.")
        for value in (self.color, self.background):
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                raise ValueError("Subtitle colors must use six-digit hex, e.g. #ffffff.")


def _timestamp_to_seconds(stamp: str) -> float:
    match = re.fullmatch(r"(\d+):(\d{2}):(\d{2})[.,](\d{1,3})", stamp.strip())
    if not match:
        raise ValueError(f"Malformed SRT timestamp: {stamp!r}")
    hours, minutes, seconds, millis = match.groups()
    millis = millis + "0" * (3 - len(millis))
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def parse_srt(path: Path) -> list[SubtitleCue]:
    text = Path(path).read_text(encoding="utf-8-sig")
    cues: list[SubtitleCue] = []
    for block in re.split(r"\r?\n\r?\n+", text.strip()):
        lines = [line for line in block.splitlines() if line.strip() != ""]
        if not lines:
            continue
        if re.fullmatch(r"\d+", lines[0].strip()):
            lines = lines[1:]
        if not lines:
            continue
        timing = re.search(r"(\d+:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[.,]\d{1,3})", lines[0])
        if not timing:
            continue
        start, end = (_timestamp_to_seconds(group) for group in timing.groups())
        caption = " ".join(lines[1:]).strip()
        if caption and end > start:
            cues.append(SubtitleCue(start, end, caption))
    if not cues:
        raise ValueError("No valid subtitle cues were parsed from the SRT file.")
    return sorted(cues, key=lambda cue: cue.start)


def evenly_spaced_cues(path: Path, total_duration: float) -> list[SubtitleCue]:
    """One caption per non-empty line of a plain-text file, spread evenly across the audio."""
    lines = [line.strip() for line in Path(path).read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if not lines:
        raise ValueError("The subtitle text file has no lines to display.")
    if total_duration <= 0:
        raise ValueError("Cannot schedule subtitles across zero-length audio.")
    step = total_duration / len(lines)
    return [SubtitleCue(index * step, (index + 1) * step, line) for index, line in enumerate(lines)]


def load_subtitle_cues(path: Path, total_duration: float) -> list[SubtitleCue]:
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"Subtitle file not found: {path}")
    if path.suffix.lower() == ".srt":
        return parse_srt(path)
    if path.suffix.lower() == ".txt":
        return evenly_spaced_cues(path, total_duration)
    raise ValueError("Subtitles must be a .srt file or a plain .txt file (one caption per line).")


def active_text(cues: list[SubtitleCue], time: float) -> str | None:
    for cue in cues:
        if cue.start <= time < cue.end:
            return cue.text
    return None


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: float) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if not current or draw.textlength(candidate, font=font) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [text]


def _load_font(options: SubtitleOptions, size: int) -> ImageFont.FreeTypeFont:
    candidates = ([str(options.font_path)] if options.font_path else []) + DEFAULT_FONT_CANDIDATES
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise ValueError("No usable TrueType font was found. Pass --subtitle-font pointing to a .ttf/.otf file on this machine.")


def burn_subtitle(frame: np.ndarray, text: str, options: SubtitleOptions) -> np.ndarray:
    """Return a copy of frame with the caption composited near the bottom edge."""
    height, width = frame.shape[:2]
    size = max(8, round(options.font_size * width / 1920))
    image = Image.fromarray(frame).convert("RGBA")
    draw = ImageDraw.Draw(image)
    font = _load_font(options, size)
    lines = _wrap(draw, text, font, width * options.max_width_fraction)
    line_heights = [draw.textbbox((0, 0), line, font=font)[3] for line in lines]
    line_height = max(line_heights) if line_heights else size
    spacing = round(line_height * .35)
    block_height = len(lines) * line_height + (len(lines) - 1) * spacing
    bottom = height * (1 - options.margin)
    top = bottom - block_height
    pad_x, pad_y = round(size * .6), round(size * .4)
    widest = max((draw.textlength(line, font=font) for line in lines), default=0)
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    box = (width / 2 - widest / 2 - pad_x, top - pad_y, width / 2 + widest / 2 + pad_x, bottom + pad_y)
    bg_rgb = ImageColor.getrgb(options.background)
    overlay_draw.rounded_rectangle(box, radius=round(size * .3), fill=(*bg_rgb, round(255 * options.background_opacity)))
    image = Image.alpha_composite(image, overlay)
    draw = ImageDraw.Draw(image)
    fg_rgb = ImageColor.getrgb(options.color)
    cursor_y = top
    for line, line_h in zip(lines, line_heights):
        line_width = draw.textlength(line, font=font)
        draw.text((width / 2 - line_width / 2, cursor_y), line, font=font, fill=(*fg_rgb, 255))
        cursor_y += line_h + spacing
    return np.asarray(image.convert("RGB"))
