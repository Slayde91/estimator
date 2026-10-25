"""Build a deterministic source distribution without workbooks or local data."""

from pathlib import Path
import py_compile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    paths = sorted(path for folder in ("estimator", "static", "data") for path in (ROOT / folder).rglob("*")
                   if path.is_file() and not {'__pycache__', '.ceasefire-evidence'} & set(path.parts))
    paths.extend([ROOT / name for name in ("README.md", "requirements.txt", "Start-Estimator.cmd", "Start-Estimator.ps1")])
    paths.append(ROOT / 'scripts' / 'install_reference_library.py')
    paths.append(ROOT / 'scripts' / 'install_library_replicas.py')
    paths.append(ROOT / 'scripts' / 'import_boss_matrix.py')
    paths.append(ROOT / 'docs' / 'BOSS_MATRIX_IMPORT.md')
    paths.append(ROOT / 'docs' / 'LIBRARY_REPLICAS.md')
    paths.append(ROOT / 'docs' / 'TAKEOFFS.md')
    paths.append(ROOT / 'docs' / 'LANGUAGES.md')
    paths.append(ROOT / 'docs' / 'PERLIFOC_ASSESSMENT.md')
    paths.append(ROOT / 'docs' / 'NULLIFIRE_SC902.md')
    paths.append(ROOT / 'docs' / 'FIRETEX_ASSESSMENTS.md')
    paths.append(ROOT / 'docs' / 'CALCULATOR_REPORT_UPDATES.md')
    paths.append(ROOT / 'docs' / 'MONOKOTE_DUCT_ASSESSMENT.md')
    paths.append(ROOT / 'docs' / 'FIREFLY_REFERENCE_REVIEW.md')
    paths.append(ROOT / 'docs' / 'TAKEOFFS_VISUAL_SEARCH.md')
    paths.append(ROOT / 'docs' / 'LOCAL_OCR_TEXT_LAYERS.md')
    paths.append(ROOT / 'scripts' / 'import_promat_spray_assessments.py')
    paths.append(ROOT / 'requirements-import.txt')
    paths.append(ROOT / 'scripts' / 'build_language_catalog.py')
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
