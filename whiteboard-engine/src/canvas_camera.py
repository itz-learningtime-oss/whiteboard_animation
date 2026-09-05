"""A continuous, tiled virtual board with smooth subpixel camera interpolation."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

from PIL import Image


def smoothstep(t: float) -> float:
    t = min(1.0, max(0.0, float(t)))
    return t * t * (3.0 - 2.0 * t)


def smootherstep(t: float) -> float:
    t = min(1.0, max(0.0, float(t)))
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


@dataclass(frozen=True)
class CameraPose:
    x: float
    y: float
    width: float
    height: float

    def __post_init__(self):
        if self.width <= 0 or self.height <= 0 or not all(math.isfinite(n) for n in (self.x, self.y, self.width, self.height)):
            raise ValueError("Camera coordinates must be finite and dimensions positive.")

    @staticmethod
    def interpolate(start: "CameraPose", end: "CameraPose", progress: float) -> "CameraPose":
        t = smootherstep(progress)
        return CameraPose(*(a + (b - a) * t for a, b in zip((start.x, start.y, start.width, start.height), (end.x, end.y, end.width, end.height))))


class CanvasCamera:
    """Tiles are loaded on demand instead of allocating a gigantic RGB bitmap."""

    def __init__(self, scene_count: int, width: int = 1920, height: int = 1080, columns: int = 2, movements: list[str] | None = None, enabled: bool = True):
        if scene_count < 1 or columns < 1 or width < 1 or height < 1:
            raise ValueError("The canvas needs scenes and positive dimensions.")
        self.width, self.height, self.enabled = width, height, enabled
        self.movements = movements or ["auto"] * scene_count
        if len(self.movements) != scene_count:
            raise ValueError("Provide one camera movement per scene.")
        self.origins: list[tuple[int, int]] = []
        for index in range(scene_count):
            row, column = divmod(index, columns)
            if row % 2:
                column = columns - 1 - column
            origin = (column * width, row * height)
            if index and self.movements[index] in {"pan_right", "pan_down"}:
                previous = self.origins[-1]
                origin = (previous[0] + width, previous[1]) if self.movements[index] == "pan_right" else (previous[0], previous[1] + height)
            # Explicit camera directions must not cause two scenes to overwrite.
            while origin in self.origins:
                origin = (origin[0] + width, origin[1])
            self.origins.append(origin)
        self.virtual_size = (max(2 * width, max(x for x, _ in self.origins) + width), max(2 * height, max(y for _, y in self.origins) + height))

    def pose(self, index: int, zoom: float = 1.0) -> CameraPose:
        if not 0 <= index < len(self.origins) or not .5 <= zoom <= 2:
            raise ValueError("Invalid scene index or camera zoom.")
        x, y = self.origins[index]
        w, h = self.width / zoom, self.height / zoom
        return CameraPose(x + (self.width - w) / 2, y + (self.height - h) / 2, w, h)

    def final_zoom(self, index: int) -> float:
        return {"zoom_in": 1.13, "zoom_out": .9, "none": 1.0}.get(self.movements[index], 1.025)

    def at(self, index: int, local_time: float, duration: float, transition: float = .8) -> CameraPose:
        if not self.enabled or self.movements[index] == "none":
            return self.pose(index)
        if index > 0 and local_time < transition:
            previous_zoom = self.final_zoom(index - 1) if self.movements[index - 1] != "none" else 1.0
            return CameraPose.interpolate(self.pose(index - 1, previous_zoom), self.pose(index), local_time / transition)
        start = transition if index else 0
        progress = smoothstep((local_time - start) / max(.1, duration - start))
        return self.pose(index, 1 + (self.final_zoom(index) - 1) * progress)

    def world_to_view(self, point: tuple[float, float], pose: CameraPose) -> tuple[float, float]:
        return ((point[0] - pose.x) / pose.width * self.width, (point[1] - pose.y) / pose.height * self.height)

    def composite(self, pose: CameraPose, tile_provider: Callable[[int], Image.Image | None], last_scene: int, background: str = "#fcfbf5") -> Image.Image:
        origin_x, origin_y = math.floor(pose.x), math.floor(pose.y)
        canvas = Image.new("RGB", (math.ceil(pose.width) + 2, math.ceil(pose.height) + 2), background)
        for index, (x, y) in enumerate(self.origins[:last_scene + 1]):
            if x >= pose.x + pose.width or x + self.width <= pose.x or y >= pose.y + pose.height or y + self.height <= pose.y:
                continue
            tile = tile_provider(index)
            if tile is not None:
                canvas.paste(tile, (x - origin_x, y - origin_y))
        # Retain fractional pan offsets instead of snapping the camera to pixels.
        return canvas.transform(
            (self.width, self.height), Image.Transform.AFFINE,
            (pose.width / self.width, 0, pose.x - origin_x, 0, pose.height / self.height, pose.y - origin_y),
            resample=Image.Resampling.BICUBIC,
        )