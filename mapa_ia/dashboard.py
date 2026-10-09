"""Dashboard auditável da análise de presença do Mapa IA.

A camada é derivada das respostas já persistidas em ``tasks``. As menções são
materializadas em uma tabela própria para permitir rastrear qualquer agregado
até a consulta original sem transformar métricas calculadas em fonte de verdade.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import csv
import io
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import median
import hashlib
import json
import math
import time
import urllib.parse

from . import core

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS dashboard_mentions(
 id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 target_company_id TEXT NOT NULL DEFAULT '',
 entity_key TEXT NOT NULL,
 raw_name TEXT NOT NULL,
 normalized_name TEXT NOT NULL,
 website TEXT NOT NULL DEFAULT '',
 niche TEXT NOT NULL DEFAULT '',
 city TEXT NOT NULL DEFAULT '',
 neighborhood TEXT NOT NULL DEFAULT '',
 mention_order INTEGER NOT NULL,
 explicit_rank INTEGER,
 source_urls_json TEXT NOT NULL DEFAULT '[]',
 matched_company_id TEXT NOT NULL DEFAULT '',
 match_status TEXT NOT NULL DEFAULT 'ai_only',
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_mentions_task_order ON dashboard_mentions(task_id,mention_order);
CREATE INDEX IF NOT EXISTS idx_dashboard_mentions_job_entity ON dashboard_mentions(job_id,entity_key);
CREATE INDEX IF NOT EXISTS idx_dashboard_mentions_job_task ON dashboard_mentions(job_id,task_id);
CREATE TABLE IF NOT EXISTS dashboard_entity_places(
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 entity_key TEXT NOT NULL,
 place_id TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending',
 confidence REAL NOT NULL DEFAULT 0,
 query_hash TEXT NOT NULL DEFAULT '',
 checked_at TEXT NOT NULL DEFAULT '',
 error TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(job_id,entity_key)
);
CREATE INDEX IF NOT EXISTS idx_dashboard_entity_places_job_status ON dashboard_entity_places(job_id,status);
CREATE TABLE IF NOT EXISTS dashboard_sync(
 job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
 completed_tasks INTEGER NOT NULL DEFAULT 0,
 max_updated_at TEXT NOT NULL DEFAULT '',
 mention_count INTEGER NOT NULL DEFAULT 0,
 synced_at TEXT NOT NULL DEFAULT ''
);
"""


def _safe_json(value, fallback):
    try:
        return json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return fallback


def _job(store: core.Store, job_id: str) -> tuple[dict, list[dict]]:
    with store.connect() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row or row["kind"] != "analyze":
        raise core.AppError("Análise não encontrada.", 404)
    job = dict(row)
    snapshot = _safe_json(job.get("snapshot", "[]"), []) or []
    return job, snapshot


def _company_lookup(snapshot: list[dict]) -> dict[str, dict]:
    return {str(c.get("id", "")): c for c in snapshot if c.get("id")}


def _match_company(snapshot: list[dict], mention: dict, niche: str) -> tuple[str, str]:
    """Retorna (company_id, status) somente para correspondências seguras.

    Correspondências parciais continuam como ``uncertain_company`` sem fundir a
    entidade. Isso evita que um homônimo contamine os agregados competitivos.
    """
    name = core.canonical(mention.get("name", ""))
    if not name:
        return "", "ai_only"
    mention_domain = core.domain(mention.get("website", ""))
    eligible = [c for c in snapshot if core.norm(c.get("niche", "")) == core.norm(niche)]
    exact: list[dict] = []
    possible: list[dict] = []
    for company in eligible:
        names = {
            core.canonical(company.get("name", "")),
            core.canonical(company.get("original_name", "")),
            *[core.canonical(v) for v in company.get("aliases", [])],
        } - {""}
        company_domain = core.domain(company.get("website", ""))
        if name in names or (mention_domain and company_domain and mention_domain == company_domain):
            exact.append(company)
        elif any(len(candidate) >= 8 and len(candidate.split()) >= 2 and (candidate in name or name in candidate) for candidate in names if len(name) >= 8):
            possible.append(company)
    if len(exact) == 1:
        return str(exact[0]["id"]), "audited_company"
    if exact or possible:
        return "", "uncertain_company"
    return "", "ai_only"


def _entity_key(mention: dict, matched_company_id: str, niche: str, city: str, neighborhood: str) -> str:
    if matched_company_id:
        return "company:" + matched_company_id
    site = core.domain(mention.get("website", ""))
    # Domínio é um identificador forte: a mesma empresa citada em consultas de
    # bairros diferentes não pode virar dois concorrentes no ranking. Quando a
    # IA não fornece site, usamos nome + nicho + cidade; o bairro da empresa-
    # alvo é contexto da consulta e não prova que o concorrente esteja ali.
    if site:
        raw = json.dumps(["domain", site], ensure_ascii=False, separators=(",", ":"))
    else:
        raw = json.dumps(["name", core.canonical(mention.get("name", "")), core.norm(niche), core.norm(city)], ensure_ascii=False, separators=(",", ":"))
    return "mention:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def sync_mentions(store: core.Store, job_id: str) -> int:
    """Materializa menções de tarefas concluídas. Idempotente e retrocompatível.

    Dashboard, mapa e auditoria podem ser carregados em paralelo. Um marcador de
    sincronização evita reprocessar/deletar milhares de menções em cada endpoint.
    """
    _, snapshot = _job(store, job_id)
    with store.connect() as db:
        state = db.execute("SELECT COUNT(*) AS total,COALESCE(MAX(updated_at),'') AS max_updated FROM tasks WHERE job_id=? AND status='completed'", (job_id,)).fetchone()
        marker = db.execute("SELECT * FROM dashboard_sync WHERE job_id=?", (job_id,)).fetchone()
        if marker and marker["completed_tasks"] == state["total"] and marker["max_updated_at"] == state["max_updated"]:
            return int(marker["mention_count"])
        tasks = list(db.execute("SELECT id,company_id,niche,result_json,created_at FROM tasks WHERE job_id=? AND status='completed' ORDER BY rowid", (job_id,)))
    lookup = _company_lookup(snapshot)
    rows: list[tuple] = []
    for task in tasks:
        result = _safe_json(task["result_json"], {}) or {}
        if not result.get("evaluable", False):
            continue
        target = lookup.get(str(task["company_id"] or ""), {})
        city = str(target.get("actual_city", ""))
        neighborhood = str(target.get("actual_neighborhood", ""))
        for index, mention in enumerate(result.get("mentions", []) or [], start=1):
            raw_name = str(mention.get("name", "")).strip()[:250]
            if not raw_name:
                continue
            matched_id, match_status = _match_company(snapshot, mention, str(task["niche"]))
            entity_key = _entity_key(mention, matched_id, str(task["niche"]), city, neighborhood)
            rank = mention.get("position")
            explicit_rank = int(rank) if isinstance(rank, int) and 0 < rank <= 500 else None
            source_urls = [core.safe_url(str(url)) for url in (mention.get("source_urls", []) or [])]
            source_urls = [url for url in source_urls if url]
            mention_id = hashlib.sha256(f"{task['id']}:{index}".encode()).hexdigest()[:32]
            rows.append((
                mention_id, job_id, task["id"], str(task["company_id"] or ""), entity_key,
                raw_name, core.canonical(raw_name), core.safe_url(str(mention.get("website", ""))),
                str(task["niche"]), city, neighborhood, index, explicit_rank,
                json.dumps(source_urls, ensure_ascii=False), matched_id, match_status, str(task["created_at"]),
            ))
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        latest = db.execute("SELECT COUNT(*) AS total,COALESCE(MAX(updated_at),'') AS max_updated FROM tasks WHERE job_id=? AND status='completed'", (job_id,)).fetchone()
        marker = db.execute("SELECT * FROM dashboard_sync WHERE job_id=?", (job_id,)).fetchone()
        if marker and marker["completed_tasks"] == latest["total"] and marker["max_updated_at"] == latest["max_updated"]:
            return int(marker["mention_count"])
        # Se uma tarefa terminou enquanto os dados eram preparados, não publique
        # um snapshot parcial; a próxima chamada refaz com o estado novo.
        if latest["total"] != state["total"] or latest["max_updated"] != state["max_updated"]:
            return int(marker["mention_count"]) if marker else 0
        db.execute("DELETE FROM dashboard_mentions WHERE job_id=?", (job_id,))
        db.executemany(
            "INSERT INTO dashboard_mentions(id,job_id,task_id,target_company_id,entity_key,raw_name,normalized_name,website,niche,city,neighborhood,mention_order,explicit_rank,source_urls_json,matched_company_id,match_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        db.execute("INSERT OR REPLACE INTO dashboard_sync(job_id,completed_tasks,max_updated_at,mention_count,synced_at) VALUES(?,?,?,?,?)", (job_id, state["total"], state["max_updated"], len(rows), core.now()))
    return len(rows)


def _filters(values: dict | None) -> dict:
    values = values or {}
    allowed_presence = {"all", "mentioned", "absent", "uncertain"}
    allowed_position = {"all", "top1", "top3", "ranked", "unranked"}
    return {
        "q": str(values.get("q", "")).strip()[:150],
        "niche": str(values.get("niche", "")).strip()[:200],
        "city": str(values.get("city", "")).strip()[:100],
        "neighborhood": str(values.get("neighborhood", "")).strip()[:120],
        "company": str(values.get("company", "")).strip()[:64],
        "presence": str(values.get("presence", "all")) if str(values.get("presence", "all")) in allowed_presence else "all",
        "position": str(values.get("position", "all")) if str(values.get("position", "all")) in allowed_position else "all",
    }


def _matches_text(query: str, *values: object) -> bool:
    needle = core.norm(query)
    return not needle or needle in core.norm(" ".join(str(value or "") for value in values))


def _task_context(store: core.Store, job_id: str, snapshot: list[dict]) -> list[dict]:
    lookup = _company_lookup(snapshot)
    with store.connect() as db:
        tasks = [dict(row) for row in db.execute("SELECT * FROM tasks WHERE job_id=? ORDER BY rowid", (job_id,))]
        mention_rows = [dict(row) for row in db.execute("SELECT * FROM dashboard_mentions WHERE job_id=? ORDER BY task_id,mention_order", (job_id,))]
    mentions_by_task: dict[str, list[dict]] = defaultdict(list)
    for row in mention_rows:
        row["sourceUrls"] = _safe_json(row.pop("source_urls_json"), []) or []
        mentions_by_task[row["task_id"]].append(row)
    result = []
    for task in tasks:
        target = lookup.get(str(task.get("company_id") or ""), {})
        parsed = _safe_json(task.get("result_json", "{}"), {}) or {}
        evaluable = bool(task.get("status") == "completed" and parsed.get("evaluable", False))
        matches = core.match_mentions(snapshot, parsed.get("mentions", []) or [], str(task.get("niche", ""))) if evaluable else {}
        target_match = matches.get(str(task.get("company_id") or ""), {"status": "absent", "positions": []})
        result.append({
            "task": task,
            "target": target,
            "result": parsed,
            "evaluable": evaluable,
            "targetMatch": target_match,
            "mentions": mentions_by_task.get(task["id"], []),
        })
    return result


def _passes_task_filter(ctx: dict, filters: dict) -> bool:
    target = ctx["target"]
    task = ctx["task"]
    target_match = ctx["targetMatch"]
    mentions = ctx["mentions"]
    if filters["niche"] and core.norm(task.get("niche", "")) != core.norm(filters["niche"]):
        return False
    if filters["city"] and core.norm(target.get("actual_city", "")) != core.norm(filters["city"]):
        return False
    if filters["neighborhood"] and core.norm(target.get("actual_neighborhood", "")) != core.norm(filters["neighborhood"]):
        return False
    if filters["company"] and str(target.get("id", "")) != filters["company"]:
        return False
    if filters["q"] and not _matches_text(filters["q"], target.get("name"), target.get("original_name"), task.get("niche"), target.get("actual_city"), target.get("actual_neighborhood"), *[m.get("raw_name") for m in mentions]):
        return False
    if filters["presence"] != "all":
        if not ctx["evaluable"]:
            return False
        if target_match.get("status") != filters["presence"]:
            return False
    # O filtro de posicao da auditoria se refere a empresa auditada, nao a
    # qualquer concorrente que apareceu na mesma resposta. Isso evita, por
    # exemplo, classificar a empresa-alvo como "Top 1" so porque um
    # concorrente ocupou a primeira posicao.
    ranks = [rank for rank in target_match.get("positions", []) if isinstance(rank, int)]
    target_was_mentioned = target_match.get("status") == "mentioned"
    if filters["position"] == "top1" and 1 not in ranks:
        return False
    if filters["position"] == "top3" and not any(rank <= 3 for rank in ranks):
        return False
    if filters["position"] == "ranked" and not ranks:
        return False
    if filters["position"] == "unranked" and (not target_was_mentioned or ranks):
        return False
    return True



def _passes_structural_task_filter(ctx: dict, filters: dict) -> bool:
    """Filtros que definem o universo de consultas antes de calcular frequência."""
    structural = dict(filters)
    structural["presence"] = "all"
    structural["position"] = "all"
    return _passes_task_filter(ctx, structural)


def _company_matches_post_filter(company: dict, filters: dict) -> bool:
    presence = filters.get("presence", "all")
    if presence == "mentioned" and company.get("appearances", 0) <= 0:
        return False
    if presence == "absent" and (company.get("validQueries", 0) <= 0 or company.get("appearances", 0) > 0 or company.get("uncertain", 0) > 0):
        return False
    if presence == "uncertain" and company.get("uncertain", 0) <= 0:
        return False
    position = filters.get("position", "all")
    if position == "top1" and company.get("top1", 0) <= 0:
        return False
    if position == "top3" and company.get("top3", 0) <= 0:
        return False
    if position == "ranked" and company.get("bestRank") is None:
        return False
    if position == "unranked" and company.get("unrankedAppearances", 0) <= 0:
        return False
    return True

def _average(values: list[int | float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def _presence_label(frequency: float) -> str:
    if frequency >= 0.8:
        return "Muito recorrente"
    if frequency >= 0.6:
        return "Recorrente"
    if frequency >= 0.3:
        return "Moderada"
    if frequency >= 0.1:
        return "Ocasional"
    if frequency > 0:
        return "Rara"
    return "Não detectada"


def _entity_aggregates(contexts: list[dict], snapshot: list[dict]) -> tuple[list[dict], set[str]]:
    lookup = _company_lookup(snapshot)
    entities: dict[str, dict] = {}
    competitor_keys: set[str] = set()
    for ctx in contexts:
        if not ctx["evaluable"]:
            continue
        target_id = str(ctx["task"].get("company_id") or "")
        seen_task: set[str] = set()
        for mention in ctx["mentions"]:
            key = mention["entity_key"]
            item = entities.setdefault(key, {
                "entityKey": key,
                "name": mention["raw_name"],
                "website": mention["website"],
                "matchedCompanyId": mention["matched_company_id"],
                "matchStatus": mention["match_status"],
                "citations": 0,
                "queries": 0,
                "top1": 0,
                "top3": 0,
                "explicitRanks": [],
                "mentionOrders": [],
                "niches": set(),
                "cities": set(),
                "neighborhoods": set(),
                "asCompetitor": 0,
                "asTarget": 0,
            })
            item["citations"] += 1
            if key not in seen_task:
                item["queries"] += 1
                seen_task.add(key)
            item["mentionOrders"].append(int(mention["mention_order"]))
            if isinstance(mention.get("explicit_rank"), int):
                rank = int(mention["explicit_rank"])
                item["explicitRanks"].append(rank)
                item["top1"] += int(rank == 1)
                item["top3"] += int(rank <= 3)
            item["niches"].add(mention["niche"])
            if mention["city"]:
                item["cities"].add(mention["city"])
            if mention["neighborhood"]:
                item["neighborhoods"].add(mention["neighborhood"])
            if mention["matched_company_id"] and mention["matched_company_id"] == target_id:
                item["asTarget"] += 1
            else:
                item["asCompetitor"] += 1
                competitor_keys.add(key)
    output = []
    for item in entities.values():
        ranks = item.pop("explicitRanks")
        orders = item.pop("mentionOrders")
        item["averageRank"] = _average(ranks)
        item["bestRank"] = min(ranks) if ranks else None
        item["averageMentionOrder"] = _average(orders)
        item["niches"] = sorted(item["niches"])
        item["cities"] = sorted(item["cities"])
        item["neighborhoods"] = sorted(item["neighborhoods"])
        matched = lookup.get(item["matchedCompanyId"], {}) if item["matchedCompanyId"] else {}
        if matched:
            item["name"] = matched.get("name") or matched.get("original_name") or item["name"]
            item["website"] = matched.get("website") or item["website"]
        item["entityType"] = "audited" if item["matchedCompanyId"] else "competitor"
        output.append(item)
    output.sort(key=lambda item: (-item["queries"], -(item["top1"] or 0), item["averageRank"] if item["averageRank"] is not None else 999, core.norm(item["name"])))
    return output, competitor_keys


def _company_aggregates(contexts: list[dict], snapshot: list[dict]) -> list[dict]:
    lookup = _company_lookup(snapshot)
    grouped: dict[str, list[dict]] = defaultdict(list)
    for ctx in contexts:
        company_id = str(ctx["task"].get("company_id") or "")
        if company_id:
            grouped[company_id].append(ctx)
    output = []
    for company_id, rows in grouped.items():
        company = lookup.get(company_id, {})
        valid = [row for row in rows if row["evaluable"]]
        appearances = sum(row["targetMatch"].get("status") == "mentioned" for row in valid)
        uncertain = sum(row["targetMatch"].get("status") == "uncertain" for row in valid)
        unranked_appearances = sum(row["targetMatch"].get("status") == "mentioned" and not row["targetMatch"].get("positions") for row in valid)
        explicit_ranks = [rank for row in valid for rank in row["targetMatch"].get("positions", []) if isinstance(rank, int)]
        mention_orders = []
        competitor_counter = Counter()
        for row in valid:
            target_id = str(row["task"].get("company_id") or "")
            for mention in row["mentions"]:
                if mention.get("matched_company_id") == target_id:
                    mention_orders.append(int(mention["mention_order"]))
                else:
                    competitor_counter[mention["raw_name"]] += 1
        valid_count = len(valid)
        frequency = appearances / valid_count if valid_count else 0.0
        output.append({
            "companyId": company_id,
            "name": company.get("name") or company.get("original_name") or "Empresa",
            "niche": company.get("niche", ""),
            "city": company.get("actual_city", ""),
            "neighborhood": company.get("actual_neighborhood", ""),
            "website": company.get("website", ""),
            "appearances": appearances,
            "uncertain": uncertain,
            "unrankedAppearances": unranked_appearances,
            "validQueries": valid_count,
            "plannedQueries": len(rows),
            "frequency": round(frequency, 4),
            "frequencyPercent": round(frequency * 100, 1),
            "presenceLabel": _presence_label(frequency),
            "bestRank": min(explicit_ranks) if explicit_ranks else None,
            "averageRank": _average(explicit_ranks),
            "medianRank": round(float(median(explicit_ranks)), 2) if explicit_ranks else None,
            "worstRank": max(explicit_ranks) if explicit_ranks else None,
            "top1": sum(rank == 1 for rank in explicit_ranks),
            "top3": sum(rank <= 3 for rank in explicit_ranks),
            "averageMentionOrder": _average(mention_orders),
            "competitors": [{"name": name, "count": count} for name, count in competitor_counter.most_common(5)],
        })
    output.sort(key=lambda item: (-item["frequency"], -(item["top1"] or 0), item["averageRank"] if item["averageRank"] is not None else 999, core.norm(item["name"])))
    return output


def _options(all_contexts: list[dict], snapshot: list[dict]) -> dict:
    niches = sorted({str(ctx["task"].get("niche", "")) for ctx in all_contexts if ctx["task"].get("niche")}, key=core.norm)
    cities = sorted({str(ctx["target"].get("actual_city", "")) for ctx in all_contexts if ctx["target"].get("actual_city")}, key=core.norm)
    neighborhoods = sorted({str(ctx["target"].get("actual_neighborhood", "")) for ctx in all_contexts if ctx["target"].get("actual_neighborhood")}, key=core.norm)
    companies = [{"id": c.get("id", ""), "name": c.get("name") or c.get("original_name") or "Empresa"} for c in snapshot]
    companies.sort(key=lambda item: core.norm(item["name"]))
    return {"niches": niches, "cities": cities, "neighborhoods": neighborhoods, "companies": companies}



def _group_rankings(contexts: list[dict], entity_name: dict[str, str]) -> dict[str, list[dict]]:
    dimensions = {"niche": defaultdict(Counter), "city": defaultdict(Counter), "neighborhood": defaultdict(Counter)}
    for ctx in contexts:
        if not ctx["evaluable"]:
            continue
        target = ctx["target"]
        groups = {
            "niche": str(ctx["task"].get("niche", "")),
            "city": str(target.get("actual_city", "")),
            "neighborhood": str(target.get("actual_neighborhood", "")),
        }
        for mention in ctx["mentions"]:
            for dimension, label in groups.items():
                if label:
                    dimensions[dimension][label][mention["entity_key"]] += 1
    output: dict[str, list[dict]] = {}
    for dimension, grouped in dimensions.items():
        rows = []
        for label, counts in sorted(grouped.items(), key=lambda pair: core.norm(pair[0])):
            rows.append({"label": label, "entities": [{"entityKey": key, "name": entity_name.get(key, "Empresa"), "citations": count} for key, count in counts.most_common(8)]})
        output[dimension] = rows
    return output

def summary(store: core.Store, job_id: str, values: dict | None = None) -> dict:
    job, snapshot = _job(store, job_id)
    sync_mentions(store, job_id)
    filters = _filters(values)
    all_contexts = _task_context(store, job_id, snapshot)
    structural_contexts = [ctx for ctx in all_contexts if _passes_structural_task_filter(ctx, filters)]
    all_companies = _company_aggregates(structural_contexts, snapshot)
    companies = [company for company in all_companies if _company_matches_post_filter(company, filters)]
    selected_company_ids = {company["companyId"] for company in companies}
    contexts = [ctx for ctx in structural_contexts if str(ctx["task"].get("company_id") or "") in selected_company_ids]
    entities, competitor_keys = _entity_aggregates(contexts, snapshot)

    valid_contexts = [ctx for ctx in contexts if ctx["evaluable"]]
    total_mentions = sum(len(ctx["mentions"]) for ctx in valid_contexts)
    position_counter = Counter()
    unranked = 0
    for ctx in valid_contexts:
        for mention in ctx["mentions"]:
            if isinstance(mention.get("explicit_rank"), int):
                position_counter[int(mention["explicit_rank"])] += 1
            else:
                unranked += 1
    position_distribution = [{"position": rank, "count": position_counter[rank]} for rank in sorted(position_counter)[:12]]
    if unranked:
        position_distribution.append({"position": None, "count": unranked})

    entity_name = {item["entityKey"]: item["name"] for item in entities}
    group_rankings = _group_rankings(contexts, entity_name)
    niche_rankings = [{"niche": row["label"], "entities": row["entities"]} for row in group_rankings["niche"]]

    with store.connect() as db:
        links = [dict(row) for row in db.execute("SELECT company_id,status FROM google_place_links WHERE job_id=?", (job_id,))]
    google_status = {row["company_id"]: row["status"] for row in links}
    matched_profiles = sum(google_status.get(c["companyId"]) == "matched" for c in companies)
    recommended = sum(c["appearances"] > 0 for c in companies)
    valid_count = len(valid_contexts)
    completed_count = sum(ctx["task"].get("status") == "completed" for ctx in contexts)
    failed_count = sum(ctx["task"].get("status") == "failed" for ctx in contexts)
    incomplete_count = sum(ctx["task"].get("status") == "completed" and not ctx["evaluable"] for ctx in contexts)
    niches = {c["niche"] for c in companies if c["niche"]}
    cities = {c["city"] for c in companies if c["city"]}
    neighborhoods = {c["neighborhood"] for c in companies if c["neighborhood"]}

    alerts = []
    if failed_count:
        alerts.append({"type": "error", "count": failed_count, "label": "consultas com falha", "filter": "failed"})
    if incomplete_count:
        alerts.append({"type": "warning", "count": incomplete_count, "label": "respostas concluídas, mas não avaliáveis", "filter": "incomplete"})
    ambiguous_google = sum(status == "ambiguous" for status in google_status.values())
    missing_google = sum(status == "not_found" for status in google_status.values())
    if ambiguous_google:
        alerts.append({"type": "warning", "count": ambiguous_google, "label": "perfis Google ambíguos", "filter": "google_ambiguous"})
    if missing_google:
        alerts.append({"type": "info", "count": missing_google, "label": "perfis Google não localizados", "filter": "google_missing"})

    return {
        "generatedAt": core.now(),
        "job": {"id": job["id"], "status": job["status"], "model": job["model"], "createdAt": job["created_at"], "repetitions": job["repetitions"], "queryTemplate": job["query_template"]},
        "filters": filters,
        "options": _options(all_contexts, snapshot),
        "kpis": {
            "auditedCompanies": len(companies),
            "recommendedCompanies": recommended,
            "recommendationRate": round((recommended / len(companies) * 100), 1) if companies else 0,
            "competitorsUnique": len(competitor_keys),
            "queriesPlanned": len(contexts),
            "queriesValid": valid_count,
            "citations": total_mentions,
            "top1Companies": sum(c["top1"] > 0 for c in companies),
            "googleMatched": matched_profiles,
            "googleTotal": len(companies),
            "niches": len(niches),
            "cities": len(cities),
            "neighborhoods": len(neighborhoods),
        },
        "quality": {
            "total": len(contexts),
            "completed": completed_count,
            "valid": valid_count,
            "failed": failed_count,
            "incomplete": incomplete_count,
            "successRate": round(valid_count / len(contexts) * 100, 1) if contexts else 0,
        },
        "alerts": alerts,
        "companies": companies,
        "entityRanking": entities[:100],
        "nicheRankings": niche_rankings,
        "groupRankings": group_rankings,
        "positionDistribution": position_distribution,
    }


def audit(store: core.Store, job_id: str, values: dict | None = None, page: int = 1, page_size: int = 25) -> dict:
    _, snapshot = _job(store, job_id)
    sync_mentions(store, job_id)
    filters = _filters(values)
    contexts = [ctx for ctx in _task_context(store, job_id, snapshot) if _passes_task_filter(ctx, filters)]
    page = max(1, int(page or 1))
    page_size = max(10, min(100, int(page_size or 25)))
    total = len(contexts)
    start = (page - 1) * page_size
    selected = contexts[start:start + page_size]
    rows = []
    for ctx in selected:
        task = ctx["task"]
        target = ctx["target"]
        target_match = ctx["targetMatch"]
        ranks = target_match.get("positions", []) if ctx["evaluable"] else []
        own_mentions = [m for m in ctx["mentions"] if m.get("matched_company_id") == str(task.get("company_id") or "")]
        rows.append({
            "taskId": task["id"],
            "companyId": str(task.get("company_id") or ""),
            "company": target.get("name") or target.get("original_name") or "Empresa",
            "niche": str(task.get("niche", "")),
            "city": target.get("actual_city", ""),
            "neighborhood": target.get("actual_neighborhood", ""),
            "iteration": int(task.get("iteration") or 1),
            "status": task.get("status", ""),
            "evaluable": ctx["evaluable"],
            "targetStatus": target_match.get("status", "absent") if ctx["evaluable"] else "not_evaluable",
            "explicitRank": min(ranks) if ranks else None,
            "mentionOrder": min((int(m["mention_order"]) for m in own_mentions), default=None),
            "prompt": str(task.get("prompt", "")),
            "mentions": [{
                "entityKey": m["entity_key"], "name": m["raw_name"], "explicitRank": m["explicit_rank"],
                "mentionOrder": m["mention_order"], "matchedCompanyId": m["matched_company_id"], "matchStatus": m["match_status"],
            } for m in ctx["mentions"]],
            "error": str(task.get("error", "")),
            "createdAt": str(task.get("created_at", "")),
            "updatedAt": str(task.get("updated_at", "")),
        })
    return {"page": page, "pageSize": page_size, "total": total, "pages": max(1, math.ceil(total / page_size)) if total else 1, "rows": rows, "filters": filters}


def entity_detail(store: core.Store, job_id: str, entity_key: str) -> dict:
    _, snapshot = _job(store, job_id)
    sync_mentions(store, job_id)
    with store.connect() as db:
        rows = [dict(row) for row in db.execute("SELECT * FROM dashboard_mentions WHERE job_id=? AND entity_key=? ORDER BY created_at,task_id,mention_order", (job_id, entity_key))]
    if not rows:
        raise core.AppError("Empresa citada não encontrada nessa execução.", 404)
    lookup = _company_lookup(snapshot)
    task_ids = sorted({row["task_id"] for row in rows})
    placeholders = ",".join("?" for _ in task_ids)
    with store.connect() as db:
        tasks = {row["id"]: dict(row) for row in db.execute(f"SELECT * FROM tasks WHERE id IN ({placeholders})", task_ids)}
        all_mentions = [dict(row) for row in db.execute(f"SELECT * FROM dashboard_mentions WHERE task_id IN ({placeholders})", task_ids)]
    co = Counter()
    for mention in all_mentions:
        if mention["entity_key"] != entity_key:
            co[mention["entity_key"]] += 1
    names_by_key = {}
    for mention in all_mentions:
        names_by_key.setdefault(mention["entity_key"], mention["raw_name"])
    ranks = [int(row["explicit_rank"]) for row in rows if isinstance(row.get("explicit_rank"), int)]
    matched_company_id = next((str(row.get("matched_company_id") or "") for row in rows if row.get("matched_company_id")), "")
    audited = lookup.get(matched_company_id, {}) if matched_company_id else {}
    occurrences = []
    for row in rows[:200]:
        task = tasks.get(row["task_id"], {})
        target = lookup.get(str(task.get("company_id") or ""), {})
        occurrences.append({
            "taskId": row["task_id"],
            "targetCompany": target.get("name") or target.get("original_name") or "Empresa",
            "targetCompanyId": str(task.get("company_id") or ""),
            "niche": row["niche"], "city": row["city"], "neighborhood": row["neighborhood"],
            "explicitRank": row["explicit_rank"], "mentionOrder": row["mention_order"], "createdAt": row["created_at"],
        })
    return {
        "entityKey": entity_key,
        "name": audited.get("name") or rows[0]["raw_name"],
        "website": audited.get("website") or rows[0]["website"],
        "matchedCompanyId": matched_company_id,
        "matchStatus": "audited_company" if matched_company_id else rows[0]["match_status"],
        "citations": len(rows),
        "queries": len(task_ids),
        "bestRank": min(ranks) if ranks else None,
        "averageRank": _average(ranks),
        "top1": sum(rank == 1 for rank in ranks),
        "top3": sum(rank <= 3 for rank in ranks),
        "niches": sorted({row["niche"] for row in rows if row["niche"]}),
        "cities": sorted({row["city"] for row in rows if row["city"]}),
        "neighborhoods": sorted({row["neighborhood"] for row in rows if row["neighborhood"]}),
        "cooccurring": [{"entityKey": key, "name": names_by_key.get(key, "Empresa"), "count": count} for key, count in co.most_common(12)],
        "occurrences": occurrences,
    }


def _entity_query_hash(entity: dict) -> str:
    return hashlib.sha256(json.dumps([
        core.canonical(entity.get("name", "")), core.domain(entity.get("website", "")),
        core.norm(entity.get("city", "")), core.norm(entity.get("neighborhood", "")),
    ], ensure_ascii=False).encode()).hexdigest()


def _entity_place_profile(store: core.Store, job_id: str, entity: dict, refresh: bool = False) -> dict:
    key = core.google_maps_key()
    if not key:
        return {"status": "not_configured", "reason": "Adicione GOOGLE_MAPS_API_KEY ao .env do backend."}
    entity_key = str(entity["entityKey"])
    query_hash = _entity_query_hash(entity)
    with store.connect() as db:
        row = db.execute("SELECT * FROM dashboard_entity_places WHERE job_id=? AND entity_key=?", (job_id, entity_key)).fetchone()
        if row and row["query_hash"] == query_hash and not refresh:
            if row["status"] == "matched" and row["place_id"]:
                cache_key = f"dashboard:{job_id}:{entity_key}:{row['place_id']}"
                cached = store._google_profile_cache.get(cache_key)
                if cached and cached[0] > time.time():
                    return cached[1]
                fields = ",".join(["id", "displayName", "formattedAddress", "rating", "userRatingCount", "googleMapsUri", "websiteUri", "primaryTypeDisplayName", "businessStatus", "location"])
                try:
                    place = core.google_maps_request(core.GOOGLE_PLACES_DETAILS_URL.format(place_id=urllib.parse.quote(row["place_id"], safe="")), key, fields)
                    profile = core.google_profile_from_place(place, core.now())
                    profile["confidence"] = row["confidence"]
                    store._google_profile_cache[cache_key] = (time.time() + core.GOOGLE_PROFILE_CACHE_SECONDS, profile)
                    return profile
                except core.AppError as exc:
                    return {"status": "error", "reason": str(exc)[:500], "placeId": row["place_id"]}
            if row["status"] in {"not_found", "ambiguous"}:
                return {"status": row["status"], "reason": row["error"], "confidence": row["confidence"], "checkedAt": row["checked_at"]}
        db.execute("INSERT OR REPLACE INTO dashboard_entity_places(job_id,entity_key,place_id,status,confidence,query_hash,checked_at,error) VALUES(?,?,?,?,?,?,?,?)", (job_id, entity_key, "", "resolving", 0, query_hash, core.now(), ""))

    pseudo_company = {
        "name": entity.get("name", ""), "original_name": entity.get("name", ""), "aliases": [],
        "website": entity.get("website", ""), "actual_city": entity.get("city", ""), "actual_neighborhood": entity.get("neighborhood", ""),
    }
    location = core.company_location(entity.get("city", ""), entity.get("neighborhood", ""))
    query = ", ".join(part for part in (entity.get("name", ""), location, "Brasil") if part)
    fields = ",".join([
        "places.id", "places.displayName", "places.formattedAddress", "places.addressComponents", "places.rating",
        "places.userRatingCount", "places.googleMapsUri", "places.websiteUri", "places.primaryTypeDisplayName", "places.businessStatus", "places.location",
    ])
    checked = core.now()
    try:
        response = core.google_maps_request(core.GOOGLE_PLACES_SEARCH_URL, key, fields, {"textQuery": query, "languageCode": "pt-BR", "regionCode": "BR", "pageSize": 5})
        candidates = []
        for place in response.get("places", []) or []:
            score, signals = core.google_candidate_score(pseudo_company, place)
            candidates.append((score, signals, place))
        candidates.sort(key=lambda item: item[0], reverse=True)
        best = candidates[0] if candidates else None
        second = candidates[1][0] if len(candidates) > 1 else 0.0
        if not best or best[0] < 0.68 or (best[1]["name"] < 0.5 and not best[1]["website"]):
            status, place_id, confidence = "not_found", "", best[0] if best else 0.0
            reason = "Nenhum perfil correspondeu com segurança ao nome e à localização citados."
            profile = {"status": status, "reason": reason, "confidence": confidence, "checkedAt": checked}
        elif second >= best[0] - 0.06 and best[0] < 0.9:
            status, place_id, confidence = "ambiguous", "", best[0]
            reason = "Há mais de um perfil parecido nessa localização; nenhum ponto foi atribuído automaticamente."
            profile = {"status": status, "reason": reason, "confidence": confidence, "checkedAt": checked}
        else:
            status, place_id, confidence = "matched", str(best[2].get("id", "")), best[0]
            reason = ""
            profile = core.google_profile_from_place(best[2], checked)
            profile["confidence"] = confidence
        with store.connect() as db:
            db.execute("UPDATE dashboard_entity_places SET place_id=?,status=?,confidence=?,query_hash=?,checked_at=?,error=? WHERE job_id=? AND entity_key=?", (place_id, status, confidence, query_hash, checked, reason, job_id, entity_key))
        if status == "matched" and place_id:
            store._google_profile_cache[f"dashboard:{job_id}:{entity_key}:{place_id}"] = (time.time() + core.GOOGLE_PROFILE_CACHE_SECONDS, profile)
        return profile
    except core.AppError as exc:
        reason = str(exc)[:500]
        with store.connect() as db:
            db.execute("UPDATE dashboard_entity_places SET status='error',checked_at=?,error=?,query_hash=? WHERE job_id=? AND entity_key=?", (checked, reason, query_hash, job_id, entity_key))
        return {"status": "error", "reason": reason, "checkedAt": checked}


def map_data(store: core.Store, job_id: str, values: dict | None = None, limit: int = 80, refresh: bool = False) -> dict:
    _, snapshot = _job(store, job_id)
    snapshot_by_id = _company_lookup(snapshot)
    data = summary(store, job_id, values)
    limit = max(10, min(150, int(limit or 80)))
    ranked = data["entityRanking"][:limit]
    if not ranked:
        return {"configured": bool(core.google_maps_key()), "attribution": "Google Maps", "pins": [], "eligible": 0, "located": 0, "limit": limit}
    if not core.google_maps_key():
        return {"configured": False, "attribution": "Google Maps", "pins": [], "eligible": len(ranked), "located": 0, "limit": limit}

    company_by_id = {c["companyId"]: c for c in data["companies"]}
    candidates = []
    for entity in ranked:
        matched_id = entity.get("matchedCompanyId") or ""
        if matched_id and matched_id in company_by_id:
            company = company_by_id[matched_id]
            candidates.append((entity, {
                "entityKey": entity["entityKey"], "name": entity["name"], "website": entity.get("website", ""),
                "city": company.get("city", ""), "neighborhood": company.get("neighborhood", ""), "matchedCompanyId": matched_id,
            }))
        else:
            candidates.append((entity, {
                "entityKey": entity["entityKey"], "name": entity["name"], "website": entity.get("website", ""),
                "city": (entity.get("cities") or [""])[0], "neighborhood": (entity.get("neighborhoods") or [""])[0], "matchedCompanyId": "",
            }))
    profiles: dict[str, dict] = {}
    workers = min(4, max(1, len(candidates)))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="mapa-dashboard-google") as pool:
        futures = {}
        for aggregate, entity in candidates:
            matched_id = entity["matchedCompanyId"]
            if matched_id:
                company = snapshot_by_id.get(matched_id)
                if company:
                    futures[pool.submit(core.google_profile_for_job, store, job_id, company, refresh)] = aggregate["entityKey"]
                    continue
            futures[pool.submit(_entity_place_profile, store, job_id, entity, refresh)] = aggregate["entityKey"]
        for future in as_completed(futures):
            key = futures[future]
            try:
                profiles[key] = future.result()
            except Exception:
                profiles[key] = {"status": "error", "reason": "Não foi possível localizar essa empresa no mapa agora."}
    pins = []
    for entity, _ in candidates:
        profile = profiles.get(entity["entityKey"], {})
        if profile.get("status") != "matched" or not isinstance(profile.get("lat"), (int, float)) or not isinstance(profile.get("lng"), (int, float)):
            continue
        pins.append({
            "entityKey": entity["entityKey"], "name": entity["name"], "entityType": entity["entityType"],
            "matchedCompanyId": entity.get("matchedCompanyId", ""), "lat": profile["lat"], "lng": profile["lng"],
            "citations": entity["queries"], "top1": entity["top1"], "averageRank": entity["averageRank"],
            "niche": (entity.get("niches") or [""])[0], "city": (entity.get("cities") or [""])[0], "neighborhood": (entity.get("neighborhoods") or [""])[0],
            "rating": profile.get("rating"), "reviewCount": profile.get("reviewCount", 0), "mapsUrl": profile.get("mapsUrl", ""),
            "address": profile.get("address", ""), "businessStatus": profile.get("businessStatus", ""),
        })
    return {"configured": True, "attribution": "Google Maps", "pins": pins, "eligible": len(ranked), "located": len(pins), "limit": limit}


def export_csv(store: core.Store, job_id: str) -> tuple[bytes, str, str]:
    """Exporta a trilha completa: toda consulta e cada menção vinculada a ela.

    Consultas sem nenhuma empresa extraída também ganham uma linha. Assim a
    exportação não apaga justamente os casos de ausência/não recomendação.
    """
    _, snapshot = _job(store, job_id)
    sync_mentions(store, job_id)
    contexts = _task_context(store, job_id, snapshot)
    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow([
        "Consulta ID", "Empresa auditada", "Nicho", "Bairro", "Cidade", "Iteração",
        "Resposta avaliável", "Resultado da empresa auditada", "Posição da empresa auditada",
        "Empresa citada", "Entidade", "Tipo de correspondência", "Posição explícita da citação",
        "Ordem de menção", "Site citado", "Fontes da menção", "Pergunta", "Status da consulta", "Data",
    ])

    def safe_cell(value):
        return "'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@")) else value

    for ctx in contexts:
        task = ctx["task"]
        target = ctx["target"]
        target_match = ctx["targetMatch"]
        target_ranks = [rank for rank in target_match.get("positions", []) if isinstance(rank, int)]
        base = [
            task["id"], target.get("name") or target.get("original_name") or "Empresa",
            str(task.get("niche", "")), target.get("actual_neighborhood", ""), target.get("actual_city", ""), task.get("iteration", ""),
            "sim" if ctx["evaluable"] else "não",
            target_match.get("status", "absent") if ctx["evaluable"] else "not_evaluable",
            min(target_ranks) if target_ranks else "",
        ]
        mentions = ctx["mentions"] or [None]
        for mention in mentions:
            cited = ["", "", "", "", "", "", ""] if mention is None else [
                mention["raw_name"], mention["entity_key"], mention["match_status"],
                mention["explicit_rank"] if mention["explicit_rank"] is not None else "", mention["mention_order"], mention["website"],
                " | ".join(mention.get("sourceUrls", []) or []),
            ]
            values = base + cited + [task.get("prompt", ""), task.get("status", ""), task.get("updated_at", "")]
            writer.writerow([safe_cell(value) for value in values])
    return ("\ufeff" + output.getvalue()).encode("utf-8"), "text/csv; charset=utf-8", "radar-recomendacao-" + job_id[:10] + ".csv"

