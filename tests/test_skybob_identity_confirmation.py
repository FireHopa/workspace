"""Manual identity confirmation: no repeated query, no unsupported facts."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from skybob import core


class IdentityConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = core.Store(Path(self.directory.name), lambda: "test-key")
        self.company = {
            "companyName": "Beandani", "city": "Estarreja, Portugal",
            "googleUrl": "https://maps.google.com/test", "siteUrl": "https://beandani.pt/",
        }
        self.created = self.store.create(self.company)
        self.id = self.created["id"]
        self.automatic = {
            "status": "ambiguous", "canonicalName": "Outra empresa",
            "city": "Outra cidade", "address": "Endereço não confirmado",
            "aliases": ["Homônimo"], "website": "https://outro.example/",
            "reason": "Site lido, mas a cidade e o perfil Google não foram confirmados.",
        }

    def awaiting_confirmation(self, status="ambiguous"):
        self.automatic["status"] = status
        with self.store.connect() as db:
            db.execute(
                "UPDATE investigations SET status='needs_review',identity_json=?,site_collection_json=?,error='Confira os dados',progress=8 WHERE id=?",
                (json.dumps(self.automatic), json.dumps({"status": "readable", "pages": []}), self.id),
            )

    def confirm(self, **overrides):
        return self.store.action(self.id, "confirm_identity", {"confirmed": True, "company": self.company, **overrides})

    def test_confirmation_preserves_history_and_advances_to_research(self):
        self.awaiting_confirmation()
        with self.store.connect() as db:
            db.execute(
                "INSERT INTO searches(id,investigation_id,stage,prompt,status,response_id,model,created_at,updated_at) VALUES(?,?,'identity','','completed','resp_saved','model',?,?)",
                ("identity-query", self.id, core.now(), core.now()),
            )
        self.store._insert_sources(self.id, "website", [{"url": self.company["siteUrl"], "title": "Site consultado"}])
        result = self.confirm()
        self.assertEqual((result["status"], result["currentStage"]), ("queued", "presence"))
        self.assertEqual(result["error"], "")
        self.assertEqual(result["siteCollection"]["status"], "readable")
        self.assertEqual(result["identity"]["confirmationMethod"], "manual")
        self.assertTrue(result["identity"]["confirmedAt"])
        self.assertEqual(result["identity"]["canonicalName"], self.company["companyName"])
        self.assertEqual(result["identity"]["city"], self.company["city"])
        self.assertEqual(result["identity"]["website"], self.company["siteUrl"])
        self.assertEqual(result["identity"]["address"], "")
        self.assertEqual(result["identity"]["aliases"], [])
        self.assertEqual(result["identity"]["automatedCheck"], self.automatic)
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(self.store._stage_row(self.id, "identity")["response_id"], "resp_saved")
        with patch.object(core, "collect_site") as collect, patch.object(self.store, "_submit_or_poll", return_value=None) as submit:
            self.store.process_next()
        collect.assert_not_called()
        self.assertEqual(submit.call_args.args[1], "presence")
        self.assertIn('"confirmationMethod": "manual"', submit.call_args.args[2])
        self.assertIn(self.company["city"], submit.call_args.args[2])

    def test_no_public_identity_match_can_be_confirmed_by_owner(self):
        self.awaiting_confirmation("not_found")
        self.assertEqual(self.confirm()["identity"]["automatedCheck"]["status"], "not_found")

    def test_explicit_acknowledgement_and_all_four_fields_are_required(self):
        self.awaiting_confirmation()
        for payload in [None, {}, {"confirmed": True}, {"confirmed": "true", "company": self.company}, {"confirmed": False, "company": self.company}, {"confirmed": True, "company": "invalid"}]:
            with self.subTest(payload=payload), self.assertRaises(core.SkybobError):
                self.store.action(self.id, "confirm_identity", payload)
            self.assertEqual(self.store.detail(self.id)["status"], "needs_review")

    def test_changed_company_snapshot_is_rejected(self):
        self.awaiting_confirmation()
        for key in self.company:
            changed = {**self.company, key: "https://different.example/" if key.endswith("Url") else "Outro dado"}
            with self.subTest(key=key), self.assertRaises(core.SkybobError) as error:
                self.confirm(company=changed)
            self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.detail(self.id)["identity"], self.automatic)

    def test_only_a_review_at_the_identity_stage_can_be_confirmed(self):
        for status, stage in [("queued", "identity"), ("running", "identity"), ("failed", "identity"), ("cancelled", "identity"), ("completed", "closer"), ("needs_review", "presence")]:
            with self.store.connect() as db:
                db.execute("UPDATE investigations SET status=?,current_stage=?,stage_index=? WHERE id=?", (status, stage, core.STAGE_ORDER.index(stage), self.id))
            with self.subTest(status=status, stage=stage), self.assertRaises(core.SkybobError) as error:
                self.confirm()
            self.assertEqual(error.exception.status, 409)
            self.assertEqual(self.store.detail(self.id)["status"], status)

    def test_duplicate_confirmation_does_not_advance_twice(self):
        self.awaiting_confirmation()
        first = self.confirm()
        with self.assertRaises(core.SkybobError):
            self.confirm()
        self.assertEqual(self.store.detail(self.id)["identity"], first["identity"])
        self.assertEqual(self.store.detail(self.id)["currentStage"], "presence")

    def test_existing_investigation_accepts_its_original_url_format(self):
        self.awaiting_confirmation()
        with self.store.connect() as db:
            db.execute("UPDATE investigations SET site_url=? WHERE id=?", ("https://beandani.pt", self.id))
        result = self.confirm(company={**self.company, "siteUrl": "https://beandani.pt"})
        self.assertEqual(result["currentStage"], "presence")

    def test_resume_keeps_confirmation_and_new_analysis_does_not_inherit_it(self):
        self.awaiting_confirmation()
        identity = self.confirm()["identity"]
        self.store.action(self.id, "cancel")
        resumed = self.store.action(self.id, "retry")
        self.assertEqual(resumed["currentStage"], "presence")
        self.assertEqual(resumed["identity"], identity)
        new = self.store.action(self.id, "reinvestigate")
        self.assertEqual(new["currentStage"], "identity")
        self.assertEqual(new["identity"], {})

    def test_late_identity_response_cannot_overwrite_manual_confirmation(self):
        with self.store.connect() as db:
            db.execute("UPDATE investigations SET site_collection_json=? WHERE id=?", (json.dumps({"status": "readable", "pages": []}), self.id))

        def late_response(*_args, **_kwargs):
            self.awaiting_confirmation()
            self.confirm()
            return {"parsed": {"status": "ambiguous", "reason": "Resposta antiga"}, "sources": []}

        with patch.object(self.store, "_submit_or_poll", side_effect=late_response):
            self.store.process_next()
        result = self.store.detail(self.id)
        self.assertEqual(result["currentStage"], "presence")
        self.assertEqual(result["identity"]["confirmationMethod"], "manual")


if __name__ == "__main__":
    unittest.main()
