"""Vincula uma cópia do histórico local a uma conta Mapa IA do Workspace.

Execute com o serviço parado: python -m mapa_ia.migrate --email EMAIL
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path
from uuid import uuid4

from .workspace import data_root


def import_history(source: Path, target: Path) -> dict:
    source = source.resolve()
    source_db = source / "mapa-ia.sqlite3"
    if not source_db.is_file():
        raise ValueError("O banco mapa-ia.sqlite3 não foi encontrado na origem.")
    if source == target.resolve():
        raise ValueError("A origem e o destino precisam ser pastas diferentes.")
    if target.exists():
        destination_db = target / "mapa-ia.sqlite3"
        if destination_db.exists():
            with sqlite3.connect(destination_db) as db:
                for table in ("immersions", "companies", "participants", "jobs", "tasks", "preparations"):
                    exists = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
                    if exists and db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]:
                        raise ValueError("Esta conta já tem dados no Mapa IA. A importação foi cancelada para preservar o histórico existente.")
        if any(folder.is_dir() and any(folder.iterdir()) for folder in (target / "uploads", target / "tmp")):
            raise ValueError("Esta conta já tem arquivos enviados. A importação foi cancelada para preservá-los.")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix=".history-", dir=target.parent) as temporary:
        staging = Path(temporary) / "account"
        staging.mkdir(mode=0o700)
        with sqlite3.connect(source_db.as_uri() + "?mode=ro", uri=True) as original, sqlite3.connect(staging / "mapa-ia.sqlite3") as copied:
            original.backup(copied)
        with sqlite3.connect(staging / "mapa-ia.sqlite3") as db:
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("O banco de origem precisa ser reparado antes de importar.")
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"immersions", "companies", "participants", "jobs", "tasks"} <= tables:
                raise ValueError("O arquivo de origem não é um banco do Mapa IA · Imersões.")
            db.execute("UPDATE jobs SET status='paused',pause_reason='Histórico transferido para o Workspace. Confira os dados e use Continuar quando desejar retomar.' WHERE status IN ('queued','running')")
            if "preparations" in tables:
                db.execute("UPDATE preparations SET status='stopped',locked_at=0,error='Organização preservada durante a transferência. Selecione a planilha novamente para continuar.' WHERE status IN ('queued','running')")
            db.execute("UPDATE tasks SET locked_at=0")
            counts = {table: db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] for table in ("immersions", "companies", "participants", "jobs")}
        for name in ("uploads", "tmp"):
            if (source / name).is_dir():
                shutil.copytree(source / name, staging / name)
            else:
                (staging / name).mkdir()
        # Copia modelos, nunca a chave da API do programa local. Se a conta já
        # configurou uma chave no Workspace, mantém suas configurações.
        saved = {}
        if (source / "settings.json").is_file():
            saved = json.loads((source / "settings.json").read_text("utf-8"))
        settings = {key: saved[key] for key in ("model", "extraction_model") if key in saved}
        if (target / "settings.json").is_file():
            shutil.copyfile(target / "settings.json", staging / "settings.json")
        else:
            (staging / "settings.json").write_text(json.dumps(settings), "utf-8")
        for path in staging.rglob("*"):
            path.chmod(0o700 if path.is_dir() else 0o600)
        if target.exists():
            backup = target.with_name(target.name + ".before-migration-" + uuid4().hex[:12])
            os.replace(target, backup)
            try:
                os.replace(staging, target)
            except Exception:
                os.replace(backup, target)
                raise
        else:
            os.replace(staging, target)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Transferir o histórico local do Mapa IA para uma conta do Workspace.")
    parser.add_argument("--email", required=True, help="E-mail de uma conta já cadastrada com acesso Mapa IA · Imersões.")
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent / "legacy_data", help="Pasta data de outra instalação do Mapa IA; o padrão usa o histórico incluído nesta entrega.")
    args = parser.parse_args()
    from main import DBUser, SessionLocal
    with SessionLocal() as db:
        user = db.query(DBUser).filter(DBUser.email == args.email.strip()).first()
        if not user or user.role != "mapa_ia":
            parser.exit(1, "Cadastre primeiro uma conta com este e-mail e acesso Mapa IA · Imersões na Gestão de Equipe.\n")
        user_id = user.id
    root = data_root()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / ".workers.lock").open("a") as lease:
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "Pare o serviço do Workspace antes de transferir o histórico.\n")
        try:
            counts = import_history(args.source, root / "users" / str(user_id))
        except (ValueError, OSError, sqlite3.Error) as exc:
            print("Não foi possível transferir o histórico: " + str(exc))
            return 1
    print(f"Histórico transferido: {counts['immersions']} imersões, {counts['companies']} cadastros, {counts['participants']} inscrições e {counts['jobs']} pesquisas. Reinicie o Workspace.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
