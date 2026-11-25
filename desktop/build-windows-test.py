"""Build an offline Windows test ZIP from the npm payload and locked JS dependencies."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "kuaimai-agent-connector-windows-test.zip"
LOCK = json.loads((ROOT / "package-lock.json").read_text())
OUTPUT.parent.mkdir(exist_ok=True)

with tempfile.TemporaryDirectory() as temp:
    packed = subprocess.check_output(
        ["npm", "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", temp],
        cwd=ROOT, env={**os.environ, "npm_config_cache": str(Path(temp) / "cache")}
    )
    tar = Path(temp) / json.loads(packed)[0]["filename"]
    with zipfile.ZipFile(Path(temp) / OUTPUT.name, "w", zipfile.ZIP_DEFLATED) as bundle:
        with tarfile.open(tar) as package:
            for item in package:
                if item.isfile():
                    bundle.writestr(item.name.removeprefix("package/"), package.extractfile(item).read())
        for name, entry in LOCK["packages"].items():
            if not name or entry.get("dev"):
                continue
            directory = ROOT / name
            manifest = json.loads((directory / "package.json").read_text())
            if manifest["version"] != entry["version"]:
                raise ValueError("Install the locked version of " + name)
            for file in sorted(directory.rglob("*")):
                relative = file.relative_to(directory)
                if "node_modules" in relative.parts or file.name == ".DS_Store":
                    continue
                if file.is_symlink() or file.suffix in {".node", ".dylib", ".exe", ".dll"}:
                    raise ValueError("Review platform-specific dependency: " + str(relative))
                if file.is_file():
                    bundle.write(file, file.relative_to(ROOT))
        for file in ("desktop/windows-test.mjs", "docs/WINDOWS.md", "tests/runtime/windows-support.test.mjs"):
            bundle.write(ROOT / file, file)
        for action in ("connect", "stop", "check"):
            command = (r'node --test "tests\runtime\windows-support.test.mjs"' if action == "check"
                       else f'node "desktop\\windows-test.mjs" {action}')
            lines = ["@echo off", "setlocal DisableDelayedExpansion", "chcp 65001 >nul",
                     'pushd "%~dp0"', "where.exe node >nul 2>nul",
                     "if errorlevel 1 (", "  echo Install Node.js 22 or newer, then reopen this file.",
                     ") else (", "  " + command, ")", "popd", "pause"]
            bundle.writestr(action.capitalize() + ".cmd", "\r\n".join(lines) + "\r\n")
    shutil.copyfile(Path(temp) / OUTPUT.name, OUTPUT)
print(OUTPUT)
