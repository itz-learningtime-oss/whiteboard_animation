"""Narration with explicit offline/system and online/keyless gTTS backends."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
SAMPLE_RATE = 48_000


@dataclass(frozen=True)
class AudioClip:
    path: Path
    duration: float


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def write_silence(path: Path, duration: float) -> AudioClip:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(SAMPLE_RATE)
        remaining = round(duration * SAMPLE_RATE)
        while remaining:
            count = min(remaining, SAMPLE_RATE)
            out.writeframesraw(b"\0\0" * count)
            remaining -= count
    return AudioClip(path, duration)


def _system_voice_worker(text: str, language: str, rate: int, output: Path) -> None:
    import pyttsx3

    engine = pyttsx3.init()
    try:
        chosen = None
        for voice in engine.getProperty("voices"):
            languages = [v.decode("utf-8", errors="ignore") if isinstance(v, bytes) else str(v) for v in (voice.languages or [])]
            if any(v.lstrip("\x00\x01\x02\x03\x04\x05").lower().startswith(language) for v in languages):
                chosen = voice.id
                break
        if not chosen:
            raise RuntimeError(f"No installed {language!r} system voice. Install a voice or eSpeak NG; do not silently use another language.")
        engine.setProperty("voice", chosen)
        engine.setProperty("rate", rate)
        engine.save_to_file(text, str(output))
        engine.runAndWait()
        for _ in range(50):
            if output.exists() and output.stat().st_size > 44:
                break
            time.sleep(.1)
        if not output.exists() or output.stat().st_size <= 44:
            raise RuntimeError("The installed speech driver did not produce an audio file.")
    finally:
        engine.stop()


class AudioGenerator:
    def __init__(self, cache: Path, language: str = "en", backend: str = "local", rate: float = 1, offline: bool = False, ffmpeg: str | None = None):
        if language not in {"en", "hi"} or backend not in {"local", "gtts", "none"}:
            raise ValueError("Unsupported language or narration backend.")
        if not .7 <= rate <= 1.4:
            raise ValueError("Narration rate must be between 0.7 and 1.4.")
        if offline and backend == "gtts":
            raise ValueError("gTTS requires internet. Use --tts local or --tts none with --offline.")
        self.cache = cache
        self.cache.mkdir(parents=True, exist_ok=True)
        self.language, self.backend, self.rate = language, backend, rate
        self.ffmpeg = ffmpeg or shutil.which("ffmpeg")
        if not self.ffmpeg:
            raise RuntimeError("FFmpeg is missing. Install FFmpeg and add it to PATH.")

    def generate(self, text: str) -> AudioClip:
        if not text.strip():
            raise ValueError("Narration text cannot be empty.")
        key = hashlib.sha256(json.dumps(["audio-v1", self.backend, self.language, self.rate, text], ensure_ascii=False).encode()).hexdigest()
        target = self.cache / f"{key}.wav"
        if target.exists():
            try:
                with wave.open(str(target), "rb") as cached:
                    if cached.getnchannels() == 1 and cached.getsampwidth() == 2 and cached.getframerate() == SAMPLE_RATE and cached.getnframes() > 0:
                        return AudioClip(target, cached.getnframes() / SAMPLE_RATE)
            except (wave.Error, EOFError):
                target.unlink(missing_ok=True)
        if self.backend == "none":
            return write_silence(target, .1)
        with tempfile.TemporaryDirectory(prefix="speech-", dir=self.cache) as directory:
            work = Path(directory)
            raw = work / ("speech.mp3" if self.backend == "gtts" else "speech.wav")
            if self.backend == "gtts":
                from gtts import gTTS
                try:
                    gTTS(text=text, lang=self.language, lang_check=False, timeout=(5, 20)).save(str(raw))
                except Exception as exc:
                    raise RuntimeError("gTTS could not synthesize narration. It is an online service; retry with internet or choose --tts local.") from exc
            else:
                executable = shutil.which("espeak-ng") or shutil.which("espeak")
                if executable:
                    voice = "hi" if self.language == "hi" else "en-us"
                    command = [executable, "-v", voice, "-s", str(round(165 * self.rate)), "-w", str(raw), "--stdin"]
                    result = subprocess.run(command, input=text, text=True, capture_output=True, timeout=90)
                else:
                    request = work / "request.json"
                    request.write_text(json.dumps({"text": text, "language": self.language, "rate": round(165 * self.rate)}), encoding="utf-8")
                    result = subprocess.run([sys.executable, "-m", "src.tts_audio", "--worker", str(request), "--output", str(raw)], cwd=ROOT, capture_output=True, text=True, timeout=90)
                if result.returncode or not raw.exists():
                    detail = result.stderr[-1000:] or "No audio file was created."
                    raise RuntimeError(f"Offline narration failed. Install a system voice or eSpeak NG. {detail}")
            normalized = work / "normalized.wav"
            command = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw)]
            if self.backend == "gtts" and self.rate != 1:
                command += ["-af", f"atempo={self.rate}"]
            command += ["-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(normalized)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            if result.returncode:
                raise RuntimeError(f"FFmpeg could not normalize narration: {result.stderr[-1200:]}")
            duration = wav_duration(normalized)
            if not .01 < duration < 300:
                raise RuntimeError("Narration duration is invalid or exceeds five minutes for one scene.")
            os.replace(normalized, target)
        return AudioClip(target, duration)


def assemble_audio(timeline: Iterable[tuple[AudioClip, float, float]], output: Path) -> None:
    """Write exact lead-in + full narration + tail silence without clipping speech."""
    with wave.open(str(output), "wb") as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(SAMPLE_RATE)
        def silence(frames: int) -> None:
            while frames > 0:
                count = min(frames, SAMPLE_RATE)
                out.writeframesraw(b"\0\0" * count)
                frames -= count
        for clip, lead, duration in timeline:
            total_frames = round(duration * SAMPLE_RATE)
            lead_frames = round(lead * SAMPLE_RATE)
            with wave.open(str(clip.path), "rb") as audio:
                if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, SAMPLE_RATE):
                    raise ValueError("Audio must be normalized to mono 48 kHz, 16-bit PCM.")
                if lead_frames + audio.getnframes() > total_frames:
                    raise ValueError("The scene is shorter than its narration; extend it rather than clipping speech.")
                silence(lead_frames)
                remaining = audio.getnframes()
                while remaining:
                    count = min(remaining, SAMPLE_RATE)
                    out.writeframesraw(audio.readframes(count))
                    remaining -= count
                silence(total_frames - lead_frames - audio.getnframes())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Internal, isolated system-voice worker")
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.worker.read_text(encoding="utf-8"))
    _system_voice_worker(request["text"], request["language"], request["rate"], args.output)