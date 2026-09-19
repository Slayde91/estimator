"""Render a complete quote PDF from an already-calculated quote snapshot.

The report does not call the calculator, read the current catalogue, or derive
financial values. Internal worksheet keys select the authoritative values;
the report uses business labels and formatting never changes saved results.
"""

from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP, localcontext
from io import BytesIO
from html import unescape
import math
from pathlib import Path
import re
from threading import Lock
from xml.sax.saxutils import escape

import reportlab
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether, LongTable, PageBreak, Paragraph, SimpleDocTemplate, Spacer,
    Table, TableStyle,
)

from .calculator import masking_breakdown
from .presentation import calculation_error_details


ROOT = Path(__file__).resolve().parent.parent
_FONT_LOCK = Lock()
_RED = colors.HexColor("#C62828")
_INK = colors.HexColor("#202831")
_MUTED = colors.HexColor("#5B6570")
_LINE = colors.HexColor("#D8DEE4")
_LIGHT = colors.HexColor("#F3F5F7")
_PALE_RED = colors.HexColor("#FFF1F0")
_PAGE_WIDTH, _PAGE_HEIGHT = A4
_MARGIN = 36
_WIDTH = _PAGE_WIDTH - 2 * _MARGIN


def _company_header(canvas, logo, page_width, page_height, margin, report_label, *, label_below_logo=False):
    """Draw the same contact header within the reserved space on every PDF page."""
    logo_width, logo_height = logo.getSize()
    scale = min(146 / logo_width, 35 / logo_height)
    canvas.drawImage(logo, margin, page_height - 22 - logo_height * scale,
                     width=logo_width * scale, height=logo_height * scale, mask="auto")
    canvas.setFillColor(_MUTED)
    canvas.setFont("CeasefireVera", 7.5)
    if label_below_logo:
        canvas.drawString(margin, page_height - 69, report_label)
    else:
        canvas.drawRightString(page_width - margin, page_height - 27, report_label)
    for offset, text in (
        (40, "ABN: 50 612 231 562"),
        (51, "Phone: 1300 92 62 88"),
        (62, "Email: sales@ceasefire.com.au"),
    ):
        canvas.drawRightString(page_width - margin, page_height - offset, text)
    canvas.setStrokeColor(_RED)
    canvas.setLineWidth(1.1)
    canvas.line(margin, page_height - 78, page_width - margin, page_height - 78)

# label, input row, hidden material row, requirements row, labour row, team cell
_LINES = (
    ("Spray / wrap", 15, 63, 35, 65, "D2"),
    ("Mesh", 16, 68, 36, 70, "D3"),
    ("Pins / clips", 17, 73, 37, None, None),
    ("Access panels", 18, 77, 38, 79, "D6"),
    ("Fan enclosure mesh", 19, 82, 39, 84, "D8"),
    ("Primer", 20, 87, 40, 89, "D4"),
    ("Topcoat", 21, 92, 41, 94, "D5"),
    ("Board", 22, 97, 42, 99, "D9"),
    ("Mastic", 23, 102, 43, 104, "D10"),
)
_ADDITIONS = (
    (112, "Mobilisation", "Labour", "E27", "mobilisations"),
    (113, "Administration", "Labour", "E28", "fees"),
    (114, "Material freight", "Material", "B5", "deliveries"),
    (115, "Access freight", "Access", "B3", "round trips"),
    (116, "Access hire", "Access", "B2", "weeks"),
    (117, "Travel", "Travel", "B7", "round trips"),
    (118, "Accommodation", "Travel", "B6", "team nights"),
    (119, "Extra labour", "Labour", "E26", "days"),
)


def _register_fonts():
    """Use fonts shipped with ReportLab on every supported platform."""
    with _FONT_LOCK:
        if "CeasefireVera" in pdfmetrics.getRegisteredFontNames():
            return
        font_dir = Path(reportlab.__file__).resolve().parent / "fonts"
        pdfmetrics.registerFont(TTFont("CeasefireVera", str(font_dir / "Vera.ttf")))
        pdfmetrics.registerFont(TTFont("CeasefireVeraBold", str(font_dir / "VeraBd.ttf")))
        pdfmetrics.registerFontFamily(
            "CeasefireVera", normal="CeasefireVera", bold="CeasefireVeraBold",
            italic="CeasefireVera", boldItalic="CeasefireVeraBold",
        )


def _text(value):
    if value is None:
        return ""
    # Paragraph XML cannot contain control characters. Keep text, tabs and
    # linebreaks, while replacing only characters invalid in XML 1.0.
    return "".join(c if c in "\n\r\t" or ord(c) >= 32 else " " for c in str(value))


def _escaped(value):
    return escape(_text(value))


def _numeric(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _number(value, *, money=False, percent=False, blank="Unavailable"):
    if not _numeric(value):
        if isinstance(value, str) and value.startswith("#"):
            return "Unavailable: " + value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return "Unavailable: non-finite value"
        return blank if value is None or value == "" else _text(value)
    decimal = Decimal(str(value))
    with localcontext() as context:
        context.prec = max(28, decimal.adjusted() + 5)
        if percent:
            decimal *= 100
        rounded = decimal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    # Avoid negative zero while preserving real negative adjustments. This is
    # presentation only: cells, totals and saved quote values are not changed.
    formatted = format(abs(rounded) if rounded == 0 else rounded, ",.2f")
    return ("$" if money else "") + formatted + ("%" if percent else "")


def _date(value):
    if not value:
        return "Not recorded"
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc)
            return parsed.strftime("%d %b %Y, %H:%M UTC")
        return parsed.strftime("%d %b %Y, %H:%M")
    except (ValueError, TypeError):
        return _text(value)


def _styles():
    base = dict(fontName="CeasefireVera", textColor=_INK, leading=12, splitLongWords=1)
    return {
        "title": ParagraphStyle("QuoteTitle", fontName="CeasefireVeraBold", fontSize=21,
                                leading=27, spaceAfter=8, textColor=_INK, splitLongWords=1),
        "long_title": ParagraphStyle("LongQuoteTitle", fontName="CeasefireVeraBold", fontSize=14,
                                     leading=18, spaceAfter=8, textColor=_INK, splitLongWords=1),
        "section": ParagraphStyle("QuoteSection", fontName="CeasefireVeraBold", fontSize=15,
                                  leading=19, spaceBefore=6, spaceAfter=10, textColor=_INK),
        "subheading": ParagraphStyle("QuoteSubheading", fontName="CeasefireVeraBold", fontSize=10,
                                     leading=13, spaceBefore=12, spaceAfter=6, textColor=_INK,
                                     keepWithNext=True),
        "body": ParagraphStyle("QuoteBody", fontSize=9, spaceAfter=7, **base),
        "small": ParagraphStyle("QuoteSmall", fontName="CeasefireVera", fontSize=7.5,
                                 leading=10, spaceAfter=5, textColor=_MUTED, splitLongWords=1),
        "cell": ParagraphStyle("QuoteCell", fontSize=7.7, alignment=TA_CENTER, **(base | {"leading": 10})),
        "numeric": ParagraphStyle("QuoteNumeric", fontSize=7.7, alignment=TA_CENTER,
                                   **(base | {"leading": 10})),
        "head": ParagraphStyle("QuoteHead", fontName="CeasefireVeraBold", fontSize=7.5,
                                leading=10, textColor=colors.white, splitLongWords=1, alignment=TA_CENTER),
        "alert": ParagraphStyle("QuoteAlert", fontName="CeasefireVeraBold", fontSize=10,
                                 leading=14, textColor=_RED, splitLongWords=1),
    }


class _Report:
    def __init__(self, quote):
        self.quote = quote
        self.result = quote.get("result", {})
        self.cells = self.result.get("cells", {})
        self.inputs = quote.get("inputs", self.result.get("inputs", {}))
        self.errors = self.result.get("errors", {})
        self.styles = _styles()
        self.story = []

    def p(self, text, style="body"):
        return Paragraph(_escaped(text).replace("\n", "<br/>"), self.styles[style])

    def rich(self, markup, style="cell"):
        """Only call with authored markup and explicitly escaped dynamic values."""
        return Paragraph(markup, self.styles[style])

    def value(self, cell, **formatting):
        if cell in self.errors:
            return "Unavailable: " + _text(self.errors[cell])
        return _number(self.cells.get(cell), **formatting)

    def summary_value(self, key, cell, **formatting):
        if 'firestopping' not in self.result:
            return self.value(cell, **formatting)
        value = self.result['summary'].get(key)
        return 'Unavailable' if value is None else _number(value, **formatting)

    def input(self, cell, **formatting):
        value = self.inputs.get(cell)
        if formatting or _numeric(value):
            return _number(value, blank="Blank", **formatting)
        return "Blank" if value is None or value == "" else _text(value)

    def table(self, headings, rows, widths, *, compact=False):
        # Numeric tokens must not wrap midway through their decimal digits.
        # Most values fit at the normal font size after column allocation; a
        # modest font reduction handles longer quantities without losing digits.
        fitted_rows = []
        for row in rows:
            fitted = []
            for index, cell in enumerate(row):
                if isinstance(cell, Paragraph) and cell.style.name == "QuoteNumeric":
                    cell = self.fit_numeric(cell, widths[index] - 12)
                fitted.append(cell)
            fitted_rows.append(fitted)
        data = [[self.p(heading, "head") for heading in headings]] + fitted_rows
        table = LongTable(data, colWidths=widths, repeatRows=1, hAlign="LEFT", splitInRow=1)
        padding = 4 if compact else 6
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), _INK),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), padding),
            ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _LIGHT]),
            ("LINEBELOW", (0, 0), (-1, 0), 0.5, _INK),
            ("LINEBELOW", (0, 1), (-1, -1), 0.35, _LINE),
        ]))
        return table

    def fit_numeric(self, paragraph, available_width):
        lines = re.split(r"<br\s*/?>", paragraph.text)
        numeric_pattern = re.compile(r"^-?\$?-?[\d,.]+(?:[eE][+-]?\d+)?%?$")
        numeric_tokens = [unescape(line).strip() for line in lines
                          if numeric_pattern.fullmatch(unescape(line).strip())]
        if not numeric_tokens:
            return paragraph
        largest = max(pdfmetrics.stringWidth(token, "CeasefireVera", 7.7) for token in numeric_tokens)
        size = min(7.7, 7.7 * available_width / largest) if largest else 7.7
        if size >= 6.8:
            style = ParagraphStyle("FittedQuoteNumeric", parent=self.styles["numeric"],
                                   fontSize=size, splitLongWords=False)
            return Paragraph(paragraph.text, style)
        # Very large detail results cannot fit at a readable size. Scientific
        # notation keeps the mantissa intact and puts the exponent on its own
        # line. It is display formatting only; no financial value is recalculated.
        rendered = []
        for line in lines:
            token = unescape(line).strip()
            if numeric_pattern.fullmatch(token) and pdfmetrics.stringWidth(token, "CeasefireVera", 6.8) > available_width:
                prefix = "$" if "$" in token else ""
                suffix = "%" if token.endswith("%") else ""
                value = Decimal(token.replace("$", "").replace(",", "").replace("%", ""))
                with localcontext() as context:
                    context.rounding = ROUND_HALF_UP
                    mantissa, exponent = format(value, ".2e").split("e")
                rendered.append(_escaped(prefix + mantissa) +
                                "<br/>x 10<super>" + str(int(exponent)) + "</super>" + suffix)
            else:
                rendered.append(line)
        return Paragraph("<br/>".join(rendered), ParagraphStyle(
            "ScientificQuoteNumeric", parent=self.styles["numeric"], fontSize=6.8, splitLongWords=False))

    def detail(self, primary, secondary=""):
        return self.rich("<b>" + _escaped(primary) + "</b>" +
                         ("<br/>" + _escaped(secondary).replace("\n", "<br/>") if secondary else ""))

    def note_block(self, text):
        # Individual paragraphs can split across pages. Never wrap arbitrary
        # estimator text in KeepTogether or a single unsplittable table row.
        normalized = _text(text).replace("\r\n", "\n").replace("\r", "\n")
        if not normalized:
            self.story.append(self.p("None recorded.", "small"))
            return
        for paragraph in normalized.split("\n"):
            if paragraph:
                self.story.append(self.p(paragraph))
            else:
                self.story.append(Spacer(1, 5))

    def summary(self):
        self.story.append(self.p(self.quote.get("report_kind", "Saved quote"), "small"))
        title = self.quote.get("title", "Untitled quote")
        # A composed project/client/site title can reach 704 characters. Keep
        # every character, using a readable smaller heading for long details.
        self.story.append(self.p(title, "long_title" if len(_text(title)) > 180 else "title"))
        identity = [
            [self.p("Client", "cell"), self.p(self.quote.get("client") or "Not recorded", "cell")],
            [self.p("Site Address", "cell"), self.p(self.quote.get("site_address") or "Not recorded", "cell")],
            [self.p("Project No.", "cell"), self.p(self.quote.get("project_no") or "Not recorded", "cell")],
            [self.p("Quote reference", "cell"), self.p(self.quote.get("id") or "Current unsaved estimate", "cell")],
            [self.p("Snapshot updated", "cell"), self.p(_date(self.quote.get("updated_at")), "cell")],
        ]
        self.story.append(self.table(["Quote details", "Recorded value"], identity, [_WIDTH * .28, _WIDTH * .72]))
        self.story.append(Spacer(1, 14))
        if self.errors:
            alert = Table([[self.p("CALCULATION INCOMPLETE", "alert")], [self.p(
                "Some results are unavailable because the estimate contains calculation errors. "
                "Available values are shown as recorded; unavailable values are never replaced with zero. "
                "The complete error list is in the quote notes section.", "body")]],
                colWidths=[_WIDTH])
            alert.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), _PALE_RED),
                ("BOX", (0, 0), (-1, -1), .6, _RED),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            self.story.extend([alert, Spacer(1, 12)])
        totals = [
            ("Labour", "labour", "F2"), ("Material", "material", "F3"), ("Access", "access", "F4"),
            ("Travel / accommodation", "travel", "F5"), ("Subtotal", "subtotal", "F6"),
            ("Fixed adjustment", None, "D27"), ("Grand total", "total", "F7"),
        ]
        rows = [[self.detail(label), self.p(self.summary_value(key, cell, money=True) if key else self.value(cell, money=True), "numeric")]
                for label, key, cell in totals]
        total_table = self.table(["Quote amount", "Amount ($)"], rows, [_WIDTH * .68, _WIDTH * .32])
        total_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 7), (-1, 7), colors.HexColor("#E8EEF0")),
            ("LINEABOVE", (0, 7), (-1, 7), 1, _RED),
        ]))
        # This is a fixed-size financial summary, so its grand total stays on
        # the same page as its component amounts even with long quote details.
        self.story.append(KeepTogether([total_table]))
        self.story.append(self.p("Project measures", "subheading"))
        checks = [
            [self.p("Total project days", "cell"), self.p(self.summary_value("days", "F10"), "numeric")],
            [self.p("Rate per project area / item", "cell"), self.p(self.summary_value("rate", "F8", money=True), "numeric")],
        ]
        self.story.append(self.table(["Calculated output", "Recorded value"], checks, [_WIDTH * .68, _WIDTH * .32], compact=True))
        self.story.extend([
            Spacer(1, 9),
            self.p("Amounts, rates, quantities, days and percentages display no more than two decimal places. "
                   "Very large detail values use scientific notation. The quote total uses the original unrounded results; adding individually rounded line amounts "
                   "can differ by a few cents. No rounding adjustment has been added.", "small"),
        ])

    def materials(self):
        self.story.extend([PageBreak(), self.p("Material breakdown", "section")])
        self.story.append(self.p(
            "All nine material lines are included, including zero quantities. Coverage is the estimator's input. "
            "Adjusted base units include the global material adjustment; wastage is then added. "
            "Fractional priced quantities are preserved.", "small"))
        rows = []
        for label, row, price_row, _, _, _ in _LINES:
            unit = "bags / drums / rolls" if row == 15 else "panels" if row == 18 else "linear m" if row == 23 else "m²"
            yield_text = "Yield not used" if row in (15, 18) else "Yield: " + self.value(f"F{row}")
            material = self.detail(label, self.input(f"D{row}") + "\n" + yield_text)
            rows.append([
                material,
                self.p(self.input(f"B{row}") + "\n" + unit, "numeric"),
                self.p(self.value(f"B{price_row}"), "numeric"),
                self.p(self.input(f"E{row}", percent=True) + "\n" + self.value(f"C{price_row}") + " units", "numeric"),
                self.p(self.value(f"D{price_row}"), "numeric"),
                self.p(self.value(f"A{price_row}", money=True), "numeric"),
                self.p(self.value(f"F{price_row}", money=True), "numeric"),
            ])
        widths = [133, 54, 62, 59, 63, 65, _WIDTH - 436]
        self.story.append(self.table(
            ["Material / yield", "Coverage", "Adjusted base units", "Wastage % / units", "Priced units", "Unit sell rate", "Line amount"],
            rows, widths))
        if 'firestopping' in self.result:
            self.story.extend([PageBreak(), self.p('Firestopping schedule materials', 'section')])
            has_register = any(item.get('name', '').endswith('Register allowance')
                for item in self.result.get('labour', {}).get('firestopping_tasks', []))
            self.story.append(self.p(
                'The schedule is included once in the quote summary. These quantities and sell rates use the recorded pricing snapshot. '
                'Shared Board and Wrap task hours are allocated by each line\'s calculated material quantities; labour days use eight hours per day. '
                + ('Register allowance is shown separately below.' if has_register else 'Setup labour is shown separately below.'), 'small'))
            entries = [item for item in self.result.get('materials', []) if item.get('source') == 'firestopping']
            if entries:
                rows = [[self.detail(item['name']),
                         self.p(_number(item.get('quantity')), 'numeric'),
                         self.p(_number(item.get('price'), money=True), 'numeric'),
                         self.p(_number(item.get('total'), money=True), 'numeric'),
                         self.p(_number(item.get('days')), 'numeric')] for item in entries]
                material_table = self.table(['Product / context', 'Quantity', 'Unit sell rate', 'Line amount', 'Labour days'],
                    rows, [203, 70, 85, 90, _WIDTH - 448], compact=True)
                material_table.splitInRow = 0
                self.story.append(material_table)
            else:
                self.story.append(self.p('No Firestopping material quantities.', 'small'))

    def labour_and_additions(self):
        self.story.extend([PageBreak(), self.p("Labour and masking", "section")])
        rows = []
        for label, row, _, req_row, labour_row, team in _LINES:
            if labour_row is None:
                continue
            rows.append([
                self.detail(label),
                self.p(self.input(team), "cell"),
                self.p(self.input(f"C{row}"), "numeric"),
                self.p(self.value(f"B{req_row}"), "numeric"),
                self.p(self.value(f"A{labour_row}", money=True), "numeric"),
                self.p(self.value(f"F{labour_row}", money=True), "numeric"),
            ])
        widths = [88, 109, 56, 65, 92, _WIDTH - 410]
        self.story.append(self.table(["Task", "Labour selection", "Output units / day", "Days", "Daily sell rate", "Line amount"], rows, widths, compact=True))
        self.story.append(self.p(
            "Pinning days: " + self.value("B37") + ". They mirror meshing days and carry no separate labour charge. "
            "Total task labour: " + self.value("B44") +
            " days / " + self.value("B45") + " weeks.", "small"))

        if 'firestopping' in self.result:
            self.story.append(self.p('Firestopping schedule labour', 'subheading'))
            tasks = self.result.get('labour', {}).get('firestopping_tasks', [])
            rows = [[self.detail(item['name']), self.p(_number(item.get('task_hours')), 'numeric'),
                     self.p(_number(item.get('days')), 'numeric'),
                     self.p(_number(item.get('total'), money=True), 'numeric')] for item in tasks]
            schedule_summary = self.result['firestopping']['result']['summary']
            rows.append([self.detail('Firestopping total'),
                         self.p(_number(schedule_summary.get('labour_hours')), 'numeric'),
                         self.p(_number(schedule_summary.get('total_days')), 'numeric'),
                         self.p(_number(schedule_summary.get('labour'), money=True), 'numeric')])
            self.story.append(self.table(['Task', 'Task hours', 'Labour days', 'Labour amount'], rows,
                [223, 80, 80, _WIDTH - 383], compact=True))
            labour_note = ('Register allowance shows the resolved registration time. Additional Labour includes entered extra hours and fixed labour adjustments. '
                if any(item.get('name', '').endswith('Register allowance') for item in tasks)
                else 'Firestopping Labour includes source setup time and fixed labour adjustments. ')
            self.story.append(self.p(
                labour_note +
                'Fixed monetary adjustments do not create task hours. These task totals include the hours allocated to material rows; '
                'they are included once in the combined quote total.', 'small'))

        self.story.append(self.p("Masking / cleaning", "subheading"))
        # Older saved quotes lack this additive presentation field. The helper
        # uses only their stored cells; it never recalculates a quote or consults
        # today's catalogue, so historical pricing remains intact.
        masking = self.result.get("masking") or masking_breakdown(self.result)
        masking_rows = [
            [self.detail("Masking labour", self.input("D7")),
             self.p(self.value("B53"), "numeric"), self.p(self.value("B51", money=True), "numeric"),
             self.p(_number(masking.get("labour_total"), money=True), "numeric")],
            [self.detail("Masking materials", self.input("B10")),
             self.p(self.value("B53"), "numeric"), self.p(self.value("B52", money=True), "numeric"),
             self.p(_number(masking.get("material_base_total"), money=True), "numeric")],
            [self.detail("Masking material adjustment"), self.p("", "numeric"), self.p("", "numeric"),
             self.p(self.value("B57", money=True), "numeric")],
        ]
        self.story.append(self.table(["Component", "Days", "Rate per day", "Amount"], masking_rows,
                                     [221, 70, 108, _WIDTH - 399], compact=True))

        self.story.extend([PageBreak(), self.p("Additions and project costs", "section")])
        rows = []
        for row, label, category, selection, unit in _ADDITIONS:
            rows.append([
                self.detail(label, self.input(selection)),
                self.p(category, "cell"),
                self.p(self.value(f"C{row}") + "\n" + unit, "numeric"),
                self.p(self.value(f"B{row}", money=True), "numeric"),
                self.p(self.value(f"D{row}", money=True), "numeric"),
            ])
        self.story.append(self.table(["Item / selection", "Category", "Adjusted qty", "Unit sell rate", "Amount"], rows,
                                     [187, 57, 83, 92, _WIDTH - 419], compact=True))
        self.story.append(self.p(
            "Entered additions: extra days = " + self.input("F26") +
            "; mobilisation quantity = " + self.input("F27") +
            "; administration quantity = " + self.input("F28") +
            "; access quantity = " + self.input("B4") +
            ". Access hire uses weekly rates. Fixed adjustment: " + self.value("D27", money=True) +
            ". All additions and the fixed adjustment are included in the quote summary.", "small"))

    def notes(self):
        self.story.extend([PageBreak(), self.p("Quote notes", "section")])
        self.story.append(self.p("NOTES", "subheading"))
        self.note_block(self.quote.get("measurements"))
        if self.errors:
            self.story.append(self.p("Calculation errors - complete list", "subheading"))
            error_rows = [[self.p(error["label"], "cell"), self.p(error["code"], "cell")]
                          for error in calculation_error_details(self.result)]
            self.story.append(self.table(["Affected calculation", "Recorded error"], error_rows,
                                         [_WIDTH * .55, _WIDTH * .45], compact=True))
        self.story.append(self.p(
            "This report uses the quote's recorded quantities and selling prices. "
            "Later pricing-library changes do not alter a saved quote's report.", "small"))


def render_quote_pdf(quote: dict) -> bytes:
    """Return a branded A4 report of authoritative snapshot results as PDF bytes."""
    if not isinstance(quote, dict) or not isinstance(quote.get("result"), dict):
        raise ValueError("A prepared quote with calculated results is required for its PDF report.")
    _register_fonts()
    logo_path = ROOT / "static" / "ceasefire-logo.png"
    if not logo_path.is_file():
        raise FileNotFoundError("The official Ceasefire logo is missing from static/ceasefire-logo.png.")
    logo = ImageReader(str(logo_path))
    logo_width, logo_height = logo.getSize()
    if not logo_width or not logo_height:
        raise ValueError("The official Ceasefire logo has invalid dimensions.")

    report = _Report(quote)
    report.summary()
    report.materials()
    report.labour_and_additions()
    report.notes()
    destination = BytesIO()
    document = SimpleDocTemplate(
        destination, pagesize=A4, leftMargin=_MARGIN, rightMargin=_MARGIN,
        topMargin=91, bottomMargin=47, pageCompression=1,
        title=_text(quote.get("title", "Ceasefire estimate")),
        author="Ceasefire", subject="Complete estimating material and labour breakdown",
    )

    def decorate(canvas, doc):
        canvas.saveState()
        _company_header(canvas, logo, _PAGE_WIDTH, _PAGE_HEIGHT, _MARGIN,
                        "ESTIMATE | COMPLETE BREAKDOWN")
        canvas.setStrokeColor(_LINE)
        canvas.setLineWidth(.5)
        canvas.line(_MARGIN, 34, _PAGE_WIDTH - _MARGIN, 34)
        canvas.setFont("CeasefireVera", 7)
        canvas.setFillColor(_MUTED)
        canvas.drawString(_MARGIN, 22, "Ceasefire ESTIMATOR | " + _text(quote.get("report_kind", "Saved quote")))
        canvas.drawRightString(_PAGE_WIDTH - _MARGIN, 22, f"Page {doc.page}")
        canvas.restoreState()

    document.build(report.story, onFirstPage=decorate, onLaterPages=decorate)
    return destination.getvalue()
