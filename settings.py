import json
import os
import sys
from pathlib import Path

_FROZEN = getattr(sys, "frozen", False)

if _FROZEN:
    _BUNDLE_DIR = Path(sys._MEIPASS)
    _EXE_DIR = Path(sys.executable).resolve().parent
else:
    _BUNDLE_DIR = Path(__file__).resolve().parent
    _EXE_DIR = _BUNDLE_DIR


def _is_writable(path: Path) -> bool:
    if path.is_dir():
        try:
            (path / ".writetest").touch(exist_ok=True)
            return True
        except (OSError, PermissionError):
            return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        return True
    except (OSError, PermissionError):
        return False


def _get_data_dir() -> Path:
    if _FROZEN and not _is_writable(_EXE_DIR):
        if sys.platform == "darwin":
            return Path.home() / "Library" / "Application Support" / "MeetingGenerator"
        elif sys.platform == "win32":
            appdata = os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming"))
            return Path(appdata) / "MeetingGenerator"
        else:
            xdg = os.environ.get("XDG_DATA_HOME", os.path.join(os.path.expanduser("~"), ".local", "share"))
            return Path(xdg) / "MeetingGenerator"
    return _EXE_DIR


BUNDLE_DIR = _BUNDLE_DIR
DATA_DIR = _get_data_dir()
WRITABLE_DIR = DATA_DIR

_OUTPUTS_DIR = DATA_DIR / "outputs"
SETTINGS_PATH = _OUTPUTS_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "api_key": "",
    "downloaded_models": [],
    "onboarding_completed": False,
    "permissions_acknowledged": False,
}

_KEYRING_SERVICE = "MeetingGenerator"
_KEYRING_USERNAME = "deepseek_api_key"


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _keyring_get() -> str | None:
    try:
        import keyring
        val = keyring.get_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
        return val or None
    except Exception:
        return None


def _keyring_set(value: str) -> bool:
    try:
        import keyring
        if value:
            keyring.set_password(_KEYRING_SERVICE, _KEYRING_USERNAME, value)
        else:
            try:
                keyring.delete_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
            except Exception:
                pass
        return True
    except Exception:
        return False


def _read_settings_file() -> dict:
    _ensure_dir(SETTINGS_PATH.parent)
    try:
        with open(SETTINGS_PATH) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    return data


def load_settings() -> dict:
    data = _read_settings_file()
    merged = {**DEFAULT_SETTINGS, **data}
    # Prefer keyring for api_key; fall back to plaintext already in the file.
    kr = _keyring_get()
    if kr:
        merged["api_key"] = kr
    return merged


def save_settings(settings: dict) -> None:
    _ensure_dir(SETTINGS_PATH.parent)
    # Persist the api_key to the OS keyring when possible; keep a plaintext
    # fallback only when keyring is unavailable (portable installs).
    to_write = dict(settings)
    api_key = (to_write.get("api_key") or "").strip()
    stored_in_keyring = _keyring_set(api_key)
    if stored_in_keyring:
        to_write["api_key"] = ""
    with open(SETTINGS_PATH, "w") as f:
        json.dump(to_write, f, indent=2, ensure_ascii=False)


def get_api_key() -> str:
    kr = _keyring_get()
    if kr:
        return kr.strip()
    data = _read_settings_file()
    key = (data.get("api_key") or "").strip()
    if not key:
        key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    return key


def set_api_key(key: str) -> None:
    settings = load_settings()
    settings["api_key"] = key.strip()
    save_settings(settings)


def get_setting(key: str, default=None):
    settings = load_settings()
    return settings.get(key, default)


def set_setting(key: str, value) -> None:
    settings = load_settings()
    settings[key] = value
    save_settings(settings)
