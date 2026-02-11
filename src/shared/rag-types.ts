/**
 * RAG Types (Qdrant Vector Database)
 * Architektur: Wie im anderen Projekt mit Claude Integration
 */

export type RAGProvider = 'qdrant' | 'chroma' | 'weaviate' | 'pinecone'

export interface QdrantConfig {
  id: string
  name: string
  host: string
  port: number
  protocol: 'http' | 'https'
  apiKey?: string
  isLocal: boolean
  createdAt: number
}

export interface RAGCollection {
  name: string
  vectorSize: number
  distance: 'Cosine' | 'Euclid' | 'Dot'
  pointsCount: number
  status: 'green' | 'yellow' | 'red'
  createdAt?: number
}

export interface RAGDocument {
  id: string
  collectionName: string
  content: string
  metadata: {
    filename?: string
    filepath?: string
    source?: string // 'local' | 'obsidian' | 'google-drive' | 'icloud'
    fileType?: string // 'pdf' | 'docx' | 'md' | 'txt'
    createdAt?: number
    modifiedAt?: number
    tags?: string[]
    [key: string]: any
  }
  embedding?: number[]
}

export interface RAGSearchResult {
  id: string
  score: number
  content: string
  metadata: Record<string, any>
}

export interface RAGSearchRequest {
  collectionName: string
  query: string
  limit?: number
  filter?: Record<string, any>
  scoreThreshold?: number
}

export interface EmbeddingModel {
  name: string
  provider: 'local' | 'openai' | 'anthropic'
  modelId: string
  dimensions: number
  maxTokens: number
}

// Default: multilingual-e5-large (wie im anderen Projekt)
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = {
  name: 'multilingual-e5-large',
  provider: 'local',
  modelId: 'intfloat/multilingual-e5-large',
  dimensions: 1024,
  maxTokens: 512
}

export interface DocumentProcessingStatus {
  filename: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number // 0-100
  error?: string
  chunksCreated?: number
  startedAt: number
  completedAt?: number
}

export interface FileWatcherConfig {
  id: string
  path: string
  recursive: boolean
  collectionName: string
  enabled: boolean
  fileTypes: string[] // ['.pdf', '.docx', '.md', '.txt']
  autoIndex: boolean
  createdAt: number
}
