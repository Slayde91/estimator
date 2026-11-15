"""Paragraph and list rendering shared by commercial documents and Forms."""
from html import escape
from html.parser import HTMLParser


class RichParagraphs(HTMLParser):
    """Convert validated editor HTML into bounded ReportLab paragraph markup."""
    def __init__(self, format_text=None):
        super().__init__(convert_charrefs=True)
        self.format_text = format_text or (lambda text: escape(text, quote=False))
        self.paragraphs = []
        self.current = []
        self.styles = []
        self.lists = []

    def flush(self):
        if self.current:
            self.paragraphs.append(''.join(self.current) + ''.join('</' + tag + '>' for tag in reversed(self.styles)))
        self.current = ['<' + tag + '>' for tag in self.styles]

    def handle_starttag(self, tag, attrs):
        mapped = {'strong': 'b', 'em': 'i'}.get(tag, tag)
        if mapped in {'b', 'i', 'u'}:
            self.styles.append(mapped)
            self.current.append('<' + mapped + '>')
        elif tag in {'ul', 'ol'}:
            self.flush()
            self.lists.append({'tag': tag, 'counter': 0})
        elif tag in {'p', 'div', 'li'}:
            self.flush()
            if tag == 'li':
                prefix = '&#8226; '
                if self.lists and self.lists[-1]['tag'] == 'ol':
                    self.lists[-1]['counter'] += 1
                    prefix = str(self.lists[-1]['counter']) + '. '
                self.current.append('&#160;' * max(0, 3 * (len(self.lists) - 1)) + prefix)
        elif tag == 'br':
            self.flush()

    def handle_endtag(self, tag):
        mapped = {'strong': 'b', 'em': 'i'}.get(tag, tag)
        if mapped in {'b', 'i', 'u'}:
            self.current.append('</' + mapped + '>')
            self.styles.pop()
        elif tag in {'p', 'div', 'li'}:
            self.flush()
        elif tag in {'ul', 'ol'}:
            self.flush()
            self.lists.pop()

    def handle_data(self, data):
        self.current.append(self.format_text(data))
