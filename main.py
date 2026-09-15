import os
import shutil
import secrets
import tempfile
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException, status, File, UploadFile, Body, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine, Column, Integer, String, JSON, ForeignKey, Boolean, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from pydantic import BaseModel
from jose import JWTError, jwt
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
from typing import List, Dict, Any, Optional, Literal
import bcrypt
from dotenv import load_dotenv

load_dotenv() 

def load_signing_key():
    configured = os.getenv("SECRET_KEY", "").strip()
    if configured and configured != "chave_fallback_insegura_apenas_para_dev":
        return configured
    # Chave privada persistente quando o servidor ainda não tem SECRET_KEY.
    # Publicação atômica evita chaves diferentes com vários workers.
    key_path = Path(__file__).resolve().parent / ".jwt_secret_key"
    if not key_path.exists():
        fd, temp_path = tempfile.mkstemp(prefix=".jwt-key-", dir=str(key_path.parent))
        try:
            with os.fdopen(fd, "w") as handle:
                handle.write(secrets.token_urlsafe(48))
            try:
                os.link(temp_path, key_path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temp_path)
    value = key_path.read_text().strip()
    if not value:
        raise RuntimeError("Configure SECRET_KEY: arquivo de chave vazio.")
    return value


SECRET_KEY = load_signing_key()
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./sistema_tarefas.db")
SERVER_URL = os.getenv("SERVER_URL", "http://localhost:8000")

ADMIN_NAME = os.getenv("ADMIN_NAME", "Admin Supremo")
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@casadoads.com")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class DBTeamRole(Base):
    __tablename__ = "team_roles"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True)

class DBUser(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String)
    email = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    role = Column(String) 
    team_role = Column(String, nullable=True) 
    notifications = Column(JSON, default=[])
    is_strategist = Column(Boolean, default=False)

class DBTemplate(Base):
    __tablename__ = "templates"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String)
    schema_fields = Column(JSON) 
    is_recurrent = Column(Boolean, default=False)

class DBTask(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True, index=True)
    template_id = Column(Integer, ForeignKey("templates.id"))
    assigned_to = Column(Integer, ForeignKey("users.id"))
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    reviewer_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    final_approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    status = Column(String, default="A Fazer") 
    dynamic_data = Column(JSON) 
    folder = Column(String, default="Entrada")
    priority = Column(String, default="Normal") 
    deadline = Column(String, nullable=True)
    comments = Column(JSON, default=[]) 
    admin_attachments = Column(JSON, default=[]) 
    admin_feedback = Column(String, nullable=True) 
    admin_notes = Column(String, nullable=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    created_at = Column(String, default=lambda: datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"), nullable=True)
    updated_at = Column(String, nullable=True)
    completed_at = Column(String, nullable=True)

class DBTaskActivity(Base):
    __tablename__ = "task_activities"
    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), index=True)
    actor_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    actor_name = Column(String, nullable=True)
    action = Column(String)
    from_status = Column(String, nullable=True)
    to_status = Column(String, nullable=True)
    note = Column(String, nullable=True)
    created_at = Column(String, default=lambda: datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"))

class DBPlan(Base):
    __tablename__ = "plans"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True)

class DBClient(Base):
    __tablename__ = "clients"
    id = Column(Integer, primary_key=True, index=True)
    company_name = Column(String)
    client_name = Column(String)
    plan_id = Column(Integer, ForeignKey("plans.id"))
    campaign_id = Column(String)
    tech_leader_id = Column(Integer, ForeignKey("users.id"))
    investment_3m = Column(String)
    project_tier = Column(Integer)
    start_date = Column(String)
    category = Column(String)
    location = Column(String)
    strategist_id = Column(Integer, ForeignKey("users.id"))
    created_by = Column(Integer, ForeignKey("users.id"))
    last_meeting = Column(String, nullable=True)
    deadline_meeting = Column(String, nullable=True)
    last_optimization = Column(String, nullable=True)
    deadline_optimization = Column(String, nullable=True)
    last_relationship = Column(String, nullable=True)
    deadline_relationship = Column(String, nullable=True)

# NOVA TABELA: Produtividade Pessoal
class DBPersonalTask(Base):
    __tablename__ = "personal_tasks"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String)
    description = Column(String, nullable=True)
    status = Column(String, default="pending") 
    priority = Column(String, default="Média") 
    created_at = Column(String, default=lambda: datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"))

Base.metadata.create_all(bind=engine)

def migrate_database():
    """Garante compatibilidade com bancos SQLite antigos sem perder dados."""
    inspector = inspect(engine)
    if "tasks" in inspector.get_table_names():
        existing_columns = {col["name"] for col in inspector.get_columns("tasks")}
        columns_to_add = {
            "created_by": "INTEGER",
            "reviewer_id": "INTEGER",
            "final_approved_by": "INTEGER",
            "created_at": "VARCHAR",
            "updated_at": "VARCHAR",
            "completed_at": "VARCHAR",
        }
        with engine.begin() as conn:
            for column_name, column_type in columns_to_add.items():
                if column_name not in existing_columns:
                    conn.execute(text(f"ALTER TABLE tasks ADD COLUMN {column_name} {column_type}"))

migrate_database()

def now_str():
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

def add_task_activity(db: Session, task_id: int, actor_id: Optional[int], actor_name: Optional[str], action: str, from_status: Optional[str] = None, to_status: Optional[str] = None, note: Optional[str] = None):
    activity = DBTaskActivity(
        task_id=task_id,
        actor_id=actor_id,
        actor_name=actor_name,
        action=action,
        from_status=from_status,
        to_status=to_status,
        note=note,
        created_at=now_str(),
    )
    db.add(activity)
    return activity

def get_template_field_type_and_required(field_config: Any):
    """Aceita templates antigos (campo: "text") e novos (campo: {type, required})."""
    if isinstance(field_config, dict):
        return field_config.get("type") or "text", bool(field_config.get("required", False))
    return field_config or "text", False

def is_required_value_filled(field_type: str, value: Any) -> bool:
    if field_type == "checkbox":
        return value is True
    if value is None:
        return False
    if isinstance(value, str):
        cleaned = value.strip()
        return bool(cleaned) and cleaned.lower() != "loading..."
    if isinstance(value, (list, dict)):
        return len(value) > 0
    return bool(value)

def get_missing_required_fields(db: Session, task: DBTask) -> List[str]:
    template = db.query(DBTemplate).filter(DBTemplate.id == task.template_id).first()
    if not template or not template.schema_fields:
        return []

    answers = task.dynamic_data or {}
    missing = []
    for field_label, field_config in template.schema_fields.items():
        field_type, required = get_template_field_type_and_required(field_config)
        if required and not is_required_value_filled(field_type, answers.get(field_label)):
            missing.append(field_label)
    return missing

def add_notification_to_user(db: Session, user_id: Optional[int], text_value: str):
    if not user_id:
        return
    user = db.query(DBUser).filter(DBUser.id == user_id).first()
    if not user:
        return
    nots = user.notifications or []
    new_not = {"id": int(datetime.utcnow().timestamp() * 1000), "text": text_value, "read": False}
    user.notifications = [new_not] + nots

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

def get_password_hash(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')

def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))
    except ValueError:
        return False

def create_access_token(data: dict):
    to_encode = data.copy()
    to_encode.update({"exp": datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

os.makedirs("uploads", exist_ok=True) 

@asynccontextmanager
async def lifespan(app: FastAPI):
    db = SessionLocal()
    admin = db.query(DBUser).filter(DBUser.email == ADMIN_EMAIL).first()
    if not admin:
        new_admin = DBUser(name=ADMIN_NAME, email=ADMIN_EMAIL, hashed_password=get_password_hash(ADMIN_PASSWORD), role="admin", team_role="Diretoria", is_strategist=True)
        db.add(new_admin)
        db.commit()
    db.close()
    yield

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    error = HTTPException(status_code=401, detail="Sessão inválida ou expirada.", headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM], options={"require_exp": True})
        email = payload.get("sub")
        if not email:
            raise error
    except JWTError:
        raise error
    user = db.query(DBUser).filter(DBUser.email == email).first()
    if not user:
        raise error
    return user


def require_module_access(request: Request, db: Session = Depends(get_db)):
    if request.url.path.rstrip("/") == "/token":
        return
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Faça login para acessar o sistema.", headers={"WWW-Authenticate": "Bearer"})
    user = get_current_user(token, db)
    path = request.url.path.rstrip("/")
    if user.role == "finance":
        allowed = path.startswith("/finance/") or path == "/me" or (
            path == f"/users/{user.id}/password" and request.method == "PUT")
        if not allowed:
            raise HTTPException(403, "Este usuário tem acesso somente ao Financeiro.")
    elif user.role not in ("admin", "employee", "conferente"):
        raise HTTPException(403, "Perfil de acesso inválido.")


def require_admin(user: DBUser = Depends(get_current_user)):
    if user.role != "admin":
        raise HTTPException(403, "Somente administradores podem gerenciar usuários.")
    return user


app = FastAPI(title="Sistema de Gestão", lifespan=lifespan, dependencies=[Depends(require_module_access)])

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

# ---- SCHEMAS ----
class UserCreate(BaseModel): name: str; email: str; password: str; role: Literal["admin", "employee", "conferente", "finance"] = "employee"; team_role: Optional[str] = None; is_strategist: bool = False
class UserUpdate(BaseModel): role: Optional[Literal["admin", "employee", "conferente", "finance"]] = None; team_role: Optional[str] = None; is_strategist: Optional[bool] = None
class UserResponse(BaseModel):
    id: int; name: str; email: str; role: str; team_role: Optional[str]; is_strategist: bool
    class Config: from_attributes = True

class TeamRoleCreate(BaseModel): name: str
class TeamRoleResponse(BaseModel): 
    id: int; name: str
    class Config: from_attributes = True

class TemplateCreate(BaseModel): name: str; schema_fields: Dict[str, Any]; is_recurrent: bool = False
class TemplateResponse(BaseModel):
    id: int; name: str; schema_fields: Dict[str, Any]; is_recurrent: bool
    class Config: from_attributes = True

class TaskCreate(BaseModel): template_id: int; assigned_to: int; dynamic_data: Dict[str, Any]; priority: str; deadline: Optional[str]; admin_attachments: Optional[List[str]] = []; admin_notes: Optional[str] = None; client_id: Optional[int] = None; created_by: Optional[int] = None; reviewer_id: Optional[int] = None
class BulkTaskCreate(BaseModel): template_id: int; target_team_role: str; dynamic_data: Dict[str, Any]; priority: str; deadline: Optional[str]; admin_attachments: Optional[List[str]] = []; admin_notes: Optional[str] = None; client_id: Optional[int] = None; created_by: Optional[int] = None; reviewer_id: Optional[int] = None
class TaskUpdate(BaseModel): dynamic_data: Dict[str, Any]; status: str; folder: Optional[str] = None; admin_feedback: Optional[str] = None; actor_id: Optional[int] = None; actor_name: Optional[str] = None
class NotificationCreate(BaseModel): text: str
class CommentCreate(BaseModel): sender: str; text: str
class TaskFlowAction(BaseModel): actor_id: Optional[int] = None; actor_name: Optional[str] = None; feedback: Optional[str] = None
class PasswordUpdate(BaseModel): current_password: str; new_password: str
class PlanCreate(BaseModel): name: str
class PlanResponse(BaseModel):
    id: int; name: str
    class Config: from_attributes = True

class ClientCreate(BaseModel):
    company_name: str; client_name: str; created_by: int; plan_id: Optional[int] = None; campaign_id: Optional[str] = None; tech_leader_id: Optional[int] = None; investment_3m: Optional[str] = None; project_tier: Optional[int] = None; start_date: Optional[str] = None; category: Optional[str] = None; location: Optional[str] = None; strategist_id: Optional[int] = None; last_meeting: Optional[str] = None; deadline_meeting: Optional[str] = None; last_optimization: Optional[str] = None; deadline_optimization: Optional[str] = None; last_relationship: Optional[str] = None; deadline_relationship: Optional[str] = None

class ClientResponse(ClientCreate):
    id: int
    class Config: from_attributes = True

# NOVOS SCHEMAS PRODUTIVIDADE
class PersonalTaskCreate(BaseModel):
    user_id: int
    title: str
    description: Optional[str] = None
    priority: str = "Média"

class PersonalTaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None

class PersonalTaskResponse(BaseModel):
    id: int; user_id: int; title: str; description: Optional[str]; status: str; priority: str; created_at: str
    class Config: from_attributes = True

# ---- ENDPOINTS AUTENTICAÇÃO E USUÁRIOS ----
@app.post("/token")
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(DBUser).filter(DBUser.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password): raise HTTPException(status_code=400, detail="Credenciais incorretas")
    token = create_access_token(data={"sub": user.email, "role": user.role, "name": user.name, "id": user.id, "is_strategist": user.is_strategist})
    return {"access_token": token, "token_type": "bearer"}

@app.put("/users/{user_id}/password")
def update_password(user_id: int, passwords: PasswordUpdate, db: Session = Depends(get_db), actor: DBUser = Depends(get_current_user)):
    if actor.id != user_id: raise HTTPException(403, "Você só pode alterar a própria senha.")
    if len(passwords.new_password) < 6 or len(passwords.new_password.encode("utf-8")) > 72:
        raise HTTPException(422, "Use uma senha de pelo menos 6 caracteres e até 72 bytes.")
    user = db.query(DBUser).filter(DBUser.id == user_id).first()
    if not user: raise HTTPException(status_code=404)
    if not verify_password(passwords.current_password, user.hashed_password): raise HTTPException(status_code=400, detail="Senha atual incorreta")
    user.hashed_password = get_password_hash(passwords.new_password)
    db.commit()
    return {"msg": "Senha atualizada"}

@app.post("/users/", response_model=UserResponse)
def create_user(user: UserCreate, db: Session = Depends(get_db), actor: DBUser = Depends(require_admin)):
    if len(user.password) < 6 or len(user.password.encode("utf-8")) > 72:
        raise HTTPException(422, "Use uma senha de pelo menos 6 caracteres e até 72 bytes.")
    if not user.name.strip() or not user.email.strip():
        raise HTTPException(422, "Nome e e-mail são obrigatórios.")
    if db.query(DBUser).filter(DBUser.email == user.email).first(): raise HTTPException(status_code=400, detail="E-mail já cadastrado.")
    if user.role == "finance":
        user.team_role = None
        user.is_strategist = False
    new_user = DBUser(name=user.name, email=user.email, hashed_password=get_password_hash(user.password), role=user.role, team_role=user.team_role, is_strategist=user.is_strategist)
    db.add(new_user); db.commit(); db.refresh(new_user)
    return new_user

@app.get("/users/", response_model=List[UserResponse])
def get_all_users(db: Session = Depends(get_db)): return db.query(DBUser).all()

@app.put("/users/{user_id}", response_model=UserResponse)
def update_user(user_id: int, user_update: UserUpdate, db: Session = Depends(get_db), actor: DBUser = Depends(require_admin)):
    user = db.query(DBUser).filter(DBUser.id == user_id).first()
    if not user: raise HTTPException(404, "Usuário não encontrado.")
    if actor.id == user_id and user_update.role not in (None, "admin"):
        raise HTTPException(400, "Você não pode retirar o próprio acesso de administrador.")
    if user_update.role is not None: user.role = user_update.role
    if user_update.team_role is not None: user.team_role = user_update.team_role
    if user_update.is_strategist is not None: user.is_strategist = user_update.is_strategist
    if user.role == "finance":
        user.team_role = None
        user.is_strategist = False
    db.commit(); db.refresh(user)
    return user

@app.post("/team-roles/", response_model=TeamRoleResponse)
def create_team_role(role: TeamRoleCreate, db: Session = Depends(get_db)):
    if db.query(DBTeamRole).filter(DBTeamRole.name == role.name).first(): raise HTTPException(status_code=400)
    new_role = DBTeamRole(name=role.name)
    db.add(new_role); db.commit(); db.refresh(new_role)
    return new_role

@app.get("/team-roles/", response_model=List[TeamRoleResponse])
def get_team_roles(db: Session = Depends(get_db)): return db.query(DBTeamRole).all()

# ---- ENDPOINTS CORE ----
@app.post("/templates/", response_model=TemplateResponse)
def create_template(template: TemplateCreate, db: Session = Depends(get_db)):
    new_tpl = DBTemplate(name=template.name, schema_fields=template.schema_fields, is_recurrent=template.is_recurrent)
    db.add(new_tpl); db.commit(); db.refresh(new_tpl)
    return new_tpl

@app.get("/templates/", response_model=List[TemplateResponse])
def get_all_templates(db: Session = Depends(get_db)): return db.query(DBTemplate).all()

@app.put("/templates/{template_id}")
def update_template(template_id: int, template: TemplateCreate, db: Session = Depends(get_db)):
    tpl = db.query(DBTemplate).filter(DBTemplate.id == template_id).first()
    if not tpl: raise HTTPException(status_code=404)
    tpl.name = template.name
    tpl.schema_fields = template.schema_fields
    tpl.is_recurrent = template.is_recurrent
    db.commit(); db.refresh(tpl)
    return tpl

@app.post("/tasks/")
def create_task(task: TaskCreate, db: Session = Depends(get_db)):
    creator = db.query(DBUser).filter(DBUser.id == task.created_by).first() if task.created_by else None
    new_task = DBTask(
        template_id=task.template_id,
        assigned_to=task.assigned_to,
        created_by=task.created_by,
        reviewer_id=task.reviewer_id,
        dynamic_data=task.dynamic_data,
        folder="Entrada",
        priority=task.priority,
        deadline=task.deadline,
        admin_attachments=task.admin_attachments,
        admin_notes=task.admin_notes,
        client_id=task.client_id,
        created_at=now_str(),
        updated_at=now_str(),
    )
    db.add(new_task)
    db.commit()
    db.refresh(new_task)
    add_task_activity(db, new_task.id, task.created_by, creator.name if creator else None, "Tarefa criada", None, "A Fazer", "Tarefa delegada para execução")
    db.commit()
    db.refresh(new_task)
    return new_task

@app.post("/tasks/bulk/")
def create_bulk_tasks(bulk_task: BulkTaskCreate, db: Session = Depends(get_db)):
    users = db.query(DBUser).filter(DBUser.team_role == bulk_task.target_team_role, DBUser.role == "employee").all()
    if not users: raise HTTPException(status_code=404)
    creator = db.query(DBUser).filter(DBUser.id == bulk_task.created_by).first() if bulk_task.created_by else None
    for u in users:
        new_task = DBTask(
            template_id=bulk_task.template_id,
            assigned_to=u.id,
            created_by=bulk_task.created_by,
            reviewer_id=bulk_task.reviewer_id,
            dynamic_data=bulk_task.dynamic_data,
            folder="Entrada",
            priority=bulk_task.priority,
            deadline=bulk_task.deadline,
            admin_attachments=bulk_task.admin_attachments,
            admin_notes=bulk_task.admin_notes,
            client_id=bulk_task.client_id,
            created_at=now_str(),
            updated_at=now_str(),
        )
        db.add(new_task)
        db.flush()
        add_task_activity(db, new_task.id, bulk_task.created_by, creator.name if creator else None, "Tarefa criada em lote", None, "A Fazer", f"Delegada para {u.name}")
    db.commit()
    return {"message": "Tarefas delegadas!"}

@app.get("/tasks/{user_id}")
def get_user_tasks(user_id: int, db: Session = Depends(get_db)):
    return db.query(DBTask).filter(DBTask.assigned_to == user_id).all()

@app.get("/tasks-created/{user_id}")
def get_tasks_created_by_user(user_id: int, db: Session = Depends(get_db)):
    return db.query(DBTask).filter(DBTask.created_by == user_id).all()

@app.get("/reviewer-tasks/{user_id}")
def get_reviewer_tasks(user_id: int, db: Session = Depends(get_db)):
    return db.query(DBTask).filter(DBTask.reviewer_id == user_id).all()

@app.get("/all-tasks/")
def get_all_tasks_admin(db: Session = Depends(get_db)): return db.query(DBTask).all()

@app.get("/task-activities/")
def get_all_task_activities(db: Session = Depends(get_db)):
    return db.query(DBTaskActivity).order_by(DBTaskActivity.id.desc()).limit(500).all()

@app.get("/tasks/{task_id}/activities")
def get_task_activities(task_id: int, db: Session = Depends(get_db)):
    return db.query(DBTaskActivity).filter(DBTaskActivity.task_id == task_id).order_by(DBTaskActivity.id.desc()).all()

@app.put("/tasks/{task_id}")
def update_task(task_id: int, task_update: TaskUpdate, db: Session = Depends(get_db)):
    db_task = db.query(DBTask).filter(DBTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    previous_status = db_task.status
    db_task.dynamic_data = task_update.dynamic_data
    db_task.status = task_update.status
    db_task.updated_at = now_str()
    if task_update.folder is not None: db_task.folder = task_update.folder
    if task_update.admin_feedback is not None: db_task.admin_feedback = task_update.admin_feedback
    if previous_status != db_task.status:
        add_task_activity(db, task_id, task_update.actor_id, task_update.actor_name, "Status atualizado", previous_status, db_task.status, task_update.admin_feedback)
    db.commit(); db.refresh(db_task)
    return db_task

@app.post("/tasks/{task_id}/send-to-reviewer")
def send_task_to_reviewer(task_id: int, action: TaskFlowAction, db: Session = Depends(get_db)):
    db_task = db.query(DBTask).filter(DBTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    missing_required_fields = get_missing_required_fields(db, db_task)
    if missing_required_fields:
        raise HTTPException(status_code=400, detail=f"Campos obrigatórios pendentes: {', '.join(missing_required_fields)}")
    previous_status = db_task.status
    next_status = "Aguardando Conferência" if db_task.reviewer_id else "Aguardando Aprovação"
    db_task.status = next_status
    db_task.folder = next_status
    db_task.admin_feedback = ""
    db_task.updated_at = now_str()
    add_task_activity(db, task_id, action.actor_id, action.actor_name, "Entrega enviada", previous_status, next_status, "Executor enviou a tarefa para revisão")
    if db_task.reviewer_id:
        add_notification_to_user(db, db_task.reviewer_id, f"Nova tarefa aguardando conferência: #{db_task.id}")
    else:
        admin = db.query(DBUser).filter(DBUser.email == ADMIN_EMAIL).first()
        add_notification_to_user(db, admin.id if admin else 1, f"Tarefa enviada para aprovação por {action.actor_name or 'um parceiro'}")
    db.commit(); db.refresh(db_task)
    return db_task

@app.post("/tasks/{task_id}/reviewer-approve")
def reviewer_approve_task(task_id: int, action: TaskFlowAction, db: Session = Depends(get_db)):
    db_task = db.query(DBTask).filter(DBTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    previous_status = db_task.status
    db_task.status = "Aguardando OK Final"
    db_task.folder = "Aguardando OK Final"
    db_task.admin_feedback = ""
    db_task.updated_at = now_str()
    add_task_activity(db, task_id, action.actor_id, action.actor_name, "Conferência aprovada", previous_status, db_task.status, action.feedback or "Conferente aprovou a entrega")
    if db_task.created_by:
        add_notification_to_user(db, db_task.created_by, f"Tarefa #{db_task.id} conferida. Aguardando seu OK final.")
    db.commit(); db.refresh(db_task)
    return db_task

@app.post("/tasks/{task_id}/reviewer-reject")
def reviewer_reject_task(task_id: int, action: TaskFlowAction, db: Session = Depends(get_db)):
    db_task = db.query(DBTask).filter(DBTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    if not action.feedback or not action.feedback.strip():
        raise HTTPException(status_code=400, detail="Informe o motivo da devolução.")
    previous_status = db_task.status
    db_task.status = "A Fazer"
    db_task.folder = "Entrada"
    db_task.admin_feedback = action.feedback.strip()
    db_task.updated_at = now_str()
    add_task_activity(db, task_id, action.actor_id, action.actor_name, "Conferência recusada", previous_status, db_task.status, action.feedback.strip())
    add_notification_to_user(db, db_task.assigned_to, "Tarefa devolvida pelo conferente para correção.")
    db.commit(); db.refresh(db_task)
    return db_task

@app.post("/tasks/{task_id}/final-approve")
def final_approve_task(task_id: int, action: TaskFlowAction, db: Session = Depends(get_db)):
    db_task = db.query(DBTask).filter(DBTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    previous_status = db_task.status
    db_task.status = "Aprovada"
    db_task.folder = "Concluídas"
    db_task.final_approved_by = action.actor_id
    db_task.updated_at = now_str()
    db_task.completed_at = now_str()
    add_task_activity(db, task_id, action.actor_id, action.actor_name, "OK final aprovado", previous_status, db_task.status, action.feedback or "Solicitante aprovou a entrega final")
    add_notification_to_user(db, db_task.assigned_to, "Tarefa aprovada pelo solicitante.")
    if db_task.reviewer_id:
        add_notification_to_user(db, db_task.reviewer_id, "Tarefa recebeu OK final do solicitante.")
    db.commit(); db.refresh(db_task)
    return db_task

@app.post("/tasks/{task_id}/final-reject")
def final_reject_task(task_id: int, action: TaskFlowAction, db: Session = Depends(get_db)):
    db_task = db.query(DBTask).filter(DBTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    if not action.feedback or not action.feedback.strip():
        raise HTTPException(status_code=400, detail="Informe o motivo da devolução.")
    previous_status = db_task.status
    db_task.status = "A Fazer"
    db_task.folder = "Entrada"
    db_task.admin_feedback = action.feedback.strip()
    db_task.updated_at = now_str()
    add_task_activity(db, task_id, action.actor_id, action.actor_name, "OK final recusado", previous_status, db_task.status, action.feedback.strip())
    add_notification_to_user(db, db_task.assigned_to, "Tarefa devolvida pelo solicitante para correção.")
    db.commit(); db.refresh(db_task)
    return db_task

@app.delete("/tasks/{task_id}")
def delete_task(task_id: int, db: Session = Depends(get_db)):
    db_task = db.query(DBTask).filter(DBTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    db.query(DBTaskActivity).filter(DBTaskActivity.task_id == task_id).delete()
    db.delete(db_task); db.commit()
    return {"msg": "Tarefa excluída"}

@app.post("/tasks/{task_id}/comments")
def add_comment(task_id: int, comment: CommentCreate, db: Session = Depends(get_db)):
    db_task = db.query(DBTask).filter(DBTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    current_comments = db_task.comments or []
    new_comment = {"sender": comment.sender, "text": comment.text, "time": datetime.utcnow().strftime("%d/%m %H:%M")}
    db_task.comments = current_comments + [new_comment]
    db_task.updated_at = now_str()
    add_task_activity(db, task_id, None, comment.sender, "Comentário adicionado", db_task.status, db_task.status, comment.text)
    db.commit(); db.refresh(db_task)
    return db_task

@app.post("/users/{user_id}/notifications")
def add_notification(user_id: int, notif: NotificationCreate, db: Session = Depends(get_db)):
    user = db.query(DBUser).filter(DBUser.id == user_id).first()
    if not user: raise HTTPException(status_code=404)
    nots = user.notifications or []
    new_not = {"id": int(datetime.utcnow().timestamp()), "text": notif.text, "read": False}
    user.notifications = [new_not] + nots 
    db.commit()
    return {"msg": "ok"}

@app.get("/users/{user_id}/notifications")
def get_notifications(user_id: int, db: Session = Depends(get_db)):
    user = db.query(DBUser).filter(DBUser.id == user_id).first()
    return user.notifications or []

@app.put("/users/{user_id}/notifications/read")
def mark_notifications_read(user_id: int, db: Session = Depends(get_db)):
    user = db.query(DBUser).filter(DBUser.id == user_id).first()
    nots = user.notifications or []
    for n in nots: n['read'] = True
    user.notifications = list(nots) 
    db.commit()
    return {"msg": "ok"}

@app.post("/plans/", response_model=PlanResponse)
def create_plan(plan: PlanCreate, db: Session = Depends(get_db)):
    if db.query(DBPlan).filter(DBPlan.name == plan.name).first(): raise HTTPException(status_code=400, detail="Plano já existe")
    new_plan = DBPlan(name=plan.name)
    db.add(new_plan); db.commit(); db.refresh(new_plan)
    return new_plan

@app.get("/plans/", response_model=List[PlanResponse])
def get_plans(db: Session = Depends(get_db)): return db.query(DBPlan).all()

@app.delete("/plans/{plan_id}")
def delete_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = db.query(DBPlan).filter(DBPlan.id == plan_id).first()
    if not plan: raise HTTPException(status_code=404)
    db.delete(plan); db.commit()
    return {"msg": "Plano excluído"}

@app.post("/clients/", response_model=ClientResponse)
def create_client(client: ClientCreate, db: Session = Depends(get_db)):
    new_client = DBClient(**client.dict()); db.add(new_client); db.commit(); db.refresh(new_client)
    return new_client

@app.get("/clients/{user_id}", response_model=List[ClientResponse])
def get_clients(user_id: int, db: Session = Depends(get_db)):
    user = db.query(DBUser).filter(DBUser.id == user_id).first()
    if not user: raise HTTPException(status_code=404)
    if user.email == ADMIN_EMAIL: return db.query(DBClient).all()
    elif user.role == "admin": return db.query(DBClient).filter(DBClient.created_by == user.id).all()
    else: return db.query(DBClient).filter(DBClient.strategist_id == user.id).all()

@app.get("/all-clients/")
def get_all_clients_basic(db: Session = Depends(get_db)):
    return [{"id": c.id, "company_name": c.company_name} for c in db.query(DBClient).all()]

@app.put("/clients/{client_id}", response_model=ClientResponse)
def update_client(client_id: int, client: ClientCreate, db: Session = Depends(get_db)):
    db_client = db.query(DBClient).filter(DBClient.id == client_id).first()
    if not db_client: raise HTTPException(status_code=404)
    for key, value in client.dict().items(): setattr(db_client, key, value)
    db.commit(); db.refresh(db_client)
    return db_client

@app.delete("/clients/{client_id}")
def delete_client(client_id: int, db: Session = Depends(get_db)):
    db_client = db.query(DBClient).filter(DBClient.id == client_id).first()
    if not db_client: raise HTTPException(status_code=404)
    db.delete(db_client); db.commit()
    return {"msg": "Cliente excluído"}

# ---- NOVOS ENDPOINTS: PRODUTIVIDADE PESSOAL ----
@app.post("/personal-tasks/", response_model=PersonalTaskResponse)
def create_personal_task(task: PersonalTaskCreate, db: Session = Depends(get_db)):
    new_task = DBPersonalTask(**task.dict())
    db.add(new_task)
    db.commit()
    db.refresh(new_task)
    return new_task

@app.get("/personal-tasks/{user_id}", response_model=List[PersonalTaskResponse])
def get_personal_tasks(user_id: int, db: Session = Depends(get_db)):
    return db.query(DBPersonalTask).filter(DBPersonalTask.user_id == user_id).order_by(DBPersonalTask.id.desc()).all()

@app.put("/personal-tasks/{task_id}", response_model=PersonalTaskResponse)
def update_personal_task(task_id: int, task_update: PersonalTaskUpdate, db: Session = Depends(get_db)):
    db_task = db.query(DBPersonalTask).filter(DBPersonalTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    for key, value in task_update.dict(exclude_unset=True).items():
        setattr(db_task, key, value)
    db.commit()
    db.refresh(db_task)
    return db_task

@app.delete("/personal-tasks/{task_id}")
def delete_personal_task(task_id: int, db: Session = Depends(get_db)):
    db_task = db.query(DBPersonalTask).filter(DBPersonalTask.id == task_id).first()
    if not db_task: raise HTTPException(status_code=404)
    db.delete(db_task)
    db.commit()
    return {"msg": "Tarefa pessoal excluída"}

@app.post("/upload/")
def upload_file(file: UploadFile = File(...)):
    filename = f"{int(datetime.utcnow().timestamp())}_{file.filename.replace(' ', '_')}"
    with open(f"uploads/{filename}", "wb+") as f: shutil.copyfileobj(file.file, f)
    return {"url": f"{SERVER_URL}/uploads/{filename}"}

@app.delete("/upload/{filename}")
def delete_file(filename: str):
    file_path = f"uploads/{filename}"
    if os.path.exists(file_path):
        os.remove(file_path); return {"message": "removido"}
    raise HTTPException(status_code=404)

@app.get("/me", response_model=UserResponse)
def current_profile(user: DBUser = Depends(get_current_user)):
    return user


from finance import register_finance
register_finance(app, engine, get_db, get_current_user)
