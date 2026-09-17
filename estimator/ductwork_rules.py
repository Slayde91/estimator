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
        'CF': 'IF(BD11=3,IF(CD11="Internal","Internal only",IF(CD11="Both","Exhaust",IF(CD11="External","Unclassified exposure",IF(OR(H11="Stair pressurisation",H11="Other pressurisation"),"Pressurisation","")))),"")',
        'R': 'IF(AND(AS11,BD11=3,BL11),IF(OR(CD11="Internal",CD11="Both"),\'PRODUCT SETTINGS\'!$M$99,'
             'IF(H11="Stair pressurisation",\'PRODUCT SETTINGS\'!$M$103,IF(H11="Other pressurisation",\'PRODUCT SETTINGS\'!$M$104,'
             'IF(CD11="External",IF(AZ11<=60,\'PRODUCT SETTINGS\'!$M$103,\'PRODUCT SETTINGS\'!$M$104),"")))),"")',
        # Do not guess away the conflict between the manual's upper wall band
        # and the current FCO3226 detailed table, or the external-layer footnote.
        'BM': 'AND(' + original('BM11') + ',OR(BD11<>3,F11=0,BI11<>5))',
    }
    wrap_note = (
        '"Estimate only. "&IF(NOT(BL11),"FyreWrap quantity is not established for these inputs. ",'
        '"Application FRL: "&AW11&". "&'
        'IF(CD11="Internal","Exhaust: internal 120/120/120; external not required. ",'
        'IF(CD11="Both","Exhaust: internal 120/120/120; external 120/120/-. ",'
        'IF(H11="Stair pressurisation","Stair pressurisation: external 120/120/60; internal not required. ",'
        'IF(H11="Other pressurisation","Other pressurisation: external 120/120/120; internal not required. ",'
        '"External fire: full selected FRL; confirm application. "))))&'
        'R11&" continuous layer(s). ")&'
        'IF(AND(F11>0,BI11=5),"Upper wall-size band differs between manual and assessment; confirm detail. ","")&'
        'IF(NOT(BM11),"Wrap total withheld: matching penetration detail required. Board and angles are separate allowances. ",'
        'IF(SUM(F11:G11)=0,"No penetration wrap included. ",'
        '"Local wall wrap is on both faces; local floor wrap is above the slab only. "))&'
        'IF(NOT(BO11),"Local wrap lengths capped to run; check locations and overlapping zones. ","")&'
        '"Required overlaps included; no waste added."'
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
