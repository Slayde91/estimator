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
from reportlab.lib.rl_accel import fp_str
from estimator.takeoff_markup_pdf_worker import page_transform, transform


def near(a, b):
    return len(a) == len(b) and all(abs(float(x)-float(y)) < .0001 for x, y in zip(a, b))


def serialized_geometry(actual, expected):
    # ReportLab emits PDF coordinates with fp_str's magnitude-dependent precision.
    # Compare those exact tokens, retaining strict geometry checks even when a
    # CropBox/UserUnit transform places a valid translation above 1,000 points.
    emitted = [float(token) for token in fp_str(*expected).split()]
    return len(actual) == len(emitted) and [float(value) for value in actual] == emitted


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
        style = {**graphic['appearance'], 'font_size': graphic['appearance']['font_size'] * graphic['geometry'].get('text_scale', 1)}
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
                if len(actual) == len(expected) and all(serialized_geometry(a, b) for a, b in zip(actual, expected)):
                    assert near(next(args for args, op in ink if op == b'w'), [style['stroke_width']]), 'Stroke is measured in physical PDF points'
                    if graphic['kind'] == 'arrow':
                        assert sum(op == b'S' for _, op in ink) >= 2, 'Arrow stem and open head are separate strokes'
                    matched = True
                    break
            else:
                q0, q1, _, q3 = [transform(point, matrix) for point in graphic['geometry']['quad_pdf']]
                w, h = math.dist(q0, q1), math.dist(q0, q3)
                expected = [(q1[0]-q0[0])/w, (q1[1]-q0[1])/w, (q0[0]-q3[0])/h, (q0[1]-q3[1])/h, *q3]
                if any(op == b'cm' and serialized_geometry(args, expected) for args, op in ink):
                    assert near(next(args for args, op in ink if op == b'w'), [style['stroke_width']]), 'Stroke is measured in physical PDF points'
                    if graphic['kind'] in ('cloud', 'circle'):
                        assert any(op == b'c' for _, op in ink), 'Cloud and Circle contain real vector curves'
                    matched = True
                    break
        assert matched, f"Actual PDF geometry does not match source coordinates for {graphic['kind']}"
        if graphic['kind'] in ('textbox', 'stamp'):
            content = page.extract_text()
            if 'text_content' in graphic:
                compact = ''.join(content.split())
                segments = []
                page.extract_text(visitor_text=lambda value, cm, tm, font, size: segments.append((value, font, size)))
                # ReportLab serializes fractional physical font sizes through
                # fp_str. Check that exact emitted size instead of rejecting
                # valid scaled fonts for the PDF token's decimal rounding.
                emitted_size = float(fp_str(style['font_size']))
                bold = ''.join(value for value, font, size in segments if font and 'Bold' in font.get('/BaseFont', '') and float(size) == emitted_size)
                numbered = 0
                italic_count = underline_count = 0
                for block in graphic['text_content']['blocks']:
                    numbered = numbered+1 if block['kind'] == 'number' else 0
                    prefix = '• ' if block['kind'] == 'bullet' else f'{numbered}. ' if numbered else ''
                    literal = prefix+''.join(run['text'] for run in block['runs'])
                    assert ''.join(literal.split()) in compact, 'Rich textbox literal block/list marker absent from actual PDF'
                    for run in block['runs']:
                        if run.get('bold'):
                            assert ''.join(run['text'].split()) in ''.join(bold.split()), 'Saved bold textbox run absent from actual PDF font'
                        count = len(run['text'].replace('\r\n', '\n').replace('\r', '\n').replace('\t', '    ').replace('\n', ''))
                        italic_count += count if run.get('italic') else 0
                        underline_count += count if run.get('underline') else 0
                # ReportLab combines the glyph translation and shear in one cm.
                assert sum(op == b'cm' and near(args[:4], [1, 0, .18, 1]) for args, op in operations) >= italic_count, 'Saved italic textbox glyph transforms absent'
                assert sum(op == b'l' for _, op in operations) >= underline_count, 'Saved underline textbox strokes absent'
            else:
                assert graphic['text'].replace('\n', '') in content.replace('\n', ''), 'Literal drawing note absent from actual PDF'
        proof.append({'id': graphic['id'], 'kind': graphic['kind'], 'page': graphic['page'], 'vector_geometry': True,
                      **({'rich_text': True, 'font_size': style['font_size'], 'italic_glyphs': italic_count,
                          'underline_glyphs': underline_count, 'literal_blocks_and_lists': True}
                         if 'text_content' in graphic else {})})
    return {'pages': len(reader.pages), 'matches': proof, 'sha256': hashlib.sha256(Path(pdf_path).read_bytes()).hexdigest()}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1], json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')))))
