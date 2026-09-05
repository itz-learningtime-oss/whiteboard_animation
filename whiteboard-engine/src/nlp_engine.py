"""Validate scripts and extract scene subjects, actions, and locations locally."""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)
MAX_TEXT = 30_000
MAX_SCENES = 40
LAYOUTS = {"centered_illustration_with_heading", "illustration_left"}
CAMERAS = {"auto", "pan_right", "pan_down", "zoom_in", "zoom_out", "none"}

VISUAL_RULES = (
    (r"\b(storage|tank|reservoir|store|barrel)\b", "storage"),
    (r"\b(rooftop|roof|collect|collects|harvest|harvesting|catch)\b", "collection"),
    (r"\b(rain|rainwater|water|droplet|river|ocean|cloud|khadin)\b", "rainwater"),
    (r"\b(farm|farms|crop|crops|grow|community|communities|sustainable|field|fields|food)\b", "growth"),
    (r"\b(sun|solar|energy|electric|power)\b", "sun"),
    (r"\b(truck|trucks|train|vehicle|transport|goods|market|car)\b", "truck"),
    (r"\b(leaf|leaves|plant|tree|nature|photosynthesis|garden)\b", "leaf"),
)


@dataclass
class Scene:
    text: str
    heading: str
    primary_visual: str
    layout: str = "centered_illustration_with_heading"
    duration: float | None = None
    camera: str = "auto"
    subjects: list[str] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)


@dataclass
class Script:
    title: str
    scenes: list[Scene]
    settings: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(item for item in items if item))


def choose_visual(text: str, subjects: list[str] | None = None) -> str:
    primary = subjects[0] if subjects else ""
    if primary in {"train", "railway", "locomotive"}:
        return "train-front"
    if primary in {"truck", "vehicle", "lorry", "car"}:
        return "truck"
    for pattern, name in VISUAL_RULES:
        if re.search(pattern, text, re.IGNORECASE):
            return name
    if subjects:
        keyword = re.sub(r"[^a-z0-9-]", "-", subjects[0].lower()).strip("-")
        if keyword:
            return keyword[:64]
    return "file-text"


@lru_cache(maxsize=4)
def _load_model(language: str, allow_rule_fallback: bool):
    import spacy

    if language == "hi":
        # The requested English model is not a Hindi dependency parser.
        pipeline = spacy.blank("hi")
        pipeline.add_pipe("sentencizer", config={"punct_chars": [".", "!", "?", "\u0964", "\u0965"]})
        LOGGER.warning("Hindi segmentation is rule-based; use explicit primary_visual values for precise artwork.")
        return pipeline
    try:
        return spacy.load("en_core_web_sm")
    except OSError as exc:
        if not allow_rule_fallback:
            raise RuntimeError(
                "The local spaCy model is missing. Run python setup_engine.py, or "
                "python -m spacy download en_core_web_sm. Use --allow-rule-fallback "
                "only if sentence splitting without dependency analysis is acceptable."
            ) from exc
        LOGGER.warning("Using explicit rule-based fallback; subject/verb extraction is unavailable.")
        pipeline = spacy.blank("en")
        pipeline.add_pipe("sentencizer")
        return pipeline


class ScriptParser:
    def __init__(self, language: str = "en", allow_rule_fallback: bool = False):
        if language not in {"en", "hi"}:
            raise ValueError("Supported narration languages are en and hi.")
        self.language = language
        self.allow_rule_fallback = allow_rule_fallback

    @staticmethod
    def _text(value: Any, label: str, max_length: int) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} must be a non-empty string.")
        text = value.strip()
        if len(text) > max_length:
            raise ValueError(f"{label} exceeds {max_length:,} characters; split it into shorter scenes.")
        if "\x00" in text:
            raise ValueError(f"{label} contains a NUL character.")
        return text

    @staticmethod
    def _heading(text: str) -> str:
        phrase = re.split(r"[.!?\u0964]", text, maxsplit=1)[0]
        return " ".join(phrase.split()[:7])[:100]

    def _analyze(self, span) -> dict[str, list[str]]:
        if not span.doc.has_annotation("DEP"):
            return {"subjects": [], "actions": [], "locations": []}
        subjects = [t.lemma_.lower() for t in span if t.dep_ in {"nsubj", "nsubjpass", "csubj"} and t.pos_ in {"NOUN", "PROPN"}]
        nouns = [t.lemma_.lower() for t in span if t.pos_ in {"NOUN", "PROPN"} and not t.is_stop]
        actions = [t.lemma_.lower() for t in span if t.pos_ == "VERB"]
        locations = [entity.text for entity in span.ents if entity.label_ in {"GPE", "LOC", "FAC"}]
        locations += [t.text for t in span if t.dep_ == "pobj" and t.head.lower_ in {"in", "at", "near", "from", "toward", "across"}]
        return {"subjects": _unique(subjects + nouns), "actions": _unique(actions), "locations": _unique(locations)}

    def parse_text(self, text: str, title: str | None = None) -> Script:
        text = self._text(text, "Script", MAX_TEXT)
        nlp = _load_model(self.language, self.allow_rule_fallback)
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        chunks = paragraphs if len(paragraphs) > 1 else [s.text.strip() for s in nlp(text).sents if s.text.strip()]
        if not chunks or len(chunks) > MAX_SCENES:
            raise ValueError(f"A script needs between 1 and {MAX_SCENES} scenes.")
        scenes: list[Scene] = []
        for index, doc in enumerate(nlp.pipe(chunks, batch_size=16)):
            scene_text = self._text(doc.text, f"Scene {index + 1}", 2_000)
            analysis = self._analyze(doc[:])
            scenes.append(Scene(
                text=scene_text, heading=self._heading(scene_text),
                primary_visual=choose_visual(scene_text, analysis["subjects"]),
                **analysis,
            ))
        return Script(title=(title or self._heading(chunks[0]))[:100], scenes=scenes)

    def parse_json(self, value: str | dict[str, Any]) -> Script:
        if isinstance(value, str):
            if len(value) > 100_000:
                raise ValueError("JSON script exceeds 100 KB.")
            try:
                value = json.loads(value)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}") from exc
        if not isinstance(value, dict):
            raise ValueError("The JSON root must be an object.")
        title = self._text(value.get("title", "Untitled story"), "Title", 100)
        rows = value.get("scenes")
        if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_SCENES:
            raise ValueError(f"scenes must be an array of 1 to {MAX_SCENES} objects.")
        scenes: list[Scene] = []
        for index, row in enumerate(rows, start=1):
            if not isinstance(row, dict):
                raise ValueError(f"Scene {index} must be an object.")
            text = self._text(row.get("text"), f"Scene {index} text", 2_000)
            heading = self._text(row.get("heading", row.get("title", self._heading(text))), f"Scene {index} heading", 100)
            visual = self._text(row.get("primary_visual", row.get("icon", choose_visual(text))), f"Scene {index} primary_visual", 100)
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_:-]{0,99}", visual):
                raise ValueError(f"Scene {index}: primary_visual must be an asset name, not a URL or path.")
            layout = row.get("layout", "centered_illustration_with_heading")
            if layout not in LAYOUTS:
                raise ValueError(f"Scene {index}: unsupported layout {layout!r}.")
            camera = row.get("camera", "auto")
            if camera not in CAMERAS:
                raise ValueError(f"Scene {index}: unsupported camera movement.")
            duration = row.get("duration")
            if duration is not None:
                if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 2 <= duration <= 120:
                    raise ValueError(f"Scene {index}: duration must be between 2 and 120 seconds.")
                duration = float(duration)
            analysis = {}
            for key in ("subjects", "actions", "locations"):
                items = row.get(key, [])
                if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
                    raise ValueError(f"Scene {index}: {key} must be a list of strings.")
                analysis[key] = [item[:100] for item in items[:30]]
            scenes.append(Scene(text=text, heading=heading, primary_visual=visual, layout=layout, duration=duration, camera=camera, **analysis))
        if sum(len(scene.text) for scene in scenes) > MAX_TEXT:
            raise ValueError(f"Combined narration exceeds {MAX_TEXT:,} characters.")
        settings = value.get("settings", {})
        if not isinstance(settings, dict):
            raise ValueError("settings must be an object.")
        return Script(title=title, scenes=scenes, settings=settings)

    def parse_file(self, path: Path) -> Script:
        if not path.is_file():
            raise ValueError(f"Script not found: {path}")
        if path.stat().st_size > 100_000:
            raise ValueError("Script file exceeds 100 KB.")
        text = path.read_text(encoding="utf-8-sig")
        return self.parse_json(text) if path.suffix.lower() == ".json" else self.parse_text(text)