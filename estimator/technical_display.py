"""Compact Technical Library display text without changing retained evidence."""
import re

_PROTECTED = re.compile(r'https?://[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', re.I)


def compact_technical_text(value):
    """Abbreviate only requested prose; links, numbers and qualifiers survive."""
    if not isinstance(value, str):
        return value

    def compact(text):
        # Joined names in the source include FIREFLYBatt/FIREFLYMastic. Keep
        # the entire remaining product name: Intubatt is never renamed Batt.
        text = re.sub(r'\bFIREFLY(?=[A-Za-z])', '', text, flags=re.I)
        text = re.sub(r'\bFIREFLY[ \t]+(?=(?:Batt|Mastic|Penowrap|Intu[A-Za-z]+)\b)', '', text, flags=re.I)
        for expression, replacement in (
                (r'\binto\s+the\s+aperture\b', 'to aperture'),
                (r'\bof\s+the\s+damper\b', 'of damper'),
                (r'\bminimum\b\.?', 'min.'), (r'\bper\b', 'p/'), (r'\bwith\b', 'w/')):
            text = re.sub(expression, replacement, text, flags=re.I)
        return text

    pieces, cursor = [], 0
    for match in _PROTECTED.finditer(value):
        pieces.extend((compact(value[cursor:match.start()]), match[0]))
        cursor = match.end()
    pieces.append(compact(value[cursor:]))
    return ''.join(pieces)
