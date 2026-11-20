"""Keep repeated selector clauses in their dedicated public fields."""
import re


SERVICE_SIZE = 'Service Size / Configuration'
BARRIER = 'Barrier Construction'
WRAP_COLUMNS = {'twrap length', 'wrap requirement'}
SIZE_COLUMNS = {'pipe size', 'service size / condition'}
_WRAP_LABEL = re.compile(r'^(?:' + '|'.join(sorted(WRAP_COLUMNS)) + r'):\s*', re.I)
_SIZE_LABEL = re.compile(r'^(?:' + '|'.join(map(re.escape, sorted(SIZE_COLUMNS))) + r'):\s*', re.I)
_REPEATED_WRAP = re.compile(r';\s*(?:' + '|'.join(sorted(WRAP_COLUMNS)) + r'):\s*([^;\r\n]+)$', re.I)
_ESTABLISHED_FRL = re.compile(r';\s*established FRL\s+([^;\r\n]+)$', re.I)
_PLASTIC_PIPE_LABEL = re.compile(r'^Service Type:\s*Plastic Pipes\s*;\s*Service Detail:\s*', re.I)


def same_words(left, right):
    """Ignore casing and spacing without treating different units as equivalent."""
    def key(text):
        return re.sub(r'\s+', ' ', text.strip().rstrip('.').casefold())

    return key(left) == key(right)


def wrap_value(value):
    value = _WRAP_LABEL.sub('', value.strip())
    return re.sub(r'(?<=\d)\s+(?=mm\b)', '', value, flags=re.I)


def size_value(value):
    value = _SIZE_LABEL.sub('', value.strip())
    return re.sub(r'(?<=\d)\s+(?=mm\b)', '', value, flags=re.I)


def clean_configuration_text(values):
    """Simplify a copy for detail and captions when the complete value already appears separately."""
    values = dict(values)
    size = values.get(SERVICE_SIZE, '')
    wrap = values.get('Service Wrap', '')
    match = _REPEATED_WRAP.search(size)
    if match and wrap and same_words(wrap_value(match[1]), wrap_value(wrap)):
        size = size[:match.start()]
    match = _PLASTIC_PIPE_LABEL.match(size)
    if match and re.search(r'\bpipes?\b', size[match.end():].split(';', 1)[0], re.I):
        size = size[match.end():]
    if SERVICE_SIZE in values:
        values[SERVICE_SIZE] = size
    barrier = values.get(BARRIER, '')
    match = _ESTABLISHED_FRL.search(barrier)
    if match and values.get('FRL') and same_words(match[1], values['FRL']):
        values[BARRIER] = barrier[:match.start()]
    return values
