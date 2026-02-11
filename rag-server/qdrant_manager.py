"""
Qdrant Vector Database Manager
"""
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct,
    Filter, FieldCondition, MatchValue,
    SearchParams
)
from typing import List, Dict, Optional
import logging
from config import settings

logger = logging.getLogger(__name__)

class QdrantManager:
    def __init__(self):
        self.client = QdrantClient(
            host=settings.QDRANT_HOST,
            port=settings.QDRANT_PORT,
            api_key=settings.QDRANT_API_KEY
        )
        logger.info(f"✅ Connected to Qdrant at {settings.QDRANT_HOST}:{settings.QDRANT_PORT}")

    def create_collection(self, collection_name: str, dimension: int = 1024) -> bool:
        """Create a new collection"""
        try:
            # Check if collection exists
            collections = self.client.get_collections().collections
            if any(c.name == collection_name for c in collections):
                logger.info(f"Collection '{collection_name}' already exists")
                return True

            # Create collection
            self.client.create_collection(
                collection_name=collection_name,
                vectors_config=VectorParams(
                    size=dimension,
                    distance=Distance.COSINE
                )
            )
            logger.info(f"✅ Created collection: {collection_name}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to create collection: {e}")
            return False

    def delete_collection(self, collection_name: str) -> bool:
        """Delete a collection"""
        try:
            self.client.delete_collection(collection_name)
            logger.info(f"🗑️ Deleted collection: {collection_name}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to delete collection: {e}")
            return False

    def list_collections(self) -> List[str]:
        """List all collections"""
        try:
            collections = self.client.get_collections().collections
            return [c.name for c in collections]
        except Exception as e:
            logger.error(f"❌ Failed to list collections: {e}")
            return []

    def upsert_points(
        self,
        collection_name: str,
        points: List[Dict],
        batch_size: int = 100
    ) -> bool:
        """Insert or update points"""
        try:
            # Prepare points for Qdrant
            qdrant_points = []
            for point in points:
                qdrant_points.append(
                    PointStruct(
                        id=point["id"],
                        vector=point["vector"],
                        payload=point.get("payload", {})
                    )
                )

            # Batch upload
            for i in range(0, len(qdrant_points), batch_size):
                batch = qdrant_points[i:i + batch_size]
                self.client.upsert(
                    collection_name=collection_name,
                    points=batch
                )
                logger.info(f"📤 Uploaded batch {i//batch_size + 1} ({len(batch)} points)")

            logger.info(f"✅ Upserted {len(qdrant_points)} points to '{collection_name}'")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to upsert points: {e}")
            return False

    def search(
        self,
        collection_name: str,
        query_vector: List[float],
        limit: int = 5,
        score_threshold: Optional[float] = None,
        filters: Optional[Dict] = None
    ) -> List[Dict]:
        """Semantic search"""
        try:
            # Build filter if provided
            qdrant_filter = None
            if filters:
                conditions = []
                for key, value in filters.items():
                    conditions.append(
                        FieldCondition(
                            key=key,
                            match=MatchValue(value=value)
                        )
                    )
                qdrant_filter = Filter(must=conditions)

            # Search
            results = self.client.search(
                collection_name=collection_name,
                query_vector=query_vector,
                limit=limit,
                score_threshold=score_threshold,
                query_filter=qdrant_filter
            )

            # Format results
            formatted_results = []
            for result in results:
                formatted_results.append({
                    "id": result.id,
                    "score": result.score,
                    "payload": result.payload
                })

            logger.info(f"🔍 Found {len(formatted_results)} results in '{collection_name}'")
            return formatted_results
        except Exception as e:
            logger.error(f"❌ Search failed: {e}")
            return []

    def delete_points(
        self,
        collection_name: str,
        point_ids: List[str]
    ) -> bool:
        """Delete specific points"""
        try:
            self.client.delete(
                collection_name=collection_name,
                points_selector=point_ids
            )
            logger.info(f"🗑️ Deleted {len(point_ids)} points from '{collection_name}'")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to delete points: {e}")
            return False

    def get_collection_info(self, collection_name: str) -> Optional[Dict]:
        """Get collection information"""
        try:
            info = self.client.get_collection(collection_name)
            return {
                "name": collection_name,
                "vectors_count": info.vectors_count,
                "points_count": info.points_count,
                "status": info.status,
                "config": {
                    "dimension": info.config.params.vectors.size,
                    "distance": info.config.params.vectors.distance.name
                }
            }
        except Exception as e:
            logger.error(f"❌ Failed to get collection info: {e}")
            return None

    def scroll_points(
        self,
        collection_name: str,
        limit: int = 100,
        offset: Optional[str] = None
    ) -> tuple[List[Dict], Optional[str]]:
        """Scroll through points (pagination)"""
        try:
            result = self.client.scroll(
                collection_name=collection_name,
                limit=limit,
                offset=offset,
                with_payload=True,
                with_vectors=False
            )

            points = [
                {
                    "id": point.id,
                    "payload": point.payload
                }
                for point in result[0]
            ]

            next_offset = result[1]
            return points, next_offset
        except Exception as e:
            logger.error(f"❌ Scroll failed: {e}")
            return [], None

# Singleton instance
_qdrant_manager = None

def get_qdrant_manager() -> QdrantManager:
    global _qdrant_manager
    if _qdrant_manager is None:
        _qdrant_manager = QdrantManager()
    return _qdrant_manager
