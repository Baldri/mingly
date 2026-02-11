"""
Embedding Model Manager
Uses multilingual-e5-large for German/English embeddings
"""
from sentence_transformers import SentenceTransformer
from typing import List, Union
import logging
import torch
from config import settings

logger = logging.getLogger(__name__)

class EmbeddingManager:
    def __init__(self):
        logger.info(f"📦 Loading embedding model: {settings.EMBEDDING_MODEL}")
        self.model = SentenceTransformer(
            settings.EMBEDDING_MODEL,
            device=settings.DEVICE
        )
        logger.info(f"✅ Model loaded on {settings.DEVICE}")
        logger.info(f"📏 Embedding dimension: {settings.EMBEDDING_DIMENSION}")

    def encode(
        self,
        texts: Union[str, List[str]],
        batch_size: int = 32,
        show_progress_bar: bool = False
    ) -> Union[List[float], List[List[float]]]:
        """
        Generate embeddings for text(s)

        Args:
            texts: Single text or list of texts
            batch_size: Batch size for encoding
            show_progress_bar: Show progress bar

        Returns:
            Single embedding (if input is str) or list of embeddings
        """
        is_single = isinstance(texts, str)
        if is_single:
            texts = [texts]

        # Add instruction prefix for e5 models
        # For retrieval tasks, use "passage: " for documents and "query: " for queries
        # We'll use "passage: " as default
        prefixed_texts = [f"passage: {text}" for text in texts]

        # Generate embeddings
        embeddings = self.model.encode(
            prefixed_texts,
            batch_size=batch_size,
            show_progress_bar=show_progress_bar,
            normalize_embeddings=True  # Normalize for cosine similarity
        )

        # Convert to list
        embeddings = embeddings.tolist()

        return embeddings[0] if is_single else embeddings

    def encode_query(self, query: str) -> List[float]:
        """
        Encode a search query
        Uses "query: " prefix for better retrieval performance
        """
        prefixed_query = f"query: {query}"
        embedding = self.model.encode(
            prefixed_query,
            normalize_embeddings=True
        )
        return embedding.tolist()

    def get_dimension(self) -> int:
        """Get embedding dimension"""
        return self.model.get_sentence_embedding_dimension()

    def get_model_info(self) -> dict:
        """Get model information"""
        return {
            "model_name": settings.EMBEDDING_MODEL,
            "dimension": self.get_dimension(),
            "device": settings.DEVICE,
            "max_seq_length": self.model.max_seq_length
        }

# Singleton instance
_embedding_manager = None

def get_embedding_manager() -> EmbeddingManager:
    global _embedding_manager
    if _embedding_manager is None:
        _embedding_manager = EmbeddingManager()
    return _embedding_manager
