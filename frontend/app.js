const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const mouthEl = document.getElementById("mouth");
const ringEl = document.getElementById("ring");
const voiceSelect = document.getElementById("voiceSelect");
const paceSlider = document.getElementById("paceSlider");
const paceValue = document.getElementById("paceValue");

let ws = null;
let micContext = null;
let micStream = null;
let micNode = null;

// --- Playback graph ---
let playbackContext = null;
let analyser = null;
let nextPlayTime = 0;
const OUTPUT_SAMPLE_RATE = 24000; // Gemini Live native-audio output rate
const scheduledSources = [];

let lipSyncRAF = null;

if (paceSlider && paceValue) {
  paceSlider.addEventListener("input", () => {
    paceValue.textContent = `${parseFloat(paceSlider.value).toFixed(2)}x`;
  });
}

function setStatus(text) {
  statusEl.textContent = text;
}

function appendTranscript(text) {
  const p = document.createElement("div");
  p.textContent = text;
  transcriptEl.appendChild(p);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ---------- Avatar lip-sync ----------
function startLipSyncLoop() {
  const data = new Uint8Array(analyser.fftSize);
  function tick() {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length); // 0..~1
    const scale = 0.3 + Math.min(rms * 6, 1) * 1.4; // idle to open
    mouthEl.style.transform = `translateX(-50%) scaleY(${scale.toFixed(2)})`;
    ringEl.classList.toggle("speaking", rms > 0.02);
    lipSyncRAF = requestAnimationFrame(tick);
  }
  tick();
}

// ---------- Audio playback (Gemini -> speakers) ----------
function initPlaybackGraph() {
  playbackContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = playbackContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(playbackContext.destination);
  nextPlayTime = playbackContext.currentTime;
  startLipSyncLoop();
}

function pcm16ToAudioBuffer(int16Bytes) {
  const int16 = new Int16Array(int16Bytes.buffer, int16Bytes.byteOffset, int16Bytes.byteLength / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
  const buffer = playbackContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);
  return buffer;
}

function playAudioChunk(base64Data) {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const buffer = pcm16ToAudioBuffer(bytes);
  const source = playbackContext.createBufferSource();
  source.buffer = buffer;

  const pace = paceSlider ? parseFloat(paceSlider.value) : 1.0;
  source.playbackRate.value = pace;

  source.connect(analyser);

  const startAt = Math.max(nextPlayTime, playbackContext.currentTime);
  source.start(startAt);
  nextPlayTime = startAt + (buffer.duration / pace);

  scheduledSources.push(source);
  source.onended = () => {
    const idx = scheduledSources.indexOf(source);
    if (idx >= 0) scheduledSources.splice(idx, 1);
  };
}

function flushPlayback() {
  // Called on "interrupted": stop everything queued/playing immediately.
  while (scheduledSources.length) {
    const s = scheduledSources.pop();
    try { s.stop(0); } catch (e) { /* already stopped */ }
  }
  nextPlayTime = playbackContext.currentTime;
}

// ---------- Mic capture (browser -> Gemini) ----------
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  micContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = micContext.createMediaStreamSource(micStream);

  // ScriptProcessorNode is deprecated but is the simplest cross-browser way
  // to get raw PCM frames without extra worklet files. Fine for a demo.
  micNode = micContext.createScriptProcessor(4096, 1, 1);
  const inputSampleRate = micContext.sampleRate;

  micNode.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const resampled = resampleTo16k(input, inputSampleRate);
    const int16 = floatTo16BitPCM(resampled);
    ws.send(int16.buffer);
  };

  source.connect(micNode);
  micNode.connect(micContext.destination);
}

function resampleTo16k(float32, inputRate) {
  if (inputRate === 16000) return float32;
  const ratio = inputRate / 16000;
  const newLength = Math.round(float32.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    result[i] = float32[Math.floor(i * ratio)];
  }
  return result;
}

function floatTo16BitPCM(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function stopMic() {
  if (micNode) { micNode.disconnect(); micNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (micContext) { micContext.close(); micContext = null; }
}

// ---------- WebSocket wiring ----------
function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const selectedVoice = voiceSelect ? voiceSelect.value : "Puck";
  ws = new WebSocket(`${proto}://${location.host}/ws?voice=${encodeURIComponent(selectedVoice)}`);

  ws.onopen = () => setStatus("Connected — Argus is preparing an opening statement…");

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "audio") {
      playAudioChunk(msg.data);
    } else if (msg.type === "interrupted") {
      flushPlayback();
      setStatus("Listening…");
    } else if (msg.type === "turn_complete") {
      setStatus("Listening…");
    } else if (msg.type === "text") {
      appendTranscript(msg.data);
    } else if (msg.type === "error") {
      setStatus("Error: " + msg.data);
    }
  };

  ws.onclose = () => setStatus("Disconnected");
  ws.onerror = () => setStatus("Connection error");
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  initPlaybackGraph();
  await startMic();
  connectWebSocket();
  setStatus("Connecting…");
});

stopBtn.addEventListener("click", () => {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  stopMic();
  if (ws) ws.close();
  if (lipSyncRAF) cancelAnimationFrame(lipSyncRAF);
  setStatus("Ended");
});