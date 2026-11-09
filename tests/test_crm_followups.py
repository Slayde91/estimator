from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.contacts import ContactsConflict, ContactsStore


class LeadFollowupsTests(unittest.TestCase):
    def test_optional_fields_survive_old_forms_and_stale_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = ContactsStore(Path(tmp) / "directory.sqlite3")
            fields = {"name": "Sam", "company": "Sample", "phone": "111", "email": "sam@example.test",
                      "site_address": "East", "next_action": "Call", "follow_up_date": "2028-02-29"}
            result = store.save("leads", {"fields": fields, "version": 0})
            fields.pop("next_action")
            fields.pop("follow_up_date")
            def edit(version, **updates):
                return store.save("leads", {"id": result["id"], "fields": {**fields, **updates}, "version": version})
            def followup():
                lead, = store.list()["leads"]
                return lead["next_action"], lead["follow_up_date"]
            edit(1, status="Qualified")
            self.assertEqual(followup(), ("Call", "2028-02-29"))
            with self.assertRaises(ContactsConflict):
                edit(1, next_action="Stale")
            for invalid in ("2027-02-29", "20281109", "2028-W01-2"):
                with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                    edit(2, next_action="New", follow_up_date=invalid)
            self.assertEqual(followup(), ("Call", "2028-02-29"))
            edit(2, next_action="Email")
            self.assertEqual(followup(), ("Email", "2028-02-29"))
            edit(3, follow_up_date="", next_action="")
            self.assertEqual(followup(), ("", ""))
            with store.connection() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM lead_followups").fetchone()[0], 0)
