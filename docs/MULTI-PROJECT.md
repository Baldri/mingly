# Multi-Projekt-Verwaltung — Mingly

## Ueberblick

Mingly unterstuetzt ab v0.6.0 die Verknuepfung von Conversations mit RAG-Wissen Projekten. Context Injection erfolgt automatisch aus der richtigen Projekt-Collection. Feature-Gate: `shared_rag` (Team-Tier).

## Architektur

```
┌──────────────────────────────────────────────────┐
│  Renderer (React)                                 │
│  ┌──────────────────────┐  ┌───────────────────┐ │
│  │ NewConversationModal  │  │ ConversationSidebar│ │
│  │ (Projekt-Selektor)   │  │ (Projekt-Badge)    │ │
│  └──────────┬───────────┘  └───────────────────┘ │
│             │ IPC                                  │
└─────────────┼──────────────────────────────────────┘
              ▼
┌──────────────────────────────────────────────────┐
│  Main Process                                     │
│  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ ConversationModel │  │ ContextInjector      │  │
│  │ (project_id,      │  │ getContextFor-       │  │
│  │  rag_collection)  │  │   Conversation()     │  │
│  └──────────────────┘  └──────────┬───────────┘  │
│                                    │              │
│  ┌─────────────────────────────────┘              │
│  │ RAGWissenClient.getContext(collection)         │
└──┼────────────────────────────────────────────────┘
   ▼ HTTP
┌──────────────────────────────────────────────────┐
│  RAG-Wissen Backend                               │
│  Collection-spezifische Suche                     │
└──────────────────────────────────────────────────┘
```

## Funktionsweise

1. **NewConversationModal** zeigt optionalen Projekt-Dropdown (Projekte aus RAG-Wissen)
2. Ausgewaehltes Projekt wird in `conversations` Tabelle gespeichert (`project_id`, `rag_collection_name`)
3. **ContextInjector.getContextForConversation()** nutzt die Collection der Conversation
4. Fallback: Conversations ohne Projekt → globale RAG-Config (abwaertskompatibel)
5. **ConversationSidebar** zeigt Projekt-Badge neben Conversation-Titel

## DB-Migration (M10)

```sql
ALTER TABLE conversations ADD COLUMN project_id TEXT;
ALTER TABLE conversations ADD COLUMN rag_collection_name TEXT;
CREATE INDEX idx_conversations_project ON conversations(project_id);
```

## Feature-Gate

Alle Projekt-Funktionen stehen hinter `requireFeature('shared_rag')` — nur fuer Team-Tier verfuegbar.

## Dateien

| Datei | Beschreibung |
|-------|-------------|
| `src/main/database/index.ts` | Migration M10 |
| `src/main/database/models/conversation.ts` | project_id + rag_collection_name |
| `src/main/rag/context-injector.ts` | getContextForConversation() |
| `src/main/rag/rag-wissen-client.ts` | listProjects() |
| `src/main/ipc/rag-handlers.ts` | list-projects Channel |
| `src/main/ipc/conversation-handlers.ts` | Feature-Gate bei create |
| `src/main/services/service-layer.ts` | Per-Conversation Context |
| `src/renderer/components/NewConversationModal.tsx` | Projekt-Selektor |
| `src/renderer/components/ConversationSidebar.tsx` | Projekt-Badge |
| `src/shared/types.ts` | IPC-Channel |
| `src/preload/index.ts` | Preload-API |
