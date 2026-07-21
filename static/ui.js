/* UI primitives: toast, modal, banner, emptyState, badge, progressBar.
   Exposed as window.UI. Vanilla JS, no dependencies. */

(function () {
    const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

    function ensureRoot(id, cls) {
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement("div");
            el.id = id;
            if (cls) el.className = cls;
            document.body.appendChild(el);
        }
        return el;
    }

    function el(tag, props, children) {
        const node = document.createElement(tag);
        if (props) {
            for (const k in props) {
                if (props[k] === null || props[k] === undefined) continue;
                if (k === "style" && typeof props[k] === "object") Object.assign(node.style, props[k]);
                else if (k === "class") node.className = props[k];
                else if (k === "html") node.innerHTML = props[k];
                else if (k.startsWith("on") && typeof props[k] === "function") node.addEventListener(k.slice(2).toLowerCase(), props[k]);
                else if (k === "attrs") { for (const a in props.attrs) node.setAttribute(a, props.attrs[a]); }
                else node.setAttribute(k, props[k]);
            }
        }
        if (children) {
            (Array.isArray(children) ? children : [children]).forEach((c) => {
                if (c == null) return;
                node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
            });
        }
        return node;
    }

    /* ── Toast ──────────────────────────────────────────── */

    function toast(msg, opts) {
        opts = opts || {};
        const root = ensureRoot("toast-root");
        root.setAttribute("role", "status");
        root.setAttribute("aria-live", opts.variant === "error" ? "assertive" : "polite");
        const variant = opts.variant || "info";
        const duration = opts.duration != null ? opts.duration : (variant === "error" ? 6000 : 3200);

        const item = el("div", { class: "toast toast--" + variant, role: "alert" });
        const body = el("div", { class: "toast-body" });
        body.appendChild(el("span", { class: "toast-icon", attrs: { "aria-hidden": "true" } }, [iconFor(variant)]));
        body.appendChild(el("span", { class: "toast-msg" }, [msg]));
        item.appendChild(body);

        if (opts.action && typeof opts.action.onClick === "function") {
            const btn = el("button", { class: "toast-action btn btn-ghost btn-sm", type: "button", onclick: () => { opts.action.onClick(); dismiss(); } }, [opts.action.label || "OK"]);
            item.appendChild(btn);
        }
        const close = el("button", { class: "toast-close", type: "button", "aria-label": "Dismiss", onclick: () => dismiss() }, ["×"]);
        item.appendChild(close);
        root.appendChild(item);

        let timer = duration > 0 ? setTimeout(dismiss, duration) : null;
        item.addEventListener("mouseenter", () => { if (timer) { clearTimeout(timer); timer = null; } });
        item.addEventListener("mouseleave", () => { if (!timer && duration > 0) timer = setTimeout(dismiss, 1200); });

        function dismiss() {
            if (item.classList.contains("toast--leaving")) return;
            item.classList.add("toast--leaving");
            setTimeout(() => item.remove(), 200);
        }

        return { dismiss };
    }

    function iconFor(variant) {
        const map = {
            success: "✔",
            error: "⚠",
            warning: "⚠",
            info: "ℹ",
        };
        return map[variant] || map.info;
    }

    /* ── Modal ──────────────────────────────────────────── */

    function modal(opts) {
        opts = opts || {};
        const root = ensureRoot("modal-root");
        const previouslyFocused = document.activeElement;

        const overlay = el("div", {
            class: "modal-overlay",
            role: "presentation",
            onclick: (e) => { if (opts.dismissable !== false && e.target === overlay) close(); },
        });

        const dialog = el("div", {
            class: "modal-dialog" + (opts.size ? " modal-dialog--" + opts.size : ""),
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "modal-title-" + Date.now(),
            tabindex: "-1",
        });

        if (opts.title) {
            const header = el("div", { class: "modal-header" });
            const title = el("h2", { class: "modal-title", id: dialog.getAttribute("aria-labelledby") }, [opts.title]);
            header.appendChild(title);
            if (opts.dismissable !== false) {
                header.appendChild(el("button", { class: "modal-close btn-icon", type: "button", "aria-label": "Close", onclick: () => close() }, ["×"]));
            }
            dialog.appendChild(header);
        }

        const body = el("div", { class: "modal-body" });
        if (typeof opts.content === "string") body.innerHTML = opts.content;
        else if (opts.content instanceof Node) body.appendChild(opts.content);
        dialog.appendChild(body);

        if (opts.footer) {
            const footer = el("div", { class: "modal-footer" });
            if (typeof opts.footer === "string") footer.innerHTML = opts.footer;
            else if (opts.footer instanceof Node) footer.appendChild(opts.footer);
            dialog.appendChild(footer);
        }

        overlay.appendChild(dialog);
        root.appendChild(overlay);
        document.documentElement.classList.add("modal-open");

        function keyHandler(e) {
            if (e.key === "Escape" && opts.dismissable !== false) { e.preventDefault(); close(); }
            else if (e.key === "Tab") trapFocus(e, dialog);
        }
        document.addEventListener("keydown", keyHandler);

        requestAnimationFrame(() => {
            const first = dialog.querySelector(FOCUSABLE);
            (first || dialog).focus();
        });

        let closed = false;
        function close(result) {
            if (closed) return;
            closed = true;
            document.removeEventListener("keydown", keyHandler);
            overlay.classList.add("modal-overlay--leaving");
            setTimeout(() => {
                overlay.remove();
                if (!document.querySelector(".modal-overlay")) document.documentElement.classList.remove("modal-open");
                try { previouslyFocused && previouslyFocused.focus && previouslyFocused.focus(); } catch (_) {}
                if (typeof opts.onClose === "function") opts.onClose(result);
            }, 160);
        }

        function setContent(node) {
            body.innerHTML = "";
            if (typeof node === "string") body.innerHTML = node;
            else if (node instanceof Node) body.appendChild(node);
            requestAnimationFrame(() => {
                const first = body.querySelector(FOCUSABLE);
                if (first) first.focus();
            });
        }

        function setFooter(node) {
            let footer = dialog.querySelector(".modal-footer");
            if (!footer) { footer = el("div", { class: "modal-footer" }); dialog.appendChild(footer); }
            footer.innerHTML = "";
            if (typeof node === "string") footer.innerHTML = node;
            else if (node instanceof Node) footer.appendChild(node);
        }

        return { close, setContent, setFooter, dialog, body };
    }

    function trapFocus(e, container) {
        const nodes = container.querySelectorAll(FOCUSABLE);
        if (!nodes.length) { e.preventDefault(); container.focus(); return; }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function confirm(opts) {
        return new Promise((resolve) => {
            const confirmLabel = opts.confirmLabel || "Confirm";
            const cancelLabel = opts.cancelLabel || "Cancel";
            const danger = opts.danger === true;
            const footer = el("div", { class: "modal-footer-actions" });
            const cancel = el("button", { class: "btn btn-ghost", type: "button", onclick: () => { m.close(); resolve(false); } }, [cancelLabel]);
            const ok = el("button", { class: "btn " + (danger ? "btn-danger-solid" : "btn-primary"), type: "button", onclick: () => { m.close(); resolve(true); } }, [confirmLabel]);
            footer.appendChild(cancel);
            footer.appendChild(ok);
            const m = modal({
                title: opts.title || "Confirm",
                content: typeof opts.message === "string" ? el("p", { class: "modal-text" }, [opts.message]) : opts.message,
                footer,
                dismissable: opts.dismissable !== false,
                size: opts.size || "sm",
                onClose: (r) => { if (r === undefined) resolve(false); },
            });
        });
    }

    /* ── Banner / EmptyState / Badge / ProgressBar ─────── */

    function banner(opts) {
        opts = opts || {};
        const variant = opts.variant || "info";
        const b = el("div", { class: "banner banner--" + variant, role: variant === "error" ? "alert" : "status" });
        b.appendChild(el("span", { class: "banner-icon", "aria-hidden": "true" }, [iconFor(variant)]));
        const body = el("div", { class: "banner-body" });
        if (opts.title) body.appendChild(el("div", { class: "banner-title" }, [opts.title]));
        if (opts.message) body.appendChild(el("div", { class: "banner-message" }, [opts.message]));
        b.appendChild(body);
        if (opts.action && typeof opts.action.onClick === "function") {
            b.appendChild(el("button", { class: "btn btn-sm btn-secondary", type: "button", onclick: opts.action.onClick }, [opts.action.label || "OK"]));
        }
        if (opts.dismissable) {
            b.appendChild(el("button", { class: "banner-close btn-icon", type: "button", "aria-label": "Dismiss", onclick: () => b.remove() }, ["×"]));
        }
        return b;
    }

    function emptyState(opts) {
        opts = opts || {};
        const wrap = el("div", { class: "empty-state-v2", role: "region" });
        if (opts.icon) wrap.appendChild(el("div", { class: "empty-state-icon", "aria-hidden": "true" }, [opts.icon]));
        if (opts.title) wrap.appendChild(el("div", { class: "empty-state-title" }, [opts.title]));
        if (opts.description) wrap.appendChild(el("div", { class: "empty-state-description" }, [opts.description]));
        if (opts.action && typeof opts.action.onClick === "function") {
            wrap.appendChild(el("button", { class: "btn btn-primary", type: "button", onclick: opts.action.onClick }, [opts.action.label || "Get started"]));
        }
        return wrap;
    }

    function badge(text, variant) {
        return el("span", { class: "badge badge--" + (variant || "neutral") }, [text]);
    }

    function progressBar(opts) {
        opts = opts || {};
        const value = Math.min(100, Math.max(0, opts.value || 0));
        const wrap = el("div", { class: "pbar" + (opts.indeterminate ? " pbar--indeterminate" : "") });
        const track = el("div", { class: "pbar-track", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(value)), "aria-label": opts.label || "Progress" });
        const fill = el("div", { class: "pbar-fill", style: { width: value + "%" } });
        track.appendChild(fill);
        wrap.appendChild(track);
        if (opts.showValue) wrap.appendChild(el("span", { class: "pbar-value" }, [Math.round(value) + "%"]));
        return {
            node: wrap,
            set(v, msg) {
                const clamped = Math.min(100, Math.max(0, v));
                fill.style.width = clamped + "%";
                track.setAttribute("aria-valuenow", String(Math.round(clamped)));
                if (msg != null) track.setAttribute("aria-valuetext", msg);
            },
            complete() { wrap.classList.add("pbar--complete"); },
        };
    }

    window.UI = {
        toast,
        modal,
        confirm,
        banner,
        emptyState,
        badge,
        progressBar,
        el,
    };
})();
