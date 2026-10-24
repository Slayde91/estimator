"""Extract the existing CLASSIFIRE mark without redrawing or changing its source."""

from hashlib import sha256
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SHA256 = 'a91d44ba45c0f96a589c577800d9e4cc292efaa1f8a9cdab7be18aaebc0d32da'
# Padded rectangle around the logo's left square mark; excludes the wordmark.
MARK_BOUNDS = (76, 172, 413, 518)
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def main():
    source = ROOT / 'static/classifire-logo.png'
    if sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError('The original CLASSIFIRE logo differs from the reviewed source.')
    with Image.open(source) as original:
        mark = original.crop(MARK_BOUNDS)
        mark.save(ROOT / 'static/classifire-app-icon.png')
        artwork = ImageOps.contain(mark, (256, 256), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        canvas.alpha_composite(artwork, ((256 - artwork.width) // 2, (256 - artwork.height) // 2))
        canvas.save(ROOT / 'static/classifire-app.ico', sizes=[(size, size) for size in SIZES])


if __name__ == '__main__':
    main()
