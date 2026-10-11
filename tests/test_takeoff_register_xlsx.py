"""Public register copies match screen data without changing source authority."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import unittest

from openpyxl import load_workbook

from estimator.catalog import ValidationError
from estimator.takeoff_register_xlsx import (AREA, DUCT, LENGTH, STEEL, SURFACE,
    export_current_register, export_physical_register, register_workbook)
from tests import test_takeoff_workspace as workspace_fixtures
from tests import test_takeoff_physical_v2_exports as physical_fixtures
from tests.test_takeoff_physical import uid


def read(payload):
    workbook = load_workbook(BytesIO(payload))
    sheet = workbook.active
    return workbook, sheet, list(sheet.values)


def presentation_fixture(mode, target=None):
    area = mode == 'walls_floors'
    fields = {'mark': '=literal identifier', 'level': 'Level 1', 'member_type': 'Beam', 'section': '410UB54',
              'fire_period_min': 120, 'sides': 3, 'width_mm': 600, 'height_mm': 400, 'shape': 'rectangular',
              'frl': '-/120/120', 'orientation': 'Horizontal', 'surface_basis': 'wall-face',
              'substrate': 'Concrete wall', 'treatment': 'Spray', 'system': 'System A', 'product': 'CAFCO 300', 'layers': 2}
    item = {'id': 'one', 'mode': 'wall' if area else mode, 'fields': fields, 'quantity': 2,
            'geometry': {'document_id': 'drawing', 'page': 1}}
    snapshot = {'documents': [{'id': 'drawing', 'name': 'Drawing 001.pdf'}]}
    results = {'one': {'length_m': 7.123456789012345, 'total_length_m': 14.24691357802469,
                       'gross_area_m2': 32.54, 'excluded_area_m2': 2.21, 'net_area_m2': 30.33,
                       'total_area_m2': 60.66, 'issues': []}}
    linked = {'one': [] if area else [{'calculator_id': target, 'status': 'Current',
        'estimating_thickness_mm': 28.123456789, 'total_thickness_mm': 50, 'duct_thickness_mm': 38}]}
    return export_current_register(snapshot, [item], results, {'one': False}, linked,
        mode=mode, target=target, confirmation='all')


class RegisterCopyTests(unittest.TestCase):
    def test_each_register_has_exact_data_headers_and_one_sheet(self):
        cases = [('steel', 'steel_vermiculite', STEEL + LENGTH),
                 ('steel', 'steel_board', STEEL + ('Exposed sides',) + LENGTH),
                 ('duct', 'ductwork', DUCT + LENGTH), ('walls_floors', None, SURFACE + AREA)]
        for mode, target, expected in cases:
            with self.subTest(mode=mode, target=target):
                workbook, sheet, rows = read(presentation_fixture(mode, target)[0])
                try:
                    self.assertEqual(workbook.sheetnames, ['Current Takeoffs'])
                    self.assertEqual(tuple(rows[0]), expected)
                    self.assertEqual(len(rows), 2)
                    self.assertEqual(rows[1][1], '=literal identifier')
                    self.assertEqual(sheet.cell(2, 2).data_type, 's')
                    self.assertFalse(any(cell.data_type == 'f' for row in sheet for cell in row))
                    self.assertEqual(sheet['A1'].fill.fgColor.rgb, '00B90A15')
                    self.assertEqual(sheet['A1'].font.color.rgb, '00FFFFFF')
                    self.assertFalse(sheet.sheet_view.showGridLines)
                    self.assertEqual(sheet.freeze_panes, 'C2')
                    self.assertEqual(sheet.auto_filter.ref, sheet.dimensions)
                    self.assertEqual(sheet.print_title_rows, '$1:$1')
                    self.assertEqual(sheet.page_setup.orientation, 'landscape')
                    self.assertGreaterEqual(sheet.row_dimensions[1].height, 32)
                    if not mode == 'walls_floors':
                        index = rows[0].index('Length each (m)')
                        self.assertEqual(rows[1][index], 7.123456789012345)
                        self.assertEqual(sheet.cell(2, index+1).number_format, '#,##0.00')
                finally:
                    workbook.close()

    def test_real_service_receipts_filter_and_source_revision_gates(self):
        case = workspace_fixtures.TakeoffWorkspaceTests(); case.setUp(); self.addCleanup(case.doCleanups)
        confirmed = case.create(); case.command('update_item', item_id=confirmed, changes={'fields': {'mark': 'B-confirmed'}}); case.confirm(confirmed)
        draft = case.create(quantity=None, measurement=None, fields={'mark': 'B-draft'})
        original = deepcopy(case.state['snapshot'])
        def export(**changes):
            return case.service.export_workspace(case.sid, 'register-xlsx', {
                'expected_revision': original['revision'], 'mode': 'steel', 'target': 'steel_vermiculite', **changes})
        for category, marks in [('all', ['B-confirmed', 'B-draft']), ('confirmed', ['B-confirmed']), ('unconfirmed', ['B-draft'])]:
            workbook, sheet, rows = read(export(confirmation=category)[0])
            try:
                self.assertEqual([row[1] for row in rows[1:]], marks)
                if category == 'unconfirmed':
                    self.assertIsNone(rows[1][rows[0].index('Qty')])
                    self.assertIsNone(rows[1][rows[0].index('Thickness (mm)')])
            finally: workbook.close()
        for target in ('arbitrary', True, [], {}):
            with self.subTest(target=target), self.assertRaises(ValidationError): export(target=target)
        with self.assertRaises(ValidationError): export(expected_revision=original['revision']-1)
        with self.assertRaises(ValidationError): export(item_ids=[draft])
        case.documents.blocked = True
        with self.assertRaises(ValidationError): export()
        self.assertEqual(case.state['snapshot'], original)

    def test_physical_hierarchy_columns_order_ancestry_and_inherited_review(self):
        case = physical_fixtures.PhysicalV2ExportTests(); case.setUp()
        case.graph['defects'][0]['confirmation'] = 'confirmed'
        original = deepcopy(case.graph)
        workbook, sheet, rows = read(export_physical_register(case.graph, confirmation='confirmed')[0])
        try:
            self.assertEqual(workbook.sheetnames, ['Defect Reports'])
            self.assertEqual(rows[0], ('Defect ID', 'Barrier ID', 'Service ID', 'Confirmation', 'Location', 'FRL',
                'Substrate', 'Orientation', 'Category', 'Service type', 'Service quantity', 'Service Size (mm)', 'Source evidence'))
            self.assertEqual([row[:3] for row in rows[1:]], [('D-0001', None, None), ('D-0001', 'B-0001', None),
                ('D-0001', 'B-0001', 'S-0001'), ('D-0001', 'B-0002', None)])
            self.assertTrue(all(row[3] == 'Confirmed' for row in rows[1:]))
            self.assertEqual(rows[3][10], 2)
            self.assertTrue(all(row[5] == '120/120/120' for row in rows[1:]))
        finally: workbook.close()
        self.assertEqual(original, case.graph)
        case.change({'op': 'delete', 'entity_id': uid(3), 'cascade': False})
        workbook, _, rows = read(export_physical_register(case.graph)[0])
        try: self.assertFalse(any(row[2] == 'S-0001' for row in rows[1:]))
        finally: workbook.close()

    def test_empty_filter_stays_a_formatted_header_only_register(self):
        case = physical_fixtures.PhysicalV2ExportTests(); case.setUp()
        workbook, sheet, rows = read(export_physical_register(case.graph, confirmation='confirmed')[0])
        try:
            self.assertEqual(len(rows), 1)
            self.assertEqual(sheet.auto_filter.ref, 'A1:M1')
        finally: workbook.close()

    def test_single_sheet_count_table_long_wrapping_and_cell_limit(self):
        payload = register_workbook([(STEEL + LENGTH, []), (('Item', 'Notes'), [['C1', 'A long recorded note. ' * 30]])])
        workbook, sheet, rows = read(payload)
        try:
            self.assertEqual(len(workbook.sheetnames), 1)
            self.assertEqual(rows[2][:2], ('Item', 'Notes'))
            self.assertGreater(sheet.row_dimensions[4].height, 26)
        finally: workbook.close()
        with self.assertRaisesRegex(ValidationError, 'cell limit'):
            register_workbook([(('Item',), [['a' * 32768]])])

    def test_public_browser_routes_use_register_projection(self):
        source = (Path(__file__).parents[1] / 'static' / 'takeoffs.js').read_text(encoding='utf-8')
        self.assertIn('physical/export/${format === "xlsx" ? "register-xlsx" : format}', source)
        self.assertIn('export/${pdf ? format : "register-xlsx"}', source)
        self.assertIn('target: isArea(mode) ? null : state.ui.target.value', source)


if __name__ == '__main__':
    unittest.main()
