"""Default filenames for inspection, register and issued document revisions."""
import re

from .document_numbers import valid_reference


INSPECTION_DOCUMENT_FILENAMES = {
    'passive_fire_register.pdf': 'PASSIVE_FIRE_INSPECTIONS.pdf',
    'passive_fire_registers.pdf': 'PASSIVE_FIRE_REGISTER.pdf',
    'duct_inspections.pdf': 'DUCT_INSPECTIONS.pdf',
    'duct_register.pdf': 'DUCT_REGISTER.pdf',
    'structural_steel_inspections.pdf': 'STEEL_INSPECTIONS.pdf',
    'structural_steel_register.pdf': 'STEEL_REGISTER.pdf',
    'passive_fire_registers.xlsx': 'PASSIVE_FIRE_REGISTER.xlsx',
    'duct_register.xlsx': 'DUCT_REGISTER.xlsx',
    'structural_steel_register.xlsx': 'STEEL_REGISTER.xlsx',
}

_PREVIOUS_PREFIXES = {
    'commercial.quote': 'Quote-',
    'commercial.work_order': 'Work-Order-',
    'commercial.purchase_order': 'Purchase-Order-',
    'swms': 'SAFE-WORK-METHOD-STATEMENT-',
}
REVISION_FILENAME_KINDS = frozenset(INSPECTION_DOCUMENT_FILENAMES | _PREVIOUS_PREFIXES)


def revision_filename(kind, filename, revision=None):
    """Name a fresh export using the recorded revision when one is available."""
    if kind not in REVISION_FILENAME_KINDS:
        return filename
    if revision is None:
        return INSPECTION_DOCUMENT_FILENAMES.get(kind, filename)
    if type(revision) is not int or revision < 1:
        raise ValueError('A download revision must be a positive integer.')
    if kind in INSPECTION_DOCUMENT_FILENAMES:
        stem, _, extension = INSPECTION_DOCUMENT_FILENAMES[kind].rpartition('.')
        return f'{stem}-{revision}.{extension}'
    if not filename.endswith('.pdf'):
        return filename

    reference = filename.removesuffix('.pdf').removeprefix(_PREVIOUS_PREFIXES[kind])
    if not valid_reference(reference):
        number, _, ordinal = reference.rpartition('-')
        if not valid_reference(number) or not re.fullmatch(r'R?[1-9][0-9]*', ordinal):
            return filename
        reference = number
    return f'{reference}-{revision}.pdf'


def has_revision_filename(kind, filename, revision):
    """Recognize an exact numeric revision name without reinterpreting legacy names."""
    if kind in INSPECTION_DOCUMENT_FILENAMES:
        return filename == revision_filename(kind, filename, revision)
    if kind in _PREVIOUS_PREFIXES:
        return is_numbered_revision_filename(filename) and filename.endswith(f'-{revision}.pdf')
    return False


def is_numbered_revision_filename(filename):
    """Recognize filenames built from a document reference and numeric revision."""
    if not isinstance(filename, str):
        return False
    reference, _, ordinal = filename.rpartition('-')
    return valid_reference(reference) and bool(re.fullmatch(r'[1-9][0-9]*\.pdf', ordinal))
