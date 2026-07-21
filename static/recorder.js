const AudioRecorder = {
    mediaRecorder: null,
    chunks: [],
    startTime: 0,
    timerInterval: null,
    analyserInterval: null,
    audioContext: null,
    recordedBlob: null,
    wavBlob: null,
    stream: null,
    mode: "mic",

    onTimer: null,
    onLevel: null,
    onStateChange: null,
    onReady: null,
    onStop: null,

    supportsSystemAudio() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    },

    supportsMicOnly() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },

    async checkPermissions() {
        const mic = window.Permissions ? await window.Permissions.probeMic() : "unknown";
        const displayMedia = window.Permissions
            ? window.Permissions.probeSystemAudio()
            : (this.supportsSystemAudio() ? "available" : "unavailable");
        return { mic, displayMedia };
    },

    async start(mode, preacquiredStream) {
        this.mode = mode;
        this.chunks = [];
        this.recordedBlob = null;
        this.wavBlob = null;

        if (preacquiredStream) {
            this.stream = preacquiredStream;
        } else {
            try {
                await this._acquireStream(mode);
            } catch (err) {
                if (this.onStateChange) this.onStateChange("error", this._normalizeError(err, mode));
                return;
            }
        }

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = this.audioContext.createMediaStreamSource(this.stream);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const dest = this.audioContext.createMediaStreamDestination();
        source.connect(dest);

        this._startAnalyser(analyser);

        const mimeType = this._getMimeType();
        const recorderOpts = { mimeType, audioBitsPerSecond: 128000 };
        this.mediaRecorder = new MediaRecorder(dest.stream, recorderOpts);

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.chunks.push(e.data);
        };

        this.mediaRecorder.onstop = async () => {
            this.recordedBlob = new Blob(this.chunks, { type: mimeType });
            this._cleanup();
            this._stopAnalyser();
            this._stopTimer();

            let wavError = null;
            try {
                this.wavBlob = await AudioRecorder.webmToWav(this.recordedBlob);
            } catch (err) {
                this.wavBlob = null;
                wavError = (err && err.message) || String(err);
                console.warn("WAV conversion failed", err);
            }

            if (this.onStop) {
                this.onStop({
                    webm: this.recordedBlob,
                    wav: this.wavBlob,
                    wavError,
                    duration: ((Date.now() - this.startTime) / 1000).toFixed(1),
                    size: (this.wavBlob || this.recordedBlob).size,
                });
            }
        };

        this.mediaRecorder.start(1000);
        this.startTime = Date.now();
        this._startTimer();

        if (this.onStateChange) this.onStateChange("recording");
    },

    stop() {
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            this.mediaRecorder.stop();
        }
    },

    _normalizeError(err, mode) {
        const info = {
            code: "unknown",
            kind: mode === "system" ? "system" : "mic",
            message: (err && err.message) || String(err),
            name: err && err.name,
        };
        if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
            info.code = "permission_denied";
        } else if (err && err.name === "NotFoundError") {
            info.code = "no_device";
        } else if (err && err.name === "NotReadableError") {
            info.code = "in_use";
        } else if (err && err.name === "OverconstrainedError") {
            info.code = "constraints";
        }
        return info;
    },

    _cleanup() {
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        if (this._mixDisplayStream) {
            this._mixDisplayStream.getTracks().forEach((t) => t.stop());
            this._mixDisplayStream = null;
        }
        if (this._mixCtx) {
            try { this._mixCtx.close(); } catch (_) {}
            this._mixCtx = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    },

    async _acquireStream(mode) {
        const micConstraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            },
        };

        if (mode === "system") {
            // getDisplayMedia MUST be the first awaited call after the user gesture
            // or Chromium/WKWebView rejects with "must be called from a user gesture handler".
            let displayStream;
            try {
                displayStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: 1, height: 1, frameRate: 1 },
                    audio: true,
                    preferCurrentTab: false,
                });
            } catch (err) {
                throw err;
            }

            const audioTracks = displayStream.getAudioTracks();
            const videoTracks = displayStream.getVideoTracks();
            videoTracks.forEach((t) => { t.stop(); displayStream.removeTrack(t); });

            if (audioTracks.length === 0) {
                // Fell through the picker without checking Share Audio.
                displayStream.getTracks().forEach((t) => t.stop());
                const err = new Error("System audio was not shared. When the picker opens, choose a tab or the entire screen and check 'Share audio'.");
                err.name = "NotAllowedError";
                throw err;
            }

            let micStream;
            try {
                micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
            } catch (err) {
                displayStream.getTracks().forEach((t) => t.stop());
                throw err;
            }

            const ctx = new AudioContext();
            const dest = ctx.createMediaStreamDestination();
            const micSrc = ctx.createMediaStreamSource(micStream);
            const sysSrc = ctx.createMediaStreamSource(displayStream);
            const micGain = ctx.createGain();
            const sysGain = ctx.createGain();
            micGain.gain.value = 1.0;
            sysGain.gain.value = 1.5;
            micSrc.connect(micGain).connect(dest);
            sysSrc.connect(sysGain).connect(dest);

            this._mixCtx = ctx;
            this._mixDisplayStream = displayStream;
            this.stream = dest.stream;
        } else {
            this.stream = await navigator.mediaDevices.getUserMedia(micConstraints);
        }
    },

    _getMimeType() {
        const types = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/ogg;codecs=opus",
        ];
        for (const t of types) {
            if (MediaRecorder.isTypeSupported(t)) return t;
        }
        return "audio/webm";
    },

    _startTimer() {
        this._stopTimer();
        this.timerInterval = setInterval(() => {
            const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
            if (this.onTimer) this.onTimer(Number(elapsed));
        }, 250);
    },

    _stopTimer() {
        if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
    },

    _startAnalyser(analyser) {
        this._stopAnalyser();
        const data = new Uint8Array(analyser.frequencyBinCount);
        this.analyserInterval = setInterval(() => {
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = sum / data.length;
            const level = Math.min(1, avg / 128);
            if (this.onLevel) this.onLevel(level);
        }, 50);
    },

    _stopAnalyser() {
        if (this.analyserInterval) { clearInterval(this.analyserInterval); this.analyserInterval = null; }
    },

    async webmToWav(blob) {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const wav = AudioRecorder._audioBufferToWav(audioBuffer);
        audioCtx.close();
        return wav;
    },

    _audioBufferToWav(audioBuffer) {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const dataLength = audioBuffer.length * blockAlign;

        const buffer = new ArrayBuffer(44 + dataLength);
        const view = new DataView(buffer);

        function writeStr(offset, str) {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        }

        writeStr(0, "RIFF");
        view.setUint32(4, 36 + dataLength, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeStr(36, "data");
        view.setUint32(40, dataLength, true);

        let offset = 44;
        const channelData = [];
        for (let c = 0; c < numChannels; c++) {
            channelData.push(audioBuffer.getChannelData(c));
        }
        for (let i = 0; i < audioBuffer.length; i++) {
            for (let c = 0; c < numChannels; c++) {
                let sample = Math.max(-1, Math.min(1, channelData[c][i]));
                sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                view.setInt16(offset, sample, true);
                offset += 2;
            }
        }

        return new Blob([buffer], { type: "audio/wav" });
    },
};
