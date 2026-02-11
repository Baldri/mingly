# Mingly RAG Server

**Qdrant + MCP Integration** - Lokale Wissensdatenbank

## Installation

### 1. Qdrant starten
```bash
docker run -d -p 6333:6333 -p 6334:6334 \
  -v $(pwd)/rag-server/qdrant_storage:/qdrant/storage:z \
  --name mingly-qdrant \
  qdrant/qdrant
```

Web UI: http://localhost:6333/dashboard

### 2. Python Setup
```bash
cd rag-server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Server starten
```bash
python mcp_server.py
```

Server: http://localhost:8765
