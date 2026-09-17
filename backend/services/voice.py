"""Groq speech-to-text and text-to-speech wrappers.

Question audio is generated with `canopylabs/orpheus-v1-english` and recorded
answers are transcribed with `whisper-large-v3-turbo`, both over the same
OpenAI-compatible Groq base URL the chat client already uses.

Orpheus caps each TTS request at `GROQ_TTS_MAX_CHARS` characters, so an
overlong question (the examiner occasionally drifts long) is split on word
boundaries into multiple requests and the resulting WAV segments are stitched
back into a single lossless file rather than failing the whole turn. The Groq
org must also accept the Canopy Labs Orpheus model terms (one-time, org admin)
before the first successful TTS call; until then Groq returns
`model_terms_required` (HTTP 400) for every request.
"""

import io
import logging
import wave
from typing import Optional

from openai import BadRequestError, OpenAI

from config import settings

log = logging.getLogger("athenaeum.voice")

_audio_client: Optional[OpenAI] = None

_JOIN_PAUSE_MS = 120  # short breath between stitched TTS segments


def _get_audio_client() -> OpenAI:
    global _audio_client
    if _audio_client is None:
        _audio_client = OpenAI(
            api_key=settings.GROQ_API_KEY,
            base_url=settings.BASE_URL_GROQ,
        )
    return _audio_client


def _error_code(exc: BadRequestError) -> Optional[str]:
    """Return the Groq error `code` (e.g. `model_terms_required`) if present.

    Groq returns codes inside `{"error": {"code": ...}}` for some 4xx and
    directly on the exception `code` attribute for others, so we check both.
    """
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            if code:
                return str(code)
    code = getattr(exc, "code", None)
    return str(code) if code else None


def _chunk_text(text: str, max_chars: int) -> list[str]:
    """Split `text` into up-to-`max_chars` chunks on word boundaries."""
    if len(text) <= max_chars:
        return [text]

    words = text.split(" ")
    chunks: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip() if current else word
        if len(candidate) > max_chars:
            if current:
                chunks.append(current)
                current = word
            else:
                chunks.append(word[:max_chars])
                current = word[max_chars:]
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def _wav_info(wav_bytes: bytes) -> tuple[int, int, int, bytes]:
    """Return `(channels, sampwidth, framerate, frames)` from a WAV blob."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    return channels, sampwidth, framerate, frames


def _join_wavs(segments: list[bytes]) -> bytes:
    """Concatenate individual WAV blobs into one WAV, inserting a brief silence.

    All segments share the same sample parameters (single model/voice), so we
    strip each header, splice the PCM frames with a short pause between them,
    and write one fresh header.
    """
    if len(segments) == 1:
        return segments[0]

    channels, sampwidth, framerate, first = _wav_info(segments[0])
    pause_frames = int(framerate * (_JOIN_PAUSE_MS / 1000))
    pause = b"\x00" * (channels * sampwidth * pause_frames)

    combined = bytearray(first)
    for segment in segments[1:]:
        _, _, _, frames = _wav_info(segment)
        combined.extend(pause)
        combined.extend(frames)

    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(framerate)
        wf.writeframes(bytes(combined))
    return out.getvalue()


def synthesize_speech(text: str) -> bytes:
    """Generate WAV bytes for `text` via Groq Orpheus TTS.

    Text longer than the per-request Orpheus cap is split on word boundaries,
    each chunk synthesized separately, and the WAV segments stitched into a
    single contiguous file so an overlong question never fails the turn.
    """
    chunks = _chunk_text(text, settings.GROQ_TTS_MAX_CHARS)
    try:
        segments = []
        for chunk in chunks:
            response = _get_audio_client().audio.speech.create(
                model=settings.GROQ_TTS_MODEL,
                voice=settings.GROQ_TTS_VOICE,
                input=chunk,
                response_format="wav",
            )
            segments.append(response.content)
        return _join_wavs(segments)
    except BadRequestError as exc:
        if _error_code(exc) == "model_terms_required":
            raise ValueError(
                "TTS requires the Canopy Labs Orpheus model terms to be "
                "accepted for this Groq account. An org admin must accept "
                "them here: "
                "\nhttps://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english"
            ) from exc
        log.exception("TTS request failed")
        raise ValueError("Failed to synthesize speech for the question") from exc
    except Exception as exc:
        log.exception("TTS request failed")
        raise ValueError("Failed to synthesize speech for the question") from exc


def transcribe_audio(audio_bytes: bytes, mime: str) -> str:
    """Transcribe recorded answer audio to text via Groq Whisper."""
    ext = "wav"
    if mime:
        candidate = mime.split("/")[-1].split(";")[0].lower()
        if candidate:
            ext = candidate
    filename = f"answer.{ext}"
    try:
        result = _get_audio_client().audio.transcriptions.create(
            model=settings.GROQ_STT_MODEL,
            file=(filename, audio_bytes, mime or "audio/webm"),
            response_format="json",
        )
        return (result.text or "").strip()
    except Exception as exc:
        log.exception("STT request failed")
        raise ValueError("Failed to transcribe your answer") from exc
