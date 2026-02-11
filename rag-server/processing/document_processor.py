"""
Document Processor
Handles document parsing, chunking, and indexing
"""
from typing import List, Dict, Any, Optional
from pathlib import Path
import hashlib
from datetime import datetime
from loguru import logger

# Document parsers will be imported dynamically
try:
    from unstructured.partition.auto import partition
    UNSTRUCTURED_AVAILABLE = True
except ImportError:
    UNSTRUCTURED_AVAILABLE = False
    logger.warning("⚠️ unstructured not available, falling back to basic parsing")


class DocumentProcessor:
    """Processes documents for RAG"""

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        """
        Initialize document processor

        Args:
            chunk_size: Number of tokens per chunk
            chunk_overlap: Overlap between chunks
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def process_file(self, file_path: str) -> Dict[str, Any]:
        """
        Process a single file

        Args:
            file_path: Path to file

        Returns:
            Dict with parsed content and metadata
        """
        try:
            path = Path(file_path)

            if not path.exists():
                raise FileNotFoundError(f"File not found: {file_path}")

            # Get file metadata
            file_stat = path.stat()
            file_type = path.suffix.lower()

            # Parse content
            content = self._parse_file(file_path, file_type)

            if not content:
                raise ValueError(f"Could not extract content from {file_path}")

            # Chunk content
            chunks = self._chunk_text(content)

            # Generate file ID (hash of path)
            file_id = self._generate_file_id(file_path)

            result = {
                "file_id": file_id,
                "file_path": file_path,
                "file_name": path.name,
                "file_type": file_type,
                "file_size": file_stat.st_size,
                "content": content,
                "chunks": chunks,
                "chunk_count": len(chunks),
                "indexed_at": datetime.now().isoformat(),
            }

            logger.info(
                f"✅ Processed {path.name}: {len(chunks)} chunks ({len(content)} chars)"
            )
            return result

        except Exception as e:
            logger.error(f"❌ Failed to process {file_path}: {e}")
            raise

    def _parse_file(self, file_path: str, file_type: str) -> str:
        """Parse file content based on type"""

        # Use unstructured if available
        if UNSTRUCTURED_AVAILABLE:
            try:
                elements = partition(filename=file_path)
                content = "\n\n".join([str(el) for el in elements])
                return content
            except Exception as e:
                logger.warning(f"⚠️ Unstructured failed, falling back: {e}")

        # Fallback to basic parsing
        if file_type in [".txt", ".md"]:
            return self._parse_text(file_path)
        elif file_type == ".pdf":
            return self._parse_pdf_fallback(file_path)
        else:
            raise ValueError(f"Unsupported file type: {file_type}")

    def _parse_text(self, file_path: str) -> str:
        """Parse plain text file"""
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()

    def _parse_pdf_fallback(self, file_path: str) -> str:
        """Fallback PDF parser using PyPDF2"""
        try:
            import PyPDF2

            with open(file_path, "rb") as f:
                reader = PyPDF2.PdfReader(f)
                text = ""
                for page in reader.pages:
                    text += page.extract_text() + "\n\n"
                return text
        except ImportError:
            raise ValueError("PyPDF2 not installed, cannot parse PDF")

    def _chunk_text(self, text: str) -> List[str]:
        """
        Chunk text into overlapping segments

        Args:
            text: Full text content

        Returns:
            List of text chunks
        """
        # Simple character-based chunking
        # In production, use token-based chunking with tiktoken

        char_chunk_size = self.chunk_size * 4  # Rough estimate: 1 token ≈ 4 chars
        char_overlap = self.chunk_overlap * 4

        chunks = []
        start = 0

        while start < len(text):
            end = start + char_chunk_size
            chunk = text[start:end]

            if chunk.strip():
                chunks.append(chunk.strip())

            start += char_chunk_size - char_overlap

        return chunks

    def _generate_file_id(self, file_path: str) -> str:
        """Generate unique ID for file"""
        return hashlib.md5(file_path.encode()).hexdigest()

    def process_directory(
        self,
        directory_path: str,
        supported_formats: Optional[List[str]] = None,
        recursive: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Process all files in a directory

        Args:
            directory_path: Path to directory
            supported_formats: List of file extensions (e.g. ['.pdf', '.txt'])
            recursive: Whether to process subdirectories

        Returns:
            List of processed documents
        """
        if supported_formats is None:
            supported_formats = [".pdf", ".txt", ".md", ".docx", ".pptx"]

        path = Path(directory_path)
        if not path.exists():
            raise FileNotFoundError(f"Directory not found: {directory_path}")

        results = []
        pattern = "**/*" if recursive else "*"

        for file_path in path.glob(pattern):
            if file_path.is_file() and file_path.suffix.lower() in supported_formats:
                try:
                    result = self.process_file(str(file_path))
                    results.append(result)
                except Exception as e:
                    logger.error(f"❌ Failed to process {file_path}: {e}")
                    continue

        logger.info(
            f"✅ Processed directory {directory_path}: {len(results)} files"
        )
        return results

    def extract_metadata(self, file_path: str) -> Dict[str, Any]:
        """Extract metadata from file without full processing"""
        path = Path(file_path)
        file_stat = path.stat()

        return {
            "file_path": file_path,
            "file_name": path.name,
            "file_type": path.suffix.lower(),
            "file_size": file_stat.st_size,
            "modified_at": datetime.fromtimestamp(file_stat.st_mtime).isoformat(),
            "created_at": datetime.fromtimestamp(file_stat.st_ctime).isoformat(),
        }
