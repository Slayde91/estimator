"""Render a local Trafalgar diagram pack without changing its originals.

This optional import tool uses PyMuPDF and Pillow. Supplier PDFs, images and
extracted text stay in the selected local output directory, outside Git.
"""

import argparse
import hashlib
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


def sha256(payload):
    return hashlib.sha256(payload).hexdigest()


def read_manifest(path):
    payload = Path(path).read_bytes()
    data = json.loads(payload.decode("utf-8-sig"))
    rows = data.get("documents")
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError("Invalid diagram manifest")
    return data, sha256(payload)


def safe_archive_files(archive):
    files = {}
    for item in archive.infolist():
        if item.is_dir():
            continue
        path = PurePosixPath(item.filename.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts or ":" in item.filename:
            raise ValueError("Unsafe archive path")
        if path.suffix.lower() not in {".pdf", ".jpg", ".jpeg", ".png"}:
            raise ValueError("Unsupported archive asset")
        if not 0 < item.file_size <= 128 * 1024 * 1024:
            raise ValueError("Invalid source size")
        key = path.stem.lower()
        if key in files:
            raise ValueError("Duplicate document identifier in archive")
        files[key] = item
    return files


def write_verified(path, payload):
    if path.exists():
        if path.read_bytes() != payload:
            raise ValueError(f"Existing prepared asset differs: {path.name}")
    else:
        path.write_bytes(payload)


def prepare(source_zip, manifest_path, output, *, long_edge=2600):
    import pymupdf
    from PIL import Image, ImageOps

    if not 1600 <= long_edge <= 5000:
        raise ValueError("Choose a long edge between 1600 and 5000 pixels")
    source_zip, manifest_path, output = Path(source_zip), Path(manifest_path), Path(output)
    manifest, manifest_sha256 = read_manifest(manifest_path)
    output.mkdir(parents=True, exist_ok=True)
    for folder in ("documents", "images"):
        (output / folder).mkdir(exist_ok=True)
    result = {"schema_version": 1, "archive_sha256": sha256(source_zip.read_bytes()),
              "manifest_sha256": manifest_sha256,
              "source_capture_sha256": manifest["metadata"]["source_capture_sha256"],
              "render_long_edge": long_edge, "documents": []}
    with ZipFile(source_zip) as archive:
        files = safe_archive_files(archive)
        known = {str(row["document_id"]).lower() for row in manifest["documents"]}
        if set(files) - known:
            raise ValueError("Archive contains documents absent from manifest")
        for position, row in enumerate(manifest["documents"], 1):
            doc_id = row["document_id"]
            item = files.get(doc_id.lower())
            record = {"document_id": doc_id, "source_url": row["source_url"],
                      "pages": [], "fields": [], "status": "missing"}
            if item is None:
                record["download_status"] = row.get("download_status", "NOT_SAVED")
                result["documents"].append(record)
                continue
            payload = archive.read(item)
            digest = sha256(payload)
            if row.get("file_sha256") and digest != row["file_sha256"]:
                raise ValueError(f"Source fingerprint mismatch: {doc_id}")
            if row.get("content_bytes") and len(payload) != row["content_bytes"]:
                raise ValueError(f"Source size mismatch: {doc_id}")
            record.update(status="prepared", source_filename=PurePosixPath(item.filename).name,
                          sha256=digest, source_bytes=len(payload))
            stem = "trafalgar-image-" + digest[:24]
            if payload.startswith(b"%PDF-"):
                pdf_filename = "documents/trafalgar-doc-" + digest[:24] + ".pdf"
                write_verified(output / pdf_filename, payload)
                record["pdf_filename"] = pdf_filename
                with pymupdf.open(stream=payload, filetype="pdf") as pdf:
                    if pdf.needs_pass or not 1 <= len(pdf) <= 10000:
                        raise ValueError(f"Unreadable source PDF: {doc_id}")
                    for page_number, page in enumerate(pdf, 1):
                        pymupdf.TOOLS.mupdf_warnings(reset=True)
                        scale = long_edge / max(page.rect.width, page.rect.height)
                        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False,
                                             colorspace=pymupdf.csRGB)
                        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                        text = page.get_text("text", sort=True).strip()
                        filename = f"images/{stem}-p{page_number:04}.jpg"
                        stream = BytesIO()
                        image.save(stream, format="JPEG", quality=90, optimize=True, subsampling=0)
                        rendered = stream.getvalue()
                        warnings = pymupdf.TOOLS.mupdf_warnings(reset=True)
                        write_verified(output / filename, rendered)
                        record["pages"].append({"page": page_number, "image_filename": filename,
                                                "image_sha256": sha256(rendered), "text": text,
                                                "width": image.width, "height": image.height,
                                                "render_warnings": warnings,
                                                "text_status": "embedded" if text else "requires_visual_transcription"})
            else:
                with Image.open(BytesIO(payload)) as original:
                    image = ImageOps.exif_transpose(original).convert("RGB")
                    image.thumbnail((long_edge, long_edge), Image.Resampling.LANCZOS)
                    filename = f"images/{stem}-p0001.jpg"
                    stream = BytesIO()
                    image.save(stream, format="JPEG", quality=90, optimize=True, subsampling=0)
                    rendered = stream.getvalue()
                    write_verified(output / filename, rendered)
                    record["pages"].append({"page": 1, "image_filename": filename,
                                            "image_sha256": sha256(rendered), "text": "",
                                            "width": image.width, "height": image.height,
                                            "text_status": "requires_visual_transcription"})
            result["documents"].append(record)
            if position % 25 == 0:
                print(f"Prepared {position}/{len(manifest['documents'])} manifest documents", flush=True)
    result["counts"] = {"manifest_documents": len(result["documents"]),
                        "prepared_documents": sum(row["status"] == "prepared" for row in result["documents"]),
                        "missing_documents": sum(row["status"] == "missing" for row in result["documents"]),
                        "pdfs": sum("pdf_filename" in row for row in result["documents"]),
                        "rendered_pages": sum(len(row["pages"]) for row in result["documents"]),
                        "pages_needing_transcription": sum(not page["text"] for row in result["documents"] for page in row["pages"])}
    (output / "documents-index.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result["counts"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--long-edge", type=int, default=2600)
    args = parser.parse_args()
    print(json.dumps(prepare(args.archive, args.manifest, args.output, long_edge=args.long_edge)))


if __name__ == "__main__":
    main()
