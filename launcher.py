import os
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path


PREFERRED_PORTS = list(range(8765, 8786))


def _pick_port() -> tuple[socket.socket, int]:
    """Bind and hold a socket so no other process can steal the port before uvicorn takes it."""
    for p in PREFERRED_PORTS:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", p))
            return s, p
        except OSError:
            s.close()
            continue
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    return s, s.getsockname()[1]


def _write_runtime_port(port: int) -> None:
    try:
        from settings import WRITABLE_DIR
        WRITABLE_DIR.mkdir(parents=True, exist_ok=True)
        (WRITABLE_DIR / "runtime_port").write_text(str(port))
    except Exception:
        pass


def _read_runtime_port() -> int | None:
    try:
        from settings import WRITABLE_DIR
        raw = (WRITABLE_DIR / "runtime_port").read_text().strip()
        return int(raw) if raw else None
    except Exception:
        return None


def _wait_for_server(port: int, timeout: float = 90.0) -> bool:
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def _server_alive(port: int) -> bool:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
        return True
    except Exception:
        return False


SPLASH_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex; justify-content: center; align-items: center;
    height: 100vh; background: #0f0f23; color: #e0e0ff;
}
.splash { text-align: center; }
.logo { font-size: 3rem; margin-bottom: 1rem; }
.name { font-size: 1.5rem; font-weight: 600; margin-bottom: 2rem; }
.spinner {
    width: 32px; height: 32px;
    border: 3px solid #333; border-top: 3px solid #6366f1;
    border-radius: 50%; animation: spin 0.8s linear infinite;
    margin: 0 auto 1rem auto;
}
@keyframes spin { to { transform: rotate(360deg); } }
.status { font-size: 0.9rem; color: #888; }
.status-time { font-size: 0.8rem; color: #555; margin-top: 0.5rem; }
</style>
</head>
<body>
<div class="splash">
    <div class="logo">&#128172;</div>
    <div class="name">Meeting Generator</div>
    <div class="spinner"></div>
    <div class="status">Starting server&hellip;</div>
    <div class="status-time" id="elapsed"></div>
</div>
<script>
var start = Date.now();
setInterval(function() {
    var s = Math.floor((Date.now() - start) / 1000);
    document.getElementById('elapsed').textContent = s + 's elapsed';
}, 500);
</script>
</body>
</html>"""


def _show_error_dialog(title: str, message: str) -> None:
    try:
        if sys.platform == "darwin":
            script = (
                f'display dialog "{message}" with title "{title}" '
                f'buttons {{"OK"}} default button "OK" with icon stop'
            )
            subprocess.run(["osascript", "-e", script], check=False)
        elif sys.platform == "win32":
            import ctypes
            MB_ICONERROR = 0x10
            ctypes.windll.user32.MessageBoxW(0, message, title, MB_ICONERROR)
        else:
            sys.stderr.write(f"[{title}] {message}\n")
    except Exception:
        sys.stderr.write(f"[{title}] {message}\n")


class _SingleInstance:
    """Cross-platform single-instance guard.

    On POSIX (macOS/Linux) uses fcntl.flock on WRITABLE_DIR/app.lock.
    On Windows uses a named global mutex via CreateMutexW.
    """

    def __init__(self) -> None:
        self._handle = None
        self._lock_path: Path | None = None

    def acquire(self) -> bool:
        try:
            from settings import WRITABLE_DIR
            WRITABLE_DIR.mkdir(parents=True, exist_ok=True)
        except Exception:
            return True  # fall through if settings unavailable

        if sys.platform == "win32":
            try:
                import ctypes
                from ctypes import wintypes
                kernel32 = ctypes.windll.kernel32
                ERROR_ALREADY_EXISTS = 183
                name = "Global\\MeetingGeneratorSingleInstance"
                kernel32.CreateMutexW.restype = wintypes.HANDLE
                self._handle = kernel32.CreateMutexW(None, False, name)
                if not self._handle:
                    return True
                if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
                    return False
                return True
            except Exception:
                return True
        else:
            try:
                import fcntl
                from settings import WRITABLE_DIR
                self._lock_path = WRITABLE_DIR / "app.lock"
                self._handle = open(self._lock_path, "w")
                try:
                    fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._handle.write(str(os.getpid()))
                    self._handle.flush()
                    return True
                except OSError:
                    self._handle.close()
                    self._handle = None
                    return False
            except Exception:
                return True

    def release(self) -> None:
        if self._handle is None:
            return
        try:
            if sys.platform == "win32":
                import ctypes
                ctypes.windll.kernel32.CloseHandle(self._handle)
            else:
                import fcntl
                try:
                    fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
                except Exception:
                    pass
                self._handle.close()
        except Exception:
            pass
        self._handle = None


def _focus_existing_instance() -> None:
    """Best-effort attempt to bring the existing window to front."""
    try:
        if sys.platform == "darwin":
            subprocess.run(
                ["osascript", "-e", 'tell application "Meeting Generator" to activate'],
                check=False,
                capture_output=True,
            )
        elif sys.platform == "win32":
            port = _read_runtime_port()
            if port and _server_alive(port):
                webbrowser.open(f"http://127.0.0.1:{port}")
    except Exception:
        pass


class _ServerThread(threading.Thread):
    def __init__(self, port: int, sock: socket.socket | None):
        super().__init__(daemon=False)
        self.port = port
        self._sock = sock
        self.error: BaseException | None = None
        self._server = None

    def run(self):
        try:
            import uvicorn
            from app import app as fastapi_app
            os.environ["PORT"] = str(self.port)
            if self._sock is not None:
                try:
                    self._sock.close()
                except Exception:
                    pass
            config = uvicorn.Config(
                fastapi_app,
                host="127.0.0.1",
                port=self.port,
                log_level="warning",
            )
            self._server = uvicorn.Server(config)
            self._server.run()
        except BaseException as e:
            self.error = e
            traceback.print_exc()

    def request_stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True


def _after_webview_ready(window, port: int, server: "_ServerThread") -> None:
    if _wait_for_server(port, timeout=90):
        try:
            window.evaluate_js(f'location.replace("http://127.0.0.1:{port}")')
        except Exception:
            pass
        return
    if server.error is not None:
        msg = f"The Meeting Generator server failed to start.\n\n{type(server.error).__name__}: {server.error}"
    else:
        msg = (
            "The Meeting Generator server did not start within 90 seconds.\n"
            "Please check that port 8765-8785 or another port is available "
            "and try again."
        )
    _show_error_dialog("Meeting Generator", msg)
    server.request_stop()
    try:
        window.destroy()
    except Exception:
        pass


def _run_browser_mode(port: int) -> None:
    webbrowser.open(f"http://127.0.0.1:{port}")
    sys.stdout.write(f"Meeting Generator running at http://127.0.0.1:{port}\n")
    sys.stdout.write("Install pywebview for a native window: pip install pywebview\n")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def main():
    guard = _SingleInstance()
    if not guard.acquire():
        _focus_existing_instance()
        sys.exit(0)

    sock, port = _pick_port()
    _write_runtime_port(port)

    server = _ServerThread(port, sock)
    server.start()

    force_browser = os.environ.get("MEETINGGEN_BROWSER") == "1"

    if force_browser:
        if not _wait_for_server(port, timeout=90):
            if server.error is not None:
                msg = f"The Meeting Generator server failed to start.\n\n{type(server.error).__name__}: {server.error}"
            else:
                msg = (
                    "The Meeting Generator server did not start within 90 seconds.\n"
                    "Please check that port 8765-8785 or another port is available "
                    "and try again."
                )
            _show_error_dialog("Meeting Generator", msg)
            guard.release()
            sys.exit(1)
        try:
            _run_browser_mode(port)
        finally:
            server.request_stop()
            guard.release()
        return

    try:
        import webview
    except ImportError:
        if not _wait_for_server(port, timeout=90):
            if server.error is not None:
                msg = f"The Meeting Generator server failed to start.\n\n{type(server.error).__name__}: {server.error}"
            else:
                msg = (
                    "The Meeting Generator server did not start within 90 seconds.\n"
                    "Please check that port 8765-8785 or another port is available "
                    "and try again."
                )
            _show_error_dialog("Meeting Generator", msg)
            guard.release()
            sys.exit(1)
        try:
            _run_browser_mode(port)
        finally:
            server.request_stop()
            guard.release()
        return

    try:
        window = webview.create_window(
            title="Meeting Generator",
            html=SPLASH_HTML,
            width=1100,
            height=760,
            min_size=(880, 560),
            resizable=True,
            easy_drag=False,
        )
        window.events.closed += lambda: server.request_stop()
        webview.start(func=_after_webview_ready, args=(window, port, server), debug=False, http_server=False)
    except Exception as e:
        _show_error_dialog(
            "Meeting Generator",
            f"The application window failed to open.\n\n{type(e).__name__}: {e}",
        )
    finally:
        server.request_stop()
        server.join(timeout=3.0)
        guard.release()


if __name__ == "__main__":
    main()
