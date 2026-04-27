import sqlite3

def atualizar_banco():
    print("Iniciando atualização do banco de dados...")
    
    # Conecta ao seu banco de dados atual
    conn = sqlite3.connect('sistema_tarefas.db')
    cursor = conn.cursor()

    try:
        # Adiciona a nova coluna na tabela de templates. O "DEFAULT 0" significa que 
        # todos os templates antigos serão marcados como "Único" (False) por padrão.
        cursor.execute("ALTER TABLE templates ADD COLUMN is_recurrent BOOLEAN DEFAULT 0;")
        print("✅ Sucesso: Coluna 'is_recurrent' adicionada à tabela 'templates' sem perder dados!")
    except sqlite3.OperationalError as e:
        # Se você rodar o script duas vezes sem querer, ele não quebra, só avisa.
        if "duplicate column name" in str(e).lower() or "já existe" in str(e).lower():
            print("⚠️ Aviso: A coluna 'is_recurrent' já existe. Nenhuma mudança foi necessária.")
        else:
            print(f"❌ Erro inexperado: {e}")

    # Salva e fecha a conexão
    conn.commit()
    conn.close()

if __name__ == "__main__":
    atualizar_banco()