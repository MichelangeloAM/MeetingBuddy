/* First-run onboarding wizard.
   Depends on window.UI (ui.js) and window.Permissions (permissions.js). */

(function () {
    const el = window.UI.el;

    const Wizard = {
        _modal: null,
        _index: 0,
        _steps: [],
        _state: {
            apiKeyOk: false,
            apiKey: "",
            selectedModel: null,
            downloadedModels: [],
            permsAcknowledged: false,
        },

        async start(opts) {
            opts = opts || {};
            const status = opts.status || await fetch("/api/onboarding").then((r) => r.json()).catch(() => ({}));
            this._state.apiKeyOk = !!status.has_api_key;
            this._state.apiKey = "";
            this._state.downloadedModels = status.downloaded_models || [];

            this._index = 0;
            this._steps = ["welcome", "apiKey", "model", "permissions", "done"];

            this._modal = window.UI.modal({
                title: "Welcome to Meeting Generator",
                content: el("div"),
                footer: el("div", { class: "modal-footer-actions" }),
                dismissable: !!opts.dismissable,
                size: "lg",
                onClose: () => { this._modal = null; },
            });

            this._render();
        },

        _render() {
            const step = this._steps[this._index];
            const body = el("div", { class: "wizard-body" });

            const track = el("div", { class: "wizard-progress" });
            this._steps.forEach((_, i) => {
                const dot = el("div", { class: "wizard-dot" + (i < this._index ? " done" : i === this._index ? " active" : "") });
                track.appendChild(dot);
            });
            body.appendChild(track);

            const stepEl = el("div", { class: "wizard-step" });
            body.appendChild(stepEl);

            const footer = el("div", { class: "modal-footer-actions" });

            if (step === "welcome") this._renderWelcome(stepEl, footer);
            else if (step === "apiKey") this._renderApiKey(stepEl, footer);
            else if (step === "model") this._renderModel(stepEl, footer);
            else if (step === "permissions") this._renderPermissions(stepEl, footer);
            else if (step === "done") this._renderDone(stepEl, footer);

            this._modal.setContent(body);
            this._modal.setFooter(footer);
        },

        _next() {
            if (this._index < this._steps.length - 1) { this._index += 1; this._render(); }
        },

        _prev() {
            if (this._index > 0) { this._index -= 1; this._render(); }
        },

        _finish() {
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ onboarding_completed: true }),
            }).then((res) => {
                if (!res.ok) throw new Error("save failed (" + res.status + ")");
                if (this._modal) this._modal.close();
                if (window.App && typeof window.App.onOnboardingComplete === "function") window.App.onOnboardingComplete();
            }).catch(() => {
                window.UI.toast("Could not save your onboarding progress. Please check your connection and try again.", { variant: "error", duration: 6000 });
                // Do NOT close the modal or call onOnboardingComplete — the wizard will still be shown next launch.
            });
        },

        _addNav(footer, opts) {
            opts = opts || {};
            if (opts.showBack && this._index > 0) {
                footer.appendChild(el("button", { class: "btn btn-ghost", type: "button", onclick: () => this._prev() }, ["Back"]));
            }
            if (opts.showSkip) {
                footer.appendChild(el("button", { class: "btn btn-ghost", type: "button", onclick: () => this._next() }, [opts.skipLabel || "Skip"]));
            }
            const nextBtn = el("button", {
                class: "btn btn-primary",
                type: "button",
                disabled: opts.disableNext ? "" : null,
                onclick: opts.onNext || (() => this._next()),
            }, [opts.nextLabel || "Next"]);
            if (opts.disableNext) nextBtn.setAttribute("disabled", "");
            footer.appendChild(nextBtn);
        },

        /* ---- Step 1: Welcome ---- */

        _renderWelcome(stepEl, footer) {
            stepEl.appendChild(el("h3", { class: "wizard-step-title" }, ["Let's get you set up."]));
            stepEl.appendChild(el("p", { class: "wizard-step-desc" }, ["A quick tour before your first meeting. You can re-run this later from Settings."]));
            const ul = el("ul", { class: "wizard-list" });
            [
                ["1", "Record or upload meetings — mic, or system audio from Zoom/Meet/Teams."],
                ["2", "Transcribe them locally with Whisper — private, offline."],
                ["3", "Summarize with DeepSeek — action items, decisions, key points."],
            ].forEach(([n, t]) => {
                const li = el("li");
                li.appendChild(el("span", { class: "wizard-list-num" }, [n]));
                li.appendChild(el("span", null, [t]));
                ul.appendChild(li);
            });
            stepEl.appendChild(ul);
            this._addNav(footer, { nextLabel: "Get started" });
        },

        /* ---- Step 2: API Key ---- */

        _renderApiKey(stepEl, footer) {
            stepEl.appendChild(el("h3", { class: "wizard-step-title" }, ["Connect DeepSeek"]));
            stepEl.appendChild(el("p", { class: "wizard-step-desc" }, ["We need a DeepSeek API key to generate meeting summaries. It's stored locally — never sent anywhere else."]));
            stepEl.appendChild(el("p", { class: "wizard-step-desc" }, [
                "Get a key at ",
                (() => { const a = el("a", { href: "https://platform.deepseek.com/api_keys", target: "_blank", rel: "noopener" }, ["platform.deepseek.com/api_keys"]); return a; })(),
                ".",
            ]));

            const inputRow = el("div", { class: "apikey-row" });
            const input = el("input", { type: "password", id: "wiz-api-key", placeholder: "sk-...", "aria-label": "DeepSeek API key" });
            inputRow.appendChild(input);
            const toggleBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => {
                input.type = input.type === "password" ? "text" : "password";
                toggleBtn.textContent = input.type === "password" ? "Show" : "Hide";
            } }, ["Show"]);
            inputRow.appendChild(toggleBtn);
            stepEl.appendChild(inputRow);

            const statusRow = el("div", { style: { minHeight: "28px", marginTop: "10px" } });
            const status = el("span", { class: "wizard-connection-status pending" }, ["Enter a key and click Test connection"]);
            statusRow.appendChild(status);
            stepEl.appendChild(statusRow);

            const testBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, ["Test connection"]);
            stepEl.appendChild(el("div", { style: { marginTop: "10px", display: "flex", gap: "8px" } }, [testBtn]));

            const nextBtn = el("button", { class: "btn btn-primary", type: "button", disabled: this._state.apiKeyOk ? null : "", onclick: async () => {
                const key = input.value.trim();
                if (key) await this._saveApiKey(key);
                this._next();
            } }, ["Save & continue"]);
            if (!this._state.apiKeyOk) nextBtn.setAttribute("disabled", "");

            testBtn.addEventListener("click", async () => {
                const key = input.value.trim();
                if (!key) {
                    status.className = "wizard-connection-status error";
                    status.textContent = "Please paste your API key first";
                    return;
                }
                status.className = "wizard-connection-status pending";
                status.textContent = "Testing…";
                testBtn.disabled = true;
                try {
                    const res = await fetch("/api/settings/test", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ api_key: key }),
                    });
                    const data = await res.json();
                    if (data.ok) {
                        status.className = "wizard-connection-status success";
                        status.textContent = `Connection successful${data.latency_ms ? ` (${Math.round(data.latency_ms)}ms)` : ""}`;
                        this._state.apiKeyOk = true;
                        this._state.apiKey = key;
                        nextBtn.removeAttribute("disabled");
                    } else {
                        status.className = "wizard-connection-status error";
                        status.textContent = data.message || "Connection failed";
                    }
                } catch (err) {
                    status.className = "wizard-connection-status error";
                    status.textContent = "Network error: " + err.message;
                } finally {
                    testBtn.disabled = false;
                }
            });

            if (this._index > 0) footer.appendChild(el("button", { class: "btn btn-ghost", type: "button", onclick: () => this._prev() }, ["Back"]));
            footer.appendChild(el("button", { class: "btn btn-ghost", type: "button", onclick: () => this._next() }, ["Skip for now"]));
            footer.appendChild(nextBtn);

            fetch("/api/settings").then((r) => r.json()).then((s) => {
                if (s.api_key_present && !this._state.apiKey) {
                    input.value = s.api_key || "";
                    status.className = "wizard-connection-status success";
                    status.textContent = "API key found — click Test connection to verify it still works.";
                }
            }).catch(() => {});
        },

        async _saveApiKey(key) {
            try {
                await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ api_key: key }),
                });
            } catch (_) {}
        },

        /* ---- Step 3: Model ---- */

        async _renderModel(stepEl, footer) {
            stepEl.appendChild(el("h3", { class: "wizard-step-title" }, ["Pick a transcription model"]));
            stepEl.appendChild(el("p", { class: "wizard-step-desc" }, ["Whisper models run locally on your machine. Download once — cached forever. Click 'Use this model' on one to set it as your default."]));

            const grid = el("div", { class: "model-grid" });
            stepEl.appendChild(grid);

            footer.appendChild(el("button", { class: "btn btn-ghost", type: "button", onclick: () => this._prev() }, ["Back"]));
            const skip = el("button", { class: "btn btn-ghost", type: "button", onclick: () => this._next() }, ["Skip for now"]);
            const next = el("button", { class: "btn btn-primary", type: "button", disabled: "", onclick: () => this._next() }, ["Continue"]);
            footer.appendChild(skip);
            footer.appendChild(next);

            const models = await fetch("/api/models").then((r) => r.json()).catch(() => []);

            let currentSelection = null;
            try { currentSelection = localStorage.getItem("mg.uploadModel") || null; } catch (_) {}

            const cards = [];

            const selectModel = (modelId) => {
                currentSelection = modelId;
                try {
                    localStorage.setItem("mg.uploadModel", modelId);
                    localStorage.setItem("mg.recordModel", modelId);
                } catch (_) {}
                this._state.selectedModel = modelId;
                cards.forEach((entry) => entry.applySelected(entry.model.id === modelId));
                next.removeAttribute("disabled");
            };

            models.forEach((m) => {
                const entry = renderWizardModelCard(m, {
                    onDownloaded: () => {
                        // After a download completes, auto-select if nothing is chosen yet.
                        if (!currentSelection) selectModel(m.id);
                        else next.removeAttribute("disabled");
                    },
                    onSelect: () => selectModel(m.id),
                });
                cards.push(entry);
                grid.appendChild(entry.node);
            });

            // If the user had previously selected a model, honor it. Otherwise pre-select the recommended (small) if downloaded.
            if (currentSelection && models.some((m) => m.id === currentSelection && m.downloaded)) {
                selectModel(currentSelection);
            } else {
                const rec = models.find((m) => m.recommended_for === "Recommended" && m.downloaded);
                const any = models.find((m) => m.downloaded);
                if (rec) selectModel(rec.id);
                else if (any) selectModel(any.id);
            }
        },

        /* ---- Step 4: Permissions ---- */

        async _renderPermissions(stepEl, footer) {
            const platform = window.Permissions ? window.Permissions.detectPlatform() : "other";
            stepEl.appendChild(el("h3", { class: "wizard-step-title" }, ["Recording permissions"]));
            stepEl.appendChild(el("p", { class: "wizard-step-desc" }, ["Meeting Generator uses your microphone to record in-person meetings and, optionally, system audio for online meetings."]));

            const micStatus = el("div", { class: "wizard-connection-status pending" }, ["Checking microphone…"]);
            stepEl.appendChild(el("div", { style: { marginBottom: "10px" } }, [micStatus]));

            const sysStatus = el("div", { class: "wizard-connection-status pending" }, ["Checking system audio support…"]);
            stepEl.appendChild(el("div", { style: { marginBottom: "10px" } }, [sysStatus]));

            const notes = el("ul", { class: "wizard-list", style: { marginTop: "16px" } });
            if (platform === "macos") {
                addNote(notes, "M", "On macOS, you'll be prompted for Microphone the first time you record. For online meetings, you'll also be asked for Screen Recording access.");
            } else if (platform === "windows") {
                addNote(notes, "W", "On Windows, you'll see the microphone prompt on first use. For online meetings, pick a tab/window and enable 'Share audio' in the picker.");
            }
            addNote(notes, "?", "If you decline by mistake, you can re-enable in your OS Settings — we'll show recovery steps in the app.");
            stepEl.appendChild(notes);

            footer.appendChild(el("button", { class: "btn btn-ghost", type: "button", onclick: () => this._prev() }, ["Back"]));
            const cont = el("button", { class: "btn btn-primary", type: "button", onclick: async () => {
                try { await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissions_acknowledged: true }) }); } catch (_) {}
                this._next();
            } }, ["I'm ready — continue"]);
            footer.appendChild(cont);

            // Probe in background
            if (window.Permissions) {
                window.Permissions.probeMic().then((state) => {
                    updatePermStatus(micStatus, {
                        granted: { cls: "success", text: "Microphone: granted" },
                        denied: { cls: "error", text: "Microphone: denied — enable in OS Settings" },
                        prompt: { cls: "pending", text: "Microphone: will prompt when you record" },
                        "no-device": { cls: "error", text: "No microphone detected" },
                        unavailable: { cls: "error", text: "Microphone API unavailable in this browser" },
                    }[state] || { cls: "pending", text: `Microphone: ${state}` });
                });
                const sys = window.Permissions.probeSystemAudio();
                updatePermStatus(sysStatus, sys === "available"
                    ? { cls: "success", text: "System audio: supported (Chromium)" }
                    : { cls: "error", text: "System audio: not supported by this browser (Safari/Firefox)" });
            }
        },

        /* ---- Step 5: Done ---- */

        _renderDone(stepEl, footer) {
            stepEl.appendChild(el("h3", { class: "wizard-step-title" }, ["You're all set."]));
            stepEl.appendChild(el("p", { class: "wizard-step-desc" }, ["Upload an audio file, or click Record in the sidebar to capture a meeting. We'll take it from there."]));
            const done = el("button", { class: "btn btn-primary", type: "button", onclick: () => this._finish() }, ["Take me to Upload"]);
            footer.appendChild(el("button", { class: "btn btn-ghost", type: "button", onclick: () => this._prev() }, ["Back"]));
            footer.appendChild(done);
        },
    };

    function updatePermStatus(elm, obj) {
        elm.className = "wizard-connection-status " + obj.cls;
        elm.textContent = obj.text;
    }

    function addNote(ul, badge, text) {
        const li = el("li");
        li.appendChild(el("span", { class: "wizard-list-num" }, [badge]));
        li.appendChild(el("span", null, [text]));
        ul.appendChild(li);
    }

    function renderWizardModelCard(m, callbacks) {
        callbacks = callbacks || {};
        // Backwards-compat: if a plain function is passed, treat it as onDownloaded.
        if (typeof callbacks === "function") callbacks = { onDownloaded: callbacks };
        const onDownloaded = callbacks.onDownloaded;
        const onSelect = callbacks.onSelect;

        const card = el("div", { class: "model-card-v2", "data-state": m.downloaded ? "ready" : "idle" });
        const header = el("div", { class: "model-card-header" });
        header.appendChild(el("span", { class: "model-card-name" }, [m.id]));
        if (m.recommended_for) header.appendChild(window.UI.badge(m.recommended_for, m.recommended_for === "Recommended" ? "accent" : "outline"));
        if (m.downloaded) header.appendChild(window.UI.badge("Downloaded", "success"));
        card.appendChild(header);
        if (m.description) card.appendChild(el("div", { class: "model-card-desc" }, [m.description]));
        const meta = el("div", { class: "model-card-meta" });
        meta.appendChild(el("span", null, [fmtModelSize(m.exact_size_mb || m.size_mb)]));
        card.appendChild(meta);

        const actions = el("div", { class: "model-card-actions" });
        card.appendChild(actions);

        let selectBtn = null;

        function makeSelectButton() {
            const b = el("button", { class: "btn btn-outline btn-sm", type: "button" }, ["Use this model"]);
            b.addEventListener("click", () => { if (onSelect) onSelect(); });
            return b;
        }

        if (m.downloaded) {
            selectBtn = makeSelectButton();
            actions.appendChild(selectBtn);
        } else {
            const btn = el("button", { class: "btn btn-primary btn-sm", type: "button" }, ["Download"]);
            actions.appendChild(btn);
            btn.addEventListener("click", async () => {
                actions.remove();
                card.setAttribute("data-state", "downloading");
                const prog = window.UI.progressBar({ value: 0, showValue: false, label: `Downloading ${m.id}` });
                const meta2 = el("div", { class: "model-card-progress-meta" });
                const dl = el("span", null, ["0 MB"]);
                const speed = el("span", null, [""]);
                meta2.appendChild(dl);
                meta2.appendChild(speed);
                const wrap = el("div", { class: "model-card-progress" }, [prog.node, meta2]);
                card.appendChild(wrap);

                const swapToSelectButton = () => {
                    wrap.remove();
                    const newActions = el("div", { class: "model-card-actions" });
                    selectBtn = makeSelectButton();
                    newActions.appendChild(selectBtn);
                    card.appendChild(newActions);
                    if (entry._selected) selectBtn.textContent = "✓ Selected";
                };

                try {
                    const res = await fetch(`/api/models/${m.id}/download`, { method: "POST" });
                    const data = await res.json();
                    if (data.status === "already_downloaded") {
                        card.setAttribute("data-state", "ready");
                        swapToSelectButton();
                        if (onDownloaded) onDownloaded();
                        return;
                    }
                    const es = new EventSource(`/api/models/${m.id}/download-progress`);
                    es.addEventListener("progress", (e) => {
                        const d = JSON.parse(e.data);
                        prog.set(d.progress || 0);
                        dl.textContent = `${(d.downloaded_mb || 0).toFixed(0)} / ${d.total_mb || m.size_mb} MB`;
                        speed.textContent = d.speed_kbps > 5 ? `${fmtSpeed(d.speed_kbps)} · ETA ${fmtEta(d.eta_sec)}` : "";
                    });
                    es.addEventListener("done", () => {
                        es.close();
                        prog.set(100);
                        prog.complete();
                        card.setAttribute("data-state", "ready");
                        swapToSelectButton();
                        if (onDownloaded) onDownloaded();
                    });
                    es.addEventListener("cancelled", () => {
                        es.close();
                        window.UI.toast("Download cancelled — partial data will resume next time.", { variant: "warning" });
                        card.setAttribute("data-state", "idle");
                    });
                    es.addEventListener("error", (e) => {
                        es.close();
                        let msg = "Download failed";
                        try { const d = JSON.parse(e.data); if (d.message) msg = d.message; } catch (_) {}
                        window.UI.toast(msg, { variant: "error" });
                        card.setAttribute("data-state", "idle");
                    });
                    es.onerror = () => { es.close(); };
                } catch (err) {
                    window.UI.toast("Failed to start download: " + err.message, { variant: "error" });
                    card.setAttribute("data-state", "idle");
                }
            });
        }

        const entry = {
            node: card,
            model: m,
            _selected: false,
            applySelected(isSelected) {
                this._selected = isSelected;
                card.classList.toggle("is-selected", isSelected);
                if (selectBtn) {
                    selectBtn.textContent = isSelected ? "✓ Selected" : "Use this model";
                    selectBtn.classList.toggle("btn-primary", isSelected);
                    selectBtn.classList.toggle("btn-outline", !isSelected);
                }
            },
        };

        return entry;
    }

    function fmtModelSize(mb) {
        if (!mb) return "";
        return mb >= 1000 ? (mb / 1000).toFixed(1) + " GB" : Math.round(mb) + " MB";
    }
    function fmtSpeed(kbps) {
        if (kbps >= 1024) return (kbps / 1024).toFixed(1) + " MB/s";
        return Math.round(kbps) + " KB/s";
    }
    function fmtEta(sec) {
        if (!sec || sec <= 0) return "…";
        if (sec < 60) return sec + "s";
        if (sec < 3600) return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
        return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
    }

    window.Wizard = Wizard;
})();
