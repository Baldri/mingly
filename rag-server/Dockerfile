FROM python:3.11-slim

WORKDIR /app

# System dependencies for unstructured document processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmagic1 \
    poppler-utils \
    tesseract-ocr \
    libreoffice-common \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create directories for data persistence
RUN mkdir -p /data/watched /data/models

ENV QDRANT_HOST=qdrant
ENV QDRANT_PORT=6333
ENV RAG_SERVER_HOST=0.0.0.0
ENV RAG_SERVER_PORT=8001
ENV LOG_LEVEL=INFO

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/api/health')" || exit 1

CMD ["python", "main.py"]
