"""Convert the supplied logo to Windows icon sizes without changing its artwork."""
import argparse
import hashlib
from pathlib import Path
import shutil

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    target = ROOT / 'static' / 'ceasefire-app-icon.png'
    with Image.open(source) as original:
        if original.format != 'PNG':
            raise SystemExit('Provide the original PNG logo.')
        artwork = ImageOps.contain(original.convert('RGBA'), (256, 256), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        canvas.alpha_composite(artwork, ((256 - artwork.width) // 2, (256 - artwork.height) // 2))
        canvas.save(ROOT / 'static' / 'ceasefire-app.ico', sizes=[(size, size) for size in SIZES])
    if source != target.resolve():
        shutil.copyfile(source, target)
    print('Original PNG SHA256:', hashlib.sha256(target.read_bytes()).hexdigest())
    with Image.open(ROOT / 'static' / 'ceasefire-app.ico') as icon:
        assert icon.ico.sizes() == {(size, size) for size in SIZES}
    print('Created transparent Windows icon at sizes:', ', '.join(map(str, SIZES)))


if __name__ == '__main__':
    main()
