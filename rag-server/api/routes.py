"""
FastAPI Routes for RAG Server
"""
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from loguru import logger

# Import our components
from qdrant.qdrant_client import QdrantManager
from embeddings.embedding_manager import EmbeddingManager
from processing.document_processor import DocumentProcessor
from config import settings

# Initialize components
qdrant = QdrantManager(
    host=settings.qdrant_host,
    port=settings.qdrant_port,
    api_key=settings.qdrant_api_key,
)
embedder = EmbeddingManager(model_name=settings.embedding_model)
processor = DocumentProcessor(
    chunk_size=settings.chunk_size,
    chunk_overlap=settings.chunk_overlap,
)

# Create router
router = APIRouter()


# ============================================================================
# Request/Response Models
# ============================================================================


class SearchRequest(BaseModel):
    query: str = Field(..., description="Search query")
    limit: int = Field(default=5, ge=1, le=100, description="Number of results")
    score_threshold: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Minimum similarity score"
    )
    filter: Optional[Dict[str, Any]] = Field(default=None, description="Metadata filters")


class SearchResult(BaseModel):
    id: str
    score: float
    text: str
    metadata: Dict[str, Any]


class SearchResponse(BaseModel):
    query: str
    results: List[SearchResult]
    total: int


class IndexFileRequest(BaseModel):
    file_path: str = Field(..., description="Path to file to index")
    collection_name: str = Field(default="documents", description="Target collection")


class IndexDirectoryRequest(BaseModel):
    directory_path: str = Field(..., description="Path to directory")
    collection_name: str = Field(default="documents", description="Target collection")
    recursive: bool = Field(default=True, description="Process subdirectories")


class CreateCollectionRequest(BaseModel):
    name: str = Field(..., description="Collection name")
    vector_size: int = Field(default=1024, description="Vector dimension")


class CollectionInfo(BaseModel):
    name: str
    vectors_count: int
    points_count: int
    status: str


# ============================================================================
# Health & Info
# ============================================================================


@router.get("/health")
async def health_check():
    """Health check endpoint"""
    qdrant_healthy = qdrant.health_check()
    return {
        "status": "healthy" if qdrant_healthy else "unhealthy",
        "qdrant": qdrant_healthy,
        "embedding_model": embedder.model_name,
    }


@router.get("/info")
async def get_info():
    """Get server information"""
    model_info = embedder.get_model_info()
    collections = qdrant.list_collections()

    return {
        "server": "Mingly RAG Server",
        "version": "1.0.0",
        "embedding_model": model_info,
        "collections": collections,
        "config": {
            "chunk_size": settings.chunk_size,
            "chunk_overlap": settings.chunk_overlap,
            "watched_dirs": settings.watch_directories,
        },
    }


# ============================================================================
# Collections
# ============================================================================


@router.post("/collections")
async def create_collection(request: CreateCollectionRequest):
    """Create a new collection"""
    success = qdrant.create_collection(
        collection_name=request.name,
        vector_size=request.vector_size,
    )

    if not success:
        raise HTTPException(status_code=500, detail="Failed to create collection")

    return {"success": True, "collection": request.name}


@router.get("/collections")
async def list_collections():
    """List all collections"""
    collections = qdrant.list_collections()
    return {"collections": collections, "total": len(collections)}


@router.get("/collections/{collection_name}")
async def get_collection_info(collection_name: str):
    """Get collection information"""
    info = qdrant.get_collection_info(collection_name)

    if not info:
        raise HTTPException(status_code=404, detail="Collection not found")

    return info


@router.delete("/collections/{collection_name}")
async def delete_collection(collection_name: str):
    """Delete a collection"""
    success = qdrant.delete_collection(collection_name)

    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete collection")

    return {"success": True, "message": f"Collection '{collection_name}' deleted"}


# ============================================================================
# Search
# ============================================================================


@router.post("/search/{collection_name}", response_model=SearchResponse)
async def search_collection(collection_name: str, request: SearchRequest):
    """Search in a collection"""
    try:
        # Embed query
        query_vector = embedder.embed_query(request.query)

        if not query_vector:
            raise HTTPException(status_code=500, detail="Failed to embed query")

        # Search in Qdrant
        results = qdrant.search(
            collection_name=collection_name,
            query_vector=query_vector,
            limit=request.limit,
            score_threshold=request.score_threshold,
            filter_conditions=request.filter,
        )

        # Format response
        formatted_results = [
            SearchResult(
                id=str(result["id"]),
                score=result["score"],
                text=result["payload"].get("text", ""),
                metadata={
                    k: v for k, v in result["payload"].items() if k != "text"
                },
            )
            for result in results
        ]

        return SearchResponse(
            query=request.query,
            results=formatted_results,
            total=len(formatted_results),
        )

    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Indexing
# ============================================================================


@router.post("/index/file")
async def index_file(request: IndexFileRequest):
    """Index a single file"""
    try:
        # Process file
        doc_result = processor.process_file(request.file_path)

        # Embed chunks
        chunk_embeddings = embedder.embed_texts(doc_result["chunks"])

        # Prepare payloads
        payloads = [
            {
                "text": chunk,
                "file_path": doc_result["file_path"],
                "file_name": doc_result["file_name"],
                "file_type": doc_result["file_type"],
                "chunk_index": i,
                "total_chunks": doc_result["chunk_count"],
                "indexed_at": doc_result["indexed_at"],
            }
            for i, chunk in enumerate(doc_result["chunks"])
        ]

        # Ensure collection exists
        qdrant.create_collection(request.collection_name, vector_size=1024)

        # Upsert to Qdrant
        success = qdrant.upsert_points(
            collection_name=request.collection_name,
            vectors=chunk_embeddings,
            payloads=payloads,
        )

        if not success:
            raise HTTPException(status_code=500, detail="Failed to index document")

        return {
            "success": True,
            "file_name": doc_result["file_name"],
            "chunks_indexed": len(chunk_embeddings),
            "collection": request.collection_name,
        }

    except Exception as e:
        logger.error(f"Indexing error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/index/directory")
async def index_directory(request: IndexDirectoryRequest):
    """Index all files in a directory"""
    try:
        # Process directory
        results = processor.process_directory(
            directory_path=request.directory_path,
            supported_formats=settings.supported_formats_list,
            recursive=request.recursive,
        )

        if not results:
            return {
                "success": True,
                "message": "No documents found",
                "files_indexed": 0,
            }

        # Ensure collection exists
        qdrant.create_collection(request.collection_name, vector_size=1024)

        total_chunks = 0

        for doc_result in results:
            # Embed chunks
            chunk_embeddings = embedder.embed_texts(doc_result["chunks"])

            # Prepare payloads
            payloads = [
                {
                    "text": chunk,
                    "file_path": doc_result["file_path"],
                    "file_name": doc_result["file_name"],
                    "file_type": doc_result["file_type"],
                    "chunk_index": i,
                    "total_chunks": doc_result["chunk_count"],
                    "indexed_at": doc_result["indexed_at"],
                }
                for i, chunk in enumerate(doc_result["chunks"])
            ]

            # Upsert to Qdrant
            qdrant.upsert_points(
                collection_name=request.collection_name,
                vectors=chunk_embeddings,
                payloads=payloads,
            )

            total_chunks += len(chunk_embeddings)

        return {
            "success": True,
            "files_indexed": len(results),
            "total_chunks": total_chunks,
            "collection": request.collection_name,
        }

    except Exception as e:
        logger.error(f"Directory indexing error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/index/{collection_name}/file")
async def delete_file_from_index(collection_name: str, file_path: str):
    """Delete all chunks from a specific file"""
    try:
        success = qdrant.delete_by_filter(
            collection_name=collection_name,
            filter_conditions={"file_path": file_path},
        )

        if not success:
            raise HTTPException(status_code=500, detail="Failed to delete file from index")

        return {
            "success": True,
            "message": f"Deleted chunks from '{file_path}'",
        }

    except Exception as e:
        logger.error(f"Delete error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Context Retrieval (for LLM augmentation)
# ============================================================================


@router.post("/context/{collection_name}")
async def get_context_for_query(collection_name: str, request: SearchRequest):
    """
    Get context for LLM augmentation
    Returns formatted context string ready to inject into system prompt
    """
    try:
        # Embed query
        query_vector = embedder.embed_query(request.query)

        # Search
        results = qdrant.search(
            collection_name=collection_name,
            query_vector=query_vector,
            limit=request.limit or 3,  # Default to 3 for context
            score_threshold=request.score_threshold or 0.7,
        )

        if not results:
            return {
                "context": "",
                "sources": [],
                "message": "No relevant context found",
            }

        # Format context
        context_parts = []
        sources = []

        for i, result in enumerate(results, 1):
            text = result["payload"].get("text", "")
            file_name = result["payload"].get("file_name", "Unknown")
            score = result["score"]

            context_parts.append(f"[Context {i} - {file_name} (relevance: {score:.2f})]")
            context_parts.append(text)
            context_parts.append("")

            sources.append(
                {"file_name": file_name, "score": score, "chunk_index": result["payload"].get("chunk_index", 0)}
            )

        context_string = "\n".join(context_parts)

        return {
            "context": context_string,
            "sources": sources,
            "total_chunks": len(results),
        }

    except Exception as e:
        logger.error(f"Context retrieval error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
