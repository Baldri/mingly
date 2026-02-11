"""
MCP Tools
Defines tools for RAG operations via MCP protocol
"""
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field


class SearchDocumentsTool(BaseModel):
    """Tool for semantic search across document collections"""

    name: str = "search_documents"
    description: str = (
        "Search for relevant documents using semantic similarity. "
        "Returns the most relevant text chunks from the specified collection. "
        "Use this tool to find information in your knowledge base."
    )

    class InputSchema(BaseModel):
        query: str = Field(
            ...,
            description="The search query (natural language question or keywords)",
        )
        collection: str = Field(
            default="documents",
            description="The collection to search in (default: 'documents')",
        )
        limit: int = Field(
            default=3, ge=1, le=10, description="Maximum number of results (1-10)"
        )
        score_threshold: Optional[float] = Field(
            default=None,
            ge=0.0,
            le=1.0,
            description="Minimum similarity score (0.0-1.0, optional)",
        )

    input_schema: InputSchema


class IndexDocumentTool(BaseModel):
    """Tool for indexing documents into a collection"""

    name: str = "index_document"
    description: str = (
        "Index a document file into the RAG system. "
        "Supported formats: PDF, TXT, MD, DOCX, PPTX, HTML. "
        "The document will be chunked and embedded for semantic search."
    )

    class InputSchema(BaseModel):
        file_path: str = Field(..., description="Absolute path to the document file")
        collection: str = Field(
            default="documents",
            description="Target collection name (default: 'documents')",
        )

    input_schema: InputSchema


class IndexDirectoryTool(BaseModel):
    """Tool for batch indexing directories"""

    name: str = "index_directory"
    description: str = (
        "Index all supported documents in a directory (recursively). "
        "Useful for bulk-importing document libraries."
    )

    class InputSchema(BaseModel):
        directory_path: str = Field(..., description="Absolute path to the directory")
        collection: str = Field(
            default="documents",
            description="Target collection name (default: 'documents')",
        )
        recursive: bool = Field(
            default=True, description="Include subdirectories (default: true)"
        )

    input_schema: InputSchema


class ListCollectionsTool(BaseModel):
    """Tool for listing available collections"""

    name: str = "list_collections"
    description: str = (
        "List all available document collections in the RAG system. "
        "Shows collection names and document counts."
    )

    class InputSchema(BaseModel):
        pass

    input_schema: InputSchema


class GetCollectionStatsTool(BaseModel):
    """Tool for getting collection statistics"""

    name: str = "get_collection_stats"
    description: str = (
        "Get detailed statistics for a collection: "
        "document count, vector count, indexed files."
    )

    class InputSchema(BaseModel):
        collection: str = Field(..., description="Collection name")

    input_schema: InputSchema


class GetContextTool(BaseModel):
    """Tool for getting formatted context for LLM injection"""

    name: str = "get_context"
    description: str = (
        "Get formatted context string ready for LLM system prompt injection. "
        "Searches for relevant documents and returns pre-formatted context."
    )

    class InputSchema(BaseModel):
        query: str = Field(
            ..., description="The query to find relevant context for"
        )
        collection: str = Field(
            default="documents",
            description="The collection to search in (default: 'documents')",
        )
        limit: int = Field(
            default=3, ge=1, le=10, description="Maximum number of context chunks (1-10)"
        )
        score_threshold: Optional[float] = Field(
            default=0.7,
            ge=0.0,
            le=1.0,
            description="Minimum similarity score (default: 0.7)",
        )

    input_schema: InputSchema


class DeleteCollectionTool(BaseModel):
    """Tool for deleting collections"""

    name: str = "delete_collection"
    description: str = "Delete an entire collection and all its documents. USE WITH CAUTION!"

    class InputSchema(BaseModel):
        collection: str = Field(..., description="Collection name to delete")
        confirm: bool = Field(
            ...,
            description="Must be true to confirm deletion (safety check)",
        )

    input_schema: InputSchema


# All available tools
MCP_TOOLS = [
    SearchDocumentsTool(),
    IndexDocumentTool(),
    IndexDirectoryTool(),
    ListCollectionsTool(),
    GetCollectionStatsTool(),
    GetContextTool(),
    DeleteCollectionTool(),
]


def get_tool_definitions() -> List[Dict[str, Any]]:
    """Get tool definitions in MCP format"""
    definitions = []

    for tool in MCP_TOOLS:
        definitions.append(
            {
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema.model_json_schema(),
            }
        )

    return definitions
