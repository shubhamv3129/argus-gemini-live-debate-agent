import asyncio
import logging
from dataclasses import dataclass, field

from google import genai
from google.genai import types

from grounding import SYSTEM_INSTRUCTION

logger = logging.getLogger("gemini_live")

# Native-audio Live model. If this model name has moved on by the time you
# run this, check: https://ai.google.dev/gemini-api/docs/live-api
MODEL = "gemini-3.1-flash-live-preview"


@dataclass
class OutgoingEvent:
    """One event to forward to the browser over the WebSocket."""
    kind: str  # "audio" | "interrupted" | "turn_complete" | "text" | "error"
    audio: bytes | None = None
    text: str | None = None


class GeminiLiveSession:
    def __init__(self):
        # Uses Application Default Credentials + these env vars (set in .env
        # or your shell): GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION,
        # GOOGLE_GENAI_USE_VERTEXAI=True
        self.client = genai.Client()
        self._session_cm = None
        self.session = None
        self.out_queue: asyncio.Queue[OutgoingEvent] = asyncio.Queue()
        self._receive_task: asyncio.Task | None = None

    async def start(self, voice_name: str = "Puck"):
        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            system_instruction=types.Content(
                role="system",
                parts=[types.Part(text=SYSTEM_INSTRUCTION)],
            ),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=voice_name
                    )
                )
            ),
            # Lets Gemini generate its own opening line without waiting on
            # the user to speak first.
            output_audio_transcription=types.AudioTranscriptionConfig(),
        )

        self._session_cm = self.client.aio.live.connect(model=MODEL, config=config)
        self.session = await self._session_cm.__aenter__()
        self._receive_task = asyncio.create_task(self._receive_loop())

        # Kick the bot into speaking first with an opening statement.
        await self.session.send_client_content(
            turns=types.Content(
                role="user",
                parts=[types.Part(text="Please begin the debate now with your opening statement.")],
            ),
            turn_complete=True,
        )

    async def send_audio_chunk(self, pcm16_bytes: bytes):
        """Forward one chunk of 16kHz mono PCM16 mic audio to Gemini."""
        if not self.session:
            return
        await self.session.send_realtime_input(
            audio=types.Blob(data=pcm16_bytes, mime_type="audio/pcm;rate=16000")
        )

    async def _receive_loop(self):
        try:
            while True:
                async for message in self.session.receive():
                    sc = message.server_content
                    if sc is None:
                        continue

                    if sc.interrupted:
                        # Model was cut off by the user speaking. Tell the
                        # browser to flush any queued/playing audio NOW.
                        await self.out_queue.put(OutgoingEvent(kind="interrupted"))

                    if sc.model_turn:
                        for part in sc.model_turn.parts:
                            if part.inline_data and part.inline_data.data:
                                await self.out_queue.put(
                                    OutgoingEvent(kind="audio", audio=part.inline_data.data)
                                )

                    if getattr(sc, "output_transcription", None) and sc.output_transcription.text:
                        await self.out_queue.put(
                            OutgoingEvent(kind="text", text=sc.output_transcription.text)
                        )

                    if sc.turn_complete:
                        await self.out_queue.put(OutgoingEvent(kind="turn_complete"))
        except Exception as e:  # noqa: BLE001
            logger.exception("Gemini receive loop crashed")
            await self.out_queue.put(OutgoingEvent(kind="error", text=str(e)))

    async def close(self):
        if self._receive_task:
            self._receive_task.cancel()
        if self._session_cm:
            await self._session_cm.__aexit__(None, None, None)