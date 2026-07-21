# -*- mode: python ; coding: utf-8 -*-

import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

_entry = Path("launcher.py").resolve()
_root = _entry.parent

APP_VERSION = os.environ.get("APP_VERSION", "0.3.0")

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
        "urllib.request",
        "webview",
        "webview.platforms.winforms",
        "webview.platforms.edgechromium",
        "httpx",
        "keyring",
        "keyring.backends",
        "keyring.backends.Windows",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "mlx_whisper",
        "mlx",
        "mlx.core",
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
    codesign_identity=None,
    entitlements_file=None,
    icon="icon.ico",
    manifest="app.manifest",
    version="version_info.txt",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="MeetingGenerator",
)
