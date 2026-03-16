# Red-Team Run Summary — 2026-03-16 (2-Layer: Regex+Swiss)

## Ergebnis

| Metrik | Wert |
|---|---|
| **Total Tests** | 143 |
| **Passed** | 98 (68.5%) |
| **Failed** | 45 (31.5%) |
| **Mode** | 2-Layer (Regex + Swiss, NER disabled) |
| **Laufzeit** | 1.60s |

## Fails nach Kategorie

### Erwartete Fails (NER-abhaengig, ohne NER nicht moeglich)

| Kategorie | Fails | Kommentar |
|---|---|---|
| PERSON (Name Detection) | ~12 | Keine Regex fuer Namen — braucht NER |
| ORGANIZATION | 2 | Keine Regex fuer Firmen — braucht NER |
| ADDRESS (Strasse) | 2 | Swiss Detector erkennt PLZ+Stadt aber nicht Strasse allein |
| PASSPORT | 4 | Regex-Pattern fuer Passport fehlt oder zu restriktiv |

### Echte Pipeline-Gaps (Fixes noetig)

| Technik | Tier | Kategorie | Beschreibung |
|---|---|---|---|
| **zero-width-space-ahv** | CRITICAL | AHV | `756\u200B.1234.5678.97` — ZWS bricht Regex |
| **split-ahv-over-lines** | CRITICAL | AHV | AHV ueber Zeilenumbruch aufgeteilt |
| **email-in-url-param** | CRITICAL | EMAIL | `?email=hans@test.ch` — wird als URL statt EMAIL erkannt |
| **zero-width-space** | HIGH | EMAIL | ZWS in Domain bricht Email-Regex |
| **url-encoded-at** | HIGH | EMAIL | `hans%40test.ch` nicht erkannt |
| **url-encoded-email-in-param** | HIGH | EMAIL | Doppelte Kodierung |
| **french-context AHV** | CRITICAL | AHV | "Numero AVS" Kontext — AHV nicht erkannt (Checksum?) |
| **german-standard DOB** | HIGH | DATE_OF_BIRTH | "geboren am" — Regex-Match fehlgeschlagen |

### Akzeptierte Risiken (Low Tier, bekannt)

| Technik | Tier | Beschreibung |
|---|---|---|
| base64 | MEDIUM | Base64-kodierte PII nicht dekodiert |
| reversed | LOW | Umgekehrter Text nicht erkannt |
| emoji-digits | LOW | Emoji-Ziffern nicht normalisiert |
| concatenation-trick | LOW | `hans + @ + test.ch` nicht erkannt |
| space-between-chars | MEDIUM | `h a n s @ t e s t . c h` nicht erkannt |
| at-dot-words | MEDIUM | `hans [at] test [dot] ch` nicht erkannt |
| html-entity-at | MEDIUM | `hans&#64;test.ch` nicht erkannt |
| html-named-entity | MEDIUM | `hans&commat;test.ch` nicht erkannt |
| fullwidth-at | MEDIUM | `hans＠test.ch` nicht erkannt |
| homoglyphen | MEDIUM | Kyrillische Buchstaben nicht normalisiert |
| decomposed-umlaut | MEDIUM | NFC-Normalisierung fehlt |

### Assertion-Parsing-Issues (False Fails)

| Test | Problem |
|---|---|
| vault-mode-basic | Compound-Assertion mit `&&` + `includes` — Evaluator-Pattern nicht abgedeckt |
| Rehydration replacements.length | Evaluator erkennt `replacements.length` Pattern nicht korrekt |

## Massnahmen

### CRITICAL (sofort fixen)
1. **Zero-Width-Character Stripping** — vor Detection alle ZWS/ZWNJ/ZWJ entfernen
2. **Email in URL-Param** — Email-Regex auch innerhalb URLs matchen
3. **AHV French Context** — Testdaten Checksum validieren (moeglicherweise ungueltige Test-AHV)

### HIGH (vor v0.7.0)
4. **URL-Encoding Dekodierung** — `%40` → `@` vor Detection
5. **DATE_OF_BIRTH Regex** — "geboren am" Pattern pruefen

### MEDIUM (Backlog)
6. HTML-Entity Dekodierung
7. Unicode NFC-Normalisierung
8. Homoglyphen-Detection
9. Assertion-Evaluator erweitern fuer komplexere Patterns

### Naechster Schritt
- 3-Layer Run mit piiranha-v1 NER (PERSON, ORG, ADDRESS Tests sollten passen)
- Assertion-Evaluator Bugfixes
- CRITICAL Fixes implementieren
