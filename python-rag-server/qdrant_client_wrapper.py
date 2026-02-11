"""
Qdrant Client Wrapper
REST API client for Qdrant vector database
"""

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from typing import List, Dict, Any
import time

class QdrantClientWrapper:
    def __init__(self, host: str = "localhost", port: int = 6333):
        self.host = host
        self.port = port
        self.client = QdrantClient(host=host, port=port)
        print(f"📊 Connecting to Qdrant at {host}:{port}")

    async def check_connection(self) -> bool:
        """Check if Qdrant is accessible"""
        try:
            collections = self.client.get_collections()
            return True
        except Exception as e:
            print(f"❌ Qdrant connection failed: {e}")
            return False

    async def ensure_collection(self, name: str, vector_size: int = 1024):
        """Ensure collection exists, create if not"""
        try:
            self.client.get_collection(name)
            print(f"✅ Collection '{name}' exists")
        except Exception:
            print(f"📦 Creating collection '{name}'")
            self.client.create_collection(
                collection_name=name,
                vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE)
            )

    async def create_collection(self, name: str, vector_size: int = 1024):
        """Create new collection"""
        self.client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE)
        )

    async def delete_collection(self, name: str):
        """Delete collection"""
        self.client.delete_collection(collection_name=name)

    async def list_collections(self) -> List[str]:
        """List all collections"""
        collections = self.client.get_collections()
        return [c.name for c in collections.collections]

    async def upsert_points(self, collection: str, points: List[Dict]):
        """Insert or update points"""
        qdrant_points = []
        for point in points:
            qdrant_points.append(
                PointStruct(
                    id=hash(point["id"]),  # Convert string ID to int hash
                    vector=point["vector"],
                    payload=point["payload"]
                )
            )

        self.client.upsert(
            collection_name=collection,
            points=qdrant_points
        )

    async def search(self, collection: str, query_vector: List[float], top_k: int = 3):
        """Semantic search"""
        results = self.client.search(
            collection_name=collection,
            query_vector=query_vector,
            limit=top_k
        )
        return results

    async def get_collection_stats(self, collection: str) -> Dict[str, Any]:
        """Get collection statistics"""
        info = self.client.get_collection(collection)
        return {
            "vectors_count": info.vectors_count,
            "points_count": info.points_count,
            "indexed": info.status == "green"
        }
