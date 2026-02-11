"""
Mingly RAG Server mit MCP-Schnittstelle
FastAPI + Qdrant + multilingual-e5-large
"""

import asyncio
import logging
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import yaml
import uvicorn

from qdrant_client_wrapper import QdrantClientWrapper
from embeddings import EmbeddingModel
from document_processor import DocumentProcessor
from file_watcher import FileWatcher

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# FastAPI App
app = FastAPI(title="Mingly RAG Server", version="1.0.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global instances
qdrant_client: Optional[QdrantClientWrapper] = None
embedding_model: Optional[EmbeddingModel] = None
document_processor: Optional[DocumentProcessor] = None
file_watcher: Optional[FileWatcher] = None
config: Dict[str, Any] = {}

# Pydantic Models
class SearchRequest(BaseModel):
    query: str
    collection: str = "documents"
    limit: int = 5

class SearchResult(BaseModel):
    content: str
    score: float
    metadata: Dict[str, Any]

class AddDocumentRequest(BaseModel):
    path: str
    collection: str = "documents"

class MCPToolCall(BaseModel):
    tool: str
    parameters: Dict[str, Any]

# Startup
@app.on_event("startup")
async def startup_event():
    global qdrant_client, embedding_model, document_processor, file_watcher, config
    
    logger.info("🚀 Starting Mingly RAG Server...")
    
    # Load config
    with open("config.yaml", "r") as f:
        config = yaml.safe_load(f)
    
    # Initialize Qdrant
    logger.info("Connecting to Qdrant...")
    qdrant_client = QdrantClientWrapper(
        host=config["qdrant"]["host"],
        port=config["qdrant"]["port"],
        api_key=config["qdrant"].get("api_key")
    )
    
    # Initialize collections
    for coll in config["collections"]:
        qdrant_client.create_collection_if_not_exists(
            name=coll["name"],
            vector_size=coll["vector_size"]
        )
    
    # Initialize embedding model
    logger.info(f"Loading embedding model: {config['embedding']['model']}...")
    embedding_model = EmbeddingModel(
        model_name=config["embedding"]["model"],
        device=config["embedding"]["device"]
    )
    
    # Initialize document processor
    document_processor = DocumentProcessor()
    
    # Initialize file watcher
    logger.info("Starting file watcher...")
    file_watcher = FileWatcher(
        directories=config["watched_directories"],
        qdrant_client=qdrant_client,
        embedding_model=embedding_model,
        document_processor=document_processor
    )
    file_watcher.start()
    
    logger.info("✅ Mingly RAG Server ready!")

# Health Check
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "qdrant_connected": qdrant_client is not None,
        "embedding_model_loaded": embedding_model is not None
    }

# MCP Tool: search_documents
@app.post("/search", response_model=List[SearchResult])
async def search_documents(request: SearchRequest):
    """Semantic search across collections"""
    try:
        # Generate query embedding
        query_vector = embedding_model.encode([request.query])[0]
        
        # Search in Qdrant
        results = qdrant_client.search(
            collection_name=request.collection,
            query_vector=query_vector,
            limit=request.limit
        )
        
        return [
            SearchResult(
                content=hit.payload.get("content", ""),
                score=hit.score,
                metadata=hit.payload.get("metadata", {})
            )
            for hit in results
        ]
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# MCP Tool: add_document
@app.post("/add_document")
async def add_document(request: AddDocumentRequest):
    """Add document to collection"""
    try:
        # Process document
        chunks = document_processor.process_file(request.path)
        
        # Generate embeddings
        texts = [chunk["content"] for chunk in chunks]
        embeddings = embedding_model.encode(texts)
        
        # Add to Qdrant
        points_added = 0
        for i, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
            qdrant_client.add_point(
                collection_name=request.collection,
                vector=embedding,
                payload={
                    "content": chunk["content"],
                    "metadata": chunk["metadata"]
                }
            )
            points_added += 1
        
        return {
            "success": True,
            "points_added": points_added,
            "collection": request.collection
        }
    except Exception as e:
        logger.error(f"Add document error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# MCP Tool: list_collections
@app.get("/collections")
async def list_collections():
    """List all collections"""
    try:
        collections = qdrant_client.list_collections()
        return {
            "collections": [
                {
                    "name": coll.name,
                    "points_count": qdrant_client.get_collection_info(coll.name).points_count
                }
                for coll in collections.collections
            ]
        }
    except Exception as e:
        logger.error(f"List collections error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# MCP Tool Endpoint (unified)
@app.post("/mcp/call")
async def mcp_tool_call(request: MCPToolCall):
    """
    Unified MCP tool endpoint
    Supports: search_documents, add_document, list_collections
    """
    try:
        if request.tool == "search_documents":
            search_req = SearchRequest(**request.parameters)
            return await search_documents(search_req)
        
        elif request.tool == "add_document":
            add_req = AddDocumentRequest(**request.parameters)
            return await add_document(add_req)
        
        elif request.tool == "list_collections":
            return await list_collections()
        
        else:
            raise HTTPException(status_code=400, detail=f"Unknown tool: {request.tool}")
    
    except Exception as e:
        logger.error(f"MCP tool call error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Run server
if __name__ == "__main__":
    uvicorn.run(
        "mcp_server:app",
        host="localhost",
        port=8765,
        reload=False,
        log_level="info"
    )
