"""
MCP Protocol Server
Implements Model Context Protocol for Claude/Mingly integration
"""
import asyncio
import json
import sys
from typing import Any, Dict, List, Optional
from loguru import logger
import httpx

from mcp.tools import get_tool_definitions
from config import settings


class MCPServer:
    """MCP Protocol Server for RAG operations"""

    def __init__(self, rag_api_base_url: str = "http://localhost:8001/api"):
        """
        Initialize MCP server

        Args:
            rag_api_base_url: Base URL of RAG FastAPI server
        """
        self.rag_api_base_url = rag_api_base_url
        self.client = httpx.AsyncClient(timeout=60.0)
        self.request_id = 0

    async def handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle MCP protocol request

        Args:
            request: MCP request dict

        Returns:
            MCP response dict
        """
        method = request.get("method")
        params = request.get("params", {})
        request_id = request.get("id")

        logger.info(f"📨 MCP Request: {method}")

        try:
            if method == "initialize":
                return self._handle_initialize(request_id)
            elif method == "tools/list":
                return self._handle_list_tools(request_id)
            elif method == "tools/call":
                return await self._handle_call_tool(request_id, params)
            else:
                return self._error_response(
                    request_id, -32601, f"Method not found: {method}"
                )

        except Exception as e:
            logger.error(f"❌ MCP Error: {e}")
            return self._error_response(request_id, -32603, str(e))

    def _handle_initialize(self, request_id: Any) -> Dict[str, Any]:
        """Handle initialize request"""
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "0.1.0",
                "serverInfo": {
                    "name": "mingly-rag-server",
                    "version": "1.0.0",
                },
                "capabilities": {
                    "tools": {},
                },
            },
        }

    def _handle_list_tools(self, request_id: Any) -> Dict[str, Any]:
        """Handle tools/list request"""
        tools = get_tool_definitions()

        logger.info(f"📋 Listing {len(tools)} tools")

        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": tools,
            },
        }

    async def _handle_call_tool(
        self, request_id: Any, params: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Handle tools/call request"""
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        logger.info(f"🔧 Calling tool: {tool_name} with {arguments}")

        try:
            if tool_name == "search_documents":
                result = await self._call_search_documents(arguments)
            elif tool_name == "index_document":
                result = await self._call_index_document(arguments)
            elif tool_name == "index_directory":
                result = await self._call_index_directory(arguments)
            elif tool_name == "list_collections":
                result = await self._call_list_collections()
            elif tool_name == "get_collection_stats":
                result = await self._call_get_collection_stats(arguments)
            elif tool_name == "get_context":
                result = await self._call_get_context(arguments)
            elif tool_name == "delete_collection":
                result = await self._call_delete_collection(arguments)
            else:
                return self._error_response(
                    request_id, -32602, f"Unknown tool: {tool_name}"
                )

            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(result, indent=2),
                        }
                    ],
                },
            }

        except Exception as e:
            logger.error(f"❌ Tool execution failed: {e}")
            return self._error_response(request_id, -32603, f"Tool error: {e}")

    async def _call_search_documents(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute search_documents tool"""
        collection = args.get("collection", "documents")
        query = args["query"]
        limit = args.get("limit", 3)
        score_threshold = args.get("score_threshold")

        url = f"{self.rag_api_base_url}/search/{collection}"
        payload = {
            "query": query,
            "limit": limit,
            "score_threshold": score_threshold,
        }

        response = await self.client.post(url, json=payload)
        response.raise_for_status()

        return response.json()

    async def _call_index_document(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute index_document tool"""
        file_path = args["file_path"]
        collection = args.get("collection", "documents")

        url = f"{self.rag_api_base_url}/index/file"
        payload = {
            "file_path": file_path,
            "collection_name": collection,
        }

        response = await self.client.post(url, json=payload)
        response.raise_for_status()

        return response.json()

    async def _call_index_directory(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute index_directory tool"""
        directory_path = args["directory_path"]
        collection = args.get("collection", "documents")
        recursive = args.get("recursive", True)

        url = f"{self.rag_api_base_url}/index/directory"
        payload = {
            "directory_path": directory_path,
            "collection_name": collection,
            "recursive": recursive,
        }

        response = await self.client.post(url, json=payload)
        response.raise_for_status()

        return response.json()

    async def _call_list_collections(self) -> Dict[str, Any]:
        """Execute list_collections tool"""
        url = f"{self.rag_api_base_url}/collections"

        response = await self.client.get(url)
        response.raise_for_status()

        return response.json()

    async def _call_get_collection_stats(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute get_collection_stats tool"""
        collection = args["collection"]

        url = f"{self.rag_api_base_url}/collections/{collection}/stats"

        response = await self.client.get(url)
        response.raise_for_status()

        return response.json()

    async def _call_get_context(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute get_context tool"""
        collection = args.get("collection", "documents")
        query = args["query"]
        limit = args.get("limit", 3)
        score_threshold = args.get("score_threshold", 0.7)

        url = f"{self.rag_api_base_url}/context/{collection}"
        payload = {
            "query": query,
            "limit": limit,
            "score_threshold": score_threshold,
        }

        response = await self.client.post(url, json=payload)
        response.raise_for_status()

        return response.json()

    async def _call_delete_collection(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute delete_collection tool"""
        collection = args["collection"]
        confirm = args.get("confirm", False)

        if not confirm:
            return {
                "success": False,
                "error": "Deletion not confirmed. Set 'confirm' to true.",
            }

        url = f"{self.rag_api_base_url}/collections/{collection}"

        response = await self.client.delete(url)
        response.raise_for_status()

        return response.json()

    def _error_response(
        self, request_id: Any, code: int, message: str
    ) -> Dict[str, Any]:
        """Generate MCP error response"""
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": code,
                "message": message,
            },
        }

    async def close(self):
        """Close HTTP client"""
        await self.client.aclose()


async def run_stdio_server():
    """Run MCP server over stdio (for Claude Desktop integration)"""
    server = MCPServer()

    logger.info("🚀 MCP Server started (stdio mode)")
    logger.info(f"📊 RAG API: {server.rag_api_base_url}")

    try:
        while True:
            # Read JSON-RPC request from stdin
            line = await asyncio.get_event_loop().run_in_executor(
                None, sys.stdin.readline
            )

            if not line:
                break

            try:
                request = json.loads(line.strip())
                response = await server.handle_request(request)

                # Write JSON-RPC response to stdout
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()

            except json.JSONDecodeError as e:
                logger.error(f"❌ Invalid JSON: {e}")
                error_response = server._error_response(None, -32700, "Parse error")
                sys.stdout.write(json.dumps(error_response) + "\n")
                sys.stdout.flush()

    except KeyboardInterrupt:
        logger.info("🛑 Shutting down...")
    finally:
        await server.close()


if __name__ == "__main__":
    # Configure logging
    logger.remove()
    logger.add(
        sys.stderr,  # Log to stderr (stdout is reserved for MCP protocol)
        format="<green>{time:HH:mm:ss}</green> | <level>{level: <8}</level> | <level>{message}</level>",
        level=settings.log_level,
    )

    asyncio.run(run_stdio_server())
