"""Regression checks: python -m unittest discover -s tests -p 'test_skybob*.py'."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from skybob import core, site
from skybob.pdf import render_dossier_pdf


def sample_payload():
    evidence = [{
        "id": f"e{i}", "auditStatus": "approved", "quote": "",
        "evidenceType": "fact", "sourceUrls": [f"https://empresa.example/prova/{i}"],
    } for i in range(12)]
    return {
        "companyName": "Empresa de Exemplo & Soluções Digitais", "city": "São Paulo, SP",
        "completedAt": "2026-10-09T12:00:00+00:00",
        "counts": {"sources": 12, "approved": 12, "discarded": 3, "searches": 10},
        "evidence": evidence,
        "report": {
            "cover_line": "Autoridade declarada precisa resistir ao confronto com evidências.",
            "opening": "A empresa apresenta uma identidade visual consistente e informações de contato. A investigação examinou o que esses sinais conseguem sustentar fora dos canais controlados pela marca. Os pontos abaixo distinguem declarações próprias de validação externa.",
            "surface_strengths": ["Marca e endereço consistentes nos canais consultados.", "Serviços e meios de contato publicados no site oficial."],
            "findings": [{
                "title": f"Achado {i + 1}: resultados publicados ainda precisam de contexto verificável",
                "category": "Autoridade e reputação digital",
                "body": "O material encontrado descreve os serviços e apresenta resultados. As fontes consultadas não forneceram contexto suficiente para atribuir esses resultados a um caso específico. Esse limite da evidência foi mantido na conclusão, sem afirmar que a empresa não tem resultados reais.",
                "evidence_ids": [f"e{i}"],
            } for i in range(5)],
            "social_proof": ["Os depoimentos próprios ajudam na primeira impressão, mas não equivalem a validação independente.", "A investigação não permite tratar um relato isolado como padrão de atendimento."],
            "promise_matrix": [{"claim": "Experiência no segmento e resultados comprovados", "evidence": "O site descreve a experiência, mas as fontes consultadas não associam cada resultado a um caso verificável.", "status": "partially_supported", "evidence_ids": ["e1"]}, {"claim": "Informações de contato acessíveis", "evidence": "Endereço e canais de atendimento publicados nas páginas consultadas diretamente.", "status": "supported", "evidence_ids": ["e2"]}],
            "authority_bullets": ["A descrição dos serviços é consistente; a validação externa exige mais contexto."],
            "ai_visibility_bullets": ["As fontes permitem associar a marca à cidade e ao segmento, sem comprovar recomendações por ferramentas de IA."],
            "synthesis_bullets": ["A identidade digital apresenta sinais consistentes.", "Os resultados declarados possuem limites de comprovação no material consultado.", "As evidências não sustentam acusações de irregularidade."],
            "hidden_next_steps": [{"title": "SEGREDO_INTERNO", "detail": "NÃO_PUBLICAR_ESTRATÉGIA", "front": front} for front in ["Site", "Prova social", "Autoridade", "Reputação"]],
            "final_line": "As evidências estão documentadas. A estratégia de correção é outra etapa.",
        },
    }


class PdfTests(unittest.TestCase):
    def pdf_text(self, payload):
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(render_dossier_pdf(payload)))
        return reader, "\n".join(page.extract_text() for page in reader.pages)

    def test_compact_report_keeps_content_and_hides_strategy(self):
        reader, text = self.pdf_text(sample_payload())
        self.assertLessEqual(len(reader.pages), 4)
        self.assertIn("Achado 5", text)
        self.assertIn("[12]", text)
        self.assertIn("CONTEÚDO BLOQUEADO", text)
        self.assertNotIn("SEGREDO_INTERNO", text)
        self.assertNotIn("NÃO_PUBLICAR_ESTRATÉGIA", text)
        for page in reader.pages:
            self.assertGreater(len(page.extract_text()), 200)

    def test_long_titles_and_body_continue_without_loss(self):
        payload = sample_payload()
        payload["report"]["findings"] = [{
            "title": "Título extenso de investigação com sinais distintos e dados contextualizados " * 3,
            "category": "Categoria extensa que deve ocupar mais de uma linha sem cortar palavras " * 2,
            "body": "Texto longo com contexto verificável. " * 350 + " FIM_DO_ACHADO",
            "evidence_ids": ["e0"],
        }]
        _, text = self.pdf_text(payload)
        self.assertIn("FIM_DO_ACHADO", text)
        self.assertIn("continuação", text)

    def test_oversized_matrix_row_splits(self):
        payload = sample_payload()
        payload["report"]["promise_matrix"][0]["evidence"] = "Evidência contextualizada em uma linha longa de tabela. " * 350 + " FIM_DA_MATRIZ"
        _, text = self.pdf_text(payload)
        self.assertIn("FIM_DA_MATRIZ", text)

    def test_sparse_report_has_no_placeholder_sections(self):
        payload = sample_payload()
        payload["report"] = {"cover_line": "Análise concluída", "opening": "As fontes não confirmaram fragilidades.", "final_line": "A investigação foi preservada."}
        payload["evidence"] = []
        reader, text = self.pdf_text(payload)
        self.assertEqual(len(reader.pages), 1)
        self.assertNotIn("Prova social sob pressão", text)
        self.assertNotIn("CONTEÚDO BLOQUEADO", text)

    def test_all_findings_sources_and_long_urls_are_preserved(self):
        payload = sample_payload()
        for i in range(12, 50):
            payload["evidence"].append({"id": f"e{i}", "auditStatus": "approved", "sourceUrls": [f"https://empresa.example/referencia/{i}/" + "abc" * 100]})
        payload["report"]["findings"] += [{"title": f"Achado adicional {i}", "category": "Dados", "body": "Conteúdo aprovado pelo auditor.", "evidence_ids": ["e0"]} for i in range(6, 13)]
        _, text = self.pdf_text(payload)
        self.assertIn("Achado adicional 12", text)
        self.assertIn("[50]", text)

    def test_text_stays_inside_horizontal_margins(self):
        import pdfplumber
        payload = sample_payload()
        payload["report"]["findings"][0]["title"] *= 3
        with pdfplumber.open(io.BytesIO(render_dossier_pdf(payload))) as pdf:
            for page in pdf.pages:
                for char in page.chars:
                    self.assertGreaterEqual(char["x0"], 49, repr(char))
                    self.assertLessEqual(char["x1"], page.width - 49, repr(char))
                    self.assertGreaterEqual(char["top"], 0)
                    self.assertLessEqual(char["bottom"], page.height)


class SiteTests(unittest.TestCase):
    def test_normalize_and_reject_unsafe_urls(self):
        self.assertEqual(site.normalize_url("empresa.example"), "https://empresa.example/")
        for value in ("file:///etc/passwd", "https://user:pass@empresa.example", "http://empresa.example:9000", "https://empresa.example\\@localhost"):
            self.assertEqual(site.normalize_url(value), "")

    def test_private_addresses_are_rejected(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"):
            with patch.object(site.socket, "getaddrinfo", return_value=[(0, 0, 0, "", (address, 443))]):
                with self.assertRaises(ValueError):
                    site._public_addresses("empresa.example", 443)

    def test_proxy_rejects_private_literals_without_dns(self):
        for target in ("https://127.0.0.1/", "http://169.254.169.254/", "http://localhost/", "http://secret.internal/"):
            with self.assertRaises(ValueError):
                site._validate_proxy_target(target)

    def test_html_extracts_text_and_structured_data(self):
        parsed = site._parse_page({"url": "https://empresa.example/", "html": '<title>Minha empresa</title><meta name="description" content="Serviços"><script>SEGREDO_JS</script><style>SEGREDO_CSS</style><script type="application/ld+json">{"@type":"Organization","name":"Empresa"}</script><h1>Empresa</h1><p>Contato e endereço</p><a href="/sobre">Sobre</a>'})
        self.assertIn("Contato e endereço", parsed["text"])
        self.assertNotIn("SEGREDO", parsed["text"])
        self.assertEqual(parsed["structuredData"][0]["@type"], "Organization")
        self.assertIn("/sobre", parsed["links"])

    def test_follows_only_relevant_internal_links(self):
        responses = []

        def fetch(url, _timeout):
            responses.append(url)
            return {"url": url, "httpStatus": 200, "contentType": "text/html; charset=utf-8", "html": '<title>Empresa</title><p>' + "Informações públicas verificáveis da empresa. " * 10 + '</p><a href="/sobre">Sobre</a><a href="https://terceiro.example/contato">Terceiro</a>'}

        with patch.object(site, "_request", side_effect=fetch):
            result = site.collect_site("https://empresa.example", max_pages=2)
        self.assertEqual(result["status"], "readable")
        self.assertEqual(responses, ["https://empresa.example/", "https://empresa.example/sobre"])

    def test_403_is_collection_limitation(self):
        with patch.object(site, "_request", side_effect=lambda url, _timeout: {"url": url, "httpStatus": 403, "contentType": "text/html", "html": "Forbidden"}):
            result = site.collect_site("https://empresa.example")
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["pages"], [])

    def test_js_only_page_uses_optional_renderer(self):
        page = {"url": "https://empresa.example/", "title": "Empresa", "text": "Conteúdo público renderizado. " * 30, "links": [], "method": "browser"}
        with patch.object(site, "_request", return_value={"url": page["url"], "httpStatus": 200, "contentType": "text/html", "html": "<div id='app'></div>"}), patch.object(site, "_render_page", return_value=page):
            result = site.collect_site(page["url"], max_pages=1)
        self.assertEqual(result["status"], "readable")
        self.assertEqual(result["pages"][0]["method"], "browser")


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = core.Store(Path(self.directory.name), lambda: "test-key")
        self.created = self.store.create({"companyName": "Empresa", "city": "São Paulo, SP", "googleUrl": "https://maps.google.com/test", "siteUrl": "empresa.example"})
        self.id = self.created["id"]

    def set_stage(self, stage, status="running"):
        with self.store.connect() as db:
            db.execute("UPDATE investigations SET current_stage=?,stage_index=?,status=?,site_collection_json=? WHERE id=?", (stage, core.STAGE_ORDER.index(stage), status, json.dumps({"status": "readable", "pages": []}), self.id))

    def test_empty_report_is_actually_empty(self):
        self.assertEqual(self.created["report"], {})

    def test_retry_keeps_remote_response_after_connection_failure(self):
        self.set_stage("presence", "failed")
        with self.store.connect() as db:
            db.execute("INSERT INTO searches(id,investigation_id,stage,prompt,status,response_id,model,created_at,updated_at) VALUES(?,?,?,'','running','resp_saved','model',?,?)", ("query", self.id, "presence", core.now(), core.now()))
        resumed = self.store.action(self.id, "retry")
        self.assertEqual(resumed["status"], "queued")
        self.assertEqual(self.store._stage_row(self.id, "presence")["response_id"], "resp_saved")

    def test_identity_can_be_corrected(self):
        self.set_stage("identity", "needs_review")
        updated = self.store.action(self.id, "retry", {"company": {"companyName": "Nome corrigido", "city": "Lisboa, Portugal", "googleUrl": "maps.google.com/corrigido", "siteUrl": "beandani.pt"}})
        self.assertEqual(updated["companyName"], "Nome corrigido")
        self.assertEqual(updated["siteCollection"]["status"], "pending")
        self.assertEqual(updated["siteUrl"], "https://beandani.pt/")

    def test_retry_ambiguous_identity_repeats_the_actual_search(self):
        self.set_stage("identity", "needs_review")
        with self.store.connect() as db:
            db.execute("INSERT INTO searches(id,investigation_id,stage,prompt,status,response_id,model,created_at,updated_at) VALUES(?,?,'identity','','completed','resp_ambiguous','model',?,?)", ("identity-query", self.id, core.now(), core.now()))
        self.store.action(self.id, "retry")
        self.assertIsNone(self.store._stage_row(self.id, "identity"))

    def test_equivalent_source_urls_do_not_lose_evidence(self):
        data = {"evidence": [{"title": "Contato", "finding": "Contato público no site.", "evidence_type": "fact", "verdict": "confirmed", "severity": "low", "source_urls": ["https://empresa.example/"], "subject_match": "confirmed"}]}
        self.store._insert_evidence(self.id, "presence", data, {"https://empresa.example"})
        item = self.store.detail(self.id)["evidence"][0]
        self.assertEqual(item["verdict"], "confirmed")
        self.assertEqual(item["sourceUrls"], ["https://empresa.example/"])

    def test_cancelled_report_cannot_be_revived_by_late_response(self):
        self.set_stage("closer")

        def finish(*_args, **_kwargs):
            self.store.action(self.id, "cancel")
            return {"parsed": sample_payload()["report"]}

        with patch.object(self.store, "_submit_or_poll", side_effect=finish):
            self.store.process_next()
        self.assertEqual(self.store.detail(self.id)["status"], "cancelled")
        self.assertEqual(self.store.detail(self.id)["report"], {})

    def test_audits_every_item_in_multiple_batches(self):
        self.set_stage("audit")
        with self.store.connect() as db:
            for index in range(107):
                db.execute("INSERT INTO evidence(id,investigation_id,stage,title,finding,evidence_type,verdict,severity,source_urls_json,subject_match,created_at) VALUES(?,?,'presence','Achado','Contexto','fact','confirmed','low',?,'confirmed',?)", (f"item{index}", self.id, json.dumps(["https://empresa.example/"]), core.now()))
        sizes = []

        def audit(_investigation, _stage, prompt, *_args):
            batch = json.loads(prompt.split("EVIDÊNCIAS:\n", 1)[1])
            sizes.append(len(batch))
            return {"parsed": {"audit_summary": "Lote auditado.", "items": [{"evidence_id": item["evidence_id"], "decision": "approved", "verdict": "confirmed", "severity": "low", "note": "Fonte e identidade confirmadas."} for item in batch]}}

        with patch.object(self.store, "_submit_or_poll", side_effect=audit):
            self.store.process_next()
        detail = self.store.detail(self.id)
        self.assertEqual(sizes, [35, 35, 35, 2])
        self.assertEqual(detail["counts"]["approved"], 107)
        self.assertEqual(detail["currentStage"], "closer")

    def test_new_analysis_preserves_original(self):
        self.set_stage("closer", "completed")
        new = self.store.action(self.id, "reinvestigate")
        self.assertNotEqual(new["id"], self.id)
        self.assertEqual(self.store.detail(self.id)["status"], "completed")

    def test_duplicate_sources_have_one_visible_reference(self):
        for stage in ("identity", "presence", "trust"):
            self.store._insert_sources(self.id, stage, [{"url": "https://empresa.example/", "title": "Empresa"}])
        detail = self.store.detail(self.id)
        self.assertEqual(len(detail["sources"]), 1)
        self.assertEqual(len(detail["sources"][0]["stages"]), 3)
        self.assertEqual(detail["counts"]["sources"], 1)


if __name__ == "__main__":
    unittest.main()
