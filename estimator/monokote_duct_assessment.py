"""FC15909-01-03 duct rules over the retained FC15909-01-2 workbook.

BRANZ, 24 February 2026, Tables 2--4 (pages 14--15), four-sided ducts.
The source gzip, saved inputs, field addresses and quantity/yield rules remain
unchanged. Apply this after the existing duct and repeated-quantity overrides.
"""

from copy import deepcopy

from openpyxl.formula.translate import Translator


REPORT = 'FC15909-01-03'
ISSUED = '24 February 2026'
REPORT_SHA256 = '474e3d3ca6abfe6b7d3017bccba6a4a8874b3a91751ffeb08b7f78baf712cd4c'
INTERNAL_MM = (37, 47, 54, 73, 73)
EXTERNAL_MM = (44, 54, 61, 71, 71)

THICKNESS_BASIS = (
    'FC15909-01-03 Tables 2-4 give the listed body thickness. '
    'Average coatings reported for the fire tests are not a general field '
    'acceptance tolerance; this report does not define such a tolerance. '
    'Verify the complete installation detail. Collar thickening, penetration '
    'infill and coating of supports are additional to this body-only estimate.'
)

SUPPORT_BASIS = (
    'Four-sided rectangular duct; longer/shorter side at most 4:1. '
    'Mesh nominally mid-depth; same cover over joints and supports. '
    'Horizontal hangers: M12 minimum, at most 1200 mm apart. '
    'Small as-entered ducts up to 1000 wide x 250 high: 0.6 mm minimum BMT '
    'and 50 x 50 x 5 mm support angles. Other covered sizes: 1 mm minimum '
    'BMT and the stiffeners/support details in sections 4.4.7-4.4.8; '
    'above 1500 mm, include the specified mid-width tie rods. '
    'Vertical: support each floor; add an intermediate support for a span '
    'over 5000 mm. Compartment/support span to smallest duct dimension '
    'must not exceed 8:1 without additional supports satisfying that limit. '
    'Support stress: 10 MPa up to 120 minutes; 6 MPa above. '
    'Concrete/masonry penetration details are assumed; frame lengths remain '
    'estimating allowances. Floor spacing, support design and the full '
    'assessment detail require review.'
)

# Browser presentation only. The engine and retained workbook still expose
# their original literal settings; only row formulas use the new assessment.
SETTINGS_DISPLAY_TEXT = {
    'C78': 73,
    'C79': 73,
    'B88': 'FC15909-01-03 (24 February 2026), Tables 2-4 pp.14-15; sections 3.2 and 4.4-4.6.',
    'E50': 'FC15909-01-03 Tables 2-4; both dimensions at most 2400 mm and aspect ratio at most 4:1.',
    'E53': 'Section 4.4.6: as-entered width at most 1000 mm and height at most 250 mm.',
    'E55': 'Sections 4.4.7-4.4.8: construction differs by size; larger ducts require tie rods.',
    'E56': 'Section 4.4.6.',
    'E57': 'Sections 4.4.7-4.4.8.',
    'E58': 'Sections 4.4.3 and 4.4.7: support stress at most 10 MPa up to 120 minutes; 6 MPa above.',
    'E59': 'Section 4.5.2: support each floor; intermediate support over 5000 mm. The 8:1 span rule also applies.',
    'E60': 'Retained standard concrete-floor estimating assumption; verify the project floor and full report detail.',
    'E61': 'Sections 4.6.2-4.6.3: maximum 50 mm for concrete/masonry; no approved minimum is inferred.',
    'E62': 'Section 4.4.7: larger-duct stiffener, not a complete support cutting list.',
    'B81': 'Concrete/masonry walls assumed. Small horizontal ducts use 50 x 50 x 5 mm support angles; larger-duct stiffeners are 25 x 25 x 3 mm. Frame lengths remain allowances.',
}


def _literal(value):
    return '"' + value.replace('"', '""') + '"'


def application_formula_overrides(model, overrides=None):
    """Return independent overrides; retain the caller's input/model objects.

    BB retains the five approved FRLs and explicit Quantity validation from
    existing application rules. BE/BF also retain any stricter saved setting:
    an editable source ceiling cannot extend this report's actual coverage.
    """
    result = deepcopy(overrides or {})
    if model['id'] != 'ductwork':
        return result
    schedule = model['schedule']
    if schedule['sheet'] != 'CALCULATOR' or schedule['first_row'] != 11:
        raise ValueError('Unexpected Monokote duct schedule layout.')
    cells = next(sheet['cells'] for sheet in model['sheets']
                 if sheet['name'] == 'CALCULATOR')
    target = result.setdefault('CALCULATOR', {})

    def original(column):
        return target.get(column + '11', cells[column + '11']['formula'])

    internal = 'CHOOSE(BN11,' + ','.join(map(str, INTERNAL_MM)) + ')'
    external = 'CHOOSE(BN11,' + ','.join(map(str, EXTERNAL_MM)) + ')'
    thickness = (f'IF(CD11="Both",MAX({internal},{external}),'
                 f'IF(CD11="Internal",{internal},'
                 f'IF(CD11="External",{external},"")))')
    masters = {
        'L': f'IF(BD11=2,IF(AND(AS11,BL11,BV11),{thickness},""),{original("L")})',
        'BE': ('IF(BD11=2,AND(' + original('BE') + ',AU11<=2400,AV11<=2400,'
               'MAX(AU11,AV11)<=4*MIN(AU11,AV11)),' + original('BE') + ')'),
        'BF': ('IF(BD11=2,AND(' + original('BF') + ',AX11<=240,AY11<=240,AZ11<=180),'
               + original('BF') + ')'),
        'J': ('IF(AND(AS11,BD11=2,BB11,AU11>0,AV11>0,'
              'MAX(AU11,AV11)>4*MIN(AU11,AV11)),"Outside report: duct aspect ratio exceeds 4:1",'
              + original('J') + ')'),
        'AM': ('IF(AND(AS11,BD11=2,BL11),' + _literal(SUPPORT_BASIS) + ','
               + original('AM') + ')'),
        'AP': ('IF(AND(AS11,BD11=2),(' + original('AP') + ')&" "&'
               + _literal(THICKNESS_BASIS) + ',' + original('AP') + ')'),
        'AQ': ('IF(AND(AS11,BD11=2),'
               + _literal('FC15909-01-03, 24 February 2026: Tables 2-4, pp.14-15; '
                          'sections 3.2 and 4.4-4.6. Four-sided body estimate.')
               + ',' + original('AQ') + ')'),
    }
    translators = {column: Translator('=' + formula, origin=column + '11')
                   for column, formula in masters.items()}
    for row in range(schedule['first_row'], schedule['last_row'] + 1):
        for column, translator in translators.items():
            target[f'{column}{row}'] = translator.translate_formula(f'{column}{row}').lstrip('=')

    return result
