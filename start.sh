#!/bin/bash
# Ativa o ambiente virtual
source venv/bin/activate
# Roda o servidor do backend
uvicorn main:app --host 127.0.0.1 --port 8000

