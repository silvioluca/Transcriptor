"""Server locale per le voci clonate di Transcriptor (XTTS-v2).

Riceve dal sito un testo e un campione di voce (WAV mono), restituisce l'audio parlato
con quella voce. Niente viene salvato su disco: i campioni restano in memoria finché
il server è acceso.

    pip install -r requirements.txt
    python clone_server.py

Al primo avvio scarica il modello (circa 1,9 GB) e chiede di accettare la licenza
Coqui CPML, che ne permette solo l'uso non commerciale.
"""

import argparse
import base64
import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL = "tts_models/multilingual/multi-dataset/xtts_v2"
OUT_SR = 24000  # frequenza dell'audio prodotto da XTTS
REF_SR = 22050  # frequenza a cui XTTS analizza il campione
MAX_BODY = 20 * 1024 * 1024
MAX_VOICES = 32
LANGS = {"it", "en", "fr", "es", "de", "pt", "pl", "tr", "ru", "nl", "cs", "ar", "zh-cn", "ja", "hu", "ko", "hi"}


def read_wav(data):
    """WAV PCM 16 bit -> (campioni float32 mono, frequenza)."""
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("Il campione deve essere un WAV a 16 bit.")
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            pcm = pcm.reshape(-1, w.getnchannels()).mean(axis=1)
    return pcm, rate


def write_wav(pcm, rate):
    """campioni float32 mono -> WAV PCM 16 bit."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2").tobytes())
    return out.getvalue()


class Engine:
    def __init__(self, device):
        import torch
        from TTS.api import TTS

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.torch = torch
        self.model = TTS(MODEL).to(device).synthesizer.tts_model
        self.voices = {}  # id -> (latenti GPT, impronta vocale)
        self.lock = threading.Lock()  # una sintesi alla volta

    def has_voice(self, voice):
        return voice in self.voices

    def add_voice(self, voice, wav_bytes):
        import torchaudio

        pcm, rate = read_wav(wav_bytes)
        if len(pcm) < rate * 5:
            raise ValueError("Campione troppo corto: servono almeno 5 secondi.")
        audio = self.torch.from_numpy(pcm).unsqueeze(0)
        if rate != REF_SR:
            audio = torchaudio.functional.resample(audio, rate, REF_SR)
        audio = audio[:, : REF_SR * 30].clip(-1, 1).to(self.device)
        # stessi passaggi di Xtts.get_conditioning_latents, senza leggere file da disco
        with self.lock, self.torch.inference_mode():
            speaker = self.model.get_speaker_embedding(audio, REF_SR)
            latents = self.model.get_gpt_cond_latents(audio, REF_SR, length=6, chunk_length=6)
        if len(self.voices) >= MAX_VOICES:
            self.voices.pop(next(iter(self.voices)))
        self.voices[voice] = (latents, speaker)

    def speak(self, voice, text, language, speed):
        latents, speaker = self.voices[voice]
        with self.lock:
            out = self.model.inference(text, language, latents, speaker, speed=speed, enable_text_splitting=True)
        wav = out["wav"]
        if hasattr(wav, "cpu"):
            wav = wav.cpu().numpy()
        return np.asarray(wav, dtype=np.float32)


class Handler(BaseHTTPRequestHandler):
    engine = None
    origins = ["*"]

    def log_message(self, fmt, *args):
        pass

    def cors(self):
        origin = self.headers.get("Origin")
        if "*" in self.origins:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin in self.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # il sito è su HTTPS pubblico e chiama un indirizzo locale: Chrome lo chiede esplicitamente
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def reply(self, status, body, ctype="application/json"):
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] != "/health":
            return self.reply(404, {"error": "Indirizzo sconosciuto."})
        self.reply(200, {"ok": True, "model": "XTTS-v2", "device": self.engine.device, "sample_rate": OUT_SR})

    def do_POST(self):
        if self.path.split("?")[0] != "/tts":
            return self.reply(404, {"error": "Indirizzo sconosciuto."})
        try:
            size = int(self.headers.get("Content-Length") or 0)
            if size <= 0 or size > MAX_BODY:
                return self.reply(413, {"error": "Richiesta troppo grande."})
            req = json.loads(self.rfile.read(size))
            text = str(req.get("text") or "").strip()
            voice = str(req.get("voice") or "")
            language = str(req.get("language") or "it")
            speed = min(2.0, max(0.5, float(req.get("speed") or 1.0)))
            ref = req.get("ref_wav_b64")
        except (ValueError, AttributeError):
            return self.reply(400, {"error": "Richiesta non valida."})
        if not text or not voice:
            return self.reply(400, {"error": "Mancano il testo o la voce."})
        if language not in LANGS:
            return self.reply(400, {"error": f"Lingua non supportata: {language}."})
        try:
            if ref:
                self.engine.add_voice(voice, base64.b64decode(ref))
            elif not self.engine.has_voice(voice):
                # voce sconosciuta: il sito rimanda la richiesta con il campione
                return self.reply(428, {"error": "Campione della voce mancante."})
            pcm = self.engine.speak(voice, text, language, speed)
        except (ValueError, wave.Error, EOFError) as e:
            return self.reply(400, {"error": str(e) or "Campione audio non valido."})
        except Exception as e:  # errore del modello: lo riporto al sito invece di chiudere la connessione
            print(f"Errore di sintesi: {e!r}")
            return self.reply(500, {"error": f"Sintesi non riuscita: {e}"})
        print(f"{len(pcm) / OUT_SR:5.1f} s  [{language}]  {text[:60]}")
        self.reply(200, write_wav(pcm, OUT_SR), "audio/wav")


def main():
    ap = argparse.ArgumentParser(description="Server di clonazione vocale per Transcriptor (XTTS-v2).")
    ap.add_argument("--host", default="127.0.0.1", help="interfaccia di ascolto (predefinita: solo questo computer)")
    ap.add_argument("--port", type=int, default=8020)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--origin", action="append", help="sito autorizzato a usare il server, ripetibile (predefinito: tutti)")
    args = ap.parse_args()

    print("Carico XTTS-v2 (al primo avvio scarica circa 1,9 GB)…")
    Handler.engine = Engine(args.device)
    Handler.origins = args.origin or ["*"]
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Pronto su http://{args.host}:{args.port}  ({Handler.engine.device}). Ctrl+C per chiudere.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
