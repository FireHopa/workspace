"""Contratos isolados por usuário. Valores monetários persistidos em centavos."""
import json
import logging
import tempfile
from contextlib import contextmanager
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError
import fcntl
import os
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from threading import Lock
from typing import Literal, Optional
from urllib.request import Request, urlopen
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, constr
from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import declarative_base

FinanceBase = declarative_base()
Money = Decimal
FINANCE_TZ = ZoneInfo(os.getenv('FINANCE_TIMEZONE', 'America/Sao_Paulo'))


def today():
    return datetime.now(FINANCE_TZ).date()


def cents(value):
    return int((Decimal(str(value)) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def euro_commission(amount_cents):
    return int((Decimal(amount_cents) * Decimal('0.05')).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def split_cents(total, count):
    quotient, remainder = divmod(total, count)
    return [quotient + (1 if i < remainder else 0) for i in range(count)]


def payment_status(due_date, paid_on, on_date=None):
    if paid_on:
        return 'pago'
    days = (date.fromisoformat(due_date) - (on_date or today())).days
    return 'atrasado' if days < 0 else 'a_receber' if days <= 7 else 'agendado'


class FinancePlan(FinanceBase):
    __tablename__ = 'finance_plans'
    __table_args__ = (UniqueConstraint('owner_id', 'name'),)
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, nullable=False, index=True)
    name = Column(String(120), nullable=False)
    amount_cents = Column(Integer, nullable=False)
    currency = Column(String(3), nullable=False)
    active = Column(Boolean, nullable=False, default=True)


class FinanceContract(FinanceBase):
    __tablename__ = 'finance_contracts'
    __table_args__ = (UniqueConstraint('owner_id', 'request_key'),)
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, nullable=False, index=True)
    request_key = Column(String(36), nullable=False)
    name = Column(String(160), nullable=False)
    company = Column(String(160), nullable=False)
    contact = Column(String(180), nullable=False)
    plan_id = Column(Integer, ForeignKey('finance_plans.id'), nullable=False)
    plan_name = Column(String(120), nullable=False)
    payment_type = Column(String(20), nullable=False)
    payment_method = Column(String(20), nullable=False)
    contract_date = Column(String(10), nullable=False)
    currency = Column(String(3), nullable=False)
    total_cents = Column(Integer, nullable=False)
    total_eur_cents = Column(Integer, nullable=False)
    installment_count = Column(Integer, nullable=False)
    created_at = Column(String, nullable=False)


class FinanceInstallment(FinanceBase):
    __tablename__ = 'finance_installments'
    __table_args__ = (UniqueConstraint('contract_id', 'number'),)
    id = Column(Integer, primary_key=True)
    contract_id = Column(Integer, ForeignKey('finance_contracts.id'), nullable=False, index=True)
    number = Column(Integer, nullable=False)
    due_date = Column(String(10), nullable=False)
    amount_cents = Column(Integer, nullable=False)
    eur_cents = Column(Integer, nullable=False)
    paid_on = Column(String(10), nullable=True)
    received_via = Column(String(20), nullable=True)
    commission_eur_cents = Column(Integer, nullable=False, default=0)
    commission_paid_on = Column(String(10), nullable=True)


ShortName = constr(strip_whitespace=True, min_length=1, max_length=120)


class PlanInput(BaseModel):
    name: ShortName
    amount: Decimal = Field(gt=0, le=100000000, max_digits=11, decimal_places=2)
    currency: Literal['EUR', 'BRL'] = 'EUR'
    active: bool = True


class ContractContact(BaseModel):
    name: constr(strip_whitespace=True, min_length=1, max_length=160)
    company: constr(strip_whitespace=True, min_length=1, max_length=160)
    contact: constr(strip_whitespace=True, min_length=1, max_length=180)


class ContractInput(ContractContact):
    request_key: UUID
    plan_id: int = Field(gt=0)
    payment_type: Literal['a_vista', 'parcelado']
    payment_method: Literal['Wise', 'Cartão', 'Pix']
    contract_date: date
    currency: Literal['EUR', 'BRL']
    total: Decimal = Field(gt=0, le=100000000, max_digits=11, decimal_places=2)
    total_eur: Optional[Decimal] = Field(default=None, gt=0, le=100000000, max_digits=11, decimal_places=2)
    installments: int = Field(default=1, ge=1, le=120, strict=True)


class PaymentInput(BaseModel):
    paid_on: date
    payment_method: Literal['Wise', 'Cartão', 'Pix']


class CommissionInput(BaseModel):
    paid_on: date


_quote_lock = Lock()
_quote_state_memory = {}
_quote_logger = logging.getLogger(__name__)


@contextmanager
def quote_state():
    """Cache de cotação diária compartilhado entre workers e reinícios."""
    global _quote_state_memory
    path = Path(os.getenv('FINANCE_QUOTE_CACHE_FILE') or
                str(Path(__file__).resolve().with_name('.finance_quote_cache.json')))
    lock_file = None
    locked = False
    try:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            lock_file = open(str(path) + '.lock', 'a')
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            locked = True
            try:
                state = json.loads(path.read_text())
                if not isinstance(state, dict):
                    state = {}
            except (OSError, ValueError):
                state = dict(_quote_state_memory)
        except OSError:
            state = dict(_quote_state_memory)
            _quote_logger.warning('Cache da cotação sem acesso ao disco; usando memória.')
        try:
            yield state
        finally:
            _quote_state_memory = dict(state)
            if locked:
                temp_path = None
                try:
                    fd, temp_path = tempfile.mkstemp(prefix='.quote-', dir=str(path.parent))
                    with os.fdopen(fd, 'w') as handle:
                        json.dump(state, handle)
                    os.replace(temp_path, path)
                except OSError:
                    _quote_logger.warning('Não foi possível persistir o cache da cotação.')
                finally:
                    if temp_path and os.path.exists(temp_path):
                        os.unlink(temp_path)
    finally:
        if lock_file:
            lock_file.close()


def retry_delay(headers, default):
    value = headers.get('Retry-After') if headers else None
    try:
        return max(default, int(value))
    except (TypeError, ValueError):
        try:
            return max(default, int(parsedate_to_datetime(value).timestamp() - time.time()))
        except (TypeError, ValueError, OverflowError):
            return default


QUOTE_PROVIDER = 'frankfurter-ecb-v2'
QUOTE_URL = 'https://api.frankfurter.dev/v2/rate/eur/brl?providers=ecb'


def quote_response(state):
    quote = state.get('quote')
    retry_at = float(state.get('retry_at', 0))
    if quote:
        try:
            rate = Decimal(quote['eur_brl'])
            rate_date = date.fromisoformat(quote['reference_date'])
            if not rate.is_finite() or rate <= 0 or rate_date > datetime.now(timezone.utc).date():
                raise ValueError('Invalid cached quote')
            # A data de referência pode ser anterior em fins de semana e feriados.
            # Uma resposta bem-sucedida ainda representa a última publicação diária.
            stale = bool(state.get('error')) or datetime.now(timezone.utc).date() - rate_date > timedelta(days=7)
            return {**quote, 'stale': stale, 'unavailable': bool(state.get('error')),
                    'message': state.get('error'), 'retry_at': retry_at}
        except (KeyError, TypeError, ValueError, ArithmeticError):
            pass
    raise HTTPException(503, state.get('error') or 'A cotação diária está indisponível. Informe o valor em euro manualmente.',
                        headers={'Retry-After': str(max(1, int(retry_at - time.time())))})


def get_quote():
    """Consulta diária gratuita. Não altera valores ou comissões dos contratos."""
    with _quote_lock, quote_state() as state:
        # Não reutilizar cotações, erros ou pausas da antiga fonte intradiária.
        if state.get('provider') != QUOTE_PROVIDER:
            state.clear()
            state['provider'] = QUOTE_PROVIDER
        if time.time() < float(state.get('retry_at', 0)):
            return quote_response(state)
        headers = {'User-Agent': 'FinanceModule/1.2', 'Accept': 'application/json'}
        try:
            request = Request(QUOTE_URL, headers=headers)
            with urlopen(request, timeout=10) as response:
                raw = json.loads(response.read(65536))
            if raw.get('base', '').upper() != 'EUR' or raw.get('quote', '').upper() != 'BRL':
                raise ValueError('Unexpected currency pair')
            rate = Decimal(str(raw['rate']))
            if not rate.is_finite() or rate <= 0:
                raise ValueError('invalid rate')
            reference_date = date.fromisoformat(raw['date'])
            now = datetime.now(timezone.utc)
            if reference_date > now.date():
                raise ValueError('Future reference date')
            state.update(quote={'eur_brl': str(rate), 'reference_date': reference_date.isoformat(),
                               'fetched_at': now.isoformat(), 'source': 'Frankfurter / BCE', 'frequency': 'daily'},
                         error=None, retry_at=time.time() + 3600)
        except HTTPError as error:
            if error.code == 429:
                message = 'O serviço de cotação diária pediu uma pausa. A consulta será retomada automaticamente.'
                delay = retry_delay(error.headers, 3600)
            else:
                message = 'O serviço de cotação diária está indisponível. Nova tentativa em cinco minutos.'
                delay = retry_delay(error.headers, 300)
            _quote_logger.warning('Frankfurter respondeu HTTP %s; consulta pausada por %s segundos.', error.code, delay)
            state.update(error=message, retry_at=time.time() + delay)
        except Exception as error:
            _quote_logger.warning('Falha na consulta Frankfurter (%s).', type(error).__name__)
            state.update(error='Não foi possível consultar a cotação diária. Nova tentativa em cinco minutos.',
                         retry_at=time.time() + 300)
        return quote_response(state)


def register_finance(app, engine, get_db, get_current_user):
    FinanceBase.metadata.create_all(engine)

    def finance_user(user=Depends(get_current_user)):
        if user.role != 'finance':
            raise HTTPException(403, 'Área exclusiva do perfil Financeiro.')
        return user

    router = APIRouter(prefix='/finance', tags=['Financeiro'], dependencies=[Depends(finance_user)])

    def own_contract(db, user, contract_id):
        contract = db.query(FinanceContract).filter_by(id=contract_id, owner_id=user.id).first()
        if not contract:
            raise HTTPException(404, 'Contrato não encontrado.')
        return contract

    def own_installment(db, user, installment_id):
        row = db.query(FinanceInstallment).join(FinanceContract).filter(
            FinanceInstallment.id == installment_id, FinanceContract.owner_id == user.id).first()
        if not row:
            raise HTTPException(404, 'Parcela não encontrada.')
        return row

    def plan_dict(plan):
        return {key: getattr(plan, key) for key in ('id', 'name', 'amount_cents', 'currency', 'active')}

    def installment_dict(row):
        result = {key: getattr(row, key) for key in ('id', 'number', 'due_date', 'amount_cents', 'eur_cents',
                  'paid_on', 'received_via', 'commission_eur_cents', 'commission_paid_on')}
        result['status'] = payment_status(row.due_date, row.paid_on)
        result['net_eur_cents'] = row.eur_cents - row.commission_eur_cents if row.paid_on else 0
        return result

    def contract_dict(db, contract, rows=None):
        if rows is None:
            rows = db.query(FinanceInstallment).filter_by(contract_id=contract.id).order_by(FinanceInstallment.number).all()
        result = {key: getattr(contract, key) for key in ('id', 'name', 'company', 'contact', 'plan_id', 'plan_name',
                  'payment_type', 'payment_method', 'contract_date', 'currency', 'total_cents', 'total_eur_cents', 'installment_count')}
        result['installments'] = [installment_dict(row) for row in rows]
        result['status'] = 'encerrado' if rows and all(row.paid_on for row in rows) else 'ativo'
        return result

    @router.get('/quote')
    def quote():
        return get_quote()

    @router.get('/plans')
    def plans(db=Depends(get_db), user=Depends(finance_user)):
        return [plan_dict(row) for row in db.query(FinancePlan).filter_by(owner_id=user.id).order_by(FinancePlan.name).all()]

    @router.post('/plans', status_code=201)
    def create_plan(data: PlanInput, db=Depends(get_db), user=Depends(finance_user)):
        row = FinancePlan(owner_id=user.id, name=data.name, amount_cents=cents(data.amount), currency=data.currency, active=data.active)
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, 'Já existe um plano com esse nome.')
        db.refresh(row)
        return plan_dict(row)

    @router.put('/plans/{plan_id}')
    def update_plan(plan_id: int, data: PlanInput, db=Depends(get_db), user=Depends(finance_user)):
        row = db.query(FinancePlan).filter_by(id=plan_id, owner_id=user.id).first()
        if not row:
            raise HTTPException(404, 'Plano não encontrado.')
        row.name, row.amount_cents, row.currency, row.active = data.name, cents(data.amount), data.currency, data.active
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, 'Já existe um plano com esse nome.')
        return plan_dict(row)

    @router.get('/overview')
    def overview(db=Depends(get_db), user=Depends(finance_user)):
        contracts = db.query(FinanceContract).filter_by(owner_id=user.id).order_by(FinanceContract.id.desc()).all()
        rows = db.query(FinanceInstallment).join(FinanceContract).filter(FinanceContract.owner_id == user.id).order_by(FinanceInstallment.number).all()
        grouped = {}
        totals = {key: 0 for key in ('received_eur_cents', 'outstanding_eur_cents', 'due_soon_eur_cents',
                  'overdue_eur_cents', 'commission_pending_eur_cents', 'commission_paid_eur_cents', 'net_eur_cents')}
        for row in rows:
            grouped.setdefault(row.contract_id, []).append(row)
            state = payment_status(row.due_date, row.paid_on)
            if row.paid_on:
                totals['received_eur_cents'] += row.eur_cents
                totals['net_eur_cents'] += row.eur_cents - row.commission_eur_cents
                commission_key = 'commission_paid_eur_cents' if row.commission_paid_on else 'commission_pending_eur_cents'
                totals[commission_key] += row.commission_eur_cents
            else:
                totals['outstanding_eur_cents'] += row.eur_cents
                if state == 'atrasado':
                    totals['overdue_eur_cents'] += row.eur_cents
                if state == 'a_receber':
                    totals['due_soon_eur_cents'] += row.eur_cents
        return {'today': today().isoformat(), 'totals': totals,
                'contracts': [contract_dict(db, contract, grouped.get(contract.id, [])) for contract in contracts]}

    @router.post('/contracts', status_code=201)
    def create_contract(data: ContractInput, db=Depends(get_db), user=Depends(finance_user)):
        existing = db.query(FinanceContract).filter_by(owner_id=user.id, request_key=str(data.request_key)).first()
        if existing:
            return contract_dict(db, existing)
        if data.contract_date > today():
            raise HTTPException(422, 'A data do primeiro pagamento não pode ser futura.')
        if data.payment_type == 'a_vista' and data.installments != 1:
            raise HTTPException(422, 'Pagamento à vista deve ter uma parcela.')
        if data.payment_type == 'parcelado' and data.installments < 2:
            raise HTTPException(422, 'Selecione pelo menos duas parcelas.')
        plan = db.query(FinancePlan).filter_by(id=data.plan_id, owner_id=user.id, active=True).first()
        if not plan:
            raise HTTPException(422, 'Selecione um plano ativo.')
        if data.currency == 'BRL' and data.total_eur is None:
            raise HTTPException(422, 'Informe o valor-base em euro para calcular as comissões.')
        total = cents(data.total)
        total_eur = cents(data.total if data.currency == 'EUR' else data.total_eur)
        if min(total, total_eur) < data.installments:
            raise HTTPException(422, 'Cada parcela precisa ter pelo menos um centavo em ambas as moedas.')
        row = FinanceContract(owner_id=user.id, request_key=str(data.request_key), name=data.name, company=data.company,
              contact=data.contact, plan_id=plan.id, plan_name=plan.name, payment_type=data.payment_type,
              payment_method=data.payment_method, contract_date=data.contract_date.isoformat(), currency=data.currency,
              total_cents=total, total_eur_cents=total_eur, installment_count=data.installments,
              created_at=datetime.now(timezone.utc).isoformat())
        db.add(row)
        try:
            db.flush()
            for i, (amount, eur) in enumerate(zip(split_cents(total, data.installments), split_cents(total_eur, data.installments))):
                first = i == 0
                db.add(FinanceInstallment(contract_id=row.id, number=i + 1,
                       due_date=(data.contract_date + timedelta(days=30 * i)).isoformat(), amount_cents=amount,
                       eur_cents=eur, paid_on=data.contract_date.isoformat() if first else None,
                       received_via=data.payment_method if first else None,
                       commission_eur_cents=euro_commission(eur) if first else 0))
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.query(FinanceContract).filter_by(owner_id=user.id, request_key=str(data.request_key)).first()
            if existing:
                return contract_dict(db, existing)
            raise
        return contract_dict(db, row)

    @router.patch('/contracts/{contract_id}')
    def edit_contact(contract_id: int, data: ContractContact, db=Depends(get_db), user=Depends(finance_user)):
        row = own_contract(db, user, contract_id)
        row.name, row.company, row.contact = data.name, data.company, data.contact
        db.commit()
        return contract_dict(db, row)

    @router.post('/installments/{installment_id}/receive')
    def receive(installment_id: int, data: PaymentInput, db=Depends(get_db), user=Depends(finance_user)):
        row = own_installment(db, user, installment_id)
        contract = own_contract(db, user, row.contract_id)
        if data.paid_on > today() or data.paid_on < date.fromisoformat(contract.contract_date):
            raise HTTPException(422, 'Use uma data entre o início do contrato e hoje.')
        # UPDATE condicional: cliques simultâneos não geram pagamentos/comissões duplicados.
        changed = db.query(FinanceInstallment).filter_by(id=row.id, paid_on=None).update({
            'paid_on': data.paid_on.isoformat(), 'received_via': data.payment_method,
            'commission_eur_cents': euro_commission(row.eur_cents)}, synchronize_session=False)
        db.commit()
        db.refresh(row)
        if not changed and (row.paid_on != data.paid_on.isoformat() or row.received_via != data.payment_method):
            raise HTTPException(409, 'Esta parcela já foi recebida com outros dados. Atualize a tela.')
        return installment_dict(row)

    @router.post('/installments/{installment_id}/commission-paid')
    def pay_commission(installment_id: int, data: CommissionInput, db=Depends(get_db), user=Depends(finance_user)):
        row = own_installment(db, user, installment_id)
        if not row.paid_on:
            raise HTTPException(409, 'Receba a parcela antes de pagar a comissão.')
        if data.paid_on > today() or data.paid_on < date.fromisoformat(row.paid_on):
            raise HTTPException(422, 'Use uma data entre o recebimento da parcela e hoje.')
        changed = db.query(FinanceInstallment).filter(FinanceInstallment.id == row.id,
                  FinanceInstallment.paid_on.isnot(None), FinanceInstallment.commission_paid_on.is_(None)).update(
                  {'commission_paid_on': data.paid_on.isoformat()}, synchronize_session=False)
        db.commit()
        db.refresh(row)
        if not changed and row.commission_paid_on != data.paid_on.isoformat():
            raise HTTPException(409, 'O estado desta comissão mudou. Atualize a tela.')
        return installment_dict(row)

    app.include_router(router)
