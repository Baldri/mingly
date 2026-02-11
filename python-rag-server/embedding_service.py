"""
Embedding Service
Uses sentence-transformers for local embeddings
Model: intfloat/multilingual-e5-large
"""

from sentence_transformers import SentenceTransformer
import numpy as np
from typing import List

class EmbeddingService:
    def __init__(self, model_name: str = "intfloat/multilingual-e5-large"):
        self.model_name = model_name
        self.model = None
        self._load_model()

    def _load_model(self):
        """Load embedding model (lazy loading)"""
        try:
            print(f"📦 Loading embedding model: {self.model_name}")
            self.model = SentenceTransformer(self.model_name)
            print(f"✅ Model loaded successfully (dim: {self.model.get_sentence_embedding_dimension()})")
        except Exception as e:
            print(f"❌ Failed to load model: {e}")
            self.model = None

    def is_loaded(self) -> bool:
        """Check if model is loaded"""
        return self.model is not None

    async def embed_texts(self, texts: List[str]) -> np.ndarray:
        """Generate embeddings for multiple texts"""
        if not self.model:
            raise RuntimeError("Embedding model not loaded")

        # Add instruction prefix for e5 models (recommended by authors)
        prefixed_texts = [f"passage: {text}" for text in texts]

        embeddings = self.model.encode(
            prefixed_texts,
            convert_to_numpy=True,
            show_progress_bar=len(texts) > 10,
            batch_size=32
        )

        return embeddings

    async def embed_query(self, query: str) -> np.ndarray:
        """Generate embedding for a query"""
        if not self.model:
            raise RuntimeError("Embedding model not loaded")

        # Add query prefix for e5 models
        prefixed_query = f"query: {query}"

        embedding = self.model.encode(
            prefixed_query,
            convert_to_numpy=True
        )

        return embedding

    def get_dimensions(self) -> int:
        """Get embedding dimensions"""
        if not self.model:
            return 1024  # Default for multilingual-e5-large
        return self.model.get_sentence_embedding_dimension()
