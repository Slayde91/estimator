from copy import deepcopy
import unittest
import hashlib
from unittest.mock import patch

from estimator.promat_installation_text import clean_installation_details


_PATCH = "Alternative 1 — Sample treatment: Fit a 25 mm patch with 38 mm screws."
_SEALANT = "Alternative 2 — Sample seal: Keep both faces clear; do not fill the pipe."
_REPEATED = "Sealing: Location: Wall - center, Method 1: Use the sample patch. Method 2: Keep both faces clear."
from estimator.technical_fields import normalize_technical_item
from estimator.technical_field_reviewed import review_fingerprint


class PromatInstallationTextTests(unittest.TestCase):
    def test_projection_scoped_to_reviewed_promat_and_source_unchanged(self):
        item = {'id': 'promat-example', 'title': 'Example', 'fields': [
            {'label': 'Installation Details', 'value': 'Alternative 2 — B.\n\nAlternative 1 — A.'}]}
        generic = normalize_technical_item(item)['fields']
        next(f for f in generic if f['label'] == 'Installation Details')['value'] = item['fields'][0]['value']
        item['promat_source'] = {'variant_ids': ['example']}
        item['technical_field_review'] = {'source_fields_sha256': review_fingerprint(item['fields']),
            'pre_review_fields_sha256': review_fingerprint(normalize_technical_item(item)['fields']), 'fields': deepcopy(generic)}
        original = deepcopy(item)
        result = normalize_technical_item(item)
        self.assertEqual(item, original)
        self.assertEqual(next(f['value'] for f in result['fields'] if f['label'] == 'Installation Details'),
                         'Alternative 1 — A.\n\nAlternative 2 — B.')
        del item['promat_source']
        self.assertEqual(normalize_technical_item(item)['fields'], generic)

    def test_whole_alternatives_sorted_without_renumbering_or_losing_conditions(self):
        text = 'Intro.\n\nAlternative 3 — Keep 15 mm.\n\nAlternative 1 — See Method 2.\n\nAlternative 2 — Do not fill.\n\nEnd.'
        result = clean_installation_details(text)
        self.assertEqual(result, 'Intro.\n\nAlternative 1 — See Method 2.\n\nAlternative 2 — Do not fill.\n\nAlternative 3 — Keep 15 mm.\n\nEnd.')
        self.assertEqual(clean_installation_details(result), result)

    def test_only_exact_reviewed_repetition_removed_and_location_retained(self):
        text = '\n\n'.join(['Intro.', _SEALANT, _PATCH, _REPEATED, 'Fire exposure: both sides.'])
        digest = lambda value: hashlib.sha256(value.encode("utf-8")).hexdigest()
        self.enterContext(patch("estimator.promat_installation_text._REPEATED_SHA256", digest(_REPEATED)))
        self.enterContext(patch("estimator.promat_installation_text._REQUIRED_SHA256", frozenset(map(digest, (_PATCH, _SEALANT, _REPEATED)))))
        result = clean_installation_details(text)
        self.assertEqual(result, '\n\n'.join(['Intro.', _PATCH, _SEALANT, 'Location: Wall - center.', 'Fire exposure: both sides.']))
        self.assertEqual(clean_installation_details(result), result)
        for changed in (text.replace('sample patch', 'different patch'),
                        text.replace('38 mm screws', '40 mm screws'),
                        text.replace(_PATCH, ''), text.replace(_REPEATED, _REPEATED + ' Additional condition.')):
            self.assertIn('Sealing:', clean_installation_details(changed))

    def test_ambiguous_numbering_and_separated_blocks_unchanged(self):
        for text in ('Alternative 2 — A.\n\nAlternative 2 — B.',
                     'Alternative 2 — A.\n\nAlternative 3 — B.',
                     'Alternative 2 — A.\n\nSeparate condition.\n\nAlternative 1 — B.'):
            self.assertEqual(clean_installation_details(text), text)
