# ⚖️ Argus — Real-Time Voice Debate Bot on Gemini Live API

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-WebSockets-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Gemini Live API](https://img.shields.io/badge/Gemini_Live_API-Native_Audio-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)
![JavaScript](https://img.shields.io/badge/Frontend-Web_Audio_Lip_Sync-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)

**Argus** is a real-time, low-latency spoken debate opponent arguing **FOR** the motion *"Artificial Intelligence Will Replace the Clinical Hepatologist"*. Built on the **Gemini Live API (`google-genai`)**, **FastAPI WebSockets**, and a **Web Audio API** frontend, Argus opens the debate autonomously, streams native audio with live output transcriptions, supports mid-sentence barge-in interruption via server-side Voice Activity Detection (VAD), and drives a real-time lip-synced CSS avatar.

---

## 📐 System Architecture

```mermaid
sequenceDiagram
    participant User as Browser (Web Audio + Avatar)
    participant FastAPI as FastAPI Server (/ws)
    participant Live as GeminiLiveSession (google-genai)

    User->>FastAPI: Open WebSocket (/ws?voice=Puck)
    FastAPI->>Live: session.start() + send_client_content("Begin opening statement")
    Live-->>FastAPI: Audio chunks + Output Transcription
    FastAPI-->>User: JSON {"type": "audio", "data": "<base64 PCM>"}
    User->>User: Play Audio & Drive Lip-Sync via AnalyserNode
    User->>FastAPI: Stream 16kHz PCM16 Mic Bytes (Barge-In)
    FastAPI->>Live: send_realtime_input(audio/pcm;rate=16000)
    Live-->>FastAPI: ServerContent(interrupted=True)
    FastAPI-->>User: JSON {"type": "interrupted"} (Flush Audio Queue Immediately)
```

---

## 📁 Project Structure

```text
argus-gemini-live-debate-agent/
├── backend/
│   ├── main.py            # FastAPI WebSocket multiplexer & static file server
│   ├── gemini_live.py     # Async Gemini Live session manager (audio in/out & VAD interruption)
│   ├── grounding.py       # Debate persona, system instructions, and clinical hepatology evidence
│   ├── .env.example       # Environment variable template
│   └── requirements.txt   # Backend Python dependencies
├── frontend/
│   ├── index.html         # Debate arena interface
│   ├── app.js             # 16kHz PCM16 mic capture, gapless audio scheduler, and AnalyserNode lip-sync
│   └── style.css          # Animated avatar & UI styling
├── scripts.py             # Multilingual (Hindi/Marathi) deterministic conversation state-machine reference
└── README.md              # Project documentation
```

---

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `GEMINI_API_KEY` | Yes | — | Google AI Studio / Gemini API key (configured in `backend/.env`) |
| `PORT` | No | `8000` | HTTP/WebSocket server port |

---

## 🚀 Quickstart

```bash
cd argus-gemini-live-debate-agent/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

python3 main.py
```

Open **`http://localhost:8000`** in Google Chrome, click **Start Debate**, grant microphone permissions, and debate Argus in real time.
