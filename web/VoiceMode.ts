/**
 * Browser-side speech recognition using vosk-browser, a Kaldi-based
 * streaming ASR runtime that runs entirely in the browser via WASM.
 *
 * Why vosk-browser specifically:
 *   - True streaming-trained model (not a chunked offline model). The
 *     encoder is causal, so partial transcripts stream out as you speak
 *     instead of waiting for end-of-utterance.
 *   - npm-published; loads via jsDelivr `+esm` like our other deps.
 *   - Event-based API: `partialresult` fires while speaking,
 *     `result` fires when the runtime decides an utterance ended,
 *     including word-level timestamps and confidence.
 *   - Model files served from alphacephei.com; ~40 MB English model
 *     `vosk-model-small-en-us-0.15` is enough for clear speech.
 */

const SAMPLE_RATE = 16000;
// We deliberately don't force the AudioContext sample rate; vosk-browser
// resamples internally and most Chromium builds open the input at the
// device's native rate (typically 44.1k or 48k).
const SCRIPT_PROCESSOR_BUFFER = 4096;

const VOSK_PACKAGE = "vosk-browser";
const VOSK_VERSION = "0.0.8";
const VOSK_CDN_URL =
    `https://cdn.jsdelivr.net/npm/${VOSK_PACKAGE}` + "@" + `${VOSK_VERSION}/+esm`;

// English small streaming model. ~40 MB tarball, the runtime caches it
// in IndexedDB after the first load.
const MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz";

const nativeDynamicImport: (url: string) => Promise<any> =
    new Function("u", "return import(u)") as any;

let cachedVoskModule: Promise<any> | undefined;
function loadVosk(): Promise<any> {
    if (cachedVoskModule) return cachedVoskModule;
    cachedVoskModule = nativeDynamicImport(VOSK_CDN_URL).catch((e) => {
        cachedVoskModule = undefined;
        throw e;
    });
    return cachedVoskModule;
}

export interface StreamingWord {
    /** Cleaned, lowercased word. */
    word: string;
    /** Absolute seconds since the speech segment started. */
    start: number;
    end: number;
}

export interface VoiceControllerCallbacks {
    onSpeechStart?: () => void;
    /** Fires whenever the streaming partial transcript changes — text
     *  may revise as the model gets more context. */
    onPartialTranscript?: (text: string) => void;
    /** Fires once per word at end-of-utterance, with timestamps. */
    onCommittedWord?: (word: StreamingWord) => void;
    onSpeechEnd?: () => void;
    onStatus?: (status: string) => void;
    onError?: (err: string) => void;
}

export class VoiceController {
    private callbacks?: VoiceControllerCallbacks;
    private active = false;
    private starting = false;

    private audioContext?: AudioContext;
    private mediaStream?: MediaStream;
    private processorNode?: ScriptProcessorNode;
    private muteGain?: GainNode;
    private sourceNode?: MediaStreamAudioSourceNode;

    private model?: any; // vosk-browser Model
    private recognizer?: any; // vosk-browser KaldiRecognizer
    private lastPartial = "";
    private speechStartFired = false;

    isActive(): boolean { return this.active; }

    async start(callbacks: VoiceControllerCallbacks): Promise<void> {
        if (this.active || this.starting) {
            console.log("[voice] start() ignored: already active/starting");
            return;
        }
        this.starting = true;
        this.callbacks = callbacks;

        try {
            this.emitStatus("Loading speech runtime…");
            console.log("[voice] loading vosk-browser from CDN");
            const t0 = performance.now();
            const vosk = await loadVosk();
            console.log(`[voice][timing] vosk module load: ${(performance.now() - t0).toFixed(0)}ms`);

            this.emitStatus("Downloading streaming model…");
            console.log("[voice] downloading model:", MODEL_URL);
            const tModel = performance.now();
            // vosk-browser exposes `createModel(url)` which downloads the
            // tarball, untars it, and instantiates the runtime worker.
            // Subsequent calls hit the IndexedDB cache.
            this.model = await vosk.createModel(MODEL_URL);
            console.log(`[voice][timing] model load: ${(performance.now() - tModel).toFixed(0)}ms`);

            this.emitStatus("Requesting microphone…");
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: true,
                    sampleRate: SAMPLE_RATE,
                },
            });

            const Ctx: typeof AudioContext = (window.AudioContext || (window as any).webkitAudioContext);
            // Don't pin sampleRate — the audio graph uses the device-native
            // rate. vosk-browser resamples to 16k internally.
            this.audioContext = new Ctx({ latencyHint: "interactive" });
            const ctxRate = this.audioContext.sampleRate;
            console.log(`[voice] audio context sample rate: ${ctxRate}Hz`);

            this.recognizer = new this.model.KaldiRecognizer(ctxRate);
            this.recognizer.setWords(true);
            this.wireRecognizerEvents();

            this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
            this.processorNode = this.audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
            this.muteGain = this.audioContext.createGain();
            this.muteGain.gain.value = 0;

            this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
                if (!this.active || !this.recognizer) return;
                try {
                    this.recognizer.acceptWaveform(event.inputBuffer);
                } catch (e) {
                    console.error("[voice] acceptWaveform failed:", e);
                }
            };

            this.sourceNode.connect(this.processorNode);
            this.processorNode.connect(this.muteGain);
            this.muteGain.connect(this.audioContext.destination);

            this.active = true;
            this.starting = false;
            this.emitStatus("Listening");
            console.log("[voice] started");
        } catch (e: any) {
            this.starting = false;
            console.error("[voice] start failed:", e);
            this.emitError(e?.message || String(e));
            this.stop();
            throw e;
        }
    }

    private wireRecognizerEvents(): void {
        const r = this.recognizer;
        if (!r) return;

        r.on("partialresult", (message: any) => {
            const partial: string = (message && message.result && message.result.partial) || "";
            if (partial === this.lastPartial) return;
            this.lastPartial = partial;
            if (partial.length > 0 && !this.speechStartFired) {
                this.speechStartFired = true;
                console.log("[voice] speech start (partial appeared)");
                try { this.callbacks?.onSpeechStart?.(); } catch (e) { console.warn("[voice] onSpeechStart threw:", e); }
            }
            try { this.callbacks?.onPartialTranscript?.(partial); } catch (e) { console.warn("[voice] onPartialTranscript threw:", e); }
        });

        r.on("result", (message: any) => {
            const result = (message && message.result) || {};
            const text: string = (result.text || "").trim();
            const words: any[] = Array.isArray(result.result) ? result.result : [];
            console.log(`[voice] result: ${JSON.stringify(text)} (${words.length} words)`);

            for (const w of words) {
                const cleaned = String(w?.word || "").toLowerCase().replace(/[^a-z]+/g, "");
                if (!cleaned) continue;
                const start = typeof w?.start === "number" ? w.start : 0;
                const end = typeof w?.end === "number" ? w.end : start;
                try {
                    this.callbacks?.onCommittedWord?.({ word: cleaned, start, end });
                } catch (e) {
                    console.warn("[voice] onCommittedWord threw:", e);
                }
            }

            if (this.speechStartFired) {
                this.speechStartFired = false;
                try { this.callbacks?.onSpeechEnd?.(); } catch (e) { console.warn("[voice] onSpeechEnd threw:", e); }
            }
            this.lastPartial = "";
        });

        r.on("error", (err: any) => {
            console.error("[voice] recognizer error:", err);
            this.emitError(String(err?.message || err));
        });
    }

    stop(): void {
        if (!this.active && !this.starting) {
            console.log("[voice] stop() ignored: not running");
            return;
        }
        console.log("[voice] stopping");
        this.active = false;
        this.starting = false;

        if (this.processorNode) {
            try { this.processorNode.onaudioprocess = null as any; } catch (e) { console.warn("[voice] processorNode handler clear failed:", e); }
            try { this.processorNode.disconnect(); } catch (e) { console.warn("[voice] processorNode disconnect failed:", e); }
            this.processorNode = undefined;
        }
        if (this.muteGain) {
            try { this.muteGain.disconnect(); } catch (e) { console.warn("[voice] muteGain disconnect failed:", e); }
            this.muteGain = undefined;
        }
        if (this.sourceNode) {
            try { this.sourceNode.disconnect(); } catch (e) { console.warn("[voice] sourceNode disconnect failed:", e); }
            this.sourceNode = undefined;
        }
        if (this.mediaStream) {
            try { this.mediaStream.getTracks().forEach(t => t.stop()); } catch (e) { console.warn("[voice] stream stop failed:", e); }
            this.mediaStream = undefined;
        }
        if (this.audioContext) {
            try { void this.audioContext.close(); } catch (e) { console.warn("[voice] audioContext close failed:", e); }
            this.audioContext = undefined;
        }

        if (this.recognizer) {
            try { this.recognizer.remove(); } catch (e) { console.warn("[voice] recognizer.remove threw:", e); }
            this.recognizer = undefined;
        }
        // Keep `this.model` cached — the runtime is heavy to spin up and
        // we want subsequent voice-mode toggles to be fast.

        this.lastPartial = "";
        this.speechStartFired = false;
        this.emitStatus("Off");
    }

    private emitStatus(msg: string) {
        try { this.callbacks?.onStatus?.(msg); } catch (e) { console.warn("[voice] onStatus threw:", e); }
    }
    private emitError(msg: string) {
        try { this.callbacks?.onError?.(msg); } catch (e) { console.warn("[voice] onError threw:", e); }
    }
}
