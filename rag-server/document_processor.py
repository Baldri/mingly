"""Document Processor (Unstructured.io)"""
from unstructured.partition.auto import partition
from typing import List, Dict
import os

class DocumentProcessor:
    def process_file(self, file_path: str) -> List[Dict]:
        """Process document and return chunks"""
        elements = partition(file_path)
        
        chunks = []
        for element in elements:
            chunks.append({
                "content": str(element),
                "metadata": {
                    "filename": os.path.basename(file_path),
                    "path": file_path,
                    "type": element.category if hasattr(element, 'category') else "unknown"
                }
            })
        
        return chunks
