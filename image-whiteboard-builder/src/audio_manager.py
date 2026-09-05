"""Decode once, measure PCM samples with pydub, and build a drift-free timeline."""

from __future__ import annotations

import math
import shutil
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

SAMPLE_RATE = 48_000
MAX_AUDIO_SECONDS = 600
MAX_AUDIO_BYTES = 128 * 1024 * 1024
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aif", ".aiff"}


@dataclass(frozen=True)
class AudioInfo:
    source: Path
    pcm_path: Path
    sample_frames: int
    sample_rate: int
    channels: int

    @property
    def exact_duration(self) -> Fraction:
        return Fraction(self.sample_frames, self.sample_rate)

    @property
    def duration(self) -> float:
        return float(self.exact_duration)


@dataclass(frozen=True)
class TimingPlan:
    sample_frames: int
    sample_rate: int
    fps: int
    frame_count: int
    first_draw_frame: int
    last_draw_frame: int

    @property
    def audio_duration(self) -> float:
        return self.sample_frames / self.sample_rate

    @property
    def video_duration(self) -> float:
        return self.frame_count / self.fps

    @property
    def audio_padding_samples(self) -> int:
        return math.ceil(Fraction(self.frame_count * self.sample_rate, self.fps)) - self.sample_frames

    def progress_at(self, frame_index: int) -> float:
        if not 0 <= frame_index < self.frame_count:
            raise IndexError("Frame index is outside the planned video.")
        return min(1.0, max(0.0, (frame_index - self.first_draw_frame) / (self.last_draw_frame - self.first_draw_frame)))


def plan_timing(sample_frames: int, sample_rate: int, fps: int = 30, lead: float = 0, hold: float = 0) -> TimingPlan:
    if isinstance(fps, bool) or fps not in {24, 25, 30, 60}:
        raise ValueError("FPS must be 24, 25, 30, or 60.")
    if not isinstance(sample_frames, int) or not isinstance(sample_rate, int) or sample_frames <= 0 or sample_rate <= 0:
        raise ValueError("Audio sample count and sample rate must be positive integers.")
    duration = Fraction(sample_frames, sample_rate)
    if not Fraction(1, 10) <= duration <= MAX_AUDIO_SECONDS:
        raise ValueError(f"Audio must be between 0.1 and {MAX_AUDIO_SECONDS} seconds.")
    if not all(math.isfinite(n) and n >= 0 for n in (lead, hold)):
        raise ValueError("Lead-in and final hold must be non-negative finite durations.")
    frames = math.ceil(duration * fps)
    first = math.ceil(lead * fps)
    last = frames - 1 - math.ceil(hold * fps)
    if last <= first:
        raise ValueError("Lead-in and hold leave no drawing time. Reduce them or use longer audio.")
    return TimingPlan(sample_frames, sample_rate, fps, frames, first, last)


def analyze_audio(source: Path, work_dir: Path, ffmpeg: str | None = None) -> AudioInfo:
    """Measure decoded audio, not rounded MP3/container metadata.

    The exact same normalized PCM is muxed into the video. Decoding is bounded
    to ten minutes plus a sentinel second, so overly long inputs are rejected,
    never silently truncated. User narration is not synthesized or replaced.
    """
    from pydub import AudioSegment

    source = Path(source).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() not in AUDIO_EXTENSIONS:
        raise ValueError("Choose an existing WAV, MP3, M4A, AAC, FLAC, OGG, Opus, or AIFF audio file.")
    if not 0 < source.stat().st_size <= MAX_AUDIO_BYTES:
        raise ValueError("Audio is empty or exceeds the 128 MB input limit.")
    executable = ffmpeg or shutil.which("ffmpeg")
    if not executable:
        raise RuntimeError("FFmpeg is required to decode audio. Install FFmpeg and add it to PATH.")
    work_dir.mkdir(parents=True, exist_ok=True)
    target = work_dir / "narration-pcm.wav"
    if target.resolve() == source:
        raise ValueError("The audio working path must not overwrite the source.")
    command = [executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", str(source), "-map", "0:a:0", "-vn", "-t", str(MAX_AUDIO_SECONDS + 1), "-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(target)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        if result.returncode or not target.is_file():
            raise RuntimeError(f"Could not decode the audio track: {result.stderr[-1500:]}")
        decoded = AudioSegment.from_wav(str(target))
        # len(AudioSegment) rounds to milliseconds. Raw PCM frame count does not.
        samples = len(decoded.raw_data) // decoded.frame_width
        info = AudioInfo(source, target, samples, decoded.frame_rate, decoded.channels)
        del decoded
        plan_timing(info.sample_frames, info.sample_rate)
        return info
    except BaseException:
        target.unlink(missing_ok=True)
        raise