# 🚀 Mingly RAG Server - Quickstart

## Installation (5 Minuten)

### 1. Qdrant starten
```bash
docker run -d -p 6333:6333 -p 6334:6334 \
  -v $(pwd)/rag-server/qdrant_storage:/qdrant/storage:z \
  --name mingly-qdrant \
  qdrant/qdrant
```

Teste: http://localhost:6333/dashboard

### 2. Python Environment
```bash
cd rag-server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Config anpassen
Editiere `config.yaml` - passe Pfade an:
```yaml
watched_directories:
  - path: /Users/DEIN_NAME/Documents
    collection: documents
    recursive: true
```

### 4. Server starten
```bash
python mcp_server.py
```

Server läuft auf: http://localhost:8765

### 5. In Mingly konfigurieren
- Settings öffnen
- MCP Tab
- Add Server:
  - Name: "Mingly RAG"
  - Host: localhost
  - Port: 8765
- Test Connection

## Testen

### Dokument hochladen
```bash
curl -X POST http://localhost:8765/add_document \
  -H "Content-Type: application/json" \
  -d '{"path": "/Users/.../test.pdf", "collection": "documents"}'
```

### Suchen
```bash
curl -X POST http://localhost:8765/search \
  -H "Content-Type: application/json" \
  -d '{"query": "test", "collection": "documents", "limit": 3}'
```

### Collections
```bash
curl http://localhost:8765/collections
```

## Troubleshooting

### Qdrant startet nicht
```bash
docker rm -f mingly-qdrant
docker run -d -p 6333:6333 qdrant/qdrant
```

### Model Download langsam
Model wird beim ersten Start (~2GB) heruntergeladen.
Cache: `~/.cache/huggingface/`

### Permissions
```bash
chmod -R 755 /Users/DEIN_NAME/Documents
```

## Done! 🎉

Jetzt in Mingly chatten und RAG wird automatisch verwendet!
