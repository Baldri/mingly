"""
Mingly RAG-MCP Server
FastAPI server with MCP protocol for RAG operations
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import uvicorn

from document_processor import DocumentProcessor
from embedding_service import EmbeddingService
from qdrant_client_wrapper import QdrantClientWrapper

app = FastAPI(title="Mingly RAG-MCP Server", version="1.0.0")

# CORS for Electron app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize services
doc_processor = DocumentProcessor()
embedding_service = EmbeddingService()
qdrant_client = QdrantClientWrapper()

# MCP Protocol Models
class MCPRequest(BaseModel):
    jsonrpc: str = "2.0"
    method: str
    params: Dict[str, Any]
    id: int

class MCPResponse(BaseModel):
    jsonrpc: str = "2.0"
    result: Any
    id: int

class MCPError(BaseModel):
    jsonrpc: str = "2.0"
    error: Dict[str, Any]
    id: int

# Tool-specific models
class IndexDocumentParams(BaseModel):
    filepath: str
    collection: str = "documents"

class SearchParams(BaseModel):
    query: str
    collection: str = "documents"
    top_k: int = 3

class CreateCollectionParams(BaseModel):
    name: str

@app.get("/")
async def root():
    return {
        "service": "Mingly RAG-MCP Server",
        "version": "1.0.0",
        "status": "running"
    }

@app.get("/health")
async def health():
    """Health check"""
    qdrant_status = await qdrant_client.check_connection()
    model_loaded = embedding_service.is_loaded()

    return {
        "status": "healthy" if qdrant_status and model_loaded else "degraded",
        "qdrant": "connected" if qdrant_status else "disconnected",
        "embedding_model": "loaded" if model_loaded else "not_loaded"
    }

@app.post("/mcp")
async def mcp_handler(request: MCPRequest) -> MCPResponse:
    """
    MCP Protocol Handler
    Handles all MCP tool calls
    """
    try:
        method = request.method
        params = request.params

        # Route to appropriate tool
        if method == "tools/list":
            result = await list_tools()
        elif method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            result = await call_tool(tool_name, tool_args)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown method: {method}")

        return MCPResponse(result=result, id=request.id)

    except Exception as e:
        return MCPError(
            error={"code": -32603, "message": str(e)},
            id=request.id
        )

async def list_tools():
    """List available MCP tools"""
    return {
        "tools": [
            {
                "name": "index_document",
                "description": "Index a single document (PDF, DOCX, PPTX, MD, TXT)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "filepath": {"type": "string", "description": "Path to document"},
                        "collection": {"type": "string", "description": "Collection name", "default": "documents"}
                    },
                    "required": ["filepath"]
                }
            },
            {
                "name": "search",
                "description": "Semantic search in collection",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "collection": {"type": "string", "description": "Collection name", "default": "documents"},
                        "top_k": {"type": "integer", "description": "Number of results", "default": 3}
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "list_collections",
                "description": "List all collections",
                "inputSchema": {"type": "object", "properties": {}}
            },
            {
                "name": "create_collection",
                "description": "Create new collection",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Collection name"}
                    },
                    "required": ["name"]
                }
            },
            {
                "name": "delete_collection",
                "description": "Delete collection",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Collection name"}
                    },
                    "required": ["name"]
                }
            },
            {
                "name": "get_stats",
                "description": "Get collection statistics",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "collection": {"type": "string", "description": "Collection name"}
                    },
                    "required": ["collection"]
                }
            }
        ]
    }

async def call_tool(tool_name: str, arguments: Dict[str, Any]):
    """Execute MCP tool"""

    if tool_name == "index_document":
        return await index_document(arguments)
    elif tool_name == "search":
        return await search(arguments)
    elif tool_name == "list_collections":
        return await list_collections()
    elif tool_name == "create_collection":
        return await create_collection(arguments)
    elif tool_name == "delete_collection":
        return await delete_collection(arguments)
    elif tool_name == "get_stats":
        return await get_stats(arguments)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown tool: {tool_name}")

async def index_document(args: Dict[str, Any]):
    """Index a single document"""
    filepath = args.get("filepath")
    collection = args.get("collection", "documents")

    # 1. Ensure collection exists
    await qdrant_client.ensure_collection(collection)

    # 2. Extract text from document
    text_chunks = await doc_processor.process_document(filepath)

    # 3. Generate embeddings
    embeddings = await embedding_service.embed_texts([chunk["text"] for chunk in text_chunks])

    # 4. Store in Qdrant
    points = []
    for i, (chunk, embedding) in enumerate(zip(text_chunks, embeddings)):
        points.append({
            "id": f"{filepath}-{i}",
            "vector": embedding.tolist(),
            "payload": {
                "filename": chunk["filename"],
                "filepath": filepath,
                "content": chunk["text"],
                "chunk_index": i,
                "total_chunks": len(text_chunks),
                "file_type": chunk["file_type"],
                "indexed_at": chunk["indexed_at"]
            }
        })

    await qdrant_client.upsert_points(collection, points)

    return {
        "success": True,
        "chunks_indexed": len(text_chunks),
        "filename": text_chunks[0]["filename"] if text_chunks else None,
        "collection": collection
    }

async def search(args: Dict[str, Any]):
    """Semantic search"""
    query = args.get("query")
    collection = args.get("collection", "documents")
    top_k = args.get("top_k", 3)

    # 1. Generate query embedding
    query_embedding = await embedding_service.embed_query(query)

    # 2. Search in Qdrant
    results = await qdrant_client.search(collection, query_embedding.tolist(), top_k)

    # 3. Format results
    formatted_results = []
    for result in results:
        formatted_results.append({
            "filename": result.payload.get("filename"),
            "filepath": result.payload.get("filepath"),
            "content": result.payload.get("content"),
            "score": result.score,
            "chunk_index": result.payload.get("chunk_index"),
            "file_type": result.payload.get("file_type")
        })

    return {
        "success": True,
        "results": formatted_results,
        "query": query,
        "collection": collection
    }

async def list_collections():
    """List all collections"""
    collections = await qdrant_client.list_collections()
    return {
        "success": True,
        "collections": collections
    }

async def create_collection(args: Dict[str, Any]):
    """Create new collection"""
    name = args.get("name")
    await qdrant_client.create_collection(name)
    return {
        "success": True,
        "collection": name
    }

async def delete_collection(args: Dict[str, Any]):
    """Delete collection"""
    name = args.get("name")
    await qdrant_client.delete_collection(name)
    return {
        "success": True,
        "collection": name
    }

async def get_stats(args: Dict[str, Any]):
    """Get collection statistics"""
    collection = args.get("collection")
    stats = await qdrant_client.get_collection_stats(collection)
    return {
        "success": True,
        "collection": collection,
        "stats": stats
    }

if __name__ == "__main__":
    print("🚀 Starting Mingly RAG-MCP Server on http://localhost:8001")
    print("📊 Qdrant Dashboard: http://localhost:6333/dashboard")
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")
