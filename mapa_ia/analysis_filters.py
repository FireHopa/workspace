"""Filtros locais dos relatórios; não executam consultas à API."""
from __future__ import annotations

from . import core

FIELDS = ("q", "niche", "presence", "city", "order")


def options(data=None):
    data = data or {}
    result = {k: str(data.get(k, ""))[:300].strip() for k in FIELDS}
    for key in ("niche", "presence", "city"):
        if not result[key]:
            result[key] = "all"
    if not result["order"]:
        result["order"] = "original"
    if result["presence"] not in {"all", "mentioned", "absent", "uncertain", "pending"}:
        raise core.AppError("Filtro de presença inválido.")
    if result["order"] not in {"original", "frequency_desc", "frequency_asc", "position", "name"}:
        raise core.AppError("Ordenação inválida.")
    return result


def apply(results, filters=None, participants=None):
    filters = options(filters)
    participants = participants or {}
    query = core.norm(filters["q"])
    selected = []
    for row in results:
        names = participants.get(row["id"], [p.get("name", "") for p in row.get("participants", [])])
        text = core.norm(" ".join([row.get("name", ""), row.get("original_name", ""), row.get("niche", ""), *names]))
        if query and query not in text:
            continue
        if filters["niche"] != "all" and core.norm(row["niche"]) != core.norm(filters["niche"]):
            continue
        if filters["presence"] != "all" and row["status"] != filters["presence"]:
            continue
        city = core.norm(row.get("actual_city", "")) or "__missing__"
        if filters["city"] != "all" and city != core.norm(filters["city"]):
            continue
        selected.append(row)
    order = filters["order"]
    if order.startswith("frequency_"):
        sign = -1 if order == "frequency_desc" else 1
        selected.sort(key=lambda r: (r["validQueries"] == 0, sign*r["appearances"]/max(1,r["validQueries"]), core.norm(r["name"])))
    elif order == "position":
        selected.sort(key=lambda r: (r["bestPosition"] if r["bestPosition"] is not None else float("inf"), core.norm(r["name"])))
    elif order == "name":
        selected.sort(key=lambda r: core.norm(r["name"]))
    return selected
