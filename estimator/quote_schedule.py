"""Compact portrait schedule tables embedded in a commercial quotation.

Canonical cells and their links remain unchanged. The table has every column
on the same page width, with normal vertical pagination for additional rows.
"""
from reportlab.lib import colors
from reportlab.platypus import HRFlowable, Image, LongTable, Paragraph, TableStyle


def append_scope_intro(report, intro):
    """Keep the quotation's scope heading in the schedule's own text flow."""
    if intro.get('heading'):
        style = report.styles['section'].clone('CommercialScopeHeading', fontSize=11, leading=15,
                                               textColor=colors.HexColor('#bd0018'), keepWithNext=True)
        report.story.append(Paragraph('SCOPE OF WORKS', style))
        rule = HRFlowable(width='100%', thickness=1, color=colors.HexColor('#bd0018'), spaceAfter=8)
        rule.keepWithNext = True
        report.story.append(rule)
        note = report.p('The following Full Schedules form the Scope of Works for this quotation.')
        note.keepWithNext = True
        report.story.append(note)
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


def quote_schedule_table(report, headings, rows, widths, page_height):
    padding = 2
    header = [report.p(heading, 'head') for heading in headings]
    # Reserve whole heading words first, using the actual embedded font.
    inset = 2 * padding + .1
    minimums = [cell.minWidth() + inset for cell in header]
    body_widths = minimums.copy()
    for row in rows:
        for index, cell in enumerate(row):
            if isinstance(cell, Paragraph):
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
    data = [header]
    for row in rows:
        for index, cell in enumerate(row):
            if isinstance(cell, Image):
                available = widths[index] - 2 * padding
                scale = min(1, available / cell.drawWidth)
                cell.drawWidth *= scale
                cell.drawHeight *= scale
        data.append(row)
    table = LongTable(data, colWidths=widths, repeatRows=1, hAlign='LEFT', splitInRow=20)
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
