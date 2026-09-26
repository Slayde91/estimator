"""HTTP security policy coverage for the optional browser annotation workaround."""

import http.client
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from estimator.server import create_server, main


STRICT_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
ANNOTATION_POLICY = STRICT_POLICY + "; style-src-elem 'self' 'unsafe-inline'"


class ContentSecurityPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        directory = Path(cls.temp.name)
        # Create the opt-in server first, then a normal instance. Each must keep
        # its own policy even while both instances are serving requests.
        cls.annotation_server = create_server(
            0, directory / "annotation.sqlite3", library_directory=directory / "library",
            allow_annotation_styles=True,
        )
        cls.strict_server = create_server(
            0, directory / "strict.sqlite3", library_directory=directory / "library",
        )
        cls.threads = []
        for server in (cls.annotation_server, cls.strict_server):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.threads.append(thread)

    @classmethod
    def tearDownClass(cls):
        for server in (cls.annotation_server, cls.strict_server):
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join()
        cls.temp.cleanup()

    def request(self, server, path, *, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=30)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            response.read()
            return response.status, dict(response.getheaders())
        finally:
            connection.close()

    def test_default_policy_is_unchanged_on_html_api_and_errors(self):
        for path, expected_status in (("/", 200), ("/api/configuration", 200), ("/missing", 404)):
            with self.subTest(path=path):
                status, headers = self.request(self.strict_server, path)
                self.assertEqual(status, expected_status)
                self.assertEqual(headers["Content-Security-Policy"], STRICT_POLICY)
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["Referrer-Policy"], "no-referrer")

    def test_opt_in_changes_only_stylesheet_elements_without_leaking_to_other_servers(self):
        for path in ("/", "/api/configuration", "/missing"):
            with self.subTest(path=path):
                _, annotation_headers = self.request(self.annotation_server, path)
                _, strict_headers = self.request(self.strict_server, path)
                self.assertEqual(annotation_headers["Content-Security-Policy"], ANNOTATION_POLICY)
                self.assertEqual(strict_headers["Content-Security-Policy"], STRICT_POLICY)

    def test_loopback_binding_and_cross_origin_rejection_remain_in_both_modes(self):
        for server, expected_policy in ((self.strict_server, STRICT_POLICY), (self.annotation_server, ANNOTATION_POLICY)):
            self.assertEqual(server.server_address[0], "127.0.0.1")
            for untrusted in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"}, {"Origin": "null"}):
                with self.subTest(policy=expected_policy, headers=untrusted):
                    status, headers = self.request(
                        server, "/api/configuration", method="POST", body="{}",
                        headers={"Content-Type": "application/json", **untrusted},
                    )
                    self.assertEqual(status, 403)
                    self.assertEqual(headers["Content-Security-Policy"], expected_policy)


class AnnotationStylesCommandLineTests(unittest.TestCase):
    def test_cli_defaults_to_strict_policy_without_a_compatibility_warning(self):
        server = Mock(server_port=8765)
        with patch("sys.argv", ["estimator"]), patch("estimator.server.create_server", return_value=server) as create, patch("estimator.server.LOGGER.warning") as warning, patch("builtins.print"):
            main()
        create.assert_called_once_with(8765, None, library_directory=None, allow_annotation_styles=False)
        warning.assert_not_called()
        server.serve_forever.assert_called_once_with()
        server.server_close.assert_called_once_with()

    def test_cli_requires_explicit_flag_and_reports_stylesheet_permission(self):
        server = Mock(server_port=8766)
        with patch("sys.argv", ["estimator", "--port", "8766", "--allow-annotation-styles"]), patch("estimator.server.create_server", return_value=server) as create, patch("estimator.server.LOGGER.warning") as warning, patch("builtins.print"):
            main()
        create.assert_called_once_with(8766, None, library_directory=None, allow_annotation_styles=True)
        warning.assert_called_once()
        self.assertIn("inline stylesheet elements are allowed", warning.call_args.args[0])
        self.assertIn("Inline scripts and style attributes remain blocked", warning.call_args.args[0])
        server.serve_forever.assert_called_once_with()
        server.server_close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
