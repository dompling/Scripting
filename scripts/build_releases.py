#!/usr/bin/env python3
"""Package each Scripting component from its src/ directory.

A component is any top-level directory with src/script.json and src/index.tsx.
Write identical ZIP bytes to dist/<Component>.zip and
<Component>/<Component>.scripting. Archive paths are relative to src/ so that
script.json and index.tsx are at the ZIP root, required by Scripting import.
"""
from __future__ import annotations

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
FORBIDDEN_SUFFIXES = (".mobiledevicepairing", ".p12", ".p8", ".pem", ".key")
FORBIDDEN_NAMES = {".ds_store", ".env", "id_rsa", "id_ed25519"}


def package(component: Path) -> None:
    source = component / "src"
    manifest = json.loads((source / "script.json").read_text(encoding="utf-8"))
    if manifest.get("entry") != "index.tsx" or manifest.get("name") != component.name:
        raise ValueError(f"{component.name}: script.json entry/name mismatch")
    files = sorted(
        (f for f in source.rglob("*") if f.is_file()),
        key=lambda f: f.relative_to(source).as_posix(),
    )
    if not files:
        raise ValueError(f"{component.name}: empty src")
    for f in files:
        rel = f.relative_to(source)
        if any(part.startswith(".") for part in rel.parts) or (
            f.name.lower() in FORBIDDEN_NAMES
            or f.suffix.lower() in FORBIDDEN_SUFFIXES
        ):
            raise ValueError(f"Potential private/hidden file in package: {rel}")

    DIST.mkdir(parents=True, exist_ok=True)
    output = DIST / f"{component.name}.zip"
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            zf.write(path, arcname=path.relative_to(source).as_posix())
    with ZipFile(output) as zf:
        names = set(zf.namelist())
        if not {"script.json", "index.tsx"} <= names:
            raise ValueError(f"{component.name}: invalid ZIP root")
        corrupt = zf.testzip()
        if corrupt:
            raise ValueError(f"{component.name}: damaged file {corrupt}")
    manual = component / f"{component.name}.scripting"
    manual.write_bytes(output.read_bytes())
    print(f"{component.name}: {len(files)} files; {output.stat().st_size} bytes; updated ZIP and .scripting")


def main() -> None:
    components = sorted(
        p for p in ROOT.iterdir()
        if p.is_dir() and (p / "src" / "script.json").is_file()
        and (p / "src" / "index.tsx").is_file()
    )
    if not components:
        raise SystemExit("No Scripting components with src/script.json and src/index.tsx")
    for component in components:
        package(component)


if __name__ == "__main__":
    main()
