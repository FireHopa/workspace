from __future__ import annotations

import fcntl
import json
import logging
import os
import re
import threading
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from . import core
from .pdf import render_dossier_pdf

logger = logging.getLogger(__name__)
MAX_BODY = 1024 * 1024


def data_root() -> Path:
    configured = os.environ.get("SKYBOB_DATA_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else Path(__file__).resolve().parent / "data"


def mapa_root() -> Path:
    configured = os.environ.get("MAPA_IA_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parent.parent / "mapa_ia" / "data"


class WorkspaceRuntime:
    def __init__(self, session_factory, user_model):
        self.root = data_root()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.root / "users").mkdir(exist_ok=True, mode=0o700)
        self.session_factory = session_factory
        self.user_model = user_model
        self.stores: dict[int, core.Store] = {}
        self.lock = threading.RLock()
        self.stopping = threading.Event()
        self.supervisor: threading.Thread | None = None

    def key_for(self, user_id: int) -> str:
        direct = os.environ.get("SKYBOB_OPENAI_API_KEY", "").strip() or os.environ.get("OPENAI_API_KEY", "").strip()
        if direct:
            return direct
        # Reutiliza apenas a credencial já configurada na conta do Mapa IA.
        # Nenhum dado de análise, empresa ou histórico é compartilhado entre os módulos.
        settings_path = mapa_root() / "users" / str(int(user_id)) / "settings.json"
        try:
            if settings_path.exists():
                saved = json.loads(settings_path.read_text("utf-8"))
                return str(saved.get("api_key") or "").strip()
        except (OSError, ValueError, TypeError):
            return ""
        return ""

    def store_for(self, user_id: int) -> core.Store:
        user_id = int(user_id)
        with self.lock:
            if user_id not in self.stores:
                directory = self.root / "users" / str(user_id)
                directory.mkdir(exist_ok=True, mode=0o700)
                with (directory / ".initialization.lock").open("a") as handle:
                    fcntl.flock(handle, fcntl.LOCK_EX)
                    self.stores[user_id] = core.Store(directory, lambda uid=user_id: self.key_for(uid))
            return self.stores[user_id]

    def account_ids(self) -> list[int]:
        with self.session_factory() as db:
            rows = db.query(self.user_model.id, self.user_model.role).all()
        return [int(row[0]) for row in rows if row[1] in {"mapa_ia", "admin"} and (self.root / "users" / str(int(row[0])) / "skybob.sqlite3").exists()]

    def worker(self):
        cursor = 0
        while not self.stopping.is_set():
            did_work = False
            try:
                ids = self.account_ids()
                if ids:
                    start = cursor % len(ids)
                    for user_id in ids[start:] + ids[:start]:
                        if self.stopping.is_set():
                            break
                        store = self.store_for(user_id)
                        if store.configured() and store.process_next():
                            did_work = True
                            cursor = (ids.index(user_id) + 1) % max(1, len(ids))
                            break
            except Exception:
                logger.warning("Uma etapa do Skybob falhou; o histórico salvo foi preservado.")
            self.stopping.wait(1 if did_work else 2.5)

    def supervise(self):
        with (self.root / ".workers.lock").open("a") as lease:
            while not self.stopping.is_set():
                try:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    self.stopping.wait(2)
                    continue
                worker = threading.Thread(target=self.worker, name="skybob-worker", daemon=True)
                try:
                    worker.start()
                    self.stopping.wait()
                    worker.join(timeout=4)
                finally:
                    fcntl.flock(lease, fcntl.LOCK_UN)
                return

    def start(self):
        if self.supervisor and self.supervisor.is_alive():
            return
        self.stopping.clear()
        self.supervisor = threading.Thread(target=self.supervise, name="skybob-supervisor", daemon=True)
        self.supervisor.start()

    def stop(self):
        self.stopping.set()
        if self.supervisor:
            self.supervisor.join(timeout=3)


async def read_json(request: Request) -> dict:
    if not request.headers.get("content-type", "").lower().startswith("application/json"):
        raise core.SkybobError("Envie uma solicitação JSON válida.")
    try:
        size = int(request.headers.get("content-length", "0"))
    except ValueError as exc:
        raise core.SkybobError("Solicitação inválida.") from exc
    if size > MAX_BODY:
        raise core.SkybobError("A solicitação excedeu o limite de tamanho.", 413)
    chunks, received = [], 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_BODY:
            raise core.SkybobError("A solicitação excedeu o limite de tamanho.", 413)
        chunks.append(chunk)
    try:
        value = json.loads(b"".join(chunks))
    except (ValueError, UnicodeDecodeError) as exc:
        raise core.SkybobError("Solicitação JSON inválida.") from exc
    if not isinstance(value, dict):
        raise core.SkybobError("Solicitação inválida.")
    return value


def register_skybob(app, session_factory, user_model, get_current_user):
    runtime = WorkspaceRuntime(session_factory, user_model)
    app.state.skybob_runtime = runtime

    def authorized(user=Depends(get_current_user)):
        if user.role not in {"mapa_ia", "admin"}:
            raise HTTPException(403, "Esta conta não tem acesso ao Skybob.")
        return user

    def account_store(user=Depends(authorized)):
        return runtime.store_for(user.id)

    router = APIRouter(prefix="/skybob", tags=["Skybob"], dependencies=[Depends(authorized)])

    @app.exception_handler(core.SkybobError)
    async def skybob_error(_request, error):
        return JSONResponse({"error": str(error)}, status_code=error.status, headers={"Cache-Control": "no-store"})

    @router.get("/health")
    def health(store=Depends(account_store)):
        return {"app": "skybob", "version": core.VERSION, "configured": store.configured()}

    @router.get("/state")
    def state(store=Depends(account_store)):
        return store.state()

    @router.post("/investigations")
    def create_investigation(data=Depends(read_json), store=Depends(account_store)):
        return store.create(data)

    @router.get("/investigations/{investigation_id}")
    def investigation_detail(investigation_id: str, store=Depends(account_store)):
        return store.detail(investigation_id)

    @router.post("/investigations/{investigation_id}/action")
    def investigation_action(investigation_id: str, data=Depends(read_json), store=Depends(account_store)):
        return store.action(investigation_id, str(data.get("action") or ""))

    @router.get("/investigations/{investigation_id}/pdf")
    def investigation_pdf(investigation_id: str, store=Depends(account_store)):
        payload = store.pdf_payload(investigation_id)
        try:
            raw = render_dossier_pdf(payload)
        except Exception as exc:
            logger.exception("Skybob PDF export failed: investigation=%s", investigation_id)
            raise HTTPException(
                status_code=500,
                detail="Nao foi possivel gerar o PDF. A investigacao permanece salva; tente novamente.",
            ) from exc
        safe_name = "-".join(re.findall(r"[A-Za-z0-9]+", payload["companyName"]))[:80] or "empresa"
        filename = f"dossie-skybob-{safe_name}.pdf"
        return Response(raw, media_type="application/pdf", headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        })

    @app.middleware("http")
    async def private_skybob_responses(request, call_next):
        is_skybob = request.url.path.startswith("/skybob/")
        try:
            response = await call_next(request)
        except (ValueError, TypeError, KeyError):
            if not is_skybob:
                raise
            response = JSONResponse({"error": "Confira os dados informados e tente novamente."}, status_code=400)
        except Exception:
            if not is_skybob:
                raise
            logger.exception("Skybob request failed: path=%s", request.url.path)
            response = JSONResponse({"error": "Não foi possível concluir a solicitação. O histórico salvo permanece preservado."}, status_code=500)
        if is_skybob:
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    app.include_router(router)
    return runtime
