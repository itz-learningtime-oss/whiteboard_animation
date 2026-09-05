"""Canny contours from the actual input image, never substitute illustrations."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_IMAGE_PIXELS = 30_000_000
MAX_IMAGE_BYTES = 30 * 1024 * 1024


@dataclass(frozen=True)
class ContourOptions:
    width: int = 1920
    height: int = 1080
    low_threshold: int = 50
    high_threshold: int = 140
    blur_size: int = 5
    min_length: float = 12
    sort: str = "spatial"
    margin: float = .075
    processing_limit: int = 1600
    max_contours: int = 12000

    def validate(self) -> None:
        if not (320 <= self.width <= 3840 and 180 <= self.height <= 2160) or self.width % 2 or self.height % 2:
            raise ValueError("Output dimensions must be even and between 320x180 and 3840x2160.")
        if self.low_threshold < 0 or self.high_threshold > 255 or self.low_threshold >= self.high_threshold:
            raise ValueError("Canny thresholds must satisfy 0 <= low < high <= 255.")
        if self.blur_size not in {3, 5, 7, 9}:
            raise ValueError("Gaussian blur kernel must be 3, 5, 7, or 9.")
        if self.sort not in {"spatial", "length"}:
            raise ValueError("Contour sorting must be spatial or length.")
        if not math.isfinite(self.min_length) or not 0 <= self.min_length <= 500:
            raise ValueError("Minimum contour length must be between 0 and 500 pixels.")
        if not 0 <= self.margin <= .3 or not 256 <= self.processing_limit <= 2560 or not 1 <= self.max_contours <= 20000:
            raise ValueError("Invalid image processing limits or margin.")


@dataclass(frozen=True)
class ContourPath:
    points: np.ndarray
    length: float


@dataclass(frozen=True)
class ContourDrawing:
    paths: tuple[ContourPath, ...]
    width: int
    height: int
    source_size: tuple[int, int]
    edge_map: np.ndarray
    sketch_map: np.ndarray

    @property
    def total_length(self) -> float:
        return sum(path.length for path in self.paths)


def load_image(source: Path) -> Image.Image:
    source = Path(source).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}:
        raise ValueError("Choose an existing PNG, JPEG, WebP, BMP, or TIFF image.")
    if not 0 < source.stat().st_size <= MAX_IMAGE_BYTES:
        raise ValueError("Image is empty or exceeds the 30 MB limit.")
    try:
        with Image.open(source) as original:
            if original.width * original.height > MAX_IMAGE_PIXELS:
                raise ValueError("Image exceeds 30 megapixels. Resize it before importing.")
            if getattr(original, "n_frames", 1) != 1:
                raise ValueError("Use a single static image, not an animated or multipage file.")
            oriented = ImageOps.exif_transpose(original).convert("RGBA")
            canvas = Image.new("RGBA", oriented.size, "white")
            return Image.alpha_composite(canvas, oriented).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("The image could not be decoded. Export a valid PNG or JPEG.") from exc


def order_contours(contours: list[np.ndarray], sort: str, image_height: int) -> list[np.ndarray]:
    def key(points):
        low = points.min(axis=0)
        length = float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())
        if sort == "length":
            return (-length, float(low[1]), float(low[0]))
        band = max(8, image_height / 20)
        return (int(low[1] // band), float(low[0]), float(low[1]), -length)
    if sort not in {"spatial", "length"}:
        raise ValueError("Unknown contour sort order.")
    return sorted(contours, key=key)


def process_image(source: Path, options: ContourOptions | None = None) -> ContourDrawing:
    options = options or ContourOptions()
    options.validate()
    image = load_image(source)
    source_size = image.size
    image.thumbnail((options.processing_limit, options.processing_limit), Image.Resampling.LANCZOS)
    rgb = np.asarray(image)
    grayscale = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(grayscale, (options.blur_size, options.blur_size), 0)
    edges = cv2.Canny(blurred, options.low_threshold, options.high_threshold, L2gradient=True)
    found, _ = cv2.findContours(edges.copy(), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours: list[np.ndarray] = []
    count = 0
    for contour in found:
        perimeter = cv2.arcLength(contour, True)
        if perimeter < options.min_length or len(contour) < 2:
            continue
        simplified = cv2.approxPolyDP(contour, .45, True).reshape(-1, 2).astype(np.float64)
        if len(simplified) < 2:
            continue
        # Rotate a closed trace to its topmost point without changing geometry.
        start = int(np.lexsort((simplified[:, 0], simplified[:, 1]))[0])
        simplified = np.roll(simplified, -start, axis=0)
        if not np.array_equal(simplified[0], simplified[-1]):
            simplified = np.vstack((simplified, simplified[0]))
        contours.append(simplified)
        count += len(simplified)
        if len(contours) > options.max_contours or count > 300000:
            raise ValueError("This image contains too many edges. Increase thresholds or blur, or use a cleaner diagram.")
    if not contours:
        raise ValueError("No drawable contours were found. Try lower thresholds or a higher-contrast image.")
    ordered = order_contours(contours, options.sort, image.height)
    inner_width = options.width * (1 - 2 * options.margin)
    inner_height = options.height * (1 - 2 * options.margin)
    scale = min(inner_width / image.width, inner_height / image.height)
    offset = np.array([(options.width - image.width * scale) / 2, (options.height - image.height * scale) / 2])
    paths = []
    sketch = np.full((options.height, options.width), 255, np.uint8)
    for points in ordered:
        fitted = points * scale + offset
        length = float(np.linalg.norm(np.diff(fitted, axis=0), axis=1).sum())
        if length <= 1e-8:
            continue
        fitted.setflags(write=False)
        paths.append(ContourPath(fitted, length))
        cv2.polylines(sketch, [np.round(fitted * 16).astype(np.int32)], False, 0, max(1, round(options.width / 1280)), cv2.LINE_AA, shift=4)
    if not paths:
        raise ValueError("All detected contours are zero-length.")
    return ContourDrawing(tuple(paths), options.width, options.height, source_size, edges, sketch)