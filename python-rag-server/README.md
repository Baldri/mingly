# Mingly RAG-MCP Server

Python-basierter RAG Server mit MCP-Protokoll für Mingly.

## Features

- ✅ **Multi-Format Support**: PDF, DOCX, PPTX, MD, TXT
- ✅ **Lokales Embedding**: multilingual-e5-large (1024 dim)
- ✅ **Qdrant Integration**: Vector database
- ✅ **MCP Protocol**: Kompatibel mit Claude & Mingly
- ✅ **Semantic Search**: Cosine similarity
- ✅ **Auto-Chunking**: 512 tokens mit 50 token overlap

## Installation

### 1. Qdrant starten (Docker)

```bash
docker run -d -p 6333:6333 -p 6334:6334 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  --name mingly-qdrant \
  qdrant/qdrant
```

**Web UI**: http://localhost:6333/dashboard

### 2. Python Dependencies installieren

```bash
cd python-rag-server
python3 -m venv venv
source venv/bin/activate  # Mac/Linux
# oder: venv\Scripts\activate  # Windows

pip install -r requirements.txt
```

**Hinweis**: Erster Start lädt das Embedding-Modell (~1.2 GB)

### 3. Server starten

```bash
python server.py
```

Server läuft auf: http://localhost:8001

## Usage

### Health Check

```bash
curl http://localhost:8001/health
```

### MCP: List Tools

```bash
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 1
  }'
```

### MCP: Index Document

```bash
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "index_document",
      "arguments": {
        "filepath": "/path/to/document.pdf",
        "collection": "documents"
      }
    },
    "id": 2
  }'
```

### MCP: Search

```bash
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search",
      "arguments": {
        "query": "machine learning algorithms",
        "collection": "documents",
        "top_k": 3
      }
    },
    "id": 3
  }'
```

## Supported File Formats

| Format | Extension | Parser |
|--------|-----------|--------|
| PDF | `.pdf` | PyPDF2 |
| Word | `.docx` | python-docx |
| PowerPoint | `.pptx` | python-pptx |
| Markdown | `.md` | markdown |
| Text | `.txt` | built-in |

## Embedding Model

**Model**: `intfloat/multilingual-e5-large`

**Features**:
- 1024 dimensions
- Multilingual (100+ languages)
- Optimized for DE/EN
- Local (no API calls)
- Free

**Performance**:
- ~50 docs/sec (CPU)
- ~500 docs/sec (GPU)
- Model size: 1.2 GB

## Architecture

```
User Document → Document Processor → Text Chunks
                                         ↓
                                   Embedding Service
                                   (multilingual-e5-large)
                                         ↓
                                   Qdrant Vector DB
                                         ↓
                                   Semantic Search
```

## Environment Variables

```bash
# Qdrant
QDRANT_HOST=localhost
QDRANT_PORT=6333

# Embedding
EMBEDDING_MODEL=intfloat/multilingual-e5-large
CHUNK_SIZE=512
CHUNK_OVERLAP=50
```

## Development

```bash
# Install dev dependencies
pip install -r requirements.txt

# Run with hot-reload
uvicorn server:app --reload --port 8001

# Run tests (if available)
pytest
```

## Troubleshooting

### Qdrant not accessible
```bash
# Check if Qdrant is running
docker ps | grep qdrant

# Check logs
docker logs mingly-qdrant

# Restart
docker restart mingly-qdrant
```

### Embedding model not loading
```bash
# Clear cache and re-download
rm -rf ~/.cache/huggingface

# Manually download
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('intfloat/multilingual-e5-large')"
```

### Port 8001 already in use
```bash
# Find process
lsof -i :8001

# Kill process
kill -9 <PID>

# Or use different port
python server.py --port 8002
```

## Integration with Mingly

Mingly verbindet sich automatisch mit dem RAG-MCP Server:

1. **Auto-Indexing**: File Watcher in Mingly → MCP `index_document`
2. **Search**: User message → MCP `search` → Context injection
3. **Collections**: Settings UI → MCP `create_collection`

## License

MIT
