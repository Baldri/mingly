"""File Watcher (Watchdog)"""
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import time
import logging

logger = logging.getLogger(__name__)

class FileWatcher:
    def __init__(self, directories, qdrant_client, embedding_model, document_processor):
        self.directories = directories
        self.qdrant_client = qdrant_client
        self.embedding_model = embedding_model
        self.document_processor = document_processor
        self.observer = Observer()
    
    def start(self):
        """Start watching directories"""
        for dir_config in self.directories:
            event_handler = DocumentEventHandler(
                collection=dir_config["collection"],
                file_types=dir_config.get("file_types", []),
                qdrant_client=self.qdrant_client,
                embedding_model=self.embedding_model,
                document_processor=self.document_processor
            )
            self.observer.schedule(
                event_handler,
                dir_config["path"],
                recursive=dir_config.get("recursive", True)
            )
            logger.info(f"Watching: {dir_config['path']} -> {dir_config['collection']}")
        
        self.observer.start()

class DocumentEventHandler(FileSystemEventHandler):
    def __init__(self, collection, file_types, qdrant_client, embedding_model, document_processor):
        self.collection = collection
        self.file_types = file_types
        self.qdrant_client = qdrant_client
        self.embedding_model = embedding_model
        self.document_processor = document_processor
        self.last_processed = {}
    
    def on_created(self, event):
        if not event.is_directory and self._should_process(event.src_path):
            self._process_file(event.src_path)
    
    def on_modified(self, event):
        if not event.is_directory and self._should_process(event.src_path):
            now = time.time()
            if event.src_path not in self.last_processed or now - self.last_processed[event.src_path] > 1:
                self._process_file(event.src_path)
                self.last_processed[event.src_path] = now
    
    def _should_process(self, path):
        if not self.file_types:
            return True
        return any(path.endswith(ext) for ext in self.file_types)
    
    def _process_file(self, path):
        try:
            logger.info(f"Processing: {path}")
            chunks = self.document_processor.process_file(path)
            texts = [c["content"] for c in chunks]
            embeddings = self.embedding_model.encode(texts)
            
            for chunk, embedding in zip(chunks, embeddings):
                self.qdrant_client.add_point(
                    collection_name=self.collection,
                    vector=embedding.tolist(),
                    payload={
                        "content": chunk["content"],
                        "metadata": chunk["metadata"]
                    }
                )
            logger.info(f"Indexed {len(chunks)} chunks from {path}")
        except Exception as e:
            logger.error(f"Error processing {path}: {e}")
