"""
Configuration Management for RAG Server
"""
from pydantic_settings import BaseSettings
from typing import List, Optional


class Settings(BaseSettings):
    """Application Settings"""

    # Qdrant Configuration
    qdrant_host: str = "localhost"
    qdrant_port: int = 6333
    qdrant_api_key: Optional[str] = None

    # Embedding Model
    embedding_model: str = "intfloat/multilingual-e5-large"
    embedding_dimension: int = 1024

    # Server Configuration
    rag_server_host: str = "0.0.0.0"
    rag_server_port: int = 8001

    # Watched Directories
    watch_dirs: str = ""  # Comma-separated

    # Obsidian
    obsidian_vault_path: Optional[str] = None

    # Google Drive
    google_drive_credentials_file: Optional[str] = None
    google_drive_folder_ids: str = ""  # Comma-separated

    # iCloud
    icloud_drive_path: Optional[str] = None

    # File Processing
    max_file_size_mb: int = 50
    supported_formats: str = ".pdf,.docx,.pptx,.txt,.md,.html"

    # Chunking
    chunk_size: int = 512
    chunk_overlap: int = 50

    # Logging
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        case_sensitive = False

    @property
    def watch_directories(self) -> List[str]:
        """Get list of directories to watch"""
        if not self.watch_dirs:
            return []
        return [d.strip() for d in self.watch_dirs.split(",") if d.strip()]

    @property
    def supported_formats_list(self) -> List[str]:
        """Get list of supported file formats"""
        return [f.strip() for f in self.supported_formats.split(",") if f.strip()]

    @property
    def google_drive_folders(self) -> List[str]:
        """Get list of Google Drive folder IDs"""
        if not self.google_drive_folder_ids:
            return []
        return [f.strip() for f in self.google_drive_folder_ids.split(",") if f.strip()]


# Global settings instance
settings = Settings()
