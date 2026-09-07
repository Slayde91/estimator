"""Render a complete quote PDF from an already-calculated quote snapshot.

The report does not call the calculator, read the current catalogue, or derive
financial values. Worksheet cell references identify the authoritative values
being presented; formatting never changes the saved calculation results.
"""

from datetime import datetime, timezone
from io import BytesIO
from html import unescape
import math
from pathlib import Path
import re
from threading import Lock
from xml.sax.saxutils import escape

import reportlab
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    LongTable, PageBreak, Paragraph, SimpleDocTemplate, Spacer,
    Table, TableStyle,
)

from .calculator import masking_breakdown


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


def _number(value, *, money=False, cents=False, percent=False, blank="Unavailable"):
    if not _numeric(value):
        if isinstance(value, str) and value.startswith("#"):
            return "Unavailable: " + value
        return blank if value is None or value == "" else _text(value)
    displayed = value * 100 if percent else value
    if not _numeric(displayed):
        return "Unavailable: display range exceeded"
    if cents:
        formatted = format(displayed, ",.2f")
    elif displayed != 0 and abs(displayed) < 0.00000001:
        formatted = format(displayed, ".10g")
    else:
        formatted = format(displayed, ",.8f").rstrip("0").rstrip(".")
        if formatted in ("-0", ""):
            formatted = "0"
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
        "section": ParagraphStyle("QuoteSection", fontName="CeasefireVeraBold", fontSize=15,
                                  leading=19, spaceBefore=6, spaceAfter=10, textColor=_INK),
        "subheading": ParagraphStyle("QuoteSubheading", fontName="CeasefireVeraBold", fontSize=10,
                                     leading=13, spaceBefore=12, spaceAfter=6, textColor=_INK,
                                     keepWithNext=True),
        "body": ParagraphStyle("QuoteBody", fontSize=9, spaceAfter=7, **base),
        "small": ParagraphStyle("QuoteSmall", fontName="CeasefireVera", fontSize=7.5,
                                 leading=10, spaceAfter=5, textColor=_MUTED, splitLongWords=1),
        "cell": ParagraphStyle("QuoteCell", fontSize=7.7, **(base | {"leading": 10})),
        "numeric": ParagraphStyle("QuoteNumeric", fontSize=7.7, alignment=TA_RIGHT,
                                   **(base | {"leading": 10})),
        "head": ParagraphStyle("QuoteHead", fontName="CeasefireVeraBold", fontSize=7.5,
                                leading=10, textColor=colors.white, splitLongWords=1),
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

    def input(self, cell, **formatting):
        value = self.inputs.get(cell)
        if formatting:
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
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
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
                value = float(token.replace("$", "").replace(",", "").replace("%", ""))
                mantissa, exponent = format(value, ".8e").split("e")
                rendered.append(_escaped(prefix + mantissa.rstrip("0").rstrip(".")) +
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
        self.story.append(self.p(self.quote.get("title", "Untitled quote"), "title"))
        self.story.append(self.p(self.quote.get("workflow", "Workflow not recorded")))
        identity = [
            [self.p("Quote reference", "cell"), self.p(self.quote.get("id") or "Current unsaved estimate", "cell")],
            [self.p("Snapshot updated", "cell"), self.p(_date(self.quote.get("updated_at")), "cell")],
        ]
        self.story.append(self.table(["Quote details", "Recorded value"], identity, [_WIDTH * .28, _WIDTH * .72]))
        self.story.append(Spacer(1, 14))
        if self.errors:
            alert = Table([[self.p("CALCULATION INCOMPLETE", "alert")], [self.p(
                "Some results are unavailable because the estimate contains calculation errors. "
                "Available values are shown as recorded; unavailable values are never replaced with zero. "
                "The complete error list is in the notes and traceability section.", "body")]],
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
            ("Labour", "F2"), ("Material", "F3"), ("Access", "F4"),
            ("Travel / accommodation", "F5"), ("Subtotal", "F6"),
            ("Fixed adjustment", "D27"), ("Grand total", "F7"),
        ]
        rows = [[self.detail(label, "Calculator!" + cell), self.p(self.value(cell, money=True, cents=True), "numeric")]
                for label, cell in totals]
        total_table = self.table(["Quote amount", "Amount ($)"], rows, [_WIDTH * .68, _WIDTH * .32])
        total_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 7), (-1, 7), colors.HexColor("#E8EEF0")),
            ("LINEABOVE", (0, 7), (-1, 7), 1, _RED),
        ]))
        self.story.append(total_table)
        self.story.append(self.p("Reconciliation checks", "subheading"))
        checks = [
            [self.p("Second subtotal / grand-total path", "cell"),
             self.p(self.value("D26", money=True, cents=True) + " / " + self.value("D28", money=True, cents=True), "numeric")],
            [self.p("Total days / total task labour days", "cell"),
             self.p(self.value("F10") + " / " + self.value("B44"), "numeric")],
            [self.p("Rate per project area / item", "cell"), self.p(self.value("F8", money=True, cents=True), "numeric")],
        ]
        self.story.append(self.table(["Calculated output", "Recorded value"], checks, [_WIDTH * .68, _WIDTH * .32], compact=True))
        self.story.extend([
            Spacer(1, 9),
            self.p("Amounts on this summary display cents. Detail pages retain up to eight decimal places. "
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
            material = self.detail(label, self.input(f"D{row}") + "\n" + yield_text +
                                   f" | row {row} / F{price_row}")
            rows.append([
                material,
                self.p(self.input(f"B{row}", cents=False) + "\n" + unit, "numeric"),
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
        self.story.append(self.p("Material pricing and quantities", "subheading"))
        self.story.append(self.p(
            "The material category total on the summary also contains material freight and masking materials "
            "shown in the labour and additions sections. Rounded purchasing counts appear only in the generated material notes; "
            "they do not replace the fractional quantities priced here.", "small"))
        self.story.append(self.p(
            "Project area / items (B8): " + self.input("B8", cents=False) +
            ". Global material adjustment (B26): " + self.input("B26", percent=True) +
            ". Global labour adjustment (B27): " + self.input("B27", percent=True) + ".", "small"))
        self.story.append(self.p(
            "The workbook takes coverage and units from the estimator. Measurement notes and workflow labels "
            "do not automatically calculate coverage, fire-rating suitability or required coating thickness.", "small"))

    def labour_and_additions(self):
        self.story.extend([PageBreak(), self.p("Labour and masking", "section")])
        rows = []
        for label, row, _, req_row, labour_row, team in _LINES:
            if labour_row is None:
                continue
            rows.append([
                self.detail(label, f"B{req_row} / F{labour_row}"),
                self.p(self.input(team), "cell"),
                self.p(self.input(f"C{row}", cents=False), "numeric"),
                self.p(self.value(f"B{req_row}"), "numeric"),
                self.p(self.value(f"A{labour_row}", money=True), "numeric"),
                self.p(self.value(f"F{labour_row}", money=True), "numeric"),
            ])
        widths = [88, 109, 56, 65, 92, _WIDTH - 410]
        self.story.append(self.table(["Task", "Labour selection", "Output units / day", "Days", "Daily sell rate", "Line amount"], rows, widths, compact=True))
        self.story.append(self.p(
            "Pinning days (B37): " + self.value("B37") + ". They mirror meshing days and carry no separate labour charge. "
            "The pinning daily-output input C17 is " + self.input("C17", cents=False) +
            " and does not affect the workbook calculation. Total task labour: " + self.value("B44") +
            " days / " + self.value("B45") + " weeks.", "small"))

        self.story.append(self.p("Masking / cleaning", "subheading"))
        # Older saved quotes lack this additive presentation field. The helper
        # uses only their stored cells; it never recalculates a quote or consults
        # today's catalogue, so historical pricing remains intact.
        masking = self.result.get("masking") or masking_breakdown(self.result)
        masking_rows = [
            [self.detail("Masking labour", self.input("D7") + " | B51 / B53"),
             self.p(self.value("B53"), "numeric"), self.p(self.value("B51", money=True), "numeric"),
             self.p(_number(masking.get("labour_total"), money=True), "numeric")],
            [self.detail("Masking materials", self.input("B10") + " | B52 / B53"),
             self.p(self.value("B53"), "numeric"), self.p(self.value("B52", money=True), "numeric"),
             self.p(_number(masking.get("material_base_total"), money=True), "numeric")],
            [self.detail("Masking material adjustment", "B57"), self.p("", "numeric"), self.p("", "numeric"),
             self.p(self.value("B57", money=True), "numeric")],
        ]
        self.story.append(self.table(["Component", "Days", "Rate per day", "Amount"], masking_rows,
                                     [221, 70, 108, _WIDTH - 399], compact=True))
        self.story.append(self.p(
            "Masking input (B9): " + self.input("B9", percent=True) +
            " of spray days. Base masking subtotal (B55): " + self.value("B55", money=True) +
            "; total including adjustment (B58): " + self.value("B58", money=True) +
            ". B52 already includes the material adjustment; B57 is its additional workbook adjustment. "
            "These subtotals are included in the summary categories.", "small"))

        self.story.extend([PageBreak(), self.p("Additions and project costs", "section")])
        rows = []
        for row, label, category, selection, unit in _ADDITIONS:
            rows.append([
                self.detail(label, self.input(selection) + f" | D{row}"),
                self.p(category, "cell"),
                self.p(self.value(f"C{row}") + "\n" + unit, "numeric"),
                self.p(self.value(f"B{row}", money=True), "numeric"),
                self.p(self.value(f"D{row}", money=True), "numeric"),
            ])
        self.story.append(self.table(["Item / selection", "Category", "Adjusted qty", "Unit sell rate", "Amount"], rows,
                                     [187, 57, 83, 92, _WIDTH - 419], compact=True))
        self.story.append(self.p(
            "Entered additions: extra days F26 = " + self.input("F26", cents=False) +
            "; mobilisation quantity F27 = " + self.input("F27", cents=False) +
            "; administration quantity F28 = " + self.input("F28", cents=False) +
            "; access quantity B4 = " + self.input("B4", cents=False) +
            ". Access hire uses weekly rates. Additions subtotal D120: " + self.value("D120", money=True) +
            ". Fixed adjustment B28 / D27: " + self.value("D27", money=True) +
            ". Subtotals shown here are explanatory and must not be added again to the summary.", "small"))

    def notes_and_sources(self):
        self.story.extend([PageBreak(), self.p("Notes and traceability", "section")])
        self.story.append(self.p("Estimator notes", "subheading"))
        self.note_block(self.inputs.get("B12"))
        self.story.append(self.p("Measurement / technical notes", "subheading"))
        self.note_block(self.quote.get("measurements"))
        self.story.append(self.p("Generated material and allowance notes", "subheading"))
        notes = self.result.get("notes")
        if "B30" in self.errors:
            self.story.append(self.p("Unavailable: " + _text(self.errors["B30"]), "alert"))
        else:
            self.note_block(notes)
        if self.errors:
            self.story.append(self.p("Calculation errors - complete list", "subheading"))
            error_rows = [[self.p("Calculator!" + _text(cell), "cell"), self.p(code, "cell")]
                          for cell, code in sorted(self.errors.items())]
            self.story.append(self.table(["Affected source cell", "Recorded error"], error_rows,
                                         [_WIDTH * .55, _WIDTH * .45], compact=True))
        self.story.append(self.p("Snapshot and source records", "subheading"))
        self.story.append(self.p(
            "This report presents the quote's prepared result and pricing snapshot. It does not refresh "
            "prices from the current catalogue or recalculate the quote. Supplier costs and markup "
            "are not inferred from historical selling prices. Worksheet references identify the original "
            "Calculator values used for each output.", "small"))
        self.story.append(self.p(
            "Report kind: " + _text(self.quote.get("report_kind", "Saved quote")) +
            ". Quote reference: " + _text(self.quote.get("id") or "Current unsaved estimate") +
            ". Snapshot: " + _date(self.quote.get("updated_at")) + ".", "small"))
        source_hashes = self.quote.get("source_hashes", {})
        for source_name, source in sorted(source_hashes.items()):
            if isinstance(source, dict):
                self.story.append(self.p(
                    _text(source.get("filename") or source_name) + " | SHA-256: " +
                    _text(source.get("sha256") or "Not recorded"), "small"))
            else:
                self.story.append(self.p(_text(source_name) + " | " + _text(source), "small"))
        if not source_hashes:
            self.story.append(self.p("Workbook source hashes were not recorded in this snapshot.", "small"))
        signature = self.quote.get("configuration", {}).get("catalog_signature")
        if signature:
            self.story.append(self.p("Catalogue structure signature: " + _text(signature), "small"))


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
    report.notes_and_sources()
    destination = BytesIO()
    document = SimpleDocTemplate(
        destination, pagesize=A4, leftMargin=_MARGIN, rightMargin=_MARGIN,
        topMargin=75, bottomMargin=47, pageCompression=1,
        title=_text(quote.get("title", "Ceasefire estimate")),
        author="Ceasefire", subject="Complete estimating material and labour breakdown",
    )

    def decorate(canvas, doc):
        canvas.saveState()
        max_width, max_height = 142, 34
        scale = min(max_width / logo_width, max_height / logo_height)
        width, height = logo_width * scale, logo_height * scale
        canvas.drawImage(logo, _MARGIN, _PAGE_HEIGHT - 22 - height,
                         width=width, height=height, mask="auto")
        canvas.setFillColor(_MUTED)
        canvas.setFont("CeasefireVera", 7.5)
        canvas.drawRightString(_PAGE_WIDTH - _MARGIN, _PAGE_HEIGHT - 35, "ESTIMATE | COMPLETE BREAKDOWN")
        canvas.setStrokeColor(_RED)
        canvas.setLineWidth(1.1)
        canvas.line(_MARGIN, _PAGE_HEIGHT - 62, _PAGE_WIDTH - _MARGIN, _PAGE_HEIGHT - 62)
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
