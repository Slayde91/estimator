"""Inspect actual disposable browser PDF downloads against retained markup geometry."""
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pypdf import PdfReader
from pypdf.generic import ContentStream
from estimator.takeoff_markup_pdf_worker import page_transform, transform


def near(a, b):
    return len(a) == len(b) and all(abs(float(x)-float(y)) < .0001 for x, y in zip(a, b))


def inspect(pdf_path, specification):
    reader = PdfReader(pdf_path)
    proof = []
    for graphic in specification['records']:
        page = reader.pages[graphic['page']-1]
        metadata = dict(next(value for value in specification['document']['pages'] if value['page'] == graphic['page']))
        if specification['physical']:
            metadata['rotation'] = (metadata['rotation'] + specification['rotations'].get(str(graphic['page']), 0)) % 360
        _, width, height = page_transform(metadata)
        bottom = 0 if specification['physical'] else float(page.mediabox.height)-height
        matrix, _, _ = page_transform(metadata, bottom, (float(page.mediabox.width)-width)/2)
        operations = ContentStream(page.get_contents(), reader).operations
        style = graphic['appearance']
        rgb = [int(style['stroke_color'][i:i+2], 16)/255 for i in (1, 3, 5)]
        starts = [index for index, (args, op) in enumerate(operations) if op == b'RG' and near(args, rgb)]
        assert starts, 'Markup stroke colour absent from actual PDF'
        matched = False
        for start in starts:
            end = next((i for i in range(start+1, len(operations)) if operations[i][1] == b'RG'), len(operations))
            ink = operations[start:end]
            if 'points' in graphic['geometry']:
                expected = [transform(point, matrix) for point in graphic['geometry']['points']]
                actual = [args for args, op in ink if op in (b'm', b'l')][:len(expected)]
                if len(actual) == len(expected) and all(near(a, b) for a, b in zip(actual, expected)):
                    assert near(next(args for args, op in ink if op == b'w'), [style['stroke_width']]), 'Stroke is measured in physical PDF points'
                    if graphic['kind'] == 'arrow':
                        assert sum(op == b'S' for _, op in ink) >= 2, 'Arrow stem and open head are separate strokes'
                    matched = True
                    break
            else:
                q0, q1, _, q3 = [transform(point, matrix) for point in graphic['geometry']['quad_pdf']]
                w, h = math.dist(q0, q1), math.dist(q0, q3)
                expected = [(q1[0]-q0[0])/w, (q1[1]-q0[1])/w, (q0[0]-q3[0])/h, (q0[1]-q3[1])/h, *q3]
                if any(op == b'cm' and near(args, expected) for args, op in ink):
                    assert near(next(args for args, op in ink if op == b'w'), [style['stroke_width']]), 'Stroke is measured in physical PDF points'
                    if graphic['kind'] in ('cloud', 'circle'):
                        assert any(op == b'c' for _, op in ink), 'Cloud and Circle contain real vector curves'
                    matched = True
                    break
        assert matched, f"Actual PDF geometry does not match source coordinates for {graphic['kind']}"
        if graphic['kind'] in ('textbox', 'stamp'):
            content = page.extract_text()
            assert graphic['text'].replace('\n', '') in content.replace('\n', ''), 'Literal drawing note absent from actual PDF'
        proof.append({'id': graphic['id'], 'kind': graphic['kind'], 'page': graphic['page'], 'vector_geometry': True})
    return {'pages': len(reader.pages), 'matches': proof, 'sha256': hashlib.sha256(Path(pdf_path).read_bytes()).hexdigest()}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1], json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')))))
