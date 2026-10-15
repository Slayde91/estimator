import unittest

from estimator.catalog import ValidationError
from estimator.download_progress import DownloadProgress


class DownloadProgressTests(unittest.TestCase):
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
