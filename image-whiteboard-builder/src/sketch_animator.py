"""Incremental contour tracing with explicit pen lifts and calibrated hand overlay."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np
from PIL import Image, ImageColor

from .audio_manager import TimingPlan
from .contour_processor import ContourDrawing

ASSETS = Path(__file__).resolve().parents[1] / "assets"


@dataclass(frozen=True)
class PenSegment:
    start: np.ndarray
    end: np.ndarray
    budget: float
    draws: bool


@dataclass(frozen=True)
class AnimationOptions:
    paper: str = "#fcfbf5"
    ink: str = "#30362d"
    pen_width: float = 2.4
    hand: bool = True
    hand_path: Path = ASSETS / "hand_marker.png"
    hand_scale: float = .28
    tip_x: float = .279
    tip_y: float = .278

    def validate(self):
        if not all(isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color) for color in (self.paper, self.ink)):
            raise ValueError("Paper and ink must use six-digit hex colors.")
        if not math.isfinite(self.pen_width) or not .5 <= self.pen_width <= 12:
            raise ValueError("Pen width must be between 0.5 and 12 reference pixels.")
        if not .05 <= self.hand_scale <= .6 or not 0 <= self.tip_x <= 1 or not 0 <= self.tip_y <= 1:
            raise ValueError("Hand scale and normalized pen-tip coordinates are invalid.")


def load_hand(path: Path) -> Image.Image:
    if not Path(path).is_file():
        raise ValueError(f"Marker hand not found: {path}. Provide --hand or explicitly use --no-hand.")
    with Image.open(path) as source:
        if source.width * source.height > 16000000:
            raise ValueError("Marker image exceeds 16 megapixels.")
        image = source.convert("RGBA")
    rgba = np.asarray(image).copy()
    if rgba[:, :, 3].min() < 250:
        return image
    # Remove white matte only where it connects to the boundary. Keep skin
    # highlights and fingernails, which are enclosed by non-white pixels.
    white = (rgba[:, :, :3].min(axis=2) > 239).astype(np.uint8)
    _, labels = cv2.connectedComponents(white, connectivity=8)
    boundary = np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1])))
    rgba[np.isin(labels, boundary[boundary != 0]), 3] = 0
    return Image.fromarray(rgba)


class SketchAnimator:
    def __init__(self, drawing: ContourDrawing, options: AnimationOptions | None = None):
        self.drawing = drawing
        self.options = options or AnimationOptions()
        self.options.validate()
        self.segments: list[PenSegment] = []
        previous = None
        for path in drawing.paths:
            if previous is not None:
                distance = float(np.linalg.norm(path.points[0] - previous))
                if distance > 1e-8:
                    self.segments.append(PenSegment(previous, path.points[0], max(.1, distance * .08), False))
            for a, b in zip(path.points[:-1], path.points[1:]):
                length = float(np.linalg.norm(b - a))
                if length > 1e-8:
                    self.segments.append(PenSegment(a, b, length, True))
            previous = path.points[-1]
        self.total_budget = sum(segment.budget for segment in self.segments)
        if self.total_budget <= 0:
            raise ValueError("The drawing has no non-zero-length contours.")
        self.color = ImageColor.getrgb(self.options.ink)
        self.pen_width = max(1, round(self.options.pen_width * drawing.width / 1920))
        self.marker = None
        if self.options.hand:
            marker = load_hand(self.options.hand_path)
            width = max(24, round(drawing.width * self.options.hand_scale))
            self.marker = marker.resize((width, round(width * marker.height / marker.width)), Image.Resampling.LANCZOS)
        self.reset()

    def reset(self) -> None:
        self.board = np.empty((self.drawing.height, self.drawing.width, 3), dtype=np.uint8)
        self.board[:] = ImageColor.getrgb(self.options.paper)
        self.cursor = 0
        self.partial = 0.0
        self.consumed = 0.0
        self.tip: tuple[float, float] | None = None
        self.pen_down = False

    def advance(self, fraction: float) -> None:
        if not math.isfinite(fraction):
            raise ValueError("Drawing progress must be finite.")
        target = max(0.0, min(1.0, fraction)) * self.total_budget
        if target < self.consumed - 1e-8:
            self.reset()
        while self.cursor < len(self.segments) and self.consumed < target - 1e-8:
            segment = self.segments[self.cursor]
            take = min(target - self.consumed, segment.budget - self.partial)
            start = segment.start + (segment.end - segment.start) * (self.partial / segment.budget)
            end = segment.start + (segment.end - segment.start) * ((self.partial + take) / segment.budget)
            if segment.draws:
                cv2.line(self.board, tuple(int(n) for n in np.round(start * 16)), tuple(int(n) for n in np.round(end * 16)), self.color, self.pen_width, cv2.LINE_AA, shift=4)
            self.tip = (float(end[0]), float(end[1]))
            self.pen_down = segment.draws
            self.partial += take
            self.consumed += take
            if self.partial >= segment.budget - 1e-8:
                self.cursor += 1
                self.partial = 0.0

    def frame(self, fraction: float) -> np.ndarray:
        self.advance(fraction)
        image = Image.fromarray(self.board.copy())
        if self.marker is not None and self.tip is not None and 0 < fraction < 1:
            anchor = (round(self.tip[0] - self.marker.width * self.options.tip_x), round(self.tip[1] - self.marker.height * self.options.tip_y))
            image.paste(self.marker, anchor, self.marker)
        return np.asarray(image)

    def frames(self, timing: TimingPlan) -> Iterator[np.ndarray]:
        self.reset()
        for index in range(timing.frame_count):
            yield self.frame(timing.progress_at(index))