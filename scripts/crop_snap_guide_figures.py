"""Render reviewed SNAP installation-guide figure selections from verified page PNGs."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re

from PIL import Image


def build_figures(directory):
    directory = directory.resolve()
    output = directory / 'guide-drawings'
    selection = json.loads((directory / 'source/guide-figures.json').read_bytes())
    renders = json.loads((output / 'renders.json').read_bytes())
    pages = {(r['url'], r['page']): r for r in renders}
    if len(pages) != len(renders):
        raise ValueError('Duplicate source page in guide renders.')
    image_keys = {s['image_key'] for s in selection['systems'].values()}
    if set(selection['figures']) != image_keys:
        raise ValueError('Guide figure selections and system assignments differ.')
    figures = {}
    for key, choice in sorted(selection['figures'].items()):
        if not re.fullmatch(r'[a-z0-9-]+', key):
            raise ValueError(f'Invalid figure name: {key}')
        guide = selection['guides'][choice['guide']]
        row = pages[(guide['url'], choice['page'])]
        path = (output / row['path']).resolve()
        if not path.is_relative_to(output) or path.suffix.lower() != '.png':
            raise ValueError(f'Invalid source page path for {key}')
        if row['pdf_sha256'] != guide['sha256'] or sha256(path.read_bytes()).hexdigest() != row['sha256']:
            raise ValueError(f'Source changed for {key}')
        figure = dict(row)
        if choice['crop'] is not None:
            left, top, right, bottom = choice['crop']
            if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
                raise ValueError(f'Invalid crop for {key}')
            with Image.open(path) as im:
                if im.format != 'PNG' or im.size != (row['width'], row['height']):
                    raise ValueError(f'Unexpected source dimensions for {key}')
                box = (round(left * im.width), round(top * im.height), round(right * im.width), round(bottom * im.height))
                crop = im.crop(box)
            dest = output / 'images' / f'{key}-{row["pdf_sha256"][:12]}-p{row["page"]}.png'
            crop.save(dest)
            figure.update(path=dest.relative_to(output).as_posix(), sha256=sha256(dest.read_bytes()).hexdigest(), width=crop.width, height=crop.height)
        figures[key] = figure
    (output / 'figures.json').write_text(json.dumps(figures, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    return figures


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='SNAP import audit directory')
    args = parser.parse_args()
    print(f'{len(build_figures(args.directory))} verified guide figures.')
