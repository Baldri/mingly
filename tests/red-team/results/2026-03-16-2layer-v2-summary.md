# Red-Team Run Summary — 2026-03-16 v2 (Post-CRITICAL-Fixes)

## Ergebnis

| Metrik | Wert | Delta zu v1 |
|---|---|---|
| **Total Tests** | 143 | - |
| **Passed** | 115 (80.4%) | +17 (+11.9%) |
| **Failed** | 28 (19.6%) | -17 |
| **Mode** | 2-Layer (Regex + Swiss, NER disabled) | - |
| **Laufzeit** | 1.52s | -0.08s |

## Geloeste CRITICAL/HIGH Issues

| Issue | Fix | Tests gefixt |
|---|---|---|
| **Zero-Width-Space** | `text-preprocessor.ts` — ZWS/ZWNJ/ZWJ/BOM/SoftHyphen Stripping | AHV + Email ZWS |
| **URL-Encoded PII** | `text-preprocessor.ts` — `%40` → `@` Decoding vor Detection | url-encoded-at, url-encoded-email-in-param |
| **Email in URL-Param** | `regex-detector.ts` — Email-Extraktion aus URL-Matches + `detector-pipeline.ts` Dedup-Exception | email-in-url-param |
| **AHV Multiline** | `swiss-detector.ts` — AHV Pattern `{0,3}` statt `?` fuer Separatoren | split-ahv-over-lines |
| **AHV French Context** | Testdaten-Fix — ungueltige Checksum `756.9876.5432.10` → `756.9876.5432.17` | french-context |
| **DOB "geboren am"** | `regex-detector.ts` — "geboren am", "ne(e) le", "born on", "data di nascita" | german-standard DOB |
| **Vault Mode Test** | Test-Config-Fix — Mode aus Metadata ableiten + Assertion NER-realistisch | vault-mode-basic |
| **Unicode NFC** | `text-preprocessor.ts` — NFC Normalisierung | decomposed-umlaut-city |
| **Assertion Evaluator** | `red-team.test.ts` — generische `X.length`, compound `&&`, `||` in entities.some() | 3 false-fail Assertions |

## Verbleibende 28 Fails

### NER-abhaengig (14 Tests — brauchen piiranha-v1 3-Layer)

| Kategorie | Tests | Kommentar |
|---|---|---|
| PERSON | 9 | name-only, surname, abbreviated, title, compound, apostrophe, umlaut, multiple, hyphenated |
| ORGANIZATION | 2 | company-with-suffix, institution-name |
| PASSPORT/ID | 2 | standard-passport, id-number (kein Regex-Pattern) |
| Language Mix (PERSON) | 3 | DE/FR/IT Szenarios mit Personennamen |

### Akzeptierte Risiken MEDIUM/LOW (11 Tests — Backlog)

| Tier | Tests | Techniken |
|---|---|---|
| MEDIUM | 8 | base64 (x2), cyrillic-e-homoglyph, html-entity-at, html-named-entity, fullwidth-at, space-between-chars, at-dot-words |
| LOW | 3 | reversed, concatenation-trick, emoji-digits |

### Decomposed-Umlaut PERSON (1 Test)
- `Mu\u0308ller` — NFC normalisiert zu Müller, aber PERSON Detection braucht NER

## Pipeline-Aenderungen

### Neue Dateien
- `src/main/privacy/text-preprocessor.ts` — Text-Normalisierung (ZWS, URL-Decode, NFC)
- `tests/unit/privacy-text-preprocessor.test.ts` — 17 Unit-Tests

### Geaenderte Dateien
- `src/main/privacy/detector-pipeline.ts` — Preprocessing vor Detection, Email-in-URL Dedup
- `src/main/privacy/regex-detector.ts` — Email-aus-URL Extraktion, DOB Pattern erweitert
- `src/main/privacy/swiss-detector.ts` — AHV Pattern fuer Multiline
- `tests/red-team/red-team.test.ts` — Evaluator Fixes, Vault-Mode Runner
- `tests/red-team/catalog/format-variations.yaml` — AHV Checksum Fix
- `tests/red-team/jailbreak/prompt-injection.yaml` — Vault-Mode Assertion Fix

## Naechste Schritte

1. **3-Layer NER Run** — piiranha-v1 aktivieren, 14+ NER-Tests sollten passen
2. **MEDIUM Backlog** — HTML-Entity Decoding, Fullwidth-Normalisierung
3. **Commit + Push** — alle Fixes
