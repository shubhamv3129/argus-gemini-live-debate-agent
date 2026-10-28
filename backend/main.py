"""
FastAPI backend for Argus — the AI Clinical Hepatology Debate Bot.
Multiplexes PCM16 microphone audio in, Gemini Live API audio/transcript out,
and interruption events over a single WebSocket.
"""
import asyncio
import base64
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Load environment variables from .env before initializing the Gemini client
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
load_dotenv(BASE_DIR / ".env")

from gemini_live import GeminiLiveSession  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")

app = FastAPI(title="Argus — AI Debate Bot")

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def index() -> FileResponse:
    """Serves the main debate frontend page."""
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket, voice: str = "Puck") -> None:
    """
    Bidirectional WebSocket endpoint for real-time audio debate with Gemini Live.
    """
    await websocket.accept()
    session = GeminiLiveSession()
    await session.start(voice_name=voice)
    logger.info("Gemini Live session started with voice: %s", voice)

    async def pump_gemini_to_browser() -> None:
        while True:
            event = await session.out_queue.get()
            if event.kind == "audio" and event.audio:
                await websocket.send_text(
                    json.dumps(
                        {
                            "type": "audio",
                            "data": base64.b64encode(event.audio).decode("ascii"),
                        }
                    )
                )
            elif event.kind == "interrupted":
                await websocket.send_text(json.dumps({"type": "interrupted"}))
            elif event.kind == "turn_complete":
                await websocket.send_text(json.dumps({"type": "turn_complete"}))
            elif event.kind == "text":
                await websocket.send_text(
                    json.dumps({"type": "text", "data": event.text})
                )
            elif event.kind == "error":
                await websocket.send_text(
                    json.dumps({"type": "error", "data": event.text})
                )

    pump_task = asyncio.create_task(pump_gemini_to_browser())

    try:
        while True:
            msg = await websocket.receive()

            if msg.get("type") == "websocket.disconnect":
                logger.info("Client disconnected gracefully")
                break

            if "bytes" in msg and msg["bytes"] is not None:
                await session.send_audio_chunk(msg["bytes"])
            elif "text" in msg and msg["text"] is not None:
                logger.info("Client control message: %s", msg["text"])

    except WebSocketDisconnect:
        logger.info("Client disconnected via exception")
    except RuntimeError as exc:
        if "disconnect message" in str(exc):
            logger.info("Client disconnected (RuntimeError caught)")
        else:
            raise
    finally:
        pump_task.cancel()
        await session.close()


def example_run_debate_server() -> None:
    """Starts the FastAPI Uvicorn server for the debate bot."""
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)


def main() -> None:
    """Main entry point."""
    example_run_debate_server()


if __name__ == "__main__":
    main()
