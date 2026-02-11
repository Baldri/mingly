"""Qdrant Client Wrapper"""
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from typing import List
import uuid

class QdrantClientWrapper:
    def __init__(self, host: str, port: int, api_key: str = None):
        self.client = QdrantClient(host=host, port=port, api_key=api_key)
    
    def create_collection_if_not_exists(self, name: str, vector_size: int):
        collections = self.client.get_collections().collections
        if name not in [c.name for c in collections]:
            self.client.create_collection(
                collection_name=name,
                vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE)
            )
    
    def add_point(self, collection_name: str, vector: List[float], payload: dict):
        point_id = str(uuid.uuid4())
        self.client.upsert(
            collection_name=collection_name,
            points=[PointStruct(id=point_id, vector=vector, payload=payload)]
        )
    
    def search(self, collection_name: str, query_vector: List[float], limit: int = 5):
        return self.client.search(
            collection_name=collection_name,
            query_vector=query_vector,
            limit=limit
        )
    
    def list_collections(self):
        return self.client.get_collections()
    
    def get_collection_info(self, name: str):
        return self.client.get_collection(name)
