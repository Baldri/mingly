#!/usr/bin/env python3
"""
Mingly RAG Server
FastAPI Server with RAG capabilities
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger
import uvicorn
import sys

from config import settings
from api.routes import router
from watchers.file_watcher import FileWatcher
from qdrant.qdrant_client import QdrantManager
from embeddings.embedding_manager import EmbeddingManager
from processing.document_processor import DocumentProcessor

# Configure logging
logger.remove()
logger.add(
    sys.stdout,
    format="<green>{time:HH:mm:ss}</green> | <level>{level: <8}</level> | <level>{message}</level>",
    level=settings.log_level,
)

# Create FastAPI app
app = FastAPI(
    title="Mingly RAG Server",
    description="Retrieval-Augmented Generation Server with Qdrant + MCP",
    version="1.0.0",
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routes
app.include_router(router, prefix="/api")

# Global file watcher
file_watcher: FileWatcher = None


@app.on_event("startup")
async def startup_event():
    """Initialize components on startup"""
    global file_watcher

    logger.info("🚀 Starting Mingly RAG Server...")

    try:
        # Components are already initialized in api/routes.py
        # Just start file watcher if configured

        if settings.watch_directories:
            from api.routes import qdrant, embedder, processor

            logger.info(f"Setting up file watchers for {len(settings.watch_directories)} directories...")

            def on_file_created(file_path: str):
                """Auto-index new files"""
                try:
                    logger.info(f"📄 Auto-indexing: {file_path}")
                    doc_result = processor.process_file(file_path)
                    chunk_embeddings = embedder.embed_texts(doc_result["chunks"])

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

                    qdrant.create_collection("documents", vector_size=1024)
                    qdrant.upsert_points("documents", chunk_embeddings, payloads)

                    logger.info(f"✅ Indexed: {doc_result['file_name']}")
                except Exception as e:
                    logger.error(f"❌ Auto-indexing failed: {e}")

            def on_file_modified(file_path: str):
                """Re-index modified files"""
                try:
                    qdrant.delete_by_filter("documents", {"file_path": file_path})
                    on_file_created(file_path)
                except Exception as e:
                    logger.error(f"❌ Re-indexing failed: {e}")

            def on_file_deleted(file_path: str):
                """Remove deleted files from index"""
                try:
                    qdrant.delete_by_filter("documents", {"file_path": file_path})
                    logger.info(f"✅ Removed: {file_path}")
                except Exception as e:
                    logger.error(f"❌ Remove failed: {e}")

            file_watcher = FileWatcher(
                directories=settings.watch_directories,
                supported_formats=settings.supported_formats_list,
                on_created=on_file_created,
                on_modified=on_file_modified,
                on_deleted=on_file_deleted,
            )

            file_watcher.start()

        logger.info("✅ RAG Server ready!")
        logger.info(f"📊 Server: http://{settings.rag_server_host}:{settings.rag_server_port}")
        logger.info(f"📊 Qdrant: http://{settings.qdrant_host}:{settings.qdrant_port}")
        logger.info(f"🧠 Model: {settings.embedding_model}")

    except Exception as e:
        logger.error(f"❌ Startup failed: {e}")
        raise


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown"""
    global file_watcher

    logger.info("🛑 Shutting down...")

    if file_watcher and file_watcher.is_running():
        file_watcher.stop()

    logger.info("✅ Shutdown complete")


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.rag_server_host,
        port=settings.rag_server_port,
        reload=False,
        log_level=settings.log_level.lower(),
    )
