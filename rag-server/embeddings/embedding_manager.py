"""
Embedding Manager
Handles text embedding using multilingual-e5-large
"""
from typing import List, Union
from sentence_transformers import SentenceTransformer
from loguru import logger
import numpy as np
import torch


class EmbeddingManager:
    """Manages text embeddings"""

    def __init__(self, model_name: str = "intfloat/multilingual-e5-large"):
        """Initialize embedding model"""
        self.model_name = model_name
        self.dimension = 1024  # multilingual-e5-large dimension

        try:
            logger.info(f"Loading embedding model: {model_name}...")

            # Check if CUDA is available
            device = "cuda" if torch.cuda.is_available() else "cpu"
            logger.info(f"Using device: {device}")

            self.model = SentenceTransformer(model_name, device=device)

            logger.info(f"✅ Embedding model loaded (dimension: {self.dimension})")
        except Exception as e:
            logger.error(f"❌ Failed to load embedding model: {e}")
            raise

    def embed_text(self, text: str) -> List[float]:
        """
        Embed a single text string

        Args:
            text: Text to embed

        Returns:
            List of floats (embedding vector)
        """
        try:
            # Add instruction prefix for e5 models (improves performance)
            text_with_instruction = f"passage: {text}"

            embedding = self.model.encode(
                text_with_instruction,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )

            return embedding.tolist()

        except Exception as e:
            logger.error(f"❌ Failed to embed text: {e}")
            return []

    def embed_texts(self, texts: List[str], batch_size: int = 32) -> List[List[float]]:
        """
        Embed multiple texts in batches

        Args:
            texts: List of texts to embed
            batch_size: Batch size for encoding

        Returns:
            List of embedding vectors
        """
        try:
            # Add instruction prefix
            texts_with_instruction = [f"passage: {text}" for text in texts]

            embeddings = self.model.encode(
                texts_with_instruction,
                batch_size=batch_size,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=len(texts) > 10,
            )

            logger.info(f"✅ Embedded {len(texts)} texts")
            return embeddings.tolist()

        except Exception as e:
            logger.error(f"❌ Failed to embed texts: {e}")
            return []

    def embed_query(self, query: str) -> List[float]:
        """
        Embed a query string (uses different instruction than passages)

        Args:
            query: Query string

        Returns:
            Embedding vector
        """
        try:
            # For queries, use "query:" prefix
            query_with_instruction = f"query: {query}"

            embedding = self.model.encode(
                query_with_instruction,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )

            return embedding.tolist()

        except Exception as e:
            logger.error(f"❌ Failed to embed query: {e}")
            return []

    def compute_similarity(
        self, embedding1: List[float], embedding2: List[float]
    ) -> float:
        """
        Compute cosine similarity between two embeddings

        Args:
            embedding1: First embedding vector
            embedding2: Second embedding vector

        Returns:
            Similarity score (0-1)
        """
        try:
            vec1 = np.array(embedding1)
            vec2 = np.array(embedding2)

            # Cosine similarity
            similarity = np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2))

            return float(similarity)

        except Exception as e:
            logger.error(f"❌ Failed to compute similarity: {e}")
            return 0.0

    def get_model_info(self) -> dict:
        """Get model information"""
        return {
            "model_name": self.model_name,
            "dimension": self.dimension,
            "device": str(self.model.device),
            "max_seq_length": self.model.max_seq_length,
        }
