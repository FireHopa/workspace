"""Aplicação automática de identificações confiáveis e revisão manual das exceções."""
from __future__ import annotations

import json

from . import core

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS niche_suggestions(
 id TEXT PRIMARY KEY REFERENCES tasks(id), company_id TEXT NOT NULL REFERENCES companies(id),
 job_id TEXT NOT NULL REFERENCES jobs(id), status TEXT NOT NULL DEFAULT 'pending',
 result_json TEXT NOT NULL, sources_json TEXT NOT NULL, expected_revision TEXT NOT NULL,
 origin TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT NOT NULL DEFAULT '',
 approved_niche TEXT NOT NULL DEFAULT '', approved_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_suggestions_company_status ON niche_suggestions(company_id,status);
"""


def record(db, task, result, sources, revision, origin, auto_apply=False):
    if result.get("status") != "identified" or not result.get("niche"):
        return False
    db.execute("UPDATE niche_suggestions SET status='stale',resolved_at=? WHERE company_id=? AND id!=? AND status IN ('pending','deferred')", (core.now(), task["company_id"], task["id"]))
    db.execute("INSERT OR IGNORE INTO niche_suggestions(id,company_id,job_id,result_json,sources_json,expected_revision,origin,created_at) VALUES(?,?,?,?,?,?,?,?)",
               (task["id"], task["company_id"], task["job_id"], json.dumps(result, ensure_ascii=False), json.dumps(sources, ensure_ascii=False), revision, origin, core.now()))

    # Uma identificação da IA só é aplicada automaticamente quando todos os
    # campos necessários para a análise estão completos e o cadastro tem um
    # nome específico. Resultados locais (sem pesquisa à IA) continuam exigindo
    # revisão humana para não transformar preenchimento antigo em validação.
    if auto_apply and origin != "local":
        company = db.execute("SELECT * FROM companies WHERE id=?", (task["company_id"],)).fetchone()
        complete = bool(
            company
            and company["name"]
            and not core.generic(company["name"])
            and str(result.get("city", "")).strip()
            and str(result.get("neighborhood", "")).strip()
        )
        if complete:
            resolved = _resolve(db, task["id"], {"action": "accept", "autoApproved": True})
            return resolved.get("status") == "accepted"
    return None


def migrate(db):
    # Recupera resultados antigos sem reenviar pesquisas e sem aprovar cadastros.
    candidates = db.execute("SELECT t.*,c.niche AS current_niche,c.sources AS current_sources,c.updated_at AS revision FROM tasks t JOIN jobs j ON j.id=t.job_id JOIN companies c ON c.id=t.company_id WHERE j.kind='identify' AND t.status='completed' AND c.status IN ('pending','review') AND c.updated_at<=t.updated_at ORDER BY t.updated_at DESC")
    visited = set()
    for row in candidates:
        if row["company_id"] in visited:
            continue
        visited.add(row["company_id"])
        try:
            result = json.loads(row["result_json"])
            raw = json.loads(row["raw_json"])
            if row["revision"] > row["created_at"] and (core.norm(result.get("niche", "")) != core.norm(row["current_niche"]) or json.loads(row["current_sources"]) != raw.get("sources", [])):
                continue
            record(db, row, result, raw.get("sources", []), row["revision"], raw.get("origin", "api"))
        except (ValueError, TypeError, AttributeError):
            continue


def pending(db, immersion_id):
    rows = db.execute("SELECT s.*,c.name,c.niche AS current_niche,c.actual_city,c.actual_neighborhood,c.status AS company_status,c.updated_at FROM niche_suggestions s JOIN companies c ON c.id=s.company_id WHERE c.immersion_id=? AND s.status IN ('pending','deferred') ORDER BY s.created_at,s.rowid", (immersion_id,))
    result = []
    for row in rows:
        if row["expected_revision"] != row["updated_at"] or row["company_status"] == "excluded":
            db.execute("UPDATE niche_suggestions SET status='stale',resolved_at=? WHERE id=?", (core.now(), row["id"]))
            continue
        proposal = json.loads(row["result_json"])
        result.append({"id": row["id"], "companyId": row["company_id"], "jobId": row["job_id"],
                       "status": row["status"], "origin": row["origin"], "createdAt": row["created_at"],
                       "name": row["name"], "niche": proposal["niche"], "city": proposal.get("city", ""), "neighborhood": proposal.get("neighborhood", ""),
                       "currentNiche": row["current_niche"], "currentCity": row["actual_city"], "currentNeighborhood": row["actual_neighborhood"],
                       "canAcceptInBatch": bool(row["name"] and not core.generic(row["name"]) and (proposal.get("city") or row["actual_city"]) and (proposal.get("neighborhood") or row["actual_neighborhood"])),
                       "reason": proposal.get("reason", ""), "sources": json.loads(row["sources_json"])})
    return result


def _resolve(db, suggestion_id, data):
    requested = data.get("action")
    if requested not in {"accept", "defer"}:
        raise core.AppError("Escolha cadastrar o nicho ou revisar depois.")
    suggestion = db.execute("SELECT * FROM niche_suggestions WHERE id=?", (suggestion_id,)).fetchone()
    if not suggestion:
        raise core.AppError("Sugestão não encontrada.", 404)
    company = db.execute("SELECT * FROM companies WHERE id=?", (suggestion["company_id"],)).fetchone()
    if suggestion["status"] == "accepted":
        # Repetir após perda de conexão não altera novamente o cadastro.
        return {"id": suggestion_id, "status": "accepted", "companyStatus": company["status"], "alreadyAccepted": True}
    if suggestion["status"] == "stale" or company["updated_at"] != suggestion["expected_revision"] or company["status"] == "excluded":
        db.execute("UPDATE niche_suggestions SET status='stale',resolved_at=? WHERE id=?", (core.now(), suggestion_id))
        return {"id": suggestion_id, "status": "stale"}
    if requested == "defer":
        db.execute("UPDATE niche_suggestions SET status='deferred' WHERE id=?", (suggestion_id,))
        return {"id": suggestion_id, "status": "deferred", "companyStatus": company["status"]}
    proposed = json.loads(suggestion["result_json"])
    niche = str(data.get("niche", proposed["niche"])).strip()
    name = str(data.get("name", company["name"])).strip()
    if not niche or len(niche) > 200 or len(name) > 250:
        raise core.AppError("Informe um nicho de até 200 caracteres e um nome de até 250 caracteres.")
    city = str(data.get("city", proposed.get("city") or company["actual_city"])).strip()[:100]
    neighborhood = str(data.get("neighborhood", proposed.get("neighborhood") or company["actual_neighborhood"])).strip()[:120]
    status = "ready" if name and not core.generic(name) and city and neighborhood else "review"
    notes = company["notes"]
    reason = str(proposed.get("reason", ""))[:300]
    if reason and reason not in notes:
        notes = (notes + "\nNicho confirmado: " + reason).strip()[:3000]
    moment = core.now()
    sources = suggestion["sources_json"] if suggestion["origin"] != "local" else company["sources"]
    changed = core.norm(niche) != core.norm(company["niche"])
    db.execute("UPDATE companies SET name=?,niche=?,actual_city=?,actual_neighborhood=?,notes=?,sources=?,status=?,updated_at=? WHERE id=?", (name, niche, city, neighborhood, notes, sources, status, moment, company["id"]))
    proposed["application"] = {"nicheChanged": changed, "previousNiche": company["niche"], "autoApproved": bool(data.get("autoApproved", False))}
    db.execute("UPDATE niche_suggestions SET status='accepted',resolved_at=?,approved_niche=?,approved_name=?,result_json=? WHERE id=?", (moment, niche, name, json.dumps(proposed, ensure_ascii=False), suggestion_id))
    db.execute("UPDATE niche_suggestions SET status='stale',resolved_at=? WHERE company_id=? AND id!=? AND status IN ('pending','deferred')", (moment, company["id"], suggestion_id))
    return {"id": suggestion_id, "status": "accepted", "companyStatus": status, "nicheChanged": changed, "alreadyAccepted": False, "autoApproved": bool(data.get("autoApproved", False))}


def resolve(store, suggestion_id, data):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        result = _resolve(db, suggestion_id, data)
    if result["status"] == "stale":
        raise core.AppError("O cadastro mudou desde esta sugestão. Atualize a tela e confira os dados atuais.", 409)
    return result


def resolve_many(store, data):
    ids = data.get("suggestionIds")
    if not isinstance(ids, list) or not ids or len(ids) > core.MAX_ROWS or not all(isinstance(s, str) for s in ids):
        raise core.AppError("Selecione entre 1 e 5.000 sugestões para confirmar.")
    accepted, skipped = [], []
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT id FROM jobs WHERE id=? AND kind='identify'", (str(data.get("jobId", "")),)).fetchone():
            raise core.AppError("Identificação não encontrada.", 404)
        for sid in dict.fromkeys(ids):
            suggestion = db.execute("SELECT s.id,c.name FROM niche_suggestions s JOIN companies c ON c.id=s.company_id WHERE s.id=? AND s.job_id=?", (sid, data["jobId"])).fetchone()
            if not suggestion:
                skipped.append({"id": sid, "reason": "Sugestão não disponível nesta identificação."})
                continue
            if not suggestion["name"] or core.generic(suggestion["name"]):
                skipped.append({"id": sid, "reason": "Confirme o nome da empresa ou profissional individualmente."})
                continue
            result = _resolve(db, sid, {"action": "accept"})
            if result["status"] == "stale":
                skipped.append({"id": sid, "reason": "Cadastro alterado desde a pesquisa. Confira os dados atuais."})
            else:
                accepted.append(result)
    return {"accepted": len(accepted), "changed": sum(r.get("nicheChanged", False) for r in accepted), "alreadyAccepted": sum(r.get("alreadyAccepted", False) for r in accepted), "skipped": skipped}


def job_results(db, job):
    """Resultado persistente da identificação, incluindo aprovações automáticas."""
    rows, counts = [], {key: 0 for key in ("pending", "accepted", "autoApproved", "changed", "unchanged", "reused", "inconclusive", "failed", "superseded", "stopped", "queued", "running")}
    snapshot = {c["id"]: c for c in job["snapshot"]}
    legacy_results = 0
    tasks = db.execute("SELECT t.*,c.name,c.niche AS current_niche,s.id AS suggestion_id,s.status AS suggestion_status,s.approved_niche,s.result_json AS approved_result FROM tasks t LEFT JOIN companies c ON c.id=t.company_id LEFT JOIN niche_suggestions s ON s.id=t.id WHERE t.job_id=? ORDER BY t.rowid", (job["id"],))
    for task in tasks:
        raw, proposal = json.loads(task["raw_json"]), json.loads(task["result_json"])
        previous = snapshot.get(task["company_id"], {})
        approval = json.loads(task["approved_result"] or "{}")
        if task["status"] == "completed" and not raw.get("review"):
            legacy_results += 1
        origin = raw.get("origin", "api")
        if task["status"] != "completed":
            outcome = task["status"]
        elif task["suggestion_status"] == "accepted":
            outcome = "accepted"
        elif task["suggestion_status"] in {"pending", "deferred"}:
            outcome = "pending"
        elif task["suggestion_status"] == "stale" or raw.get("review", {}).get("outcome") == "superseded":
            outcome = "superseded"
        elif proposal.get("status") == "identified" and proposal.get("niche"):
            outcome = "reused" if origin == "local" else "unchanged"
        else:
            outcome = "inconclusive"
        counts[outcome] += 1
        if origin in {"local", "cache"} and outcome != "reused":
            counts["reused"] += 1
        auto_approved = bool(approval.get("application", {}).get("autoApproved", False))
        if outcome == "accepted" and auto_approved:
            counts["autoApproved"] += 1
        if outcome == "accepted" and approval.get("application", {}).get("nicheChanged", core.norm(previous.get("niche", "")) != core.norm(task["approved_niche"])):
            counts["changed"] += 1
        review = raw.get("review", {}) or {}
        google_validation = raw.get("googleValidation", {}) or {}
        rows.append({"id": task["id"], "companyId": task["company_id"], "name": task["name"] or previous.get("target_name") or previous.get("name", ""), "previousNiche": previous.get("niche", ""), "currentNiche": task["current_niche"] or "", "proposedNiche": proposal.get("niche", ""), "approvedNiche": task["approved_niche"] or "", "city": proposal.get("city", ""), "neighborhood": proposal.get("neighborhood", ""), "reason": task["error"] or proposal.get("reason", ""), "origin": origin, "outcome": outcome, "suggestionId": task["suggestion_id"] or "", "suggestionStatus": task["suggestion_status"] or "", "hasSources": bool(raw.get("sources")), "autoApproved": auto_approved, "verification": str(review.get("verification") or ""), "verificationReason": str(google_validation.get("reason") or "")})
    return {"counts": counts, "rows": rows, "legacyResults": legacy_results}
