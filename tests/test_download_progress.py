import unittest

from estimator.catalog import ValidationError
from estimator.download_progress import DownloadProgress
from estimator.crm_access import download_route


class DownloadProgressTests(unittest.TestCase):
    def test_frozen_revision_export_paths_can_claim_one_progress_receipt(self):
        identity='12345678-1234-4234-8234-123456789abc'
        for route in [f'/api/certifications/{identity}/revisions/1.pdf',
                      f'/api/certifications/{identity}/revisions/9999999999.pdf',
                      f'/api/documentation/{identity}']:
            with self.subTest(route=route):
                self.assertTrue(download_route(route))
                progress=DownloadProgress();token=progress.begin()['token'];progress.claim(token)
                progress.update(token,100,'saved')
                self.assertEqual(progress.read(token),{'percent':100,'state':'saved'})
                with self.assertRaises(ValidationError):progress.claim(token)

    def test_frozen_export_patterns_reject_malformed_and_mutation_paths(self):
        identity='12345678-1234-4234-8234-123456789abc'
        roots=[f'/api/certifications/{identity}/revisions/1.pdf',f'/api/documentation/{identity}']
        invalid=[f'/api/certifications/{identity}', '/api/certifications',
                 f'/api/certifications/{identity}/delete',f'/api/documentation/{identity}/delete',
                 f'/api/documentation/{"a"*36}',f'/api/documentation/{identity.upper()}',
                 f'/api/certifications/{identity.upper()}/revisions/1.pdf',
                 '/api/certifications/not-a-uuid/revisions/1.pdf']
        invalid.extend(f'/api/certifications/{identity}/revisions/{revision}.pdf'
                       for revision in ['0','01','-1','1.0','10000000000','%31','1%2F2'])
        invalid.extend(path+suffix for path in roots for suffix in ['/','/extra','%2Fextra','?workspace=other','#fragment'])
        invalid.extend(path.replace(identity,identity.replace('-','%2d',1)) for path in roots)
        for route in invalid:
            with self.subTest(route=route):self.assertFalse(download_route(route))

    def test_single_use_measured_pages_and_completion_authority(self):
        progress = DownloadProgress()
        token = progress.begin()['token']
        self.assertEqual(progress.read(token), {'percent': 0, 'state': 'waiting'})
        progress.claim(token)
        progress.pages(token, 1, 3)
        self.assertEqual(progress.read(token), {'percent': 35, 'state': 'preparing'})
        progress.pages(token, 0, 3)
        self.assertEqual(progress.read(token)['percent'], 35)
        progress.update(token, 90, 'saving')
        self.assertEqual(progress.read(token)['percent'], 90)
        progress.update(token, 100, 'saved')
        progress.update(token, 0, 'failed')
        self.assertEqual(progress.read(token), {'percent': 100, 'state': 'saved'})
        with self.assertRaises(ValidationError):
            progress.claim(token)

    def test_bounded_active_receipts_expiration_and_failure(self):
        now = [0]
        progress = DownloadProgress(clock=lambda: now[0], limit=1, ttl=60)
        token = progress.begin()['token']
        with self.assertRaises(ValidationError):
            progress.begin()
        progress.claim(token)
        progress.update(token, 0, 'failed')
        self.assertEqual(progress.read(token)['state'], 'failed')
        replacement = progress.begin()['token']
        with self.assertRaises(ValidationError):
            progress.read(token)
        now[0] = 60
        with self.assertRaises(ValidationError):
            progress.read(replacement)
        self.assertEqual(progress.begin()['percent'], 0)

    def test_invalid_page_counts_and_unknown_tokens_fail_closed(self):
        progress = DownloadProgress()
        token = progress.begin()['token']
        progress.claim(token)
        for completed, total in ((2, 1), (-1, 2), (0, 0), (1.5, 2)):
            with self.assertRaises(ValidationError):
                progress.pages(token, completed, total)
        with self.assertRaises(ValidationError):
            progress.claim('invented')


if __name__ == '__main__':
    unittest.main()
