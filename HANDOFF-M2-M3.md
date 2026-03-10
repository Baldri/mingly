# Handoff: M2 Orchestrator UI + M3 Prompt-Templates

**Datum:** 2026-03-10
**Version:** Mingly v0.5.1
**Verifiziert:** typecheck 0 Fehler, build OK (3 Targets), 1043 Tests gruen (61 Dateien)

---

## Zusammenfassung

Beide Features hatten vollstaendiges Backend (IPC, Models, Engine) — nur die UI-Schicht fehlte.
Gleiche Situation wie M1 (Bild-Upload), das ebenfalls bereits komplett implementiert war.

| Feature | Scope | Neue Dateien | Editierte Dateien |
|---------|-------|-------------|-------------------|
| M2: Orchestrator Settings | Settings Tab | 1 | 1 |
| M3: Prompt-Templates | Store + Settings Tab + Modal + Backend-Integration | 2 | 7 |

---

## M2: Orchestrator Settings Tab

### Neue Dateien

#### `src/renderer/components/OrchestratorSettingsTab.tsx` (268 Zeilen)
- **Export:** `OrchestratorSettingsTab` React Component
- **Store:** `useOrchestratorStore` (loadConfig, updateConfig)
- **UI-Elemente:**
  - Toggle: Orchestrator ein/aus
  - Slider: Delegation Threshold (0.0–1.0, Default 0.75)
  - Slider: Auto-Approve Cost Limit ($0–$10, Default $0 = immer fragen)
  - Slider: Max Sub-Tasks (1–10, Default 3)
  - Preferred Models Grid: 5 RequestCategories × 6 Modell-Optionen (auto/claude-sonnet/claude-opus/gpt-4/gemini-pro/local)
- **Pattern:** Analog zu `PrivacySettingsTab.tsx` — useEffect + loadConfig on mount, onChange → updateConfig

### Editierte Dateien

#### `src/renderer/components/SettingsPage.tsx`
- Import `OrchestratorSettingsTab` hinzugefuegt
- `SettingsTab` Union Type: `'orchestrator'` hinzugefuegt
- `TABS` Array: `{ id: 'orchestrator', label: 'Orchestrator', icon: '🤖' }`
- Tab-Content Rendering: `activeTab === 'orchestrator' && <OrchestratorSettingsTab />`

---

## M3: Prompt-Templates — Vollstaendige Integration

### Datenfluss

```
NewConversationModal (Template-Auswahl)
  → chat-store.createConversation(title, provider, model, templateId)
    → preload: conversations.create(title, provider, model, templateId)
      → IPC: CREATE_CONVERSATION
        → ConversationModel.create(title, provider, model, templateId)
          → INSERT INTO conversations (..., template_id)

Beim Senden einer Nachricht:
  ipc-handlers.ts SEND_MESSAGE
    → Step 4a: ConversationModel.findById(conversationId)
      → Prueft conversation.templateId
        → PromptTemplateModel.findById(templateId)
          → resolveTemplate(systemPrompt, variables, {})
            → systemPrompt += templatePrompt
            → PromptTemplateModel.incrementUsage(templateId)
```

### Neue Dateien

#### `src/renderer/stores/template-store.ts` (158 Zeilen)
- **Export:** `useTemplateStore` Zustand Hook
- **State:**
  - `templates: PromptTemplate[]`
  - `selectedTemplate: PromptTemplate | null`
  - `filter: { category: TemplateCategory | 'all', favoriteOnly: boolean }`
  - `isLoading: boolean`, `error: string | null`
- **Actions:**
  - CRUD: `loadTemplates`, `createTemplate`, `updateTemplate`, `deleteTemplate`
  - UI: `toggleFavorite`, `selectTemplate`, `setFilter`, `clearError`
  - Import/Export: `exportTemplates` (returns JSON string), `importTemplates` (parses JSON array)
- **IPC:** Alle Calls via `window.electronAPI.templates.*`
- **Pattern:** Analog zu `settings-store.ts` — try/catch mit `set({ error })`, Loading-State

#### `src/renderer/components/TemplatesTab.tsx` (522 Zeilen)
- **Export:** `TemplatesTab` React Component
- **Store:** `useTemplateStore`
- **UI-Elemente:**
  - Header mit Create + Import/Export Buttons
  - Kategorie-Filter: 8 Buttons (All + 7 TemplateCategories)
  - Favorites-Only Toggle
  - Template-Liste: Name, Kategorie-Badge, Stern-Toggle, Usage-Count, Edit/Delete Buttons
  - Inline Create/Edit Form:
    - Name, Kategorie-Dropdown, Beschreibung
    - System-Prompt Textarea (8 Zeilen)
    - Dynamischer Variablen-Editor (Name + Default-Wert, Add/Remove)
  - Import: Hidden file input (`<input type="file" accept=".json">`)
  - Export: Blob-Download als JSON
- **Kategorie-Farben:** Tailwind-Klassen pro TemplateCategory (code=blue, creative=purple, analysis=green, etc.)

### Editierte Dateien

#### `src/renderer/components/SettingsPage.tsx`
- Import `TemplatesTab` hinzugefuegt
- `SettingsTab` Union Type: `'templates'` hinzugefuegt
- `TABS` Array: `{ id: 'templates', label: 'Templates', icon: '📝' }`
- Tab-Content Rendering: `activeTab === 'templates' && <TemplatesTab />`
- **Total:** Settings Page hat jetzt 11 Tabs (vorher 9)

#### `src/renderer/components/NewConversationModal.tsx`
- Import: `useTemplateStore` hinzugefuegt
- State: `selectedTemplateId` (string, default '')
- useEffect: `loadTemplates()` bei Modal-Open
- `handleCreate()`: Gibt `selectedTemplateId || undefined` als 4. Parameter weiter
- **Neues UI-Element:** Template-Selector (`<select>` mit Optgroups)
  - "No template" Default-Option
  - Favorites-Gruppe (wenn vorhanden)
  - All Templates-Gruppe
  - Beschreibung unter Select bei Auswahl

#### `src/renderer/stores/chat-store.ts`
- `createConversation` Signatur: `(title, provider, model, templateId?)` → 4. Parameter
- IPC-Call aktualisiert: `templateId` wird durchgereicht

#### `src/preload/index.ts`
- `conversations.create` Signatur: `(title, provider, model, templateId?)` → 4. Parameter
- `ipcRenderer.invoke` aktualisiert: `templateId` wird weitergegeben

#### `src/main/ipc/conversation-handlers.ts`
- `CREATE_CONVERSATION` Handler: 4. Parameter `templateId?: string`
- Weiterleitung an `ConversationModel.create(title, provider, model, templateId)`

#### `src/main/database/models/conversation.ts`
- Interface `Conversation`: `templateId?: string` hinzugefuegt
- `create()`: `template_id` in INSERT SQL, Parameter `templateId?: string`
- `findById()`: SELECT inkludiert `template_id`, gemappt auf `templateId`
- `findAll()`: SELECT inkludiert `template_id`, gemappt auf `templateId`

#### `src/main/database/index.ts` — Migration 9
```typescript
function migration9(database: SqlJsDatabase): void {
  database.run(`ALTER TABLE conversations ADD COLUMN template_id TEXT`)
  log.info('Migration 9 completed: template_id column added to conversations')
}
```
- `runMigrations()`: `if (version < 9) { migration9(database); setSchemaVersion(database, 9) }`

#### `src/main/ipc-handlers.ts` — SEND_MESSAGE Template-Integration
- Imports: `PromptTemplateModel`, `resolveTemplate`
- **Step 4a** (nach System-Prompt-Build, vor RAG-Injection):
  - Prueft `conversation.templateId`
  - Laedt Template via `PromptTemplateModel.findById()`
  - Loest Variablen auf via `resolveTemplate()`
  - Haengt Template-Prompt an System-Prompt an
  - Inkrementiert Usage-Counter
  - Non-blocking: try/catch mit console.warn (gleich wie RAG/MCP)

---

## Migration 9: Schema-Aenderung

| Tabelle | Aenderung | Typ |
|---------|-----------|-----|
| conversations | `template_id TEXT` | Neue Spalte (nullable) |

- Automatisch bei App-Start via `runMigrations()`
- Bestehende Conversations erhalten `template_id = NULL`
- Keine Datenverlust-Gefahr (nur ADD COLUMN)

---

## Bereits vorhandenes Backend (NICHT geaendert)

Diese Dateien existierten bereits und wurden **nicht modifiziert**:

| Datei | Funktion |
|-------|----------|
| `src/main/routing/hybrid-orchestrator.ts` | HybridOrchestrator mit OrchestratorConfig |
| `src/main/routing/intelligent-router.ts` | IntelligentRouter mit RequestCategory |
| `src/main/ipc/business-handlers.ts` | 7 Orchestrator IPC Channels |
| `src/renderer/stores/orchestrator-store.ts` | Zustand Store fuer Orchestrator-Config |
| `src/renderer/components/DelegationProposalDialog.tsx` | Dialog fuer Task-Delegation |
| `src/renderer/components/OrchestrationStatusBar.tsx` | Status-Anzeige |
| `src/main/database/models/prompt-template.ts` | PromptTemplateModel (CRUD) |
| `src/main/prompts/template-engine.ts` | Template Engine (Variable Resolution) |
| `src/main/prompts/builtin-templates.ts` | 20 Built-in Templates |
| `src/main/ipc/content-handlers.ts` | 8 Template IPC Channels |

---

## Verifikation

| Check | Ergebnis |
|-------|----------|
| `npm run typecheck` | 0 Fehler |
| `npm run build` | 3 Targets OK (main 2.0MB, preload 35KB, renderer 19 chunks) |
| `npm test` | 1043 Tests, 61 Dateien, 0 Fehler |

---

## Manuelle Test-Checkliste

### M2: Orchestrator
- [ ] Settings → Orchestrator Tab oeffnen
- [ ] Toggle ein/aus → Config wird gespeichert
- [ ] Slider bewegen → Werte aendern sich
- [ ] Preferred Models Grid → Modelle pro Kategorie waehlen
- [ ] Tab schliessen + oeffnen → Werte bleiben erhalten

### M3: Templates
- [ ] Settings → Templates Tab oeffnen
- [ ] Template erstellen (Name, Kategorie, System-Prompt, Variablen)
- [ ] Template bearbeiten → Aenderungen gespeichert
- [ ] Template loeschen → Aus Liste entfernt
- [ ] Favorit setzen → Stern gelb, Template in Favoriten-Gruppe
- [ ] Kategorie-Filter → Nur passende Templates angezeigt
- [ ] Export → JSON-Datei wird heruntergeladen
- [ ] Import → Templates aus JSON-Datei geladen
- [ ] New Conversation → Template-Selector sichtbar
- [ ] Template waehlen → Beschreibung angezeigt
- [ ] Nachricht senden → Template-System-Prompt wird angewendet (Console: "📝 Template applied")
- [ ] Usage-Count steigt nach Nachricht

---

## Architektur-Entscheidungen

1. **`template_id` als DB-Spalte statt JSON-Metadata:**
   Cleaner, querybar, folgt bestehendem Schema-Pattern (nicht in metadata JSON verschachtelt)

2. **Template-Application als Step 4a (nach System-Prompt, vor RAG):**
   Template hat Prioritaet ueber Auto-Context (RAG/MCP), aber Basis-System-Prompt bleibt erhalten

3. **Non-blocking Error Handling:**
   Template-Fehler blockieren nicht das Senden — gleich wie RAG- und MCP-Injection (console.warn)

4. **Inline-Form statt Modal fuer Template-Editing:**
   Konsistent mit anderem Settings-Content, weniger UI-Overhead
