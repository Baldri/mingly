# Red-Team Run v4 — 3-Layer nach Modellwechsel — 2026-08-05

## Score

| Modus | Bestanden | Rot | Total | Rate | Δ zu v3 (2026-03-17) |
|-------|-----------|-----|-------|------|----------------------|
| **2-Layer (Regex+Swiss)** | 116 | 27 | 143 | 81.1 % | **+1** |
| **3-Layer (Regex+Swiss+NER)** | 118 | 15 | 133 | **88.7 %** | **+5** |

> Layer 3 ist seit PR #14 `Xenova/bert-base-multilingual-cased-ner-hrl`
> statt `piiranha-v1`. Auswahl per Messung, siehe `scripts/ner-eval/`.

## Zuerst: die Suite lief seit Monaten gar nicht durch

**Vor diesem Lauf brach die Suite in beiden Modi ab** — `Worker exited
unexpectedly`, nach 25 von 143 Fällen auf dem Stand vor #14 und nach 40 auf
dem aktuellen. Nichtdeterministisch, nie vollständig. Die v3-Baseline war
damit **nicht reproduzierbar**, unabhängig vom Modell.

Ursache: `runDetection`, `runAnonymization` und `runRehydrationTest` riefen
vor **jedem** Fall `setNERDetector(null)`. Das schaltet Layer 3 nicht ab —
es leert den Singleton, und der nächste `detectPII()` baut einen **echten**
Detektor, der einen Worker-Thread startet und die ONNX-Session lädt. Der
«2-Layer»-Modus lief also mit lebendem Layer 3 und zahlte einen Modell-Ladevorgang
pro Testfall, bis der Fork starb.

Dass die v3-Zahlen im März entstanden, liegt nur daran, dass das Modell damals
noch nicht heruntergeladen war — `isAvailable()` war falsch, der Detektor blieb
wirkungslos, und derselbe Code mass tatsächlich 2 Layer. Der Defekt war die
ganze Zeit da und wurde erst durch ein vorhandenes Modell sichtbar.

Behoben mit einem expliziten `NER_OFF`-Stub (`isAvailable: () => false`).
**«Auf Default zurücksetzen» und «aus» sind nicht dasselbe** — dieselbe Klasse
wie der Unit-Test-Flake vom selben Tag.

## Was der Modellwechsel gebracht hat

Sechs der sieben in v3 als «Still failing with NER» geführten Fälle sind grün:

| Test | Kategorie | v3 | jetzt |
|------|-----------|----|-------|
| name-only-no-context | PERSON | rot | ✅ |
| multiple-names | PERSON | rot | ✅ |
| title-abbreviated | PERSON | rot | ✅ |
| apostrophe-in-name | PERSON | rot | ✅ |
| company-with-suffix | ORGANIZATION | rot — «piiranha-v1 has no ORG label» | ✅ |
| institution-name | ORGANIZATION | rot — «piiranha-v1 has no ORG label» | ✅ |
| standard-passport | PASSPORT | rot | rot |

## Was er gekostet hat

| Test | Kategorie | v3 | jetzt | Grund |
|------|-----------|----|-------|-------|
| id-number | PASSPORT | ✅ (von NER gefixt) | **rot** | piiranha mappte `IDCARDNUM`; das neue Modell hat das Label nicht |

Das ist die einzige Regression im Katalog und war vorhersehbar — v3 führte
`id-number` ausdrücklich unter «Fixed by NER … NER maps IDCARDNUM label».

## Ein kritischer Fehlalarm, gefunden und behoben

`no-pii-text [critical]` («Kein PII hier, nur ein normaler Satz ueber das
Wetter in der Schweiz.») wurde durch den Wechsel **rot**: Das neue Modell
taggt Länder als `LOC`, und der Anonymizer setzte dafür eine Schweizer Stadt
ein. Gemessen:

```
"… das Wetter in der Schweiz."            -> "… das Wetter in der Luzern."
"… exportiert nach Deutschland und Österreich."  -> "… nach Luzern und Baden."
"Wie ist das Wetter in Europa?"           -> "Wie ist das Wetter in Luzern?"
```

Ein Land allein identifiziert niemanden — die Schwärzung kauft keinen
Datenschutz und kostet dem nachgelagerten Modell einen brauchbaren Satz.
`ner-worker.ts` verwirft solche Spans jetzt (`NON_PERSONAL_PLACES`), bewusst
nur bei **Ganz-Span-Treffern**: «Schweizerhof» bleibt eine Location, Städte
bleiben geschwärzt.

## Vorbefund, inzwischen behoben

`Der Zug nach Zürich faellt aus.` → `Der Luzern nach Baden faellt aus.`

Der Swiss-Detektor matchte die Stadt **Zug** im Wort «Zug» — Homonym-Problem
in `SWISS_CITIES`, unabhängig vom Modell und älter als dieser Lauf.

**Behoben am selben Tag.** Welche Namen betroffen sind, wurde gemessen statt
angenommen: nur **Zug** und **Baden** feuerten in Nicht-Ort-Sätzen. Die hier
zunächst ebenfalls genannte Stadt **«Chur» gehört NICHT dazu** — sie ist kein
deutsches Wort; die Behauptung war ungeprüft und ist damit zurückgezogen.

Beide Namen bleiben in der Liste (Layer 3 deckt sie nicht ab — «Ich wohne in
Zug.» erzeugte *keine* NER-Entität) und brauchen jetzt einen vorangehenden
Ortshinweis. Sprachlich trägt genau die Kontraktion die Unterscheidung:
«in Zug» ist die Stadt, «im Zug» das Fahrzeug; «bei Baden» der Ort, «beim
Baden» die Tätigkeit. Katalog-Score dadurch unverändert (kein Testfall deckt
den Fall ab), volle Suite 1292 grün.

## Restliche rote Fälle (15, 3-Layer)

Unverändert gegenüber v3 und alle ausserhalb der NER-Zuständigkeit —
Encoding-Angriffe (`base64` ×2, `cyrillic-e-homoglyph`, `space-between-chars`,
`reversed`, `emoji-digits`, `at-dot-words`, `url-encoded-email-in-param`,
`email-in-url-param`), `concatenation-trick`, Sprachmischung (3×),
`standard-passport`, `id-number`.

## Reproduktion

```bash
npm run test:red-team                 # 2-Layer
RUN_3LAYER=1 npm run test:red-team    # 3-Layer (lädt das Modell, ~20 s)
```
