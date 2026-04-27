import sqlite3

def atualizar_banco():
    print("Iniciando atualização do banco de dados (Vínculo de Clientes)...")
    
    conn = sqlite3.connect('sistema_tarefas.db')
    cursor = conn.cursor()

    try:
        # Adiciona a nova coluna client_id na tabela de tarefas
        cursor.execute("ALTER TABLE tasks ADD COLUMN client_id INTEGER;")
        print("✅ Sucesso: Coluna 'client_id' adicionada à tabela 'tasks' sem perder dados!")
    except sqlite3.OperationalError as e:
        if "duplicate column name" in str(e).lower() or "já existe" in str(e).lower():
            print("⚠️ Aviso: A coluna 'client_id' já existe. Nenhuma mudança foi necessária.")
        else:
            print(f"❌ Erro inexperado: {e}")

    conn.commit()
    conn.close()

if __name__ == "__main__":
    atualizar_banco()