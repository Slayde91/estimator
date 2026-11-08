"""Conversion minimums guard the saved snapshot before any Project allocation."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from estimator.catalog import ValidationError
from estimator.contacts import ContactsConflict, ContactsStore, CONVERSION_REQUIRED_MESSAGE


class LeadConversionRequirementsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = ContactsStore(Path(temporary.name) / "contacts.sqlite3")
        self.fields = {"name": "Saved Person", "phone": "0400", "company": "Saved Company",
                       "email": "saved@example.test", "site_address": "10 Saved Street"}
        saved = self.store.save("leads", {"version": 0, "fields": self.fields})
        self.ident = saved["id"]
        self.body = {"id": self.ident, "version": saved["version"]}

    def test_each_required_value_is_checked_before_callback_without_any_directory_writes(self):
        original = self.store.list()["leads"][0]
        for key in ("name", "phone", "company", "email", "site_address"):
            for missing in ("", " \t\n "):
                with self.subTest(field=key, value=missing):
                    with self.store.connection() as db:
                        if key == "site_address":
                            db.execute("UPDATE leads SET site_address=? WHERE id=?", (missing, self.ident))
                        else:
                            snapshot = {name: original[name] for name in ("name", "phone", "company", "title", "email", "abn_acn", "account_id")}
                            snapshot[key] = missing
                            db.execute("UPDATE leads SET person_snapshot=? WHERE id=?", (json.dumps(snapshot), self.ident))
                    before = deepcopy(self.store.list())
                    create = Mock()
                    with self.assertRaisesRegex(ValidationError, "Complete Name, Phone, Company, Email and Site address"):
                        self.store.convert(self.body, create)
                    create.assert_not_called()
                    self.assertEqual(self.store.list(), before)
                    with self.store.connection() as db:
                        self.assertEqual(db.execute("SELECT count(*) FROM converted_leads").fetchone()[0], 0)
                        db.execute("UPDATE leads SET site_address=?,person_snapshot=? WHERE id=?",
                                   (original["site_address"], json.dumps({name: original[name] for name in ("name", "phone", "company", "title", "email", "abn_acn", "account_id")}), self.ident))

    def test_complete_saved_snapshot_survives_later_canonical_contact_changes_and_replays(self):
        lead = self.store.list()["leads"][0]
        # Canonical Contact edits do not erase valid Lead-specific details.
        self.store.save("contacts", {"id": lead["contact_id"], "version": 1,
                                      "fields": {"name": "Changed Person", "company": "Changed Company"}})
        self.body["version"] = 2
        create = Mock(return_value={"project_no": "PN-01", "path": "fixture/PN-01.cf.json"})
        result = self.store.convert(self.body, create)
        self.assertEqual(create.call_args.args[0]["phone"], "0400")
        self.assertEqual(create.call_args.args[0]["company"], "Saved Company")
        self.assertEqual(self.store.convert({**self.body, "version": -1}, create), result)
        create.assert_called_once()

    def test_old_join_based_lead_is_checked_and_existing_receipt_remains_replayable(self):
        lead = self.store.list()["leads"][0]
        with self.store.connection() as db:
            db.execute("UPDATE leads SET person_snapshot=NULL WHERE id=?", (self.ident,))
            db.execute("UPDATE contacts SET phone='' WHERE id=?", (lead["contact_id"],))
        create = Mock()
        with self.assertRaises(ValidationError) as raised:
            self.store.convert(self.body, create)
        self.assertEqual(str(raised.exception), CONVERSION_REQUIRED_MESSAGE)
        create.assert_not_called()
        with self.store.connection() as db:
            db.execute("INSERT INTO converted_leads VALUES(?,?,?,?,?)",
                       (self.ident, lead["contact_id"], lead["account_id"], "PN-LEGACY", "fixture/legacy.cf.json"))
            db.execute("DELETE FROM leads WHERE id=?", (self.ident,))
        self.assertEqual(self.store.convert({**self.body, "version": -1}, create),
                         {"project_no": "PN-LEGACY", "path": "fixture/legacy.cf.json"})
        create.assert_not_called()

    def test_stale_version_still_fails_before_callback_and_partial_leads_remain_saveable(self):
        saved = self.store.save("leads", {"version": 1, "fields": {"name": "Partial", "company": "Draft"}})
        self.assertEqual(len(self.store.list()["leads"]), 2)
        create = Mock()
        with self.assertRaises(ContactsConflict):
            self.store.convert({"id": saved["id"], "version": 1}, create)
        create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
