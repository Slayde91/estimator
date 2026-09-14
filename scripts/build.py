"""Build a deterministic source distribution without workbooks or local data."""

from pathlib import Path
import py_compile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    paths = sorted(path for folder in ("estimator", "static", "data") for path in (ROOT / folder).rglob("*") if path.is_file() and "__pycache__" not in path.parts)
    paths.extend([ROOT / name for name in ("README.md", "requirements.txt", "Start-Estimator.cmd", "Start-Estimator.ps1")])
    for path in paths:
        if path.suffix == ".py":
            py_compile.compile(str(path), doraise=True)
    output = ROOT / "dist" / "ceasefire-estimator.zip"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in paths:
            info = zipfile.ZipInfo(path.relative_to(ROOT).as_posix(), date_time=(2026,9,6,0,0,0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    print(f"Built {output.name}: {len(paths)} files, {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
