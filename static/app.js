const App = {
    currentJobId: null,
    eventSource: null,
    modelEventSource: null,
    segments: [],
    audioDuration: 0,
    lastSegEnd: 0,
    result: null,
    activeTab: "overview",
    searchQuery: "",
    currentView: "upload",
    recordBlob: null,
    recordFilename: "",
    recordMode: null,
    currentPhase: null,
    onboardingStatus: null,
    permissionsSeen: {},
    _summarizeElapsedTimer: null,
    _summarizeStart: 0,
    _etaSpeedEma: 0,
    _etaBaseline: 0,
    _cancelling: false,
    _jobActive: false,
    detectedLanguage: null,

    AUDIO_EXT: ["mp3","wav","m4a","flac","ogg","opus","webm","mp4","aac","oga","wma","aiff","aif"],

    VIEW_TITLES: {
        upload: "Upload",
        record: "Record",
        history: "History",
        settings: "Settings",
    },

    async init() {
        this.applyTheme();
        document.getElementById("theme-toggle").addEventListener("click", () => this.toggleDarkMode());
        this.bindDropZone();

        const vtSlider = document.getElementById("adv-vad-threshold");
        if (vtSlider) vtSlider.addEventListener("input", () => this._updateVadThresholdLabel());

        if (!AudioRecorder.supportsSystemAudio()) {
            const opt = document.getElementById("rec-mode-system");
            if (opt) {
                opt.disabled = true;
                opt.setAttribute("aria-disabled", "true");
                opt.style.opacity = "0.55";
            }
            const note = document.getElementById("rec-system-note");
            if (note) note.classList.remove("hidden");
        }

        // Fetch onboarding state to gate first-run wizard + surface banners.
        try {
            const res = await fetch("/api/onboarding");
            this.onboardingStatus = await res.json();
        } catch (_) {
            this.onboardingStatus = { needs_onboarding: false, has_api_key: false, has_model: false };
        }

        this.navigate("upload");
        this.loadHistoryList();
        this._renderUploadBanners();
        this._restoreRecordLang();
        this._restoreOutputLang();

        fetch("/api/models").then((r) => r.json()).then((models) => this._populateModelSelects(models)).catch(() => {});

        // Try to reattach to any in-flight job so a page reload doesn't strand the user.
        try {
            const res = await fetch("/api/jobs/active");
            const active = await res.json();
            if (Array.isArray(active) && active.length > 0) {
                const job = active[0];
                this.currentJobId = job.id;
                this._jobActive = true;
                this.showProcessingView();
                this.connectSSE(job.id);
            }
        } catch (_) {}

        if (this.onboardingStatus && this.onboardingStatus.needs_onboarding && window.Wizard) {
            window.Wizard.start({ status: this.onboardingStatus, dismissable: false });
        }
    },

    _restoreRecordLang() {
        try {
            const saved = localStorage.getItem("mg.recordLang") || "";
            const sel = document.getElementById("lang-select-record");
            if (sel) sel.value = saved;
        } catch (_) {}
    },

    _restoreOutputLang() {
        try {
            const saved = localStorage.getItem("mg.outputLang") || "auto";
            const sel = document.getElementById("output-lang-select");
            if (sel) sel.value = saved;
            const selRec = document.getElementById("output-lang-select-record");
            if (selRec) selRec.value = saved;
        } catch (_) {}
    },

    _persistRecordLang(val) {
        try { localStorage.setItem("mg.recordLang", val || ""); } catch (_) {}
    },

    _persistOutputLang(val) {
        try { localStorage.setItem("mg.outputLang", val || "auto"); } catch (_) {}
    },

    _persistModelChoice(sel) {
        try {
            const key = sel.id === "model-select-record" ? "mg.recordModel" : "mg.uploadModel";
            localStorage.setItem(key, sel.value || "");
        } catch (_) {}
    },

    onOnboardingComplete() {
        fetch("/api/onboarding").then((r) => r.json()).then((s) => {
            this.onboardingStatus = s;
            this._renderUploadBanners();
            if (this.currentView === "settings") this.loadSettingsData();
            fetch("/api/models").then((r) => r.json()).then((models) => this._populateModelSelects(models)).catch(() => {});
        }).catch(() => {});
    },

    rerunOnboarding() {
        if (!window.Wizard) return;
        fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ onboarding_completed: false }),
        }).finally(() => {
            fetch("/api/onboarding").then((r) => r.json()).then((s) => {
                this.onboardingStatus = s;
                window.Wizard.start({ status: s, dismissable: true });
            });
        });
    },

    async _renderUploadBanners() {
        const slot = document.getElementById("upload-banner-slot");
        if (!slot) return;
        slot.innerHTML = "";
        let s;
        try {
            const res = await fetch("/api/onboarding");
            s = await res.json();
            this.onboardingStatus = s;
        } catch (_) {
            s = this.onboardingStatus || {};
        }
        if (!s.has_api_key) {
            slot.appendChild(window.UI.banner({
                variant: "warning",
                title: "DeepSeek API key not configured",
                message: "Add your API key in Settings to enable AI-powered summaries.",
                action: { label: "Open Settings", onClick: () => this.navigate("settings") },
            }));
        }
        if (!s.has_model) {
            slot.appendChild(window.UI.banner({
                variant: "info",
                title: "No transcription model downloaded",
                message: "Download a Whisper model in Settings before your first transcription.",
                action: { label: "Manage models", onClick: () => this.navigate("settings") },
            }));
        }
    },

    navigate(view) {
        this.currentView = view;
        document.querySelectorAll(".nav-item").forEach((el) => {
            const active = el.dataset.view === view;
            el.classList.toggle("active", active);
            if (active) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
        });
        document.getElementById("topbar-title").textContent = this.VIEW_TITLES[view] || view;

        document.querySelectorAll(".view").forEach((el) => { el.classList.remove("active"); el.classList.add("hidden"); });
        const target = document.getElementById("view-" + view);
        if (target) {
            target.classList.remove("hidden");
            target.classList.add("active");
        }

        if (view === "settings") this.loadSettingsData();
        if (view === "history") this.loadHistoryList();
        if (view !== "record") this.resetRecording();
        if (view === "upload") { this._renderUploadBanners(); this._renderActiveJobBanner(); }
        if (view === "upload" || view === "record") this._populateModelSelects();

        this._renderReturnToProcessingPill();
        // Do NOT close eventSource on navigate — keep the job running in the background.
    },

    reset() {
        if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
        this._stopSummarizeElapsed();
        this.currentJobId = null;
        this._jobActive = false;
        this.segments = [];
        this.audioDuration = 0;
        this.lastSegEnd = 0;
        this._etaSpeedEma = 0;
        this._etaBaseline = 0;
        this._cancelling = false;
        this.detectedLanguage = null;
        this.result = null;
        this.activeTab = "overview";
        this.currentPhase = null;
        this.navigate("upload");
        this.loadHistoryList();
        this._renderReturnToProcessingPill();
    },

    _renderReturnToProcessingPill() {
        const topbar = document.getElementById("topbar");
        if (!topbar) return;
        let pill = document.getElementById("return-to-processing-pill");
        const pv = document.getElementById("processing-view");
        const onProcessing = pv && pv.classList.contains("active");
        const shouldShow = !!(this._jobActive && this.currentJobId && !onProcessing);
        if (shouldShow) {
            if (!pill) {
                pill = document.createElement("button");
                pill.id = "return-to-processing-pill";
                pill.type = "button";
                pill.className = "return-to-processing";
                pill.textContent = "Return to processing job →";
                pill.onclick = () => this.showProcessingView();
                topbar.appendChild(pill);
            }
        } else if (pill) {
            pill.remove();
        }
    },

    _renderActiveJobBanner() {
        const slot = document.getElementById("upload-banner-slot");
        if (!slot) return;
        // Remove any prior active-job banner
        const prior = slot.querySelector("[data-banner='active-job']");
        if (prior) prior.remove();
        if (!this._jobActive || !this.currentJobId) return;
        const banner = window.UI.banner({
            variant: "info",
            title: "A meeting is currently being processed",
            message: "Cancel it to start a new one, or return to see progress.",
            action: { label: "Return to processing", onClick: () => this.showProcessingView() },
        });
        banner.setAttribute("data-banner", "active-job");
        slot.appendChild(banner);
    },

    showProcessingView() {
        document.querySelectorAll(".view").forEach((el) => { el.classList.remove("active"); el.classList.add("hidden"); });
        const pv = document.getElementById("processing-view");
        pv.classList.remove("hidden");
        pv.classList.add("active");
        document.getElementById("topbar-title").textContent = "Processing";
        this.currentView = "processing";
        // If we already have segments buffered, rebuild the feed instead of wiping it.
        if (this.segments.length > 0) {
            const feed = document.getElementById("live-feed");
            if (feed) {
                feed.innerHTML = "";
                this.segments.forEach((s) => {
                    const div = document.createElement("div");
                    div.className = "live-segment";
                    div.innerHTML = `<span class="ts">${this.fmtTimestamp(s.start)}</span>${this.esc(s.text)}`;
                    feed.appendChild(div);
                });
                document.getElementById("segment-count").textContent = this.segments.length + " segments";
            }
        } else {
            this._resetPhaseCards();
        }
        this._renderReturnToProcessingPill();
    },

    showResultView() {
        document.querySelectorAll(".view").forEach((el) => { el.classList.remove("active"); el.classList.add("hidden"); });
        const rv = document.getElementById("result-view");
        rv.classList.remove("hidden");
        rv.classList.add("active");
    },

    // --- Theme ---

    applyTheme() {
        const t = localStorage.getItem("theme") || "light";
        document.documentElement.classList.toggle("dark", t === "dark");
    },

    toggleDarkMode() {
        const html = document.documentElement;
        const dark = html.classList.toggle("dark");
        localStorage.setItem("theme", dark ? "dark" : "light");
    },

    // --- Settings ---

    async loadSettingsData() {
        try {
            const res = await fetch("/api/settings");
            const s = await res.json();
            document.getElementById("api-key-input").value = s.api_key || "";
            const bs = document.getElementById("adv-batch-size");
            if (bs) bs.value = String(s.batch_size || "auto");
            const cu = document.getElementById("adv-cuda");
            if (cu) cu.value = String(s.cuda_enabled || "auto");
            const ve = document.getElementById("adv-vad-enabled");
            if (ve) ve.value = s.vad_enabled !== false ? "true" : "false";
            const vt = document.getElementById("adv-vad-threshold");
            if (vt) { vt.value = s.vad_threshold || 0.5; this._updateVadThresholdLabel(); }
            const vm = document.getElementById("adv-vad-min-silence");
            if (vm) vm.value = s.vad_min_silence_ms || 500;
            const vp = document.getElementById("adv-vad-speech-pad");
            if (vp) vp.value = s.vad_speech_pad_ms || 400;
            const ol = s.output_language;
            if (ol && ol !== "auto") {
                try { localStorage.setItem("mg.outputLang", ol); } catch (_) {}
                this._populateOutputLangSelects();
            }
        } catch {}
        this.loadModelList();
        this.loadDiskSpace();
        this.loadSystemRAM();
    },

    toggleApiKeyVisibility() {
        const inp = document.getElementById("api-key-input");
        const btn = document.getElementById("api-key-toggle");
        if (inp.type === "password") {
            inp.type = "text";
            btn.textContent = "Hide";
            btn.setAttribute("aria-label", "Hide API key");
        } else {
            inp.type = "password";
            btn.textContent = "Show";
            btn.setAttribute("aria-label", "Show API key");
        }
    },

    async saveApiKey() {
        const key = document.getElementById("api-key-input").value.trim();
        const status = document.getElementById("apikey-status");
        try {
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_key: key }),
            });
            if (res.ok) {
                status.textContent = "API key saved";
                status.className = "settings-status success";
                window.UI.toast("API key saved", { variant: "success" });
                if (this.onboardingStatus) this.onboardingStatus.has_api_key = !!key;
            } else {
                status.textContent = "Failed to save.";
                status.className = "settings-status error";
                window.UI.toast("Failed to save API key", { variant: "error" });
            }
            setTimeout(() => { status.textContent = ""; }, 3000);
        } catch {
            status.textContent = "Connection error.";
            status.className = "settings-status error";
            window.UI.toast("Connection error", { variant: "error" });
        }
    },

    async testApiKey() {
        const key = document.getElementById("api-key-input").value.trim();
        const btn = document.getElementById("api-key-test-btn");
        const status = document.getElementById("apikey-status");
        if (!key) { window.UI.toast("Enter an API key first", { variant: "warning" }); return; }
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = "Testing…";
        try {
            const res = await fetch("/api/settings/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_key: key }),
            });
            const data = await res.json();
            if (data.ok) {
                status.textContent = "Connection ok" + (data.latency_ms ? ` (${Math.round(data.latency_ms)}ms)` : "");
                status.className = "settings-status success";
                window.UI.toast("Connection successful", { variant: "success" });
            } else {
                status.textContent = data.message || "Connection failed";
                status.className = "settings-status error";
                window.UI.toast(data.message || "Connection failed", { variant: "error" });
            }
        } catch (err) {
            window.UI.toast("Network error: " + err.message, { variant: "error" });
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    },

    async loadDiskSpace() {
        const note = document.getElementById("disk-space-note");
        if (!note) return;
        try {
            const res = await fetch("/api/system/disk");
            const d = await res.json();
            const freeGb = d.free_bytes / (1024 * 1024 * 1024);
            note.textContent = `${freeGb.toFixed(1)} GB free on the disk hosting your Hugging Face cache.`;
            note.classList.toggle("disk-space-note--warn", freeGb < 3);
        } catch (_) {
            note.textContent = "";
        }
    },

    async loadSystemRAM() {
        const info = document.getElementById("ram-info");
        if (!info) return;
        try {
            const res = await fetch("/api/system/ram");
            const d = await res.json();
            info.textContent = `${d.available_gb.toFixed(1)} GB free / ${d.total_gb.toFixed(1)} GB total`;
        } catch (_) {
            info.textContent = "";
        }
    },

    _updateVadThresholdLabel() {
        const vt = document.getElementById("adv-vad-threshold");
        const vl = document.getElementById("vad-threshold-val");
        if (vt && vl) vl.textContent = parseFloat(vt.value).toFixed(2);
    },

    async saveAdvancedSettings() {
        const status = document.getElementById("adv-status");
        try {
            const body = {
                batch_size: document.getElementById("adv-batch-size").value,
                cuda_enabled: document.getElementById("adv-cuda").value,
                vad_enabled: document.getElementById("adv-vad-enabled").value === "true",
                vad_threshold: parseFloat(document.getElementById("adv-vad-threshold").value),
                vad_min_silence_ms: parseInt(document.getElementById("adv-vad-min-silence").value),
                vad_speech_pad_ms: parseInt(document.getElementById("adv-vad-speech-pad").value),
            };
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                status.textContent = "Settings saved";
                status.className = "settings-status success";
                window.UI.toast("Transcription settings saved", { variant: "success" });
            } else {
                status.textContent = "Failed to save.";
                status.className = "settings-status error";
            }
            setTimeout(() => { status.textContent = ""; }, 3000);
        } catch {
            status.textContent = "Connection error.";
            status.className = "settings-status error";
        }
    },

    // --- Model Download ---

    async loadModelList() {
        try {
            const res = await fetch("/api/models");
            const models = await res.json();
            this.renderModelGrid(models);
            this._populateModelSelects(models);
        } catch {}
    },

    _populateModelSelects(models) {
        if (!models) {
            fetch("/api/models").then((r) => r.json()).then((m) => this._populateModelSelects(m)).catch(() => {});
            return;
        }
        const selects = [document.getElementById("model-select"), document.getElementById("model-select-record")];
        selects.forEach((sel) => {
            if (!sel) return;
            const currentVal = sel.value;
            const storageKey = sel.id === "model-select-record" ? "mg.recordModel" : "mg.uploadModel";
            let saved = "";
            try { saved = localStorage.getItem(storageKey) || ""; } catch (_) {}

            sel.innerHTML = "";
            models.forEach((m) => {
                const opt = document.createElement("option");
                opt.value = m.id;
                const sizeStr = this.fmtModelSize(m.size_mb);
                const extra = m.downloaded ? ` \u00b7 downloaded \u2713` : ` \u2014 ${sizeStr} \u2014 not installed`;
                const label = m.recommended_for === "Recommended" ? `${m.id} \u2014 ${sizeStr} \u2014 Recommended` : `${m.id} ${extra}`;
                opt.textContent = label;
                sel.appendChild(opt);
            });

            if (currentVal && models.some((m) => m.id === currentVal)) {
                sel.value = currentVal;
            } else if (saved && models.some((m) => m.id === saved)) {
                sel.value = saved;
            } else {
                const recommended = models.find((m) => m.recommended_for === "Recommended" && m.downloaded);
                const anyDownloaded = models.find((m) => m.downloaded);
                if (recommended) sel.value = recommended.id;
                else if (anyDownloaded) sel.value = anyDownloaded.id;
                else if (models.length) sel.value = models[models.length - 1].id;
            }

            if (!sel._mgPersistBound) {
                sel._mgPersistBound = true;
                sel.addEventListener("change", () => this._persistModelChoice(sel));
            }
        });
        this._populateOutputLangSelects();
    },

    _populateOutputLangSelects() {
        const langs = [
            { code: "auto", name: "Auto (same as transcript)" },
            { code: "en", name: "English" },
            { code: "it", name: "Italian" },
            { code: "es", name: "Spanish" },
            { code: "fr", name: "French" },
            { code: "de", name: "German" },
            { code: "pt", name: "Portuguese" },
            { code: "nl", name: "Dutch" },
            { code: "ru", name: "Russian" },
            { code: "zh", name: "Chinese" },
            { code: "ja", name: "Japanese" },
            { code: "ko", name: "Korean" },
            { code: "ar", name: "Arabic" },
            { code: "hi", name: "Hindi" },
            { code: "tr", name: "Turkish" },
            { code: "pl", name: "Polish" },
            { code: "sv", name: "Swedish" },
            { code: "no", name: "Norwegian" },
            { code: "fi", name: "Finnish" },
            { code: "da", name: "Danish" },
            { code: "cs", name: "Czech" },
            { code: "uk", name: "Ukrainian" },
            { code: "ro", name: "Romanian" },
            { code: "el", name: "Greek" },
            { code: "hu", name: "Hungarian" },
            { code: "he", name: "Hebrew" },
            { code: "id", name: "Indonesian" },
            { code: "th", name: "Thai" },
            { code: "vi", name: "Vietnamese" },
            { code: "ms", name: "Malay" },
            { code: "ca", name: "Catalan" },
        ];
        let saved = "auto";
        try { saved = localStorage.getItem("mg.outputLang") || "auto"; } catch (_) {}

        const selects = [
            document.getElementById("output-lang-select"),
            document.getElementById("output-lang-select-record"),
        ];
        selects.forEach((sel) => {
            if (!sel) return;
            sel.innerHTML = "";
            langs.forEach((l) => {
                const opt = document.createElement("option");
                opt.value = l.code;
                opt.textContent = l.name;
                sel.appendChild(opt);
            });
            sel.value = langs.some((l) => l.code === saved) ? saved : "auto";
            if (!sel._mgOutputBound) {
                sel._mgOutputBound = true;
                sel.addEventListener("change", () => this._persistOutputLang(sel.value));
            }
        });
    },

    renderModelGrid(models) {
        const grid = document.getElementById("model-list");
        if (!grid) return;
        grid.innerHTML = "";
        models.forEach((m) => grid.appendChild(this._buildModelCard(m)));
    },

    _buildModelCard(m) {
        const el = window.UI.el;
        const state = m.downloaded ? "ready" : (m.downloading ? "downloading" : "idle");
        const card = el("div", { class: "model-card-v2", "data-state": state, "data-model": m.id });

        const header = el("div", { class: "model-card-header" });
        header.appendChild(el("span", { class: "model-card-name" }, [m.id]));
        if (m.recommended_for) header.appendChild(window.UI.badge(m.recommended_for, m.recommended_for === "Recommended" ? "accent" : "outline"));
        if (m.downloaded) header.appendChild(window.UI.badge("Downloaded", "success"));
        card.appendChild(header);

        if (m.description) card.appendChild(el("div", { class: "model-card-desc" }, [m.description]));

        const meta = el("div", { class: "model-card-meta" });
        const size = m.downloaded && m.exact_size_mb ? `${this.fmtModelSize(m.exact_size_mb)} on disk` : this.fmtModelSize(m.size_mb);
        meta.appendChild(el("span", null, [size]));
        if (!m.downloaded && !m.downloading) meta.appendChild(el("span", null, [`~${this.fmtDlTime(m.size_mb)} on a 10 Mbps link`]));
        card.appendChild(meta);

        const actions = el("div", { class: "model-card-actions" });
        card.appendChild(actions);

        if (m.downloading) {
            const wrap = this._buildModelProgress(m);
            card.appendChild(wrap.node);
            actions.appendChild(el("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: () => this.cancelModelDownload(m.id) }, ["Cancel"]));
            this.connectModelSSE(m.id, wrap.update, wrap.setDone);
        } else if (m.downloaded) {
            actions.appendChild(el("button", { class: "btn btn-outline btn-sm", type: "button", onclick: () => this.confirmDeleteModel(m.id) }, ["Delete cached model"]));
        } else {
            actions.appendChild(el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => this.downloadModel(m.id) }, ["Download"]));
        }

        return card;
    },

    _buildModelProgress(m) {
        const el = window.UI.el;
        const prog = window.UI.progressBar({ value: m.download_progress || 0, showValue: false, label: `Downloading ${m.id}` });
        const dl = el("span", null, [`${(m.downloaded_mb || 0).toFixed(0)} / ${m.total_mb || m.size_mb} MB`]);
        const speed = el("span", null, [m.speed_kbps > 5 ? `${this.fmtSpeed(m.speed_kbps)} · ETA ${this.fmtEta(m.eta_sec)}` : "Estimating…"]);
        const meta = el("div", { class: "model-card-progress-meta" }, [dl, speed]);
        const wrap = el("div", { class: "model-card-progress" }, [prog.node, meta]);

        function update(d) {
            prog.set(d.progress || 0, d.message);
            dl.textContent = `${(d.downloaded_mb || 0).toFixed(0)} / ${d.total_mb || m.size_mb} MB`;
            speed.textContent = d.speed_kbps > 5 ? `${App.fmtSpeed(d.speed_kbps)} · ETA ${App.fmtEta(d.eta_sec)}` : (d.message || "Estimating…");
        }
        function setDone() {
            prog.set(100);
            prog.complete();
            speed.textContent = "";
        }
        return { node: wrap, update, setDone };
    },

    async downloadModel(modelId) {
        try {
            const res = await fetch(`/api/models/${modelId}/download`, { method: "POST" });
            const data = await res.json();
            if (data.status === "already_downloaded") { this.loadModelList(); return; }
            this._mutateModelCardToDownloading(modelId);
        } catch (err) {
            window.UI.toast("Failed to start download: " + err.message, { variant: "error" });
        }
    },

    _mutateModelCardToDownloading(modelId) {
        const card = document.querySelector(`.model-card-v2[data-model="${modelId}"]`);
        if (!card) return;
        card.setAttribute("data-state", "downloading");
        const m = { id: modelId, downloaded: false, downloading: true, download_progress: 0, downloaded_mb: 0, total_mb: 0, speed_kbps: 0, eta_sec: 0 };
        const actions = card.querySelector(".model-card-actions");
        const meta = card.querySelector(".model-card-meta");
        if (meta) meta.innerHTML = "Preparing&hellip;";
        if (actions) actions.innerHTML = "";
        const progress = this._buildModelProgress(m);
        card.appendChild(progress.node);
        if (actions) actions.innerHTML = '<button class="btn btn-secondary btn-sm" type="button">Cancel</button>';
        const cancelBtn = actions.querySelector("button");
        if (cancelBtn) cancelBtn.onclick = () => this.cancelModelDownload(modelId);
        const _orig = progress.setDone;
        progress.setDone = () => {
            if (_orig) _orig();
            card.setAttribute("data-state", "ready");
            if (meta) meta.innerHTML = "";
            if (actions) actions.innerHTML = '<button class="btn btn-outline btn-sm" type="button">Delete cached model</button>';
            const delBtn = actions.querySelector("button");
            if (delBtn) delBtn.onclick = () => this.confirmDeleteModel(modelId);
            const progWrap = card.querySelector(".model-card-progress");
            if (progWrap) progWrap.remove();
            this.loadModelList();
            this._populateModelSelects();
        };
        this.connectModelSSE(modelId, progress.update, progress.setDone);
    },

    async cancelModelDownload(modelId) {
        const ok = await window.UI.confirm({
            title: "Cancel download?",
            message: "Cancelling stops progress tracking. Partial data stays cached and will resume automatically the next time you try.",
            confirmLabel: "Cancel download",
            cancelLabel: "Keep downloading",
            danger: true,
        });
        if (!ok) return;
        try {
            await fetch(`/api/models/${modelId}/cancel`, { method: "POST" });
        } catch (err) {
            window.UI.toast("Failed to cancel: " + err.message, { variant: "error" });
        }
    },

    async confirmDeleteModel(modelId) {
        const ok = await window.UI.confirm({
            title: `Delete cached model "${modelId}"?`,
            message: "The model will be removed from your Hugging Face cache. You'll need to re-download it to use again.",
            confirmLabel: "Delete",
            cancelLabel: "Keep",
            danger: true,
        });
        if (!ok) return;
        try {
            const res = await fetch(`/api/models/${modelId}`, { method: "DELETE" });
            const data = await res.json();
            if (data.ok) { window.UI.toast("Model deleted", { variant: "success" }); this.loadModelList(); this.loadDiskSpace(); }
            else {
                console.error("delete model failed", { modelId, response: data });
                window.UI.toast(data.error || "Could not delete model. It may be downloading or in use.", { variant: "warning" });
            }
        } catch (err) {
            console.error("delete model error", { modelId, error: err.message });
            window.UI.toast("Delete failed: " + err.message, { variant: "error" });
        }
    },

    connectModelSSE(modelId, onUpdate, onDone) {
        if (this.modelEventSource) this.modelEventSource.close();
        const es = new EventSource(`/api/models/${modelId}/download-progress`);
        this.modelEventSource = es;
        es.addEventListener("progress", (e) => {
            try { onUpdate(JSON.parse(e.data)); } catch (_) {}
        });
        es.addEventListener("done", () => {
            es.close(); this.modelEventSource = null;
            if (onDone) { onDone(); } else { this.loadModelList(); }
            this._populateModelSelects();
            window.UI.toast(`Model ${modelId} ready`, { variant: "success" });
        });
        es.addEventListener("cancelled", () => {
            es.close(); this.modelEventSource = null;
            if (!onDone) this.loadModelList();
            window.UI.toast("Download cancelled — will resume next time", { variant: "warning" });
        });
        es.addEventListener("error", (e) => {
            es.close(); this.modelEventSource = null;
            let msg = "Download failed";
            try { const d = JSON.parse(e.data); if (d.message) msg = d.message; } catch (_) {}
            if (!onDone) this.loadModelList();
            window.UI.toast(msg, { variant: "error" });
        });
        es.onerror = () => { es.close(); this.modelEventSource = null; };
    },

    // --- Recording ---

    selectRecordMode(mode) {
        this.recordMode = mode;
        this._populateModelSelects();
        document.getElementById("record-mode-select").classList.add("hidden");
        document.getElementById("record-ready").classList.remove("hidden");

        const label = mode === "system" ? "System Audio + Microphone" : "Microphone";
        const icon = mode === "system"
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="badge-icon" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
            : document.querySelector(".record-source-badge .badge-icon")?.outerHTML || "";
        document.getElementById("rec-source-label").textContent = label;
        document.getElementById("rec-source-badge").querySelector("svg")?.remove();
        if (icon) document.getElementById("rec-source-badge").insertAdjacentHTML("afterbegin", icon);

        if (mode === "system") {
            document.getElementById("rec-src-system").classList.remove("hidden");
            document.getElementById("rec-active-label").textContent = "System + Mic";
            const inst = document.getElementById("rec-system-instructions");
            if (inst) inst.style.display = "block";
        } else {
            document.getElementById("rec-src-system").classList.add("hidden");
            document.getElementById("rec-active-label").textContent = "Mic";
            const inst = document.getElementById("rec-system-instructions");
            if (inst) inst.style.display = "none";
        }

        document.getElementById("model-select-record").value = document.getElementById("model-select").value;
    },

    resetRecordingMode() {
        document.getElementById("record-mode-select").classList.remove("hidden");
        document.getElementById("record-ready").classList.add("hidden");
        document.getElementById("record-active").classList.add("hidden");
        document.getElementById("record-done").classList.add("hidden");
        const slot = document.getElementById("record-banner-slot");
        if (slot) slot.innerHTML = "";
        this.recordMode = null;
        this.recordBlob = null;
    },

    async startRecording() {
        const mode = this.recordMode || "mic";
        if (!AudioRecorder.supportsMicOnly() && !AudioRecorder.supportsSystemAudio()) {
            window.UI.toast("Your browser does not support audio capture. Try a different browser or the desktop app.", { variant: "error" });
            return;
        }

        if (mode !== "system") {
            const ok = await this._showPermissionsPreflight(mode);
            if (!ok) return;
        }

        document.getElementById("record-ready").classList.add("hidden");
        document.getElementById("record-done").classList.add("hidden");
        document.getElementById("record-active").classList.remove("hidden");

        AudioRecorder.onTimer = (sec) => {
            document.getElementById("record-timer").textContent =
                String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
        };
        AudioRecorder.onLevel = (level) => {
            document.getElementById("vu-fill").style.height = (level * 100) + "%";
        };
        AudioRecorder.onStateChange = (state, info) => {
            if (state === "error") this._handleRecordingError(info, mode);
        };
        AudioRecorder.onStop = (result) => {
            this.recordBlob = result.blob;
            document.getElementById("rec-duration").textContent = result.duration + "s";
            document.getElementById("rec-size").textContent = this.fmtSize(result.size);
            document.getElementById("record-active").classList.add("hidden");
            document.getElementById("record-done").classList.remove("hidden");
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ permissions_acknowledged: true }),
            }).catch(() => {});
        };

        this.recordFilename = "recording_" + new Date().toISOString().replace(/[:.]/g, "-");
        await AudioRecorder.start(mode);
        window.UI.toast("Recording started — " + (mode === "system" ? "system audio + mic" : "microphone"), { variant: "success" });
    },

    async _showPermissionsPreflight(mode) {
        if (this.permissionsSeen[mode]) return true;
        return new Promise((resolve) => {
            const el = window.UI.el;
            const platform = window.Permissions ? window.Permissions.detectPlatform() : "other";
            const body = el("div");
            body.appendChild(el("p", { class: "modal-text" }, ["We'll ask your operating system for microphone access. Click Allow when the system dialog appears."]));

            const steps = el("ol", { class: "wizard-list" });
            addStep(steps, "1", "Allow the microphone prompt when it appears.");
            addStep(steps, "2", "Speak normally — you'll see a level meter confirming input.");
            body.appendChild(steps);

            let settled = false;
            const footer = el("div", { class: "modal-footer-actions" });
            const m = window.UI.modal({
                title: "Record microphone",
                content: body,
                footer,
                size: "md",
                onClose: () => { if (!settled) { settled = true; resolve(false); } },
            });

            footer.appendChild(el("button", { class: "btn btn-ghost", type: "button", onclick: () => { settled = true; m.close(); resolve(false); } }, ["Cancel"]));
            footer.appendChild(el("button", { class: "btn btn-primary", type: "button", onclick: () => {
                this.permissionsSeen[mode] = true;
                settled = true;
                m.close();
                resolve(true);
            } }, ["Continue"]));
        });

        function addStep(ul, n, t) {
            const li = document.createElement("li");
            const num = document.createElement("span"); num.className = "wizard-list-num"; num.textContent = n;
            li.appendChild(num);
            const span = document.createElement("span"); span.textContent = t;
            li.appendChild(span);
            ul.appendChild(li);
        }
    },

    _handleRecordingError(info, mode) {
        this.resetRecordingMode();
        const slot = document.getElementById("record-banner-slot");
        const platform = window.Permissions ? window.Permissions.detectPlatform() : "other";

        if (info && info.code === "permission_denied") {
            const kind = mode === "system" ? "system" : "mic";
            const instr = window.Permissions ? window.Permissions.getRecoveryInstructions(platform, kind) : null;
            if (slot && instr) {
                slot.innerHTML = "";
                const el = window.UI.el;
                const banner = window.UI.banner({
                    variant: "error",
                    title: instr.title,
                    message: "Permission was denied. Follow the steps below and try again.",
                });
                slot.appendChild(banner);
                const recovery = el("div", { class: "perm-recovery card" });
                const ol = el("ol", { class: "perm-recovery-steps" });
                (instr.steps || []).forEach((s) => ol.appendChild(el("li", null, [s])));
                recovery.appendChild(ol);
                const actions = el("div", { class: "perm-recovery-actions" });
                if (instr.settingsPane) {
                    actions.appendChild(el("button", { class: "btn btn-primary", type: "button", onclick: () => this.openSystemSettings(instr.settingsPane) }, ["Open system settings"]));
                }
                actions.appendChild(el("button", { class: "btn btn-secondary", type: "button", onclick: () => { slot.innerHTML = ""; } }, ["Dismiss"]));
                recovery.appendChild(actions);
                slot.appendChild(recovery);
            }
            window.UI.toast("Recording permission denied", { variant: "error" });
            return;
        }
        if (info && info.code === "no_device") {
            window.UI.toast("No microphone was detected. Plug one in and try again.", { variant: "error" });
            return;
        }
        if (info && info.code === "in_use") {
            window.UI.toast("Your microphone is being used by another app.", { variant: "error" });
            return;
        }
        window.UI.toast("Recording error: " + ((info && info.message) || "Unknown"), { variant: "error" });
    },

    async openSystemSettings(pane) {
        try {
            const res = await fetch("/api/system/open-settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pane }),
            });
            const data = await res.json();
            if (!data.ok) window.UI.toast(data.message || "Could not open system settings", { variant: "warning" });
        } catch (err) {
            window.UI.toast("Failed: " + err.message, { variant: "error" });
        }
    },

    stopRecording() { AudioRecorder.stop(); },

    processRecording() {
        const blob = this.recordBlob;
        if (!blob) return;
        const filename = (this.recordFilename || "recording") + ".webm";
        const file = new File([blob], filename, { type: blob.type });
        const langSel = document.getElementById("lang-select-record");
        const language = langSel ? (langSel.value || "") : "";
        if (langSel) this._persistRecordLang(language);
        this.navigate("upload");
        this.uploadFile(file, { fromRecord: true, language });
    },

    downloadRecording() {
        const blob = this.recordBlob;
        if (!blob) { window.UI.toast("No recording available to download.", { variant: "warning" }); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (this.recordFilename || "recording") + ".webm";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    resetRecording() {
        this.resetRecordingMode();
    },

    // --- Upload ---

    bindDropZone() {
        if (this._dzBound) return;
        const dz = document.getElementById("drop-zone");
        const fi = document.getElementById("file-input");
        if (!dz || !fi) return;
        this._dzBound = true;

        dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag-over"); });
        dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
        dz.addEventListener("drop", (e) => {
            e.preventDefault();
            dz.classList.remove("drag-over");
            const f = e.dataTransfer.files[0];
            fi.value = "";
            if (f && this.validFile(f)) this.uploadFile(f);
            else if (f) window.UI.toast("Unsupported audio format.", { variant: "warning" });
        });
        fi.addEventListener("drop", (e) => { e.preventDefault(); });

        fi.addEventListener("change", () => {
            if (!fi.files.length) return;
            const f = fi.files[0];
            const MAX_MB = 500;
            if (f.size > MAX_MB * 1024 * 1024) {
                window.UI.toast("File exceeds " + MAX_MB + " MB limit. Consider splitting the recording.", { variant: "warning" });
                fi.value = "";
                return;
            }
            fi.value = "";
            this.uploadFile(f);
        });
    },

    validFile(f) { return this.AUDIO_EXT.includes(f.name.split(".").pop().toLowerCase()); },

    async uploadFile(file, opts) {
        opts = opts || {};
        if (this._jobActive && this.currentJobId) {
            window.UI.toast("Another meeting is being processed. Cancel it first.", { variant: "warning" });
            return;
        }
        this.showProcessingView();
        this.segments = [];
        this.audioDuration = 0;
        this.lastSegEnd = 0;
        this._etaSpeedEma = 0;
        this._etaBaseline = Date.now();
        this.detectedLanguage = null;
        this.currentPhase = null;
        this._resetPhaseCards();

        const recordModel = document.getElementById("model-select-record");
        const uploadModel = document.getElementById("model-select");
        const fromRecord = !!opts.fromRecord;
        const model = fromRecord && recordModel ? recordModel.value
            : (uploadModel ? uploadModel.value : "large-v3");
        const language = opts.language || "";
        const outputLang = document.getElementById("output-lang-select")?.value
            || document.getElementById("output-lang-select-record")?.value
            || "auto";
        const langLabel = language ? ` · ${language.toUpperCase()}` : " · auto";
        document.getElementById("file-info").innerHTML =
            `<span class="fi-name">${this.esc(file.name)}</span>` +
            `<span class="fi-meta"><span>${this.fmtSize(file.size)}</span><span>model: ${model}${langLabel}</span></span>`;

        this._setPhaseState("transcribe", "active", "Uploading…", 0);

        const fd = new FormData();
        fd.append("file", file);
        fd.append("model_size", model);
        if (language) fd.append("language", language);
        fd.append("output_language", outputLang);

        try {
            const res = await fetch("/api/upload", { method: "POST", body: fd });
            if (!res.ok) throw new Error(`Upload failed (${res.status})`);
            const d = await res.json();
            this.currentJobId = d.job_id;
            this._jobActive = true;
            this.connectSSE(d.job_id);
            this._renderReturnToProcessingPill();
        } catch (err) {
            const fi = document.getElementById("file-input");
            if (fi) fi.value = "";
            this.showError(err.message);
        }
    },

    // --- Two-phase progress helpers ---

    _resetPhaseCards() {
        this._setPhaseState("download", "idle", "Waiting…", 0);
        this._setPhaseState("transcribe", "idle", "Waiting…", 0);
        this._setPhaseState("summarize", "idle", "Waiting for transcript…", 0);
        document.getElementById("phase-card-download").classList.add("hidden");
        document.getElementById("phase-eta-download").textContent = "";
        document.getElementById("phase-eta-transcribe").textContent = "";
        document.getElementById("phase-elapsed-summarize").textContent = "";
        document.getElementById("phase-check-download").classList.add("hidden");
        document.getElementById("phase-check-transcribe").classList.add("hidden");
        document.getElementById("phase-check-summarize").classList.add("hidden");
        document.getElementById("segment-count").textContent = "";
        document.getElementById("live-feed").innerHTML = "";
        this._stopSummarizeElapsed();
        const cancelBtn = document.getElementById("job-cancel-btn");
        if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = "Cancel"; cancelBtn.style.display = ""; }
        this._cancelling = false;
    },

    _setPhaseState(name, state, msg, pct) {
        const card = document.getElementById(`phase-card-${name}`);
        const fill = document.getElementById(`phase-fill-${name}`);
        const track = document.getElementById(`phase-track-${name}`);
        const msgEl = document.getElementById(`phase-msg-${name}`);
        const pctEl = document.getElementById(`phase-pct-${name}`);
        const check = document.getElementById(`phase-check-${name}`);
        if (!card) return;
        card.setAttribute("data-state", state);
        if (msg != null) msgEl.textContent = msg;
        if (pct != null) {
            const clamped = Math.min(100, Math.max(0, pct));
            fill.style.width = clamped + "%";
            track.setAttribute("aria-valuenow", String(Math.round(clamped)));
            pctEl.textContent = Math.round(clamped) + "%";
        }
        if (state === "done") check.classList.remove("hidden");
        else check.classList.add("hidden");
    },

    _startSummarizeElapsed() {
        this._stopSummarizeElapsed();
        this._summarizeStart = Date.now();
        const elm = document.getElementById("phase-elapsed-summarize");
        this._summarizeElapsedTimer = setInterval(() => {
            if (!elm) return;
            const sec = Math.floor((Date.now() - this._summarizeStart) / 1000);
            elm.textContent = `${this.fmtTime(sec)} elapsed`;
        }, 500);
    },

    _stopSummarizeElapsed() {
        if (this._summarizeElapsedTimer) {
            clearInterval(this._summarizeElapsedTimer);
            this._summarizeElapsedTimer = null;
        }
    },

    // --- SSE ---

    connectSSE(jobId) {
        if (this.eventSource) this.eventSource.close();
        const es = new EventSource("/api/progress/" + jobId);
        this.eventSource = es;
        this._etaBaseline = Date.now();

        es.addEventListener("status", (e) => {
            const d = JSON.parse(e.data);
            this.audioDuration = d.audio_duration || 0;
            if (d.language) {
                this.detectedLanguage = d.language;
            }
            this._setPhaseState("transcribe", "active", d.message || "…", d.progress || 0);
        });

        es.addEventListener("phase", (e) => {
            this.updatePhase(JSON.parse(e.data).phase);
        });

        es.addEventListener("progress", (e) => {
            const d = JSON.parse(e.data);
            const phase = d.phase || this.currentPhase || "transcribing";
            if (phase === "downloading_model") {
                document.getElementById("phase-card-download").classList.remove("hidden");
                this._setPhaseState("download", "active", d.message, d.progress || 0);
            } else if (phase === "summarizing") {
                this._setPhaseState("summarize", "active", d.message, d.progress || 0);
            } else {
                this._setPhaseState("transcribe", "active", d.message, d.progress || 0);
                this._updateTranscribeETA(d);
            }
        });

        es.addEventListener("segment", (e) => {
            this.appendSegment(JSON.parse(e.data));
        });

        es.addEventListener("language_detected", (e) => {
            try {
                const d = JSON.parse(e.data);
                if (d.language) {
                    this.detectedLanguage = d.language;
                    const sc = document.getElementById("segment-count");
                    if (sc) sc.textContent = `${this.segments.length} segments · lang: ${d.language}`;
                }
            } catch (_) {}
        });

        es.addEventListener("ping", () => {}); // keepalive

        es.addEventListener("cancelled", (e) => {
            es.close();
            this.eventSource = null;
            this._jobActive = false;
            let msg = "Transcription cancelled";
            try { const d = JSON.parse(e.data); if (d.message) msg = d.message; } catch (_) {}
            this._stopSummarizeElapsed();
            const btn = document.getElementById("job-cancel-btn");
            if (btn) btn.style.display = "none";
            window.UI.toast(msg, { variant: "warning" });
            this.reset();
        });

        es.addEventListener("done", async () => {
            es.close();
            this.eventSource = null;
            this._jobActive = false;
            this._setPhaseState("download", "done", "Model download complete", 100);
            this._setPhaseState("transcribe", "done", "Transcription complete", 100);
            this._setPhaseState("summarize", "done", "Summary ready", 100);
            this._stopSummarizeElapsed();
            this._renderReturnToProcessingPill();
            setTimeout(() => this.fetchAndRender(), 300);
        });

        es.addEventListener("error", (e) => {
            es.close();
            this.eventSource = null;
            this._jobActive = false;
            let msg = "An unexpected error occurred";
            try { const d = JSON.parse(e.data); if (d.message) msg = d.message; } catch {}
            this.showError(msg);
        });

        es.onerror = () => {
            // The default onerror fires on transport hiccups too. Only fully close
            // if we've drained the buffer AND the server said we're done — handled
            // in the explicit event handlers above. Here we just log & let the
            // browser retry automatically for other cases.
            if (es.readyState === EventSource.CLOSED) {
                this.eventSource = null;
            }
        };
    },

    async cancelJob() {
        if (!this.currentJobId || this._cancelling) return;
        this._cancelling = true;
        const btn = document.getElementById("job-cancel-btn");
        if (btn) { btn.disabled = true; btn.textContent = "Cancelling…"; }
        try {
            await fetch(`/api/job/${this.currentJobId}/cancel`, { method: "POST" });
        } catch (err) {
            window.UI.toast("Cancel failed: " + err.message, { variant: "error" });
            this._cancelling = false;
            if (btn) { btn.disabled = false; btn.textContent = "Cancel"; }
        }
    },

    updatePhase(phase) {
        this.currentPhase = phase;
        if (phase === "downloading_model") {
            document.getElementById("phase-card-download").classList.remove("hidden");
            this._setPhaseState("download", "active", "Downloading model…", 0);
        } else if (phase === "loading_model") {
            this._setPhaseState("download", "done", "Model download complete", 100);
            this._setPhaseState("transcribe", "active", "Loading model…", 0);
            // Reset ETA baseline so a slow model download doesn't skew the estimate.
            this._etaBaseline = Date.now();
            this._etaSpeedEma = 0;
        } else if (phase === "transcribing") {
            this._setPhaseState("download", "done", "Model download complete", 100);
            this._setPhaseState("transcribe", "active", "Transcribing…", 0);
            if (!this._etaBaseline) this._etaBaseline = Date.now();
        } else if (phase === "summarizing") {
            this._setPhaseState("transcribe", "done", "Transcription complete", 100);
            this._setPhaseState("summarize", "active", "Analyzing meeting…", 0);
            this._startSummarizeElapsed();
        } else if (phase === "done") {
            this._setPhaseState("summarize", "done", "Summary ready", 100);
            this._stopSummarizeElapsed();
        }
    },

    _updateTranscribeETA(d) {
        const etaSlot = document.getElementById("phase-eta-transcribe");
        const ad = d.audio_duration || this.audioDuration;
        const wallElapsed = this._etaBaseline ? (Date.now() - this._etaBaseline) / 1000 : (d.elapsed_seconds || 0);
        if (ad > 0 && this.audioDuration === 0) this.audioDuration = ad;

        // Not enough data yet: don't show wild numbers.
        if (!ad || this.lastSegEnd <= 0 || wallElapsed < 3 || this.lastSegEnd < 5) {
            if (etaSlot) etaSlot.textContent = "Estimating…";
            return;
        }

        const instantSpeed = this.lastSegEnd / wallElapsed;  // audio-seconds per wall-second
        if (!isFinite(instantSpeed) || instantSpeed <= 0) {
            if (etaSlot) etaSlot.textContent = "Estimating…";
            return;
        }

        // Exponential moving average smoothing.
        const alpha = 0.3;
        if (this._etaSpeedEma <= 0) this._etaSpeedEma = instantSpeed;
        else this._etaSpeedEma = alpha * instantSpeed + (1 - alpha) * this._etaSpeedEma;

        const remaining = Math.max(0, (ad - this.lastSegEnd) / this._etaSpeedEma);
        if (etaSlot) etaSlot.textContent = remaining > 0 ? "ETA " + this.fmtTime(remaining) : "";
    },

    appendSegment(d) {
        this.segments.push(d);
        this.lastSegEnd = d.end;
        const feed = document.getElementById("live-feed");
        const div = document.createElement("div");
        div.className = "live-segment";
        div.innerHTML = `<span class="ts">${this.fmtTimestamp(d.start)}</span>${this.esc(d.text)}`;
        feed.appendChild(div);
        feed.scrollTop = feed.scrollHeight;
        document.getElementById("segment-count").textContent = this.segments.length + " segments";
    },

    // --- Result ---

    async fetchAndRender() {
        if (!this.currentJobId) return;
        try {
            const res = await fetch("/api/result/" + this.currentJobId);
            if (!res.ok) throw new Error("Failed to load results");
            this.result = await res.json();
            this.showResultView();
            this.renderTabs();
            document.getElementById("topbar-title").textContent = "Result";
        } catch (err) {
            this.showError(err.message);
        }
    },

    async loadHistoryJob(id) {
        this.currentJobId = id;
        try {
            const res = await fetch("/api/result/" + id);
            if (!res.ok) throw new Error("Job not found");
            this.result = await res.json();
            this.showResultView();
            this.renderTabs();
            document.getElementById("topbar-title").textContent = "Result";
        } catch (err) {
            this.showError(err.message);
        }
    },

    renderTabs() {
        document.getElementById("result-view").innerHTML = `
            <div class="stats-bar">${this.buildStats()}</div>
            <div class="tabs" role="tablist">
                <button class="tab active" role="tab" aria-selected="true" data-tab="overview" onclick="App.showTab('overview')">Overview</button>
                <button class="tab" role="tab" aria-selected="false" data-tab="transcript" onclick="App.showTab('transcript')">Transcript</button>
                <button class="tab" role="tab" aria-selected="false" data-tab="export" onclick="App.showTab('export')">Export</button>
            </div>
            <div id="tab-content" class="tab-content" role="tabpanel"></div>
        `;
        this.showTab("overview");
        this.loadHistoryList();
    },

    showTab(name) {
        this.activeTab = name;
        document.querySelectorAll(".tab").forEach((t) => {
            const active = t.dataset.tab === name;
            t.classList.toggle("active", active);
            t.setAttribute("aria-selected", active ? "true" : "false");
        });
        const tc = document.getElementById("tab-content");
        if (name === "overview") tc.innerHTML = this.buildOverview();
        else if (name === "transcript") tc.innerHTML = this.buildTranscript();
        else if (name === "export") tc.innerHTML = this.buildExport();
    },

    buildStats() {
        const d = this.result;
        return [
            `<span class="stat-pill"><strong>${d.word_count}</strong> words</span>`,
            `<span class="stat-pill"><strong>${this.fmtTime(d.audio_duration)}</strong> duration</span>`,
            d.processing_time ? `<span class="stat-pill"><strong>${this.fmtTime(d.processing_time)}</strong> processing</span>` : "",
            d.metadata ? `<span class="stat-pill"><strong>${d.metadata.model_size}</strong></span>` : "",
            d.metadata ? `<span class="stat-pill">${this.fmtSize(d.metadata.file_size)}</span>` : "",
        ].filter(Boolean).join("");
    },

    buildOverview() {
        const d = this.result;
        return `
            <div class="result-section-header">
                <span class="section-title">Summary</span>
                <button class="copy-btn" onclick="App.copyText(App.result.summary)">Copy</button>
            </div>
            <p class="summary-text">${this.esc(d.summary)}</p>

            <div class="result-section-header">
                <span class="section-title">Key Discussion Points</span>
                <button class="copy-btn" onclick="App.copyText(App.result.key_points.join('\\n'))">Copy</button>
            </div>
            <ul class="item-list">${d.key_points.map((p) => `<li>${this.esc(p)}</li>`).join("")}</ul>

            <div class="result-section-header">
                <span class="section-title">Action Items</span>
                <button class="copy-btn" onclick="App.copyText(App.result.action_items.join('\\n'))">Copy</button>
            </div>
            ${d.action_items.map((a, i) => `
                <div class="checklist-item">
                    <input type="checkbox" id="ai-${i}" ${localStorage.getItem("ai-" + this.currentJobId + "-" + i) ? "checked" : ""}
                           onchange="App.toggleActionItem(${i}, this.checked)">
                    <label for="ai-${i}">${this.esc(a)}</label>
                </div>
            `).join("")}<br>

            <div class="result-section-header">
                <span class="section-title">Decisions Made</span>
                <button class="copy-btn" onclick="App.copyText(App.result.decisions.join('\\n'))">Copy</button>
            </div>
            <ul class="item-list">${d.decisions.map((p) => `<li>${this.esc(p)}</li>`).join("")}</ul>

            <div class="result-section-header">
                <span class="section-title">Topics Covered</span>
            </div>
            <div class="topics-row">${d.topics.map((t) => `<span class="tag">${this.esc(t)}</span>`).join("")}</div>
        `;
    },

    buildTranscript() {
        const d = this.result;
        const segments = d.timed_segments || [];
        const lines = segments.map((s) => {
            const ts = this.fmtTimestamp(s.start);
            return `<span class="ts" onclick="App.copyText('${ts.replace(/'/g, "\\'")}')" title="Click to copy timestamp">${ts}</span> ${this.esc(s.text)}`;
        });
        return `
            <div class="search-box">
                <label class="sr-only" for="transcript-search">Search transcript</label>
                <input type="text" id="transcript-search" placeholder="Search transcript..." value="${this.esc(this.searchQuery)}"
                       oninput="App.searchTranscript()">
                <span class="search-count" id="search-count"></span>
            </div>
            <div class="transcript-body" id="transcript-body">${lines.join("\n")}</div>
            <div class="transcript-actions">
                <button class="btn btn-secondary" onclick="App.copyText(App.result.transcript)">Copy transcript</button>
                <div class="dropdown" id="transcript-download-dropdown">
                    <button type="button" class="btn btn-primary" aria-haspopup="true" aria-expanded="false"
                            onclick="App.toggleTranscriptDownloadMenu(event)">
                        Download <span class="dropdown-caret" aria-hidden="true">&#9662;</span>
                    </button>
                    <div class="dropdown-menu" id="transcript-download-menu" hidden role="menu">
                        <button type="button" class="dropdown-item" role="menuitem" onclick="App.downloadTranscript('docx')">
                            <span aria-hidden="true">&#128196;</span> Word (.docx)
                        </button>
                        <button type="button" class="dropdown-item" role="menuitem" onclick="App.downloadTranscript('pdf')">
                            <span aria-hidden="true">&#128209;</span> PDF
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    toggleTranscriptDownloadMenu(event) {
        event.stopPropagation();
        const menu = document.getElementById("transcript-download-menu");
        const btn = event.currentTarget;
        const opening = menu.hasAttribute("hidden");
        if (opening) {
            menu.removeAttribute("hidden");
            btn.setAttribute("aria-expanded", "true");
            const close = (e) => {
                if (!document.getElementById("transcript-download-dropdown")?.contains(e.target)) {
                    menu.setAttribute("hidden", "");
                    btn.setAttribute("aria-expanded", "false");
                    document.removeEventListener("click", close);
                }
            };
            document.addEventListener("click", close);
        } else {
            menu.setAttribute("hidden", "");
            btn.setAttribute("aria-expanded", "false");
        }
    },

    async downloadTranscript(kind) {
        const menu = document.getElementById("transcript-download-menu");
        if (menu) menu.setAttribute("hidden", "");
        const id = this.currentJobId;
        if (!id) { window.UI.toast("No meeting loaded.", { variant: "warning" }); return; }
        const map = {
            docx: { url: `/api/result/${id}/transcript/docx`, name: "transcript.docx", label: "Word document exported" },
            pdf: { url: `/api/result/${id}/transcript/pdf`, name: "transcript.pdf", label: "PDF exported" },
        };
        const target = map[kind];
        if (!target) return;
        await this.saveFile(target.url, target.name, target.label);
    },

    searchTranscript() {
        const q = document.getElementById("transcript-search").value.toLowerCase();
        this.searchQuery = q;
        const body = document.getElementById("transcript-body");
        const segs = this.result.timed_segments || [];
        const lines = segs.map((s) => {
            const ts = this.fmtTimestamp(s.start);
            const text = this.esc(s.text);
            const display = q ? text.replace(new RegExp(`(${this.escRegex(q)})`, "gi"), "<mark>$1</mark>") : text;
            return `<span class="ts" onclick="App.copyText('${ts.replace(/'/g, "\\'")}')" title="Click to copy timestamp">${ts}</span> ${display}`;
        });
        body.innerHTML = lines.join("\n");
        const count = q ? segs.filter((s) => s.text.toLowerCase().includes(q)).length : 0;
        document.getElementById("search-count").textContent = count > 0 ? `Found in ${count} segments` : "";
    },

    buildExport() {
        const id = this.currentJobId;
        return `
            <div class="export-grid">
                <button type="button" class="export-card" onclick="App.downloadExport('pdf')" aria-label="Download PDF">
                    <div class="export-icon" aria-hidden="true">&#128196;</div>
                    <div class="export-label">PDF</div>
                    <div class="export-hint">Formatted document</div>
                </button>
                <button type="button" class="export-card" onclick="App.downloadExport('text')" aria-label="Download plain text">
                    <div class="export-icon" aria-hidden="true">&#128221;</div>
                    <div class="export-label">Plain Text</div>
                    <div class="export-hint">.txt file</div>
                </button>
                <button type="button" class="export-card" onclick="App.downloadExport('markdown')" aria-label="Download markdown">
                    <div class="export-icon" aria-hidden="true">&#128214;</div>
                    <div class="export-label">Markdown</div>
                    <div class="export-hint">.md file</div>
                </button>
                <button type="button" class="export-card" onclick="App.downloadExport('json')" aria-label="Download JSON">
                    <div class="export-icon" aria-hidden="true">&#128187;</div>
                    <div class="export-label">JSON</div>
                    <div class="export-hint">Raw data</div>
                </button>
            </div>
            <button class="btn btn-primary" onclick="App.copyText(App.result.transcript)">Copy full transcript</button>
        `;
    },

    async downloadExport(kind) {
        const id = this.currentJobId;
        if (!id) { window.UI.toast("No meeting loaded.", { variant: "warning" }); return; }
        const map = {
            pdf: { path: "pdf", name: "meeting_notes.pdf" },
            text: { path: "text", name: "meeting_notes.txt" },
            markdown: { path: "markdown", name: "meeting_notes.md" },
            json: { path: "", name: "meeting_notes.json" },
        };
        const target = map[kind];
        if (!target) return;
        const url = `/api/result/${id}${target.path ? "/" + target.path : ""}`;
        const btn = document.querySelector(`.export-card[onclick*="'${kind}'"]`);
        if (btn) btn.classList.add("is-loading");
        try {
            await this.saveFile(url, target.name, `${kind.toUpperCase()} exported`);
        } finally {
            if (btn) btn.classList.remove("is-loading");
        }
    },

    async saveFile(url, filename, successLabel) {
        try {
            // Preferred path: pywebview desktop bridge. Opens a native Save dialog
            // via Python and writes the file — no window navigation, no blank window.
            const api = window.pywebview && window.pywebview.api;
            const bridgeFn = api ? (api.save_file || api.saveFile) : null;
            if (bridgeFn) {
                const result = await bridgeFn.call(api, url, filename);
                if (result && result.ok) {
                    window.UI.toast(`Saved to ${result.path}`, { variant: "success", duration: 2000 });
                } else if (result && result.cancelled) {
                    // User cancelled the save dialog; no toast needed.
                } else {
                    window.UI.toast(`Export failed: ${(result && result.error) || "unknown"}`, { variant: "error" });
                }
                return;
            }

            // Browser-mode fallback: fetch + blob + programmatic download.
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = objUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
            window.UI.toast(successLabel || "Exported", { variant: "success", duration: 1600 });
        } catch (err) {
            window.UI.toast(`Export failed: ${err.message}`, { variant: "error" });
        }
    },

    toggleActionItem(idx, checked) {
        localStorage.setItem("ai-" + this.currentJobId + "-" + idx, checked ? "1" : "");
    },

    // --- Copy ---

    async copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            window.UI.toast("Copied!", { variant: "success", duration: 1400 });
        } catch {
            const ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            window.UI.toast("Copied!", { variant: "success", duration: 1400 });
        }
    },

    // --- Error ---

    showError(msg) {
        document.querySelectorAll(".view").forEach((el) => { el.classList.remove("active"); el.classList.add("hidden"); });
        const ev = document.getElementById("error-view");
        ev.classList.remove("hidden");
        ev.classList.add("active");
        document.getElementById("error-msg").textContent = msg;
        document.getElementById("topbar-title").textContent = "Error";
    },

    // --- History ---

    async loadHistoryList() {
        const list = document.getElementById("history-list-inline");
        const empty = document.getElementById("history-empty");
        if (!list) return;
        try {
            const res = await fetch("/api/jobs");
            const jobs = await res.json();
            if (jobs.length === 0) {
                list.innerHTML = "";
                if (empty) {
                    empty.classList.remove("hidden");
                    empty.innerHTML = "";
                    empty.appendChild(window.UI.emptyState({
                        icon: "📄",
                        title: "No meetings yet",
                        description: "Upload an audio file or record your first meeting to get started.",
                        action: { label: "Upload a meeting", onClick: () => this.navigate("upload") },
                    }));
                }
                return;
            }
            if (empty) empty.classList.add("hidden");
            list.innerHTML = jobs.map((j) => `
                <div class="history-item" role="listitem" onclick="App.loadHistoryJob('${j.id}')"
                     onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();App.loadHistoryJob('${j.id}');}" tabindex="0">
                    <div class="history-info">
                        <span class="history-name">${this.esc(j.filename)}</span>
                        <span class="history-meta">${j.model_size} &middot; ${this.fmtTime(j.audio_duration)} &middot; ${this.fmtDate(j.created_at)}</span>
                    </div>
                    <div class="history-actions">
                        <button class="btn-icon btn-danger" onclick="event.stopPropagation();App.deleteJob('${j.id}')" aria-label="Delete meeting ${this.esc(j.filename)}" title="Delete">&times;</button>
                    </div>
                </div>
            `).join("");
        } catch {}
    },

    async deleteJob(id) {
        const ok = await window.UI.confirm({
            title: "Delete this meeting?",
            message: "The transcript, summary, and audio file will be permanently removed.",
            confirmLabel: "Delete",
            danger: true,
        });
        if (!ok) return;
        try {
            await fetch("/api/job/" + id, { method: "DELETE" });
            window.UI.toast("Meeting deleted", { variant: "success" });
            if (this.currentJobId === id) { this.reset(); } else { this.loadHistoryList(); }
        } catch {
            window.UI.toast("Failed to delete", { variant: "error" });
        }
    },

    // --- Formatting ---

    fmtTime(sec) {
        const s = Math.round(sec || 0);
        if (s < 60) return s + "s";
        if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
        return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
    },

    fmtTimestamp(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return h > 0
            ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
            : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    },

    fmtSize(bytes) {
        if (!bytes) return "";
        const u = ["B", "KB", "MB", "GB"];
        let i = 0, s = bytes;
        while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
        return s.toFixed(i > 0 ? 1 : 0) + " " + u[i];
    },

    fmtModelSize(mb) {
        if (!mb) return "";
        return mb >= 1000 ? (mb / 1000).toFixed(1) + " GB" : Math.round(mb) + " MB";
    },

    fmtDlTime(mb) {
        if (!mb) return "";
        const mbps = 10;
        const sec = (mb * 8) / mbps;
        if (sec < 60) return Math.round(sec) + "s";
        if (sec < 3600) return Math.round(sec / 60) + " min";
        return Math.round(sec / 3600) + "h " + Math.round((sec % 3600) / 60) + "m";
    },

    fmtSpeed(kbps) {
        if (!kbps || kbps <= 0) return "";
        if (kbps >= 1024) return (kbps / 1024).toFixed(1) + " MB/s";
        return Math.round(kbps) + " KB/s";
    },

    fmtEta(sec) {
        if (!sec || sec <= 0) return "…";
        if (sec < 60) return sec + "s";
        if (sec < 3600) return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
        return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
    },

    fmtDate(iso) {
        if (!iso) return "";
        try {
            return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        } catch { return iso; }
    },

    esc(text) {
        const d = document.createElement("div");
        d.textContent = text || "";
        return d.innerHTML;
    },

    escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); },
};

document.addEventListener("DOMContentLoaded", () => App.init());
