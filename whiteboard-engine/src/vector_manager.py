"""Safe SVG acquisition, affine path sampling, ordered layers, and clipped hatching.

Only passive path-based SVG is accepted. Scripts, raster images, external links,
CSS, filters, and unresolved <use> references are rejected rather than executed.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, replace
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import requests
from defusedxml.ElementTree import fromstring
from requests.adapters import HTTPAdapter
from svgpathtools import parse_path
from urllib3.util.retry import Retry

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[1]
MAX_SVG_BYTES = 2_000_000
MAX_POINTS = 300_000
NUMBER = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
INK = "#343c32"
ALLOWED_TAGS = {"svg", "g", "path", "line", "polyline", "polygon", "rect", "circle", "ellipse", "title", "desc"}
STYLE_KEYS = {"fill", "stroke", "stroke-width", "fill-rule", "opacity", "fill-opacity", "stroke-opacity", "display", "visibility"}


@dataclass(frozen=True)
class VectorAsset:
    path: Path
    source: str
    license: str
    fallback: bool = False


@dataclass
class Stroke:
    points: np.ndarray
    layer: str
    color: str = INK
    width: float = 2.2

    @property
    def length(self) -> float:
        return float(np.linalg.norm(np.diff(self.points, axis=0), axis=1).sum())


@dataclass
class VectorDrawing:
    strokes: list[Stroke]
    bounds: tuple[float, float, float, float]

    def fit(self, x: float, y: float, width: float, height: float) -> "VectorDrawing":
        min_x, min_y, max_x, max_y = self.bounds
        scale = min(width / max(max_x - min_x, 1e-6), height / max(max_y - min_y, 1e-6))
        offset = np.array([x + (width - (max_x - min_x) * scale) / 2, y + (height - (max_y - min_y) * scale) / 2])
        base = np.array([min_x, min_y])
        return VectorDrawing([replace(stroke, points=(stroke.points - base) * scale + offset) for stroke in self.strokes], (x, y, x + width, y + height))

    def line_segments(self) -> list[tuple[float, float, float, float]]:
        return [(float(a[0]), float(a[1]), float(b[0]), float(b[1])) for stroke in self.strokes for a, b in zip(stroke.points[:-1], stroke.points[1:])]


def sanitize_svg(data: bytes) -> bytes:
    if not data or len(data) > MAX_SVG_BYTES:
        raise ValueError("SVG is empty or exceeds the 2 MB limit.")
    try:
        root = fromstring(data)
    except Exception as exc:
        raise ValueError("SVG is malformed or contains forbidden XML entities.") from exc
    if root.tag.rsplit("}", 1)[-1] != "svg":
        raise ValueError("Asset is not an SVG document.")
    count = 0
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag not in ALLOWED_TAGS:
            raise ValueError(f"Unsupported SVG element <{tag}>. Export a flattened, path-only SVG first.")
        element.tag = tag
        if tag not in {"svg", "g", "title", "desc"}:
            count += 1
        style = element.attrib.pop("style", "")
        for rule in style.split(";"):
            if ":" in rule:
                key, value = rule.split(":", 1)
                if key.strip() in STYLE_KEYS:
                    element.set(key.strip(), value.strip())
        for key, value in list(element.attrib.items()):
            name = key.rsplit("}", 1)[-1].lower()
            if name.startswith("on") or name in {"href", "src", "filter", "clip-path", "mask", "class"} or "url(" in value.lower():
                raise ValueError(f"Unsafe or unresolved SVG attribute: {name}.")
            if len(value) > 1_000_000:
                raise ValueError("SVG attribute is too large.")
            if value == "currentColor":
                element.set(key, INK)
        element.attrib.pop("id", None)
    if not 1 <= count <= 10_000:
        raise ValueError("SVG must contain between 1 and 10,000 drawable elements.")
    root.set("xmlns", "http://www.w3.org/2000/svg")
    root.set("stroke-linecap", "round")
    root.set("stroke-linejoin", "round")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(data)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class VectorManager:
    def __init__(self, assets: Path | None = None, offline: bool = False, strict: bool = False):
        self.assets = (assets or ROOT / "assets").resolve()
        self.cache = self.assets / "cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.offline, self.strict = offline, strict
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "ScribbleWhiteboard/1.0 (open-source local renderer)"
        retry = Retry(total=2, backoff_factor=.3, status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET"], respect_retry_after_header=False)
        self.session.mount("https://", HTTPAdapter(max_retries=retry))

    def close(self) -> None:
        self.session.close()

    def _fetch(self, url: str) -> bytes:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in {"api.iconify.design", "www.svgrepo.com", "svgrepo.com", "publicdomainvectors.org", "www.publicdomainvectors.org"}:
            raise ValueError("Remote SVG provider is not on the HTTPS allowlist.")
        with self.session.get(url, timeout=(4, 12), stream=True, allow_redirects=False) as response:
            response.raise_for_status()
            if 300 <= response.status_code < 400:
                raise ValueError("Asset redirects are disabled; register a direct HTTPS SVG URL.")
            content = bytearray()
            for chunk in response.iter_content(16384):
                content.extend(chunk)
                if len(content) > MAX_SVG_BYTES:
                    raise ValueError("Remote SVG exceeds 2 MB.")
            return sanitize_svg(bytes(content))

    def get_svg(self, name: str) -> VectorAsset:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_:-]{0,99}", name):
            raise ValueError("Visual must be an asset name, not a path or URL.")
        safe_name = name.lower().replace(":", "--")
        for folder in ("custom", "illustrations", "fallbacks"):
            candidate = self.assets / folder / f"{safe_name}.svg"
            if candidate.is_file():
                data = sanitize_svg(candidate.read_bytes())
                target = self.cache / f"local-{safe_name}.svg"
                _atomic_write(target, data)
                return VectorAsset(target, f"assets/{folder}/{safe_name}.svg", "See assets/LICENSE.md" if folder != "custom" else "User-supplied; verify its license")
        cache_path = self.cache / f"{safe_name}.svg"
        metadata_path = cache_path.with_suffix(".json")
        if cache_path.exists():
            try:
                sanitize_svg(cache_path.read_bytes())
                info = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
                return VectorAsset(cache_path, info.get("source", "local cache"), info.get("license", "See original provider"))
            except (ValueError, OSError):
                cache_path.unlink(missing_ok=True)
        if not self.offline:
            candidates: list[tuple[str, str]] = []
            registry = self.assets / "asset_manifest.json"
            if registry.exists():
                manifest = json.loads(registry.read_text(encoding="utf-8"))
                entry = manifest.get(name)
                if entry:
                    if not isinstance(entry, dict) or not entry.get("license") or not entry.get("url"):
                        raise ValueError(f"Manifest asset {name!r} needs an explicit url and license.")
                    candidates.append((entry["url"], entry["license"]))
            if ":" in name:
                prefix, keyword = name.split(":", 1)
                prefixes = [prefix] if prefix in {"lucide", "tabler", "ph"} else []
            else:
                keyword = name.replace("_", "-")
                prefixes = ["lucide", "tabler", "ph"]
            for prefix in prefixes:
                # Stroke width is normalized locally; it is not an Iconify query option.
                variant = f"{keyword}-light" if prefix == "ph" and not keyword.endswith("-light") else keyword
                candidates.append((f"https://api.iconify.design/{prefix}/{variant}.svg", "ISC (Lucide)" if prefix == "lucide" else "MIT"))
            for url, license_name in candidates:
                try:
                    data = self._fetch(url)
                    _atomic_write(cache_path, data)
                    _atomic_write(metadata_path, json.dumps({"source": url, "license": license_name, "sha256": hashlib.sha256(data).hexdigest()}).encode())
                    return VectorAsset(cache_path, url, license_name)
                except (requests.RequestException, ValueError) as exc:
                    LOGGER.warning("Could not fetch %s: %s", name, exc)
        if self.strict:
            raise ValueError(f"No illustration for {name!r}. Add assets/custom/{safe_name}.svg or disable --strict-assets.")
        fallback = self.assets / "fallbacks" / "file-text.svg"
        if not fallback.is_file():
            raise FileNotFoundError("Required offline backup assets/fallbacks/file-text.svg is missing.")
        LOGGER.warning("Using the explicit document fallback for %r. Supply a custom SVG for precise subject artwork.", name)
        return VectorAsset(fallback, "assets/fallbacks/file-text.svg", "ISC (Lucide)", fallback=True)


def transform_matrix(value: str) -> np.ndarray:
    result = np.eye(3)
    remainder = re.sub(r"([a-zA-Z]+)\s*\(([^)]*)\)", "", value).strip(" ,\t\r\n")
    if remainder:
        raise ValueError("Malformed SVG transform.")
    for kind, raw in re.findall(r"([a-zA-Z]+)\s*\(([^)]*)\)", value):
        nums = [float(n) for n in re.findall(NUMBER, raw)]
        if not all(math.isfinite(n) and abs(n) <= 1e7 for n in nums):
            raise ValueError("SVG transform contains invalid coordinates.")
        matrix = np.eye(3)
        if kind == "matrix" and len(nums) == 6:
            a, b, c, d, e, f = nums
            matrix = np.array([[a, c, e], [b, d, f], [0, 0, 1]])
        elif kind == "translate" and len(nums) in {1, 2}:
            matrix[0, 2], matrix[1, 2] = nums[0], nums[1] if len(nums) == 2 else 0
        elif kind == "scale" and len(nums) in {1, 2}:
            matrix[0, 0], matrix[1, 1] = nums[0], nums[1] if len(nums) == 2 else nums[0]
        elif kind == "rotate" and len(nums) in {1, 3}:
            angle = math.radians(nums[0]); c, s = math.cos(angle), math.sin(angle)
            matrix[:2, :2] = [[c, -s], [s, c]]
            if len(nums) == 3:
                center = np.array(nums[1:]); matrix[:2, 2] = center - matrix[:2, :2] @ center
        elif kind in {"skewX", "skewY"} and len(nums) == 1:
            matrix[0 if kind == "skewX" else 1, 1 if kind == "skewX" else 0] = math.tan(math.radians(nums[0]))
        else:
            raise ValueError(f"Unsupported SVG transform: {kind}.")
        result = result @ matrix
    return result


def _shape_path(element) -> str:
    tag = element.tag.rsplit("}", 1)[-1]
    def number(key: str, default: float = 0) -> float:
        raw = element.get(key, str(default))
        if not re.fullmatch(NUMBER, raw):
            raise ValueError(f"SVG {key} must use unitless viewBox coordinates.")
        value = float(raw)
        if not math.isfinite(value) or abs(value) > 1e7:
            raise ValueError("SVG coordinate is out of bounds.")
        return value
    if tag == "path":
        return element.get("d", "")
    if tag == "line":
        return f"M{number('x1')} {number('y1')} L{number('x2')} {number('y2')}"
    if tag in {"polyline", "polygon"}:
        points = re.findall(NUMBER, element.get("points", ""))
        if len(points) < 4 or len(points) % 2:
            raise ValueError("SVG polygon/polyline has invalid points.")
        return "M" + " ".join(points[:2]) + " L" + " ".join(points[2:]) + (" Z" if tag == "polygon" else "")
    if tag in {"circle", "ellipse"}:
        cx, cy = number("cx"), number("cy")
        rx = number("r") if tag == "circle" else number("rx")
        ry = rx if tag == "circle" else number("ry")
        if rx <= 0 or ry <= 0:
            return ""
        return f"M{cx-rx} {cy} A{rx} {ry} 0 1 0 {cx+rx} {cy} A{rx} {ry} 0 1 0 {cx-rx} {cy} Z"
    if tag == "rect":
        x, y, width, height = number("x"), number("y"), number("width"), number("height")
        if width <= 0 or height <= 0:
            return ""
        rx = min(max(number("rx", number("ry")), 0), width / 2)
        ry = min(max(number("ry", rx), 0), height / 2)
        if rx and ry:
            return f"M{x+rx} {y} H{x+width-rx} A{rx} {ry} 0 0 1 {x+width} {y+ry} V{y+height-ry} A{rx} {ry} 0 0 1 {x+width-rx} {y+height} H{x+rx} A{rx} {ry} 0 0 1 {x} {y+height-ry} V{y+ry} A{rx} {ry} 0 0 1 {x+rx} {y} Z"
        return f"M{x} {y} H{x+width} V{y+height} H{x} Z"
    return ""


def hatch_region(contours: list[np.ndarray], spacing: float = 5, angle: float = -35, fill_rule: str = "nonzero") -> list[np.ndarray]:
    """Scan closed contours using winding/parity, preserving holes and concavities.

    Pen lifts separate disconnected intervals. This deliberately avoids drawing
    connecting diagonals through a hole just to create a single zigzag path.
    """
    if spacing <= 0 or not math.isfinite(spacing):
        raise ValueError("Hatch spacing must be positive and finite.")
    if not contours:
        return []
    theta = math.radians(angle)
    rotation = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    polygons = [np.asarray(p, dtype=float) @ rotation for p in contours if len(p) >= 3]
    if not polygons:
        return []
    low = min(p[:, 1].min() for p in polygons)
    high = max(p[:, 1].max() for p in polygons)
    if (high - low) / spacing > 20_000:
        raise ValueError("Hatch density exceeds the safety limit.")
    strokes: list[np.ndarray] = []
    for row, y in enumerate(np.arange(low + spacing / 2, high, spacing)):
        events: list[tuple[float, int]] = []
        for polygon in polygons:
            if not np.allclose(polygon[0], polygon[-1]):
                polygon = np.vstack([polygon, polygon[0]])
            for a, b in zip(polygon[:-1], polygon[1:]):
                if (a[1] <= y < b[1]) or (b[1] <= y < a[1]):
                    x = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
                    events.append((float(x), 1 if b[1] > a[1] else -1))
        events.sort()
        winding, start = 0, None
        for x, direction in events:
            was_inside = bool(winding % 2) if fill_rule == "evenodd" else winding != 0
            winding += 1 if fill_rule == "evenodd" else direction
            is_inside = bool(winding % 2) if fill_rule == "evenodd" else winding != 0
            if not was_inside and is_inside:
                start = x
            elif was_inside and not is_inside and start is not None and x - start > 1e-8:
                segment = np.array([[start, y], [x, y]]) @ rotation.T
                strokes.append(segment[::-1] if row % 2 else segment)
                start = None
    return strokes


def parse_svg(path: Path, accent: str = "#648650", hatching: bool = True) -> VectorDrawing:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", accent):
        raise ValueError("Accent must be a six-digit hex color.")
    root = fromstring(sanitize_svg(path.read_bytes()))
    view = [float(n) for n in re.findall(NUMBER, root.get("viewBox", "0 0 24 24"))]
    if len(view) != 4 or view[2] <= 0 or view[3] <= 0 or not all(math.isfinite(n) for n in view):
        raise ValueError("SVG needs a valid viewBox with positive dimensions.")
    unit = max(view[2], view[3]) / 900
    strokes: list[Stroke] = []
    fills: list[Stroke] = []
    point_count = 0

    def visit(element, matrix: np.ndarray, inherited: dict[str, str]) -> None:
        nonlocal point_count
        tag = element.tag.rsplit("}", 1)[-1]
        style = {**inherited, **{k: v for k, v in element.attrib.items() if k in STYLE_KEYS or k.startswith("data-")}}
        if style.get("display") == "none" or style.get("visibility") == "hidden" or style.get("opacity") == "0":
            return
        current = matrix @ transform_matrix(element.get("transform", ""))
        data = _shape_path(element)
        if data:
            vector_path = parse_path(data)
            closed_contours = []
            for subpath in vector_path.continuous_subpaths():
                points: list[complex] = []
                for segment in subpath:
                    length = segment.length(error=1e-5)
                    if length < 1e-9:
                        continue
                    steps = max(1, min(4096, math.ceil(length / max(unit * 2.5, 1e-6))))
                    point_count += steps + 1
                    if point_count > MAX_POINTS:
                        raise ValueError("SVG exceeds the 300,000 point complexity limit.")
                    # A dense parametric sample is rescaled to pixel space later;
                    # animation timing uses measured polyline arc length, not t.
                    sampled = [segment.point(i / steps) for i in range(steps + 1)]
                    points.extend(sampled if not points else sampled[1:])
                if len(points) < 2:
                    continue
                coords = np.array([[p.real, p.imag, 1] for p in points]) @ current.T
                coords = coords[:, :2]
                if not np.isfinite(coords).all() or np.abs(coords).max() > 1e8:
                    raise ValueError("SVG contains invalid transformed coordinates.")
                closed = subpath.isclosed()
                if closed:
                    closed_contours.append(coords)
                explicit = style.get("data-layer", "")
                layer = explicit if explicit in {"outline", "detail", "hatch"} else "outline" if closed or len(subpath) > 3 else "detail"
                color = style.get("stroke", INK)
                if color in {"none", "currentColor", "accent", "#648650"} or style.get("data-accent") == "true":
                    color = accent if layer == "hatch" else INK
                if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                    color = accent if layer == "hatch" else INK
                if layer != "hatch" or hatching:
                    strokes.append(Stroke(coords, layer, color, 2.4 if layer == "outline" else 1.35))
            fill = style.get("fill", "none").lower()
            wants_fill = style.get("data-hatch", "").lower() in {"true", "1"} or fill not in {"none", "transparent", "white", "#fff", "#ffffff"}
            if hatching and closed_contours and wants_fill and style.get("data-hatch") != "false":
                for points in hatch_region(closed_contours, spacing=unit * 7, fill_rule=style.get("fill-rule", "nonzero")):
                    if len(fills) + len(strokes) >= 50_000:
                        raise ValueError("SVG exceeds the 50,000 stroke complexity limit.")
                    fills.append(Stroke(points, "hatch", accent, 1.25))
        if tag in {"svg", "g"}:
            for child in element:
                visit(child, current, style)

    visit(root, np.eye(3), {})
    strokes += fills
    if not strokes:
        raise ValueError("SVG contains no visible, non-zero-length paths.")
    strokes.sort(key=lambda stroke: {"outline": 0, "detail": 1, "hatch": 2}[stroke.layer])
    all_points = np.vstack([stroke.points for stroke in strokes])
    low, high = all_points.min(axis=0), all_points.max(axis=0)
    return VectorDrawing(strokes, (float(low[0]), float(low[1]), float(high[0]), float(high[1])))