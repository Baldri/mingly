"""Embedding Model (multilingual-e5-large)"""
from sentence_transformers import SentenceTransformer
from typing import List
import numpy as np

class EmbeddingModel:
    def __init__(self, model_name: str = "intfloat/multilingual-e5-large", device: str = "cpu"):
        self.model = SentenceTransformer(model_name, device=device)
        self.dimension = 1024
    
    def encode(self, texts: List[str]) -> np.ndarray:
        """Encode texts to vectors"""
        return self.model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
