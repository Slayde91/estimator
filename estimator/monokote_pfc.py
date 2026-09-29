"""Narrow application repair for retained Monokote named channel lookups.

The imported workbook is immutable. Its PFC web-to-slab rows have published
named thicknesses but no generic factor table. Excel AND eagerly evaluates
NOT(empty-text AO) in CE/CF even when BM confirms a named result. Guard just
that irrelevant check; retain source flags, limits and quantity formulas.
"""


def application_formula_overrides(model):
    cells = next(sheet for sheet in model['sheets'] if sheet['name'] == 'ENGINE')['cells']
    overrides = {}
    # Row 2 is the lookup; schedule row 10 maps to ENGINE row 3.
    last_row = model['schedule']['last_row'] - 7
    for row in range(2, last_row + 1):
        for column in ('CE', 'CF'):
            address = f'{column}{row}'
            original = cells[address]['formula']
            token = f'NOT(AO{row})'
            if original.count(token) != 1 or f'NOT(BM{row})' not in original:
                raise ValueError(f'Unexpected Monokote named-lookup guard at {address}.')
            # The canonical technical product also represents Z106. The
            # original expression still governs every other exposure/lookup.
            # Replace only this token, without duplicating the full formula.
            guarded = (
                f'IF(AND(A{row}="MONOKOTE MK-6 HY",B{row}="PFC3W",BM{row}),'
                f'FALSE,{token})'
            )
            overrides[address] = original.replace(token, guarded)
    return {'ENGINE': overrides}
