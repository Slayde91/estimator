"""Read the penetration workbook without opening Excel or rewriting its source.

The package retains formulas, cached values, constants, names and validation
metadata. Calculation consumes formulas; caches are independent audit evidence.
"""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import posixpath
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile


NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'


def extract(source):
    source = Path(source)
    payload = source.read_bytes()
    model = {'version': 1, 'source': {'filename': source.name,
             'sha256': hashlib.sha256(payload).hexdigest()}, 'sheets': [],
             'defined_names': {}, 'tables': {}, 'list_filters': [], 'list_lookups': []}
    with ZipFile(source) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            for item in ET.fromstring(archive.read('xl/sharedStrings.xml')):
                strings.append(''.join(node.text or '' for node in item.iter() if node.tag.endswith('}t')))
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        relationships = {r.get('Id'): r.get('Target') for r in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        model['names_metadata'] = [dict(node.attrib, formula=node.text) for node in workbook.findall('m:definedNames/m:definedName', NS)]
        model['defined_names'] = {n['name']: n['formula'] for n in model['names_metadata'] if 'localSheetId' not in n}
        calc = workbook.find('m:calcPr', NS)
        model['calculation_properties'] = {} if calc is None else calc.attrib
        model['external_links'] = [name for name in archive.namelist() if name.startswith('xl/externalLinks/') and name.endswith('.xml')]
        model['has_vba'] = any('vbaProject' in name for name in archive.namelist())
        model['part_sha256'] = {name: hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()}
        for item in workbook.findall('m:sheets/m:sheet', NS):
            target = relationships[item.get(REL)]
            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
            xml = ET.fromstring(archive.read(target))
            sheet = {'name': item.get('name'), 'state': item.get('state', 'visible'), 'cells': {},
                     'validations': [], 'merges': [n.get('ref') for n in xml.findall('m:mergeCells/m:mergeCell', NS)]}
            rel_path = posixpath.join(posixpath.dirname(target), '_rels', posixpath.basename(target) + '.rels')
            if rel_path in archive.namelist():
                sheet_rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(archive.read(rel_path))}
                for part in xml.findall('m:tableParts/m:tablePart', NS):
                    table_target = sheet_rels[part.get(REL)]
                    table_path = table_target.lstrip('/') if table_target.startswith('/') else posixpath.normpath(posixpath.join(posixpath.dirname(target), table_target))
                    table = ET.fromstring(archive.read(table_path))
                    model['tables'][table.get('name')] = {'sheet': sheet['name'], 'ref': table.get('ref'),
                        'header_row_count': int(table.get('headerRowCount', '1')),
                        'totals_row_count': int(table.get('totalsRowCount', '0')),
                        'columns': [dict(n.attrib) for n in table.findall('m:tableColumns/m:tableColumn', NS)],
                        'attributes': dict(table.attrib)}
            for node in xml.findall('m:sheetData/m:row/m:c', NS):
                address, typ = node.get('r'), node.get('t', 'n')
                value = node.find('m:v', NS)
                text = None if value is None else value.text
                if typ == 's':
                    val = strings[int(text)] if text is not None else None
                elif typ == 'inlineStr':
                    val = ''.join(n.text or '' for n in node.findall('.//m:t', NS))
                elif typ == 'b':
                    val = text == '1'
                elif typ in ('str', 'e'):
                    val = '' if typ == 'str' and value is not None and text is None else text
                else:
                    val = float(text) if text is not None else None
                    if val is not None and val.is_integer():
                        val = int(val)
                formula = node.find('m:f', NS)
                if formula is None and val is None:
                    continue
                cell = {'data_type': typ, 'style': int(node.get('s', '0'))}
                if formula is not None:
                    if not formula.text:
                        raise ValueError(f'Unexpanded formula {sheet["name"]}!{address}')
                    cell.update(formula='=' + formula.text, cached_value=val, formula_attributes=formula.attrib)
                else:
                    cell['value'] = val
                sheet['cells'][address] = cell
            for node in xml.iter():
                if node.tag.endswith('}dataValidation'):
                    formulas = [n.text for n in node.iter() if n.tag.endswith('}f') or n.tag.endswith('}formula1') and n.text]
                    refs = node.get('sqref') or next((n.text for n in node.iter() if n.tag.endswith('}sqref')), '')
                    sheet['validations'].append({'range': refs, 'formulas': formulas, 'attributes': dict(node.attrib)})
            model['sheets'].append(sheet)
        for cell in model['sheets'][0]['cells'].values():
            formula = cell.get('formula', '')
            if 'FILTER' in formula:
                address = next(a for a, c in model['sheets'][0]['cells'].items() if c is cell)
                keywords = re.search(r'_xlpm.keywords,\s*\{([^}]+)', formula)[1]
                model['list_filters'].append({'column': re.sub(r'\d', '', address), 'keywords': re.findall(r'"([^"]+)"', keywords), 'formula': formula})
            elif '_xlpm.returnRange' in formula:
                address = next(a for a, c in model['sheets'][0]['cells'].items() if c is cell)
                model['list_lookups'].append({'column': re.sub(r'\d', '', address),
                    'lookup_column': re.search(r'_xlpm.lookupVals,\s*([A-Z]+)1', formula)[1],
                    'return_column': re.search(r'_xlpm.returnRange,\s*\[1\]INVENTORY!([A-Z]+)', formula)[1], 'formula': formula})
    model['counts'] = {'formulas': sum('formula' in c for s in model['sheets'] for c in s['cells'].values()),
                       'cells': sum(len(s['cells']) for s in model['sheets'])}
    if hashlib.sha256(source.read_bytes()).hexdigest() != model['source']['sha256']:
        raise ValueError('Source changed during import')
    return model


def write_model(model, destination):
    payload = json.dumps(model, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    Path(destination).write_bytes(gzip.compress(payload, mtime=0))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'data' / 'penetration.json.gz')
    args = parser.parse_args()
    result = extract(args.source)
    write_model(result, args.output)
    print(json.dumps({'sha256': result['source']['sha256'], **result['counts']}))
