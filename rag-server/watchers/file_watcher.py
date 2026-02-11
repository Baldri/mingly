"""
File Watcher
Monitors directories for changes and auto-indexes
"""
from typing import List, Callable, Optional
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent
from loguru import logger
import time


class DocumentEventHandler(FileSystemEventHandler):
    """Handles file system events"""

    def __init__(
        self,
        on_created: Callable[[str], None],
        on_modified: Callable[[str], None],
        on_deleted: Callable[[str], None],
        supported_formats: List[str],
    ):
        """
        Initialize event handler

        Args:
            on_created: Callback for file creation
            on_modified: Callback for file modification
            on_deleted: Callback for file deletion
            supported_formats: List of file extensions to watch
        """
        super().__init__()
        self.on_created_callback = on_created
        self.on_modified_callback = on_modified
        self.on_deleted_callback = on_deleted
        self.supported_formats = [f.lower() for f in supported_formats]

    def _is_supported_file(self, file_path: str) -> bool:
        """Check if file type is supported"""
        return Path(file_path).suffix.lower() in self.supported_formats

    def on_created(self, event: FileSystemEvent):
        """Handle file creation"""
        if event.is_directory:
            return

        if self._is_supported_file(event.src_path):
            logger.info(f"📄 New file detected: {event.src_path}")
            try:
                self.on_created_callback(event.src_path)
            except Exception as e:
                logger.error(f"❌ Error handling file creation: {e}")

    def on_modified(self, event: FileSystemEvent):
        """Handle file modification"""
        if event.is_directory:
            return

        if self._is_supported_file(event.src_path):
            logger.info(f"✏️  File modified: {event.src_path}")
            try:
                self.on_modified_callback(event.src_path)
            except Exception as e:
                logger.error(f"❌ Error handling file modification: {e}")

    def on_deleted(self, event: FileSystemEvent):
        """Handle file deletion"""
        if event.is_directory:
            return

        if self._is_supported_file(event.src_path):
            logger.info(f"🗑️  File deleted: {event.src_path}")
            try:
                self.on_deleted_callback(event.src_path)
            except Exception as e:
                logger.error(f"❌ Error handling file deletion: {e}")


class FileWatcher:
    """Watches directories for file changes"""

    def __init__(
        self,
        directories: List[str],
        supported_formats: Optional[List[str]] = None,
        on_created: Optional[Callable[[str], None]] = None,
        on_modified: Optional[Callable[[str], None]] = None,
        on_deleted: Optional[Callable[[str], None]] = None,
    ):
        """
        Initialize file watcher

        Args:
            directories: List of directories to watch
            supported_formats: List of file extensions to monitor
            on_created: Callback for file creation
            on_modified: Callback for file modification
            on_deleted: Callback for file deletion
        """
        self.directories = directories
        self.supported_formats = supported_formats or [
            ".pdf",
            ".txt",
            ".md",
            ".docx",
            ".pptx",
            ".html",
        ]

        self.on_created = on_created or self._default_callback
        self.on_modified = on_modified or self._default_callback
        self.on_deleted = on_deleted or self._default_callback

        self.observer = Observer()
        self.handlers = []

    def _default_callback(self, file_path: str):
        """Default callback (no-op)"""
        logger.debug(f"File event: {file_path}")

    def start(self):
        """Start watching directories"""
        for directory in self.directories:
            path = Path(directory)

            if not path.exists():
                logger.warning(f"⚠️  Directory does not exist: {directory}")
                continue

            if not path.is_dir():
                logger.warning(f"⚠️  Not a directory: {directory}")
                continue

            # Create event handler
            handler = DocumentEventHandler(
                on_created=self.on_created,
                on_modified=self.on_modified,
                on_deleted=self.on_deleted,
                supported_formats=self.supported_formats,
            )

            # Schedule observer
            self.observer.schedule(handler, str(path), recursive=True)
            self.handlers.append(handler)

            logger.info(f"👁️  Watching directory: {directory}")

        # Start observer
        self.observer.start()
        logger.info(f"✅ File watcher started ({len(self.directories)} directories)")

    def stop(self):
        """Stop watching"""
        self.observer.stop()
        self.observer.join()
        logger.info("🛑 File watcher stopped")

    def add_directory(self, directory: str):
        """Add a directory to watch"""
        if directory not in self.directories:
            self.directories.append(directory)

            path = Path(directory)
            if path.exists() and path.is_dir():
                handler = DocumentEventHandler(
                    on_created=self.on_created,
                    on_modified=self.on_modified,
                    on_deleted=self.on_deleted,
                    supported_formats=self.supported_formats,
                )

                self.observer.schedule(handler, str(path), recursive=True)
                self.handlers.append(handler)

                logger.info(f"👁️  Added directory to watch: {directory}")

    def remove_directory(self, directory: str):
        """Remove a directory from watching"""
        if directory in self.directories:
            self.directories.remove(directory)
            logger.info(f"🚫 Removed directory from watch: {directory}")
            # Note: watchdog doesn't provide easy way to unschedule specific path
            # Would need to restart observer

    def is_running(self) -> bool:
        """Check if watcher is running"""
        return self.observer.is_alive()


class ObsidianWatcher(FileWatcher):
    """Specialized watcher for Obsidian vaults"""

    def __init__(
        self,
        vault_path: str,
        on_created: Optional[Callable[[str], None]] = None,
        on_modified: Optional[Callable[[str], None]] = None,
        on_deleted: Optional[Callable[[str], None]] = None,
    ):
        """
        Initialize Obsidian watcher

        Args:
            vault_path: Path to Obsidian vault
            on_created: Callback for note creation
            on_modified: Callback for note modification
            on_deleted: Callback for note deletion
        """
        # Obsidian uses markdown files
        super().__init__(
            directories=[vault_path],
            supported_formats=[".md"],
            on_created=on_created,
            on_modified=on_modified,
            on_deleted=on_deleted,
        )

        logger.info(f"📓 Obsidian watcher initialized for: {vault_path}")
