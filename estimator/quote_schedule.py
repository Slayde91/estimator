"""Compact portrait schedule tables embedded in a commercial quotation.

Canonical cells and their links remain unchanged. The table has every column
on the same page width, with normal vertical pagination for additional rows.
"""
from reportlab.lib import colors
from reportlab.platypus import HRFlowable, Image, LongTable, Paragraph, TableStyle


SCOPE_SCHEDULE_TITLES = {
    'steel_vermiculite': 'STEEL | SPRAY',
    'steel_board': 'STEEL | BOARD',
    'ductwork': 'DUCT | SPRAY / WRAP',
    'steel_intumescent': 'STEEL | INTUMESCENT PAINT',
    'penetration': 'FIRESTOPPING SCHEDULE',
}


def append_scope_schedule_heading(report, calculator_id):
    """Give a schedule the same text size as its containing estimate name."""
    style = report.styles['subheading'].clone(
        'CommercialScheduleHeading', spaceBefore=6, spaceAfter=8, keepWithNext=True)
    report.story.append(Paragraph(SCOPE_SCHEDULE_TITLES[calculator_id], style))


def append_project_report_title(report, title):
    """Brand the full schedule title without changing other report headings."""
    if title.upper() == 'FIRE PROTECTION SCHEDULE':
        report.styles['project_schedule_title'] = report.styles['title'].clone(
            'ProjectScheduleTitle', textColor=colors.HexColor('#bd0018'))
        report.story.append(report.p(title.upper(), 'project_schedule_title'))
    else:
        report.story.append(report.p(title, 'title'))


def append_scope_intro(report, intro):
    """Keep the quotation's scope heading in the schedule's own text flow."""
    if intro.get('heading'):
        style = report.styles['section'].clone('CommercialScopeHeading', fontSize=11, leading=15,
                                               textColor=colors.HexColor('#bd0018'), keepWithNext=True)
        report.story.append(Paragraph('SCOPE OF WORKS', style))
        rule = HRFlowable(width='100%', thickness=1, color=colors.HexColor('#bd0018'), spaceAfter=8)
        rule.keepWithNext = True
        report.story.append(rule)
    if intro.get('preamble'):
        # Reuse the commercial renderer's safe, validated rich-text conversion
        # so legacy exclusions retain their emphasis and list structure.
        from .commercial_documents import validate_rich_text
        from .commercial_pdf import _rich
        report.story.extend(_rich(validate_rich_text(intro['preamble'], 'Scope'), report.styles['body']))
    name = report.p(intro['name'], 'subheading')
    name.keepWithNext = True
    report.story.append(name)


def configure_quote_schedule(report):
    # A fixed 6.8 pt floor avoids making crowded registers progressively tiny.
    # Narrow text wraps instead, including exceptional numeric identifiers.
    for name in ('cell', 'numeric', 'head'):
        report.styles[name] = report.styles[name].clone(
            'CommercialSchedule' + name.title(), fontSize=6.8, leading=8.8,
            spaceBefore=0, spaceAfter=0, splitLongWords=True)


def fitted_column_widths(header, rows, widths, padding=2, *, fixed_columns=()):
    """Fit short headings and ordinary values before splitting long tokens."""
    # Reserve whole heading words first, using the actual embedded font.
    inset = 2 * padding + .1
    minimums = [widths[index] if index in fixed_columns else cell.minWidth() + inset
                for index, cell in enumerate(header)]
    body_widths = minimums.copy()
    for row in rows:
        for index, cell in enumerate(row):
            if isinstance(cell, Paragraph) and index not in fixed_columns:
                body_widths[index] = max(body_widths[index], cell.minWidth() + inset)
    # Protect ordinary words and identifiers before exceptionally long tokens.
    # A column that cannot fit its longest token keeps its normal wrapping.
    space = sum(widths) - sum(minimums)
    for extra, index in sorted((wanted - minimum, index)
                               for index, (wanted, minimum) in enumerate(zip(body_widths, minimums))):
        if extra > space:
            break
        minimums[index] += extra
        space -= extra
    shortfall = sum(max(0, minimum - width) for minimum, width in zip(minimums, widths))
    spare = sum(max(0, width - minimum) for minimum, width in zip(minimums, widths))
    if 0 < shortfall <= spare:
        widths = [max(width, minimum) - max(0, width - minimum) * shortfall / spare
                  for width, minimum in zip(widths, minimums)]
    return widths


def quote_schedule_table(report, headings, rows, widths, page_height):
    padding = 2
    header = [report.p(heading, 'head') for heading in headings]
    widths = list(widths)
    fixed_columns = ()
    product = next((index for index, heading in enumerate(headings)
                    if heading == 'Product' or heading.startswith('Product /')), None)
    if 'Location' in headings and 'Item / mark' in headings and product is not None:
        location, item = headings.index('Location'), headings.index('Item / mark')
        # Give both identity fields the same compact width. Long marks wrap
        # within it instead of borrowing the Product column's reading space.
        identity = min(widths[location], widths[item])
        widths[product] += widths[location] + widths[item] - 2 * identity
        widths[location] = widths[item] = identity
        fixed_columns = (location, item)
    widths = fitted_column_widths(header, rows, widths, padding, fixed_columns=fixed_columns)
    data = [header]
    for row in rows:
        for index, cell in enumerate(row):
            if isinstance(cell, Image):
                available = widths[index] - 2 * padding
                scale = min(1, available / cell.drawWidth)
                cell.drawWidth *= scale
                cell.drawHeight *= scale
        data.append(row)
    # Split a tall row into the available frame before moving whole rows.
    # Otherwise a split remainder can fit back on the same page and paint
    # the repeated header twice there.
    table = LongTable(data, colWidths=widths, repeatRows=1, hAlign='LEFT', splitByRow=0, splitInRow=20)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#bd0018')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('GRID', (0, 0), (-1, -1), .4, colors.HexColor('#bd0018')),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), padding),
        ('RIGHTPADDING', (0, 0), (-1, -1), padding),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    for row_index, row in enumerate(rows, 1):
        if any(isinstance(cell, Paragraph) and
               cell.wrap(widths[index] - 2 * padding, page_height)[1] > page_height - 180
               for index, cell in enumerate(row)):
            table.setStyle(TableStyle([('VALIGN', (0, row_index), (-1, row_index), 'TOP')]))
    return table
