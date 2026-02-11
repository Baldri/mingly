"""
Qdrant Client Wrapper
Handles all vector database operations
"""
from typing import List, Dict, Optional, Any
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    VectorParams,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue,
    SearchRequest,
)
from loguru import logger
import uuid


class QdrantManager:
    """Manages Qdrant vector database operations"""

    def __init__(self, host: str = "localhost", port: int = 6333, api_key: Optional[str] = None):
        """Initialize Qdrant client"""
        self.host = host
        self.port = port
        self.api_key = api_key

        try:
            self.client = QdrantClient(
                host=host,
                port=port,
                api_key=api_key,
                timeout=30,
            )
            logger.info(f"✅ Connected to Qdrant at {host}:{port}")
        except Exception as e:
            logger.error(f"❌ Failed to connect to Qdrant: {e}")
            raise

    def create_collection(
        self, collection_name: str, vector_size: int = 1024, distance: str = "Cosine"
    ) -> bool:
        """Create a new collection"""
        try:
            # Check if collection exists
            collections = self.client.get_collections().collections
            if any(c.name == collection_name for c in collections):
                logger.info(f"Collection '{collection_name}' already exists")
                return True

            # Create collection
            distance_metric = Distance.COSINE if distance == "Cosine" else Distance.EUCLID

            self.client.create_collection(
                collection_name=collection_name,
                vectors_config=VectorParams(size=vector_size, distance=distance_metric),
            )

            logger.info(f"✅ Created collection '{collection_name}'")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to create collection '{collection_name}': {e}")
            return False

    def delete_collection(self, collection_name: str) -> bool:
        """Delete a collection"""
        try:
            self.client.delete_collection(collection_name=collection_name)
            logger.info(f"✅ Deleted collection '{collection_name}'")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to delete collection '{collection_name}': {e}")
            return False

    def list_collections(self) -> List[Dict[str, Any]]:
        """List all collections"""
        try:
            collections = self.client.get_collections().collections
            return [
                {
                    "name": c.name,
                    "vectors_count": self.get_collection_info(c.name).get("vectors_count", 0),
                }
                for c in collections
            ]
        except Exception as e:
            logger.error(f"❌ Failed to list collections: {e}")
            return []

    def get_collection_info(self, collection_name: str) -> Dict[str, Any]:
        """Get collection information"""
        try:
            info = self.client.get_collection(collection_name=collection_name)
            return {
                "name": collection_name,
                "vectors_count": info.vectors_count,
                "points_count": info.points_count,
                "status": info.status,
            }
        except Exception as e:
            logger.error(f"❌ Failed to get collection info for '{collection_name}': {e}")
            return {}

    def upsert_points(
        self,
        collection_name: str,
        vectors: List[List[float]],
        payloads: List[Dict[str, Any]],
        ids: Optional[List[str]] = None,
    ) -> bool:
        """Insert or update points in collection"""
        try:
            # Generate IDs if not provided
            if ids is None:
                ids = [str(uuid.uuid4()) for _ in vectors]

            # Create points
            points = [
                PointStruct(id=id_, vector=vector, payload=payload)
                for id_, vector, payload in zip(ids, vectors, payloads)
            ]

            # Upsert to Qdrant
            self.client.upsert(collection_name=collection_name, points=points)

            logger.info(
                f"✅ Upserted {len(points)} points to collection '{collection_name}'"
            )
            return True

        except Exception as e:
            logger.error(f"❌ Failed to upsert points to '{collection_name}': {e}")
            return False

    def search(
        self,
        collection_name: str,
        query_vector: List[float],
        limit: int = 5,
        score_threshold: Optional[float] = None,
        filter_conditions: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """Search for similar vectors"""
        try:
            # Build filter if provided
            query_filter = None
            if filter_conditions:
                must_conditions = []
                for key, value in filter_conditions.items():
                    must_conditions.append(
                        FieldCondition(key=key, match=MatchValue(value=value))
                    )
                query_filter = Filter(must=must_conditions)

            # Search
            search_result = self.client.search(
                collection_name=collection_name,
                query_vector=query_vector,
                limit=limit,
                score_threshold=score_threshold,
                query_filter=query_filter,
            )

            # Format results
            results = []
            for hit in search_result:
                results.append(
                    {
                        "id": hit.id,
                        "score": hit.score,
                        "payload": hit.payload,
                    }
                )

            logger.info(
                f"🔍 Found {len(results)} results in collection '{collection_name}'"
            )
            return results

        except Exception as e:
            logger.error(f"❌ Search failed in collection '{collection_name}': {e}")
            return []

    def delete_points(
        self, collection_name: str, point_ids: List[str]
    ) -> bool:
        """Delete specific points by ID"""
        try:
            self.client.delete(
                collection_name=collection_name,
                points_selector=point_ids,
            )
            logger.info(
                f"✅ Deleted {len(point_ids)} points from collection '{collection_name}'"
            )
            return True
        except Exception as e:
            logger.error(f"❌ Failed to delete points from '{collection_name}': {e}")
            return False

    def delete_by_filter(
        self, collection_name: str, filter_conditions: Dict[str, Any]
    ) -> bool:
        """Delete points matching filter"""
        try:
            must_conditions = []
            for key, value in filter_conditions.items():
                must_conditions.append(
                    FieldCondition(key=key, match=MatchValue(value=value))
                )

            filter_obj = Filter(must=must_conditions)

            self.client.delete(
                collection_name=collection_name,
                points_selector=filter_obj,
            )

            logger.info(
                f"✅ Deleted points matching filter from collection '{collection_name}'"
            )
            return True
        except Exception as e:
            logger.error(f"❌ Failed to delete by filter from '{collection_name}': {e}")
            return False

    def get_point(self, collection_name: str, point_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve a specific point by ID"""
        try:
            point = self.client.retrieve(
                collection_name=collection_name,
                ids=[point_id],
            )

            if point:
                return {
                    "id": point[0].id,
                    "payload": point[0].payload,
                    "vector": point[0].vector,
                }
            return None

        except Exception as e:
            logger.error(f"❌ Failed to get point {point_id} from '{collection_name}': {e}")
            return None

    def scroll_points(
        self,
        collection_name: str,
        limit: int = 100,
        offset: Optional[str] = None,
    ) -> tuple[List[Dict[str, Any]], Optional[str]]:
        """Scroll through points (pagination)"""
        try:
            result = self.client.scroll(
                collection_name=collection_name,
                limit=limit,
                offset=offset,
                with_vectors=False,
            )

            points = [
                {"id": point.id, "payload": point.payload}
                for point in result[0]
            ]

            next_offset = result[1] if len(result) > 1 else None

            return points, next_offset

        except Exception as e:
            logger.error(f"❌ Failed to scroll points from '{collection_name}': {e}")
            return [], None

    def health_check(self) -> bool:
        """Check if Qdrant is healthy"""
        try:
            self.client.get_collections()
            return True
        except Exception as e:
            logger.error(f"❌ Qdrant health check failed: {e}")
            return False
