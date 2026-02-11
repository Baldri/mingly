#!/usr/bin/env python3
"""
Start All Services
Runs both FastAPI REST API and MCP Protocol Server
"""
import subprocess
import sys
import time
from loguru import logger
from config import settings

logger.remove()
logger.add(
    sys.stdout,
    format="<green>{time:HH:mm:ss}</green> | <level>{level: <8}</level> | <level>{message}</level>",
    level=settings.log_level,
)


def start_fastapi_server():
    """Start FastAPI server in background"""
    logger.info("🚀 Starting FastAPI REST API server...")
    logger.info(f"   URL: http://{settings.rag_server_host}:{settings.rag_server_port}")

    process = subprocess.Popen(
        [sys.executable, "main.py"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
    )

    return process


def start_mcp_server():
    """Start MCP Protocol server in background"""
    logger.info("🚀 Starting MCP Protocol server...")
    logger.info("   Mode: stdio (for Claude Desktop)")

    process = subprocess.Popen(
        [sys.executable, "-m", "mcp.mcp_server"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
    )

    return process


def main():
    logger.info("=" * 60)
    logger.info("Mingly RAG Server - Starting All Services")
    logger.info("=" * 60)

    processes = []

    try:
        # Start FastAPI
        fastapi_process = start_fastapi_server()
        processes.append(("FastAPI", fastapi_process))
        time.sleep(2)  # Give FastAPI time to start

        # Start MCP
        mcp_process = start_mcp_server()
        processes.append(("MCP", mcp_process))

        logger.info("")
        logger.info("✅ All services started!")
        logger.info("")
        logger.info("Services:")
        logger.info(f"  - REST API: http://{settings.rag_server_host}:{settings.rag_server_port}/docs")
        logger.info(f"  - MCP Protocol: stdio mode (PID: {mcp_process.pid})")
        logger.info(f"  - Qdrant UI: http://{settings.qdrant_host}:{settings.qdrant_port}/dashboard")
        logger.info("")
        logger.info("Press Ctrl+C to stop all services")
        logger.info("")

        # Monitor processes
        while True:
            for name, process in processes:
                if process.poll() is not None:
                    logger.error(f"❌ {name} process died! Exit code: {process.returncode}")
                    raise SystemExit(1)

            time.sleep(1)

    except KeyboardInterrupt:
        logger.info("")
        logger.info("🛑 Shutting down all services...")

        for name, process in processes:
            logger.info(f"   Stopping {name}...")
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                logger.warning(f"   Force killing {name}...")
                process.kill()

        logger.info("✅ All services stopped")

    except Exception as e:
        logger.error(f"❌ Fatal error: {e}")
        for name, process in processes:
            process.terminate()
        sys.exit(1)


if __name__ == "__main__":
    main()
