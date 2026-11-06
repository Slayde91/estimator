"""Compact portrait schedule tables embedded in a commercial quotation.

Canonical cells and their links remain unchanged. The table has every column
on the same page width, with normal vertical pagination for additional rows.
"""
from reportlab.lib import colors
from reportlab.platypus import Image, LongTable, Paragraph, TableStyle


def configure_quote_schedule(report):
    # A fixed 6.8 pt floor avoids making crowded registers progressively tiny.
    # Narrow text wraps instead, including exceptional numeric identifiers.
    for name in ('cell', 'numeric', 'head'):
        report.styles[name] = report.styles[name].clone(
            'CommercialSchedule' + name.title(), fontSize=6.8, leading=8.8,
            spaceBefore=0, spaceAfter=0, splitLongWords=True)


def quote_schedule_table(report, headings, rows, widths, page_height):
    padding = 2
    data = [[report.p(heading, 'head') for heading in headings]]
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
