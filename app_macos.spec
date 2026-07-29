# -*- mode: python ; coding: utf-8 -*-

import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

_entry = Path("launcher.py").resolve()
_root = _entry.parent

APP_VERSION = os.environ.get("APP_VERSION", "0.0.3")
CODESIGN_IDENTITY = os.environ.get("CODESIGN_IDENTITY") or "-"

_fw_data = collect_data_files("faster_whisper", include_py_files=False)
_ct2_data = collect_data_files("ctranslate2", include_py_files=False)
_av_bins = collect_dynamic_libs("av")
_ct2_bins = collect_dynamic_libs("ctranslate2")
_onnx_bins = collect_dynamic_libs("onnxruntime")
_tokenizers_bins = collect_dynamic_libs("tokenizers")

a = Analysis(
    [str(_entry)],
    pathex=[str(_root)],
    binaries=[] + _av_bins + _ct2_bins + _onnx_bins + _tokenizers_bins,
    datas=[
        (str(_root / "templates"), "templates"),
        (str(_root / "static"), "static"),
    ] + _fw_data + _ct2_data,
    hiddenimports=[
        "faster_whisper",
        "faster_whisper.utils",
        "faster_whisper.transcribe",
        "faster_whisper.vad",
        "faster_whisper.audio",
        "faster_whisper.feature_extractor",
        "faster_whisper.tokenizer",
        "ctranslate2",
        "onnxruntime",
        "onnxruntime.capi",
        "onnxruntime.capi._pybind_state",
        "av",
        "av.codec",
        "av.container",
        "av.audio",
        "av.audio.resampler",
        "av.audio.stream",
        "tokenizers",
        "tokenizers.decoders",
        "huggingface_hub",
        "tqdm",
        "numpy",
        "fpdf",
        "fpdf.enums",
        "jinja2",
        "jinja2.ext",
        "python_multipart",
        "sse_starlette",
        "openai",
        "dotenv",
        "anyio",
        "engineio",
        "starlette",
        "fastapi",
        "uvicorn",
        "webview",
        "webview.platforms.cocoa",
        "httpx",
        "keyring",
        "keyring.backends",
        "keyring.backends.macOS",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "torch",
        "tensorflow",
        "tensorboard",
        "sympy",
        "PIL",
        "matplotlib",
        "scipy",
        "pandas",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="MeetingGenerator",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=CODESIGN_IDENTITY,
    entitlements_file="entitlements.plist",
    icon="icon.icns",
)

app = BUNDLE(
    exe,
    name="MeetingGenerator.app",
    icon="icon.icns",
    bundle_identifier="com.meetinggenerator.app",
    version=APP_VERSION,
    info_plist={
        "CFBundleName": "Meeting Generator",
        "CFBundleDisplayName": "Meeting Generator",
        "CFBundleExecutable": "MeetingGenerator",
        "CFBundleIdentifier": "com.meetinggenerator.app",
        "CFBundleShortVersionString": APP_VERSION,
        "CFBundleVersion": APP_VERSION,
        "LSMinimumSystemVersion": "11.0",
        "NSHighResolutionCapable": True,
        "NSRequiresAquaSystemAppearance": False,
        "LSUIElement": False,
        "NSMicrophoneUsageDescription": "Meeting Generator records audio from your microphone to transcribe in-person meetings and calls. Audio stays on your device.",
        "NSCameraUsageDescription": "Meeting Generator does not use the camera. This entry is only present because macOS may request it alongside screen capture.",
        "NSScreenCaptureUsageDescription": "Meeting Generator captures system audio from apps like Zoom, Teams and Google Meet to transcribe online meetings. Only audio is used; screen content is discarded.",
        "NSSystemAdministrationUsageDescription": "Meeting Generator does not require administrator access.",
        "NSAppleEventsUsageDescription": "Meeting Generator uses Apple Events to open the Privacy pane in System Settings when microphone or screen-recording access is denied.",
        "NSAppTransportSecurity": {
            "NSAllowsLocalNetworking": True,
        },
        "LSApplicationCategoryType": "public.app-category.productivity",
    },
)
