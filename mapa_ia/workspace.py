"""API e filas do Mapa IA usando a autenticação e o processo do Workspace."""
from __future__ import annotations

import fcntl
import json
import logging
import os
import threading
import urllib.parse
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from . import core, dashboard, niche_reviews, organizer

logger = logging.getLogger(__name__)
MAX_BODY = 15 * 1024 * 1024


def data_root() -> Path:
    configured = os.environ.get("MAPA_IA_DATA_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else Path(__file__).resolve().parent / "data"


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
        self.worker_count = max(0, min(4, int(os.environ.get("MAPA_IA_WORKERS", "2"))))

    def store_for(self, user_id: int) -> core.Store:
        # O ID é obtido exclusivamente do usuário autenticado, nunca do pedido.
        user_id = int(user_id)
        with self.lock:
            if user_id not in self.stores:
                directory = self.root / "users" / str(user_id)
                directory.mkdir(exist_ok=True, mode=0o700)
                # Evita duas migrações simultâneas da mesma conta em ASGI workers.
                with (directory / ".initialization.lock").open("a") as handle:
                    fcntl.flock(handle, fcntl.LOCK_EX)
                    self.stores[user_id] = core.Store(directory)
            return self.stores[user_id]

    def account_ids(self) -> list[int]:
        with self.session_factory() as db:
            ids = [row[0] for row in db.query(self.user_model.id).filter(self.user_model.role == "mapa_ia").all()]
        # Retoma históricos já inicializados mesmo sem o navegador aberto.
        return [user_id for user_id in ids if (self.root / "users" / str(user_id) / "mapa-ia.sqlite3").exists()]

    def process_account(self, user_id: int) -> bool:
        store = self.store_for(user_id)
        if not store.settings()["keyConfigured"]:
            return False
        preparation = organizer.claim(store)
        if preparation:
            organizer.process(store, preparation)
            return True
        task = store.claim_task()
        if task:
            core.process_task(store, task)
            return True
        return False

    def worker(self, offset: int):
        cursor = offset
        while not self.stopping.is_set():
            did_work = False
            try:
                ids = self.account_ids()
                if ids:
                    start = cursor % len(ids)
                    for user_id in ids[start:] + ids[:start]:
                        if self.stopping.is_set():
                            break
                        if self.process_account(user_id):
                            did_work = True
                            cursor = ids.index(user_id) + 1
                            break
            except Exception:
                # Não registrar chaves, contatos ou corpos de respostas.
                logger.warning("Uma etapa do Mapa IA falhou; o andamento salvo será preservado.")
            self.stopping.wait(0.5 if did_work else 2)

    def supervise(self):
        # Uma única fila de workers por instalação, inclusive com vários
        # processos do Uvicorn. Outro processo assume quando o líder encerra.
        with (self.root / ".workers.lock").open("a") as lease:
            while not self.stopping.is_set():
                try:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    self.stopping.wait(2)
                    continue
                workers = [threading.Thread(target=self.worker, args=(i,), name=f"mapa-ia-{i}", daemon=True) for i in range(self.worker_count)]
                try:
                    for worker in workers:
                        worker.start()
                    self.stopping.wait()
                    for worker in workers:
                        worker.join()
                finally:
                    fcntl.flock(lease, fcntl.LOCK_UN)
                return

    def start(self):
        if not self.worker_count or (self.supervisor and self.supervisor.is_alive()):
            return
        self.stopping.clear()
        self.supervisor = threading.Thread(target=self.supervise, name="mapa-ia-supervisor", daemon=True)
        self.supervisor.start()

    def stop(self):
        self.stopping.set()
        if self.supervisor:
            # Uma consulta enviada à API pode terminar em segundo plano. Os
            # locks persistidos evitam repetir o envio no reinício do servidor.
            self.supervisor.join(timeout=3)


async def read_json(request: Request) -> dict:
    if not request.headers.get("content-type", "").lower().startswith("application/json"):
        raise core.AppError("Envie uma solicitação JSON válida.")
    try:
        size = int(request.headers.get("content-length", "0"))
    except ValueError as exc:
        raise core.AppError("Solicitação incompleta.") from exc
    if size > MAX_BODY:
        raise core.AppError("O envio excedeu o limite de tamanho.", 413)
    chunks, received = [], 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_BODY:
            raise core.AppError("O envio excedeu o limite de tamanho.", 413)
        chunks.append(chunk)
    try:
        value = json.loads(b"".join(chunks))
    except (ValueError, UnicodeDecodeError) as exc:
        raise core.AppError("Solicitação incompleta.") from exc
    if not isinstance(value, dict):
        raise core.AppError("Solicitação inválida.")
    return value


def download(raw: bytes, content_type: str, filename: str) -> Response:
    return Response(raw, media_type=content_type, headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + urllib.parse.quote(filename, safe=""),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })


def register_mapa_ia(app, session_factory, user_model, get_current_user):
    runtime = WorkspaceRuntime(session_factory, user_model)
    app.state.mapa_ia_runtime = runtime

    def authorized(user=Depends(get_current_user)):
        if user.role != "mapa_ia":
            raise HTTPException(403, "Esta conta não tem acesso ao Mapa IA · Imersões.")
        return user

    def account_store(user=Depends(authorized)):
        return runtime.store_for(user.id)

    router = APIRouter(prefix="/mapa-ia", tags=["Mapa IA · Imersões"], dependencies=[Depends(authorized)])

    @app.exception_handler(core.AppError)
    async def mapa_error(_request, error):
        return JSONResponse({"error": str(error)}, status_code=error.status, headers={"Cache-Control": "no-store"})

    @router.get("/health")
    def health():
        return {"app": "mapa-ia-imersoes", "version": core.VERSION, "integration": "workspace"}

    @router.get("/state")
    def state(immersion: str = "", store=Depends(account_store)):
        return store.state(immersion)

    @router.get("/tasks/{task_id}")
    def task_detail(task_id: str, store=Depends(account_store)):
        return store.task_detail(task_id)

    @router.get("/preparations/{preparation_id}")
    def preparation_detail(preparation_id: str, store=Depends(account_store)):
        return organizer.detail(store, preparation_id)

    @router.get("/diagnostics/{immersion_id}")
    def diagnostics(immersion_id: str, job: str = "", store=Depends(account_store)):
        report = store.diagnostics(immersion_id, job)
        return download(json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8"), "application/json", "diagnostico-mapa-ia.json")

    @router.get("/export/{immersion_id}")
    def export(immersion_id: str, request: Request, job: str = "", format: str = "xlsx", store=Depends(account_store)):
        filters = {key: request.query_params[key] for key in ("q", "niche", "presence", "city", "order") if key in request.query_params}
        return download(*core.export_report(store, immersion_id, job, format, filters))

    @router.post("/settings")
    def settings(data=Depends(read_json), store=Depends(account_store)):
        return store.save_settings(data)

    @router.post("/uploads/inspect")
    def inspect_upload(data=Depends(read_json), store=Depends(account_store)):
        return store.stage_upload(data)

    @router.post("/uploads/organize")
    def organize_upload(data=Depends(read_json), store=Depends(account_store)):
        return organizer.start(store, data)

    @router.post("/preparations/{preparation_id}")
    def preparation_action(preparation_id: str, data=Depends(read_json), store=Depends(account_store)):
        return organizer.action(store, preparation_id, str(data.get("action", "")))

    @router.post("/immersions/import")
    def import_upload(data=Depends(read_json), store=Depends(account_store)):
        return store.import_upload(data)

    @router.post("/companies/{company_id}")
    def update_company(company_id: str, data=Depends(read_json), store=Depends(account_store)):
        return store.update_company(company_id, data)

    @router.post("/niche-suggestions/{suggestion_id}")
    def resolve_niche(suggestion_id: str, data=Depends(read_json), store=Depends(account_store)):
        return niche_reviews.resolve(store, suggestion_id, data)

    @router.post("/niche-confirmations")
    def confirm_niches(data=Depends(read_json), store=Depends(account_store)):
        return niche_reviews.resolve_many(store, data)

    @router.post("/immersions/{immersion_id}/jobs")
    def create_job(immersion_id: str, data=Depends(read_json), store=Depends(account_store)):
        return store.create_job(immersion_id, data)

    @router.get("/jobs/{job_id}/google-profiles")
    def google_profiles(job_id: str, refresh: bool = False, store=Depends(account_store)):
        return store.google_profiles(job_id, refresh)

    @router.get("/jobs/{job_id}/dashboard")
    def dashboard_summary(job_id: str, request: Request, store=Depends(account_store)):
        filters = {key: request.query_params[key] for key in ("q", "niche", "city", "neighborhood", "company", "presence", "position") if key in request.query_params}
        return dashboard.summary(store, job_id, filters)

    @router.get("/jobs/{job_id}/dashboard/audit")
    def dashboard_audit(job_id: str, request: Request, page: int = 1, page_size: int = 25, store=Depends(account_store)):
        filters = {key: request.query_params[key] for key in ("q", "niche", "city", "neighborhood", "company", "presence", "position") if key in request.query_params}
        return dashboard.audit(store, job_id, filters, page, page_size)

    @router.get("/jobs/{job_id}/dashboard/entities/{entity_key}")
    def dashboard_entity(job_id: str, entity_key: str, store=Depends(account_store)):
        return dashboard.entity_detail(store, job_id, entity_key)

    @router.get("/jobs/{job_id}/dashboard/map")
    def dashboard_map(job_id: str, request: Request, limit: int = 80, refresh: bool = False, store=Depends(account_store)):
        filters = {key: request.query_params[key] for key in ("q", "niche", "city", "neighborhood", "company", "presence", "position") if key in request.query_params}
        return dashboard.map_data(store, job_id, filters, limit, refresh)

    @router.get("/jobs/{job_id}/dashboard/export")
    def dashboard_export(job_id: str, store=Depends(account_store)):
        return download(*dashboard.export_csv(store, job_id))

    @router.post("/jobs/{job_id}")
    def job_action(job_id: str, data=Depends(read_json), store=Depends(account_store)):
        return store.job_action(job_id, str(data.get("action", "")))

    @app.middleware("http")
    async def private_responses(request, call_next):
        is_mapa = request.url.path.startswith("/mapa-ia/")
        try:
            response = await call_next(request)
        except (ValueError, TypeError, KeyError):
            if not is_mapa:
                raise
            response = JSONResponse({"error": "Confira os campos preenchidos e tente novamente."}, status_code=400)
        except Exception:
            if not is_mapa:
                raise
            logger.warning("Não foi possível concluir uma solicitação do Mapa IA.")
            response = JSONResponse({"error": "Não foi possível concluir. Tente novamente; o histórico salvo permanece preservado."}, status_code=500)
        if is_mapa:
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    app.include_router(router)
    return runtime
