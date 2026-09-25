"""Reviewed application rules, separate from the immutable Excel source.

See docs/FYREWRAP_RULE_REVIEW.md and docs/CALCULATOR_EXCEPTIONS.md.
The FRL shown for an application is its highest requirement, not a claim that
both fire directions have that insulation rating.
"""

from openpyxl.formula.translate import Translator


def application_formula_overrides(model):
    cells = next(sheet for sheet in model['sheets'] if sheet['name'] == 'CALCULATOR')['cells']
    original = lambda address: cells[address]['formula']
    masters = {
        # Closed schedule choices also gate historic, unlisted inputs. Keep their
        # literal values visible; never turn an unsupported value into a result.
        'BB': 'AND(' + original('BB11') + ',OR(C11="CAFCO 300",C11="MONOKOTE",C11="FyreWrap"),'
              'OR(E11="60/60/60",E11="90/90/90",E11="120/120/120",E11="180/180/180",E11="240/240/180"))',
        'BG': 'OR(H11="Internal",H11="External",H11="Both",AND(BD11=3,OR(H11="Stair pressurisation",H11="Other pressurisation")))',
        'CF': 'IF(BD11=3,IF(CD11="Internal","Internal only",IF(OR(CD11="Both",CD11="External"),"Exhaust",IF(OR(H11="Stair pressurisation",H11="Other pressurisation"),"Pressurisation",""))),"")',
        'R': 'IF(AND(AS11,BD11=3,BL11),IF(OR(CD11="Internal",CD11="External",CD11="Both"),\'PRODUCT SETTINGS\'!$M$99,'
             'IF(H11="Stair pressurisation",\'PRODUCT SETTINGS\'!$M$103,IF(H11="Other pressurisation",\'PRODUCT SETTINGS\'!$M$104,'
             '""))),"")',
        # Do not guess away the conflict between the manual's upper wall band
        # and the current FCO3226 detailed table, or the external-layer footnote.
        'BM': 'AND(' + original('BM11') + ',OR(BD11<>3,F11=0,BI11<>5))',
    }
    wrap_area = original('N11')
    if wrap_area.count('SUM(V11:X11)') != 1:
        raise ValueError('Unexpected FyreWrap wrap-area formula.')
    # B111 is a fraction, and zero reproduces the assessed source quantity.
    # Apply it once to total wrap area; O (rolls) already divides N by B112.
    masters['N'] = wrap_area.replace(
        'SUM(V11:X11)', "SUM(V11:X11)*(1+N('PRODUCT SETTINGS'!$B$111))")
    assumptions_valid = original('BV11')
    updated_checks = (
        ("'PRODUCT SETTINGS'!$B$96=0.038",
         "AND(ISNUMBER('PRODUCT SETTINGS'!$B$96),'PRODUCT SETTINGS'!$B$96>0)"),
        ("'PRODUCT SETTINGS'!$B$99=0.1",
         "AND(ISNUMBER('PRODUCT SETTINGS'!$B$99),'PRODUCT SETTINGS'!$B$99>=0,"
         "'PRODUCT SETTINGS'!$B$99<MIN('PRODUCT SETTINGS'!$B$97,'PRODUCT SETTINGS'!$B$98))"),
        ("'PRODUCT SETTINGS'!$B$111=0",
         "AND(ISNUMBER('PRODUCT SETTINGS'!$B$111),'PRODUCT SETTINGS'!$B$111>=0)"),
    )
    for before, after in updated_checks:
        if assumptions_valid.count(before) != 1:
            raise ValueError('Unexpected FyreWrap assumptions guard.')
        assumptions_valid = assumptions_valid.replace(before, after)
    masters['BV'] = assumptions_valid
    wrap_note = (
        '"Estimate only. "&IF(NOT(BL11),"FyreWrap quantity is not established for these inputs. ",'
        '"Application FRL: "&AW11&". "&'
        'IF(CD11="Internal","Exhaust: internal 120/120/120; external not required. ",'
        'IF(CD11="Both","Exhaust: internal 120/120/120; external 120/120/-. ",'
        'IF(H11="Stair pressurisation","Stair pressurisation: external 120/120/60; internal not required. ",'
        'IF(H11="Other pressurisation","Other pressurisation: external 120/120/120; internal not required. ",'
        '"External exhaust: external 120/120/-; internal not selected. "))))&'
        'R11&" continuous layer(s). ")&'
        'IF(AND(F11>0,BI11=5),"Upper wall-size band differs between manual and assessment; confirm detail. ","")&'
        'IF(NOT(BM11),"Wrap total withheld: matching penetration detail required. Board and angles are separate allowances. ",'
        'IF(SUM(F11:G11)=0,"No penetration wrap included. ",'
        '"Local wall wrap is on both faces; local floor wrap is above the slab only. "))&'
        'IF(NOT(BO11),"Local wrap lengths capped to run; check locations and overlapping zones. ","")&'
        'IF(OR(\'PRODUCT SETTINGS\'!$B$96<>0.038,\'PRODUCT SETTINGS\'!$B$99<>0.1),'
        '"Changed blanket or overlap assumptions require a matching detail. ","")&'
        '"Required overlaps included; "&IF(N(\'PRODUCT SETTINGS\'!$B$111)>0,'
        '"added waste applied to wrap area and rolls.","no waste added.")'
    )
    masters['AP'] = 'IF(AND(AS11,BD11=3),' + wrap_note + ',' + original('AP11') + ')'
    masters['J'] = ('IF(AND(AS11,BD11=3,BL11,BV11,F11>0,BI11=5),'
                    '"Wrap withheld: wall table discrepancy",' + original('J11') + ')')
    masters['AQ'] = ('IF(AND(AS11,BD11=3),"FyreWrap manual v290426 pp.8-9,24-27,38-39; '
                     'FC17299-01-1; FCO3226 Rev F. Application FRL preserves directional requirements.",'
                     + original('AQ11') + ')')
    return {'CALCULATOR': {
        f'{column}{row}': Translator('=' + formula, origin=f'{column}11').translate_formula(f'{column}{row}').lstrip('=')
        for column, formula in masters.items()
        for row in range(model['schedule']['first_row'], model['schedule']['last_row'] + 1)
    }}
