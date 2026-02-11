"""
RAG Manager - Main orchestrator
Combines Qdrant, Embeddings, Document Processing, and File Watching
"""
from typing import List, Dict, Optional
import logging
from qdrant_manager import get_qdrant_manager
from embedding_manager import get_embedding_manager
from document_processor import get_document_processor
from file_watcher import get_file_watcher
import asyncio
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

class RAGManager:
    def __init__(self):
        self.qdrant = get_qdrant_manager()
        self.embeddings = get_embedding_manager()
        self.document_processor = get_document_processor()
        self.file_watcher = None
        self.executor = ThreadPoolExecutor(max_workers=4)
        logger.info("✅ RAG Manager initialized")

    # ========================================
    # Collection Management
    # ========================================

    def create_collection(self, collection_name: str) -> bool:
        """Create a new RAG collection"""
        dimension = self.embeddings.get_dimension()
        return self.qdrant.create_collection(collection_name, dimension)

    def delete_collection(self, collection_name: str) -> bool:
        """Delete a collection"""
        return self.qdrant.delete_collection(collection_name)

    def list_collections(self) -> List[str]:
        """List all collections"""
        return self.qdrant.list_collections()

    def get_collection_info(self, collection_name: str) -> Optional[Dict]:
        """Get collection information"""
        return self.qdrant.get_collection_info(collection_name)

    # ========================================
    # Document Indexing
    # ========================================

    async def index_file(
        self,
        collection_name: str,
        file_path: str,
        metadata: Optional[Dict] = None
    ) -> Dict:
        """
        Index a single file into a collection

        Returns:
            Dict with success status and stats
        """
        try:
            logger.info(f"📄 Indexing file: {file_path}")

            # Process document (chunking)
            loop = asyncio.get_event_loop()
            chunks = await loop.run_in_executor(
                self.executor,
                self.document_processor.process_file,
                file_path,
                metadata
            )

            if not chunks:
                return {
                    "success": False,
                    "error": "No chunks generated",
                    "chunks_processed": 0
                }

            # Generate embeddings
            texts = [chunk["text"] for chunk in chunks]
            embeddings = await loop.run_in_executor(
                self.executor,
                self.embeddings.encode,
                texts,
                32,  # batch_size
                True  # show_progress_bar
            )

            # Prepare points for Qdrant
            points = []
            for chunk, embedding in zip(chunks, embeddings):
                points.append({
                    "id": chunk["id"],
                    "vector": embedding,
                    "payload": {
                        "text": chunk["text"],
                        **chunk["metadata"]
                    }
                })

            # Upload to Qdrant
            success = await loop.run_in_executor(
                self.executor,
                self.qdrant.upsert_points,
                collection_name,
                points
            )

            if success:
                logger.info(f"✅ Indexed {len(points)} chunks from {file_path}")
                return {
                    "success": True,
                    "file_path": file_path,
                    "chunks_processed": len(points),
                    "collection": collection_name
                }
            else:
                return {
                    "success": False,
                    "error": "Failed to upsert points",
                    "chunks_processed": 0
                }

        except Exception as e:
            logger.error(f"❌ Failed to index file: {e}")
            return {
                "success": False,
                "error": str(e),
                "chunks_processed": 0
            }

    async def index_directory(
        self,
        collection_name: str,
        directory_path: str,
        recursive: bool = True,
        metadata: Optional[Dict] = None
    ) -> Dict:
        """Index all files in a directory"""
        try:
            logger.info(f"📁 Indexing directory: {directory_path}")

            # Process all files
            loop = asyncio.get_event_loop()
            chunks = await loop.run_in_executor(
                self.executor,
                self.document_processor.process_directory,
                directory_path,
                recursive,
                metadata
            )

            if not chunks:
                return {
                    "success": False,
                    "error": "No chunks generated",
                    "files_processed": 0,
                    "chunks_processed": 0
                }

            # Generate embeddings
            texts = [chunk["text"] for chunk in chunks]
            embeddings = await loop.run_in_executor(
                self.executor,
                self.embeddings.encode,
                texts,
                32,
                True
            )

            # Prepare points
            points = []
            for chunk, embedding in zip(chunks, embeddings):
                points.append({
                    "id": chunk["id"],
                    "vector": embedding,
                    "payload": {
                        "text": chunk["text"],
                        **chunk["metadata"]
                    }
                })

            # Upload to Qdrant
            success = await loop.run_in_executor(
                self.executor,
                self.qdrant.upsert_points,
                collection_name,
                points
            )

            # Count unique files
            unique_files = len(set(chunk["metadata"]["file_path"] for chunk in chunks))

            if success:
                logger.info(f"✅ Indexed {unique_files} files ({len(points)} chunks)")
                return {
                    "success": True,
                    "directory": directory_path,
                    "files_processed": unique_files,
                    "chunks_processed": len(points),
                    "collection": collection_name
                }
            else:
                return {
                    "success": False,
                    "error": "Failed to upsert points",
                    "files_processed": 0,
                    "chunks_processed": 0
                }

        except Exception as e:
            logger.error(f"❌ Failed to index directory: {e}")
            return {
                "success": False,
                "error": str(e),
                "files_processed": 0,
                "chunks_processed": 0
            }

    # ========================================
    # Search
    # ========================================

    async def search(
        self,
        collection_name: str,
        query: str,
        limit: int = 5,
        score_threshold: Optional[float] = 0.5,
        filters: Optional[Dict] = None
    ) -> List[Dict]:
        """
        Semantic search in collection

        Args:
            collection_name: Target collection
            query: Search query
            limit: Max results
            score_threshold: Minimum similarity score (0-1)
            filters: Metadata filters

        Returns:
            List of results with text, score, and metadata
        """
        try:
            logger.info(f"🔍 Searching: '{query}' in '{collection_name}'")

            # Generate query embedding
            loop = asyncio.get_event_loop()
            query_vector = await loop.run_in_executor(
                self.executor,
                self.embeddings.encode_query,
                query
            )

            # Search in Qdrant
            results = await loop.run_in_executor(
                self.executor,
                self.qdrant.search,
                collection_name,
                query_vector,
                limit,
                score_threshold,
                filters
            )

            logger.info(f"✅ Found {len(results)} results")
            return results

        except Exception as e:
            logger.error(f"❌ Search failed: {e}")
            return []

    def get_context(
        self,
        results: List[Dict],
        max_tokens: int = 2000
    ) -> str:
        """
        Convert search results to context string for LLM

        Args:
            results: Search results
            max_tokens: Approximate max tokens (rough estimate: 1 token ≈ 4 chars)

        Returns:
            Formatted context string
        """
        if not results:
            return ""

        context_parts = []
        total_chars = 0
        max_chars = max_tokens * 4

        for i, result in enumerate(results, 1):
            text = result["payload"]["text"]
            source = result["payload"].get("file_name", "Unknown")
            score = result["score"]

            part = f"[{i}] (Score: {score:.2f}, Source: {source})\n{text}\n"

            if total_chars + len(part) > max_chars:
                break

            context_parts.append(part)
            total_chars += len(part)

        return "\n---\n".join(context_parts)

    # ========================================
    # File Watching
    # ========================================

    def start_file_watching(self, directories: List[str], collection_name: str):
        """Start watching directories for auto-indexing"""
        def on_file_change(file_path: str, event_type: str):
            """Callback for file changes"""
            logger.info(f"📢 File {event_type}: {file_path}")

            if event_type in ["created", "modified"]:
                # Index file asynchronously
                asyncio.create_task(
                    self.index_file(collection_name, file_path)
                )
            elif event_type == "deleted":
                # TODO: Delete from Qdrant (need file_hash lookup)
                logger.info(f"⚠️ File deletion not yet implemented")

        self.file_watcher = get_file_watcher(on_file_change)

        for directory in directories:
            self.file_watcher.add_directory(directory, recursive=True)

        self.file_watcher.start()
        logger.info(f"👁️ Started watching {len(directories)} directories")

    def stop_file_watching(self):
        """Stop file watching"""
        if self.file_watcher:
            self.file_watcher.stop()
            logger.info("🛑 Stopped file watching")

    def get_watched_directories(self) -> List[str]:
        """Get list of watched directories"""
        if self.file_watcher:
            return self.file_watcher.get_watched_directories()
        return []

# Singleton instance
_rag_manager = None

def get_rag_manager() -> RAGManager:
    global _rag_manager
    if _rag_manager is None:
        _rag_manager = RAGManager()
    return _rag_manager
