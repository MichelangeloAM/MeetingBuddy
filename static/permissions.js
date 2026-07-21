/* Permissions detection + recovery instructions for microphone and system audio. */

(function () {
    function detectPlatform() {
        const p = (navigator.platform || "").toLowerCase();
        const ua = (navigator.userAgent || "").toLowerCase();
        if (p.includes("mac") || ua.includes("mac os")) return "macos";
        if (p.includes("win") || ua.includes("windows")) return "windows";
        return "other";
    }

    function detectBrowser() {
        const ua = navigator.userAgent || "";
        if (/Firefox\//.test(ua)) return "firefox";
        if (/Edg\//.test(ua)) return "edge";
        // Safari check must come before Chrome check (Safari UA has 'Safari' but no 'Chrome')
        if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return "chromium";
        if (/Safari\//.test(ua)) return "safari";
        return "other";
    }

    async function probeMic() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "unavailable";

        // Try the Permissions API first — supported on Chrome/Chromium; not on Safari/WKWebView.
        if (navigator.permissions && navigator.permissions.query) {
            try {
                const status = await navigator.permissions.query({ name: "microphone" });
                if (status && status.state) return status.state; // 'granted' | 'denied' | 'prompt'
            } catch (_) {
                /* fall through */
            }
        }

        // Fallback: attempt a real getUserMedia call and immediately release.
        try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true });
            s.getTracks().forEach((t) => t.stop());
            return "granted";
        } catch (err) {
            if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) return "denied";
            if (err && err.name === "NotFoundError") return "no-device";
            return "unknown";
        }
    }

    function probeSystemAudio() {
        const has = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
        const browser = detectBrowser();
        // Safari & Firefox don't support system audio via getDisplayMedia in practice.
        if (!has || browser === "safari" || browser === "firefox") return "unavailable";
        return "available";
    }

    function getRecoveryInstructions(platform, kind) {
        const p = platform || detectPlatform();
        if (kind === "mic") {
            if (p === "macos") return {
                title: "Enable microphone access",
                steps: [
                    "Open System Settings → Privacy & Security → Microphone",
                    "Turn on the switch next to Meeting Generator (or your browser)",
                    "Come back here and try recording again",
                ],
                settingsPane: "microphone",
                platform: p,
            };
            if (p === "windows") return {
                title: "Enable microphone access",
                steps: [
                    "Open Settings → Privacy & security → Microphone",
                    "Turn on 'Microphone access' and 'Let apps access your microphone'",
                    "Ensure Meeting Generator is enabled in the app list",
                    "Return here and try recording again",
                ],
                settingsPane: "microphone",
                platform: p,
            };
            return {
                title: "Enable microphone access",
                steps: ["Grant microphone access from your browser or OS settings and retry."],
                settingsPane: "microphone",
                platform: p,
            };
        }
        if (kind === "system") {
            if (p === "macos") return {
                title: "Enable screen-recording access",
                steps: [
                    "Open System Settings → Privacy & Security → Screen Recording",
                    "Turn on the switch next to Meeting Generator",
                    "Quit and reopen the app, then try again",
                    "When the picker appears, select an audio-producing tab or the whole screen and check 'Share audio'",
                ],
                settingsPane: "screen-recording",
                platform: p,
            };
            if (p === "windows") return {
                title: "Sharing system audio on Windows",
                steps: [
                    "Click Start recording — Windows will show a screen-share picker",
                    "Choose a tab or window that is playing audio (Zoom, Teams, browser…)",
                    "Check 'Share tab audio' or 'Share system audio' at the bottom of the picker",
                    "If no audio option appears, capture microphone only for now",
                ],
                settingsPane: "microphone",
                platform: p,
            };
            return {
                title: "System audio unavailable",
                steps: ["Your browser does not support capturing system audio."],
                settingsPane: null,
                platform: p,
            };
        }
        return { title: "Grant permissions", steps: [], settingsPane: null, platform: p };
    }

    window.Permissions = {
        detectPlatform,
        detectBrowser,
        probeMic,
        probeSystemAudio,
        getRecoveryInstructions,
    };
})();
