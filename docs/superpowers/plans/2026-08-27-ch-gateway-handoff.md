# CH-Gateway — Handoff 27.08.2026

**Repo:** `~/mingly` · **`main` auf `d85dd0f`** · **1426 Tests gruen / 29 uebersprungen**, `npm run typecheck` Exit 0, `build:main` und `build:renderer` Exit 0. Kein offener PR.

Alle Zahlen hier sind gemessen, nicht erinnert: die Suite wurde nach dem letzten Merge in einem frischen Worktree auf `origin/main` gefahren.

---

## Was heute auf `main` gelandet ist

| Commit | PR | Inhalt |
|---|---|---|
| `7e02858` | #24 | Flake-Fix: Code-Splitting quellbasiert pruefen statt einen Import stoppen |
| `80dd86f` | #23 | CH-Gateway Policy-Kern (Registry, Klassifikator, Engine, Audit, CH-Endpunkt) |
| `6d8232e` | #25 | Residenz-Policy verkettet, `on-device`, `.env`-Laden |
| `a8a2bdd` | #26 | **P1:** Delegation laeuft durch den Guard |
| `00e7e0b` | #27 | Renderer/Main-Grenze geschlossen und bewacht |
| `d85dd0f` | #28 | Schweizer Endpunkt aus der App konfigurierbar |

Von 1325 auf 1426 Tests. **Kein bestehender Test wurde veraendert.**

**H1 ist erledigt:** Infomaniak-Produkt bestellt, AVV seit 27.08. in Kraft (elektronisch, ohne Unterschrift gueltig — daher `dpaStatus: 'signed'`). Die Modellliste des Kontos fuehrt `swiss-ai/Apertus-v1.5-70B` unter 11 Modellen. Preis 0.70 / 2.50 CHF je 1M Token. Die URL-Form `/2/ai/{product_id}/openai/v1` ist gegen die API verifiziert (401 gegen 404, mit Negativkontrolle).

---

## Was Holger entscheiden muss

**1. Konsolen-Login: Zitadel selbst hosten?**
Technisch passt es — Infomaniak bietet managed Kubernetes und managed PostgreSQL im eigenen Schweizer Rechenzentrum, Zitadel braucht genau das. Der Knackpunkt ist die Lizenz: Community Edition ist **AGPLv3**, die Enterprise-Lizenz existiert laut Zitadel ausdrueklich, um Modifikationen privat zu halten. Unveraendert betreiben ist der gangbare Weg; sobald gepatcht und ueber Netz angeboten wird, greift die Offenlegung.
**Nicht von einem Agenten entscheiden lassen** — das gehoert vor einen Juristen, bevor es in einem Kundenvertrag steht.
Fehlende Zahlen fuer die Entscheidung: Preis der Enterprise-Lizenz, Preis von Infomaniaks Produktions-Kubernetes plus PostgreSQL. Mit beiden ist es eine Rechnung statt einer Abwaegung.
*Blockiert nichts:* die API-Ebene des Gateways braucht Schluessel, kein Login.

**2. Schutzbedarf `'low'` erlaubt jeden Anbieter**, auch `residency: 'unknown'` — also einen mandantenseitig eingetragenen Endpunkt unbekannten Standorts. Spec-konform (§4.2), aber eine Produktzusage. Ein Grenztest in `tests/unit/policy-engine.test.ts` haelt die Stelle fest; verschieben kostet eine Zeile in `DEFAULT_POLICY`.

**3. `residency: 'CH'` ist vertraglich NICHT belegt.** Art. 13.1 des Infomaniak-AVV verbietet Transfers nur *"to countries outside the EU and/or the European Economic Area"* — die Schweiz liegt nicht im EWR, eine Zusage «Daten bleiben in der Schweiz» steht nirgends im Vertrag. Die CH-Residenz stuetzt sich auf den Leistungsbeschrieb. Dazu Art. 5.1: Unterauftragsverarbeiter sind pauschal genehmigt, ihre Liste steht in den Service-AGB. **Wer CH-Residenz verspricht, muss diese Liste kennen.**

---

## Was fertig aussieht, aber Grenzen hat

**Die Residenzschicht ist heute weitgehend deckungsgleich mit der Vertrauensschicht.** Weil Vertrauen aus der Residenz abgeleitet wird, stimmen beide meist ueberein. Sie blockt nur den Fall, in dem ein **expliziter** Vertrauenseintrag einen Anbieter hochstuft, dessen Standort die Policy ablehnt (`tests/unit/routing-guard-wiring.test.ts`, letzter Test). Ihr eigener Beitrag ist der Audit-Eintrag und ein versionierter, deklarativer Regelsatz — nicht zusaetzliche Blockwirkung.

**`bySource` bleibt auf dem Guard-Pfad null.** Die Trefferzahlen je Detektorschicht (Invariante I3) stammen vom Klassifikator des Policy-Kerns, nicht vom Vertrauensklassifikator, der den Guard speist. I3 ist in seiner eigenen Einheit getestet, kommt im Audit-Log aber nicht an.

**`deduplicateEntities` kollabiert I3 an der Quelle.** `src/main/privacy/detector-pipeline.ts` loest ueberlappende Spans nach Quellprioritaet auf und behaelt eine — ein deckungsgleiches `swiss`/`ner`-Paar erreicht `classify()` als EIN Eintrag. Es existiert kein Test ueber die Strecke Pipeline → classify → Audit.

**Die Vollform von I1 ist nicht pruefbar.** Sie verlangt den Credential-Resolver **nach** der Policy; den gibt es erst in Plan 2. Gesichert ist die Vorstufe: Policy vor Router, durch einen Test, der bei Reihenfolgetausch faellt.

**Die Einstellungs-Oberflaeche ist ungetestet.** Das Repo hat keine Komponententests, und es wurde dafuer kein Framework eingefuehrt. Die Logik dahinter — Aufloesung, Registrierung, Entfernung, Validierung — ist vollstaendig getestet.

---

## Naechste Schritte, in dieser Reihenfolge

**1. Plan 2 — Gateway-Dienst.** Mandantenverwaltung, HTTP-API, Credential-Resolver, Ausgabefilterkette. Der Resolver loest ein **Paar** auf, Schluessel plus Produkt-ID: die ID wandert in die Basis-URL (`/2/ai/{product_id}/openai/v1`), ein reiner Schluessel-Resolver kann Infomaniak pro Mandant nicht adressieren. Einstiegspunkte: `src/main/config/infomaniak-config.ts`, `src/main/routing/provider-registry.ts`.

**2. Eignungspruefung gegen Apertus.** Der Zugang steht, die Suite `ch_kmu_v1` ist nie gegen diesen Endpunkt gelaufen. `capabilities` steht bewusst auf dem Unmeasured-Default 0.5 und `models` ist leer — das Angebot verkauft eine Pruefung, also darf die Registry keine Zusage machen. Diese Werte einzutragen ist das Ergebnis der Pruefung, nicht ihre Vorbereitung.

**3. `hybrid-orchestrator.ts` und die Delegation.** Der Guard laeuft jetzt bei der **Ausfuehrung**, nicht beim **Vorschlag** — ein Vorschlag kann also einen Anbieter nennen, den die Ausfuehrung ablehnt. Ehrlich, aber der Nutzer sieht den Vorschlag vorher. Den Guard schon in `analyzeForDelegation` laufen zu lassen waere die freundlichere Variante.

**4. Produkt-ID fuer Endnutzer zu Ende denken.** Sie steht jetzt in den Einstellungen (Privacy-Tab), der Token im Keychain. Offen: ein Weg, den Endpunkt zu **testen**, bevor eine echte Anfrage darauf laeuft — heute erfaehrt ein Nutzer erst beim Senden, ob Token und ID zusammenpassen.

---

## Umgebungsfallen, die diese Session gekostet haben

Diese vier haben je einen Umlauf oder mehr gekostet. Wer hier weiterarbeitet, spart sie sich:

**`git checkout -- <datei>` nach einer Sabotage loescht nicht committete Arbeit.** Es stellt den letzten Commit her, nicht den Zustand vor der Sabotage. Kopie sichern, nicht gegen HEAD zuruecksetzen.

**`cp` laeuft hier mit `-i` als Alias** und lehnt Ueberschreiben still ab («not overwritten»), waehrend der Exit-Code Erfolg suggeriert. Fuer Rueckstellungen `python3 shutil.copyfile` nehmen — und die Sicherung erst loeschen, wenn die Ruecknahme **gemessen** ist.

**`git log --format=%G?` meldet `N` fuer «keine Signatur», auch wenn nur die Verifikation fehlt** (`gpg.ssh.allowedSignersFile` nicht konfiguriert). Die Signatur am Commit-Objekt pruefen: `git cat-file commit HEAD | grep gpgsig`.

**`node_modules` in einem Worktree enthaelt nur `.vite` — die Suite laeuft trotzdem**, weil Node den Verzeichnisbaum hinauf nach `~/mingly/node_modules` aufloest. Ein Worktree **ausserhalb** von `~/mingly` funktioniert deshalb nicht. Ein Agent hat daraus faelschlich «Abhaengigkeiten fehlen» geschlossen.

Dazu die RTK-Regeln aus `RTK.md`, die hier alle zugeschlagen haben: `grep` ueber mehrere Dateien und `git diff` nur ueber `rtk proxy`, und **jeder Nullbefund braucht eine Positivkontrolle im selben Lauf**. Drei Reviewer-Fehlalarme dieser Session waren Abwesenheitsbehauptungen aus unvollstaendiger Lektuere.

---

## Die Lehre, die ueber das Projekt hinausgeht

Die Kette begann als «Zugang holen und eine Modellliste abfragen» und endete bei einem P1. Jeder Schritt legte einen Befund frei, den der vorige verdeckt hatte:

- Der Policy-Kern war fertig — und aus der App nicht erreichbar.
- Die App routete laengst nach Schutzbedarf — nur mit einem zweiten, aelteren System.
- Die Verkettung beider wirkte nicht — der Schweizer Endpunkt wurde behandelt wie ein erfundener Anbietername.
- Und der Orchestrator umging die ganze Kette ohnehin — ohne jeden Guard.

Gefunden wurde davon **nichts durch Nachdenken**. Jedes Mal war es eine Messung, die einer Behauptung widersprach — der eines Agenten so oft wie der eigenen. Wer hier weitermacht, sollte dieselbe Gewohnheit mitbringen: **einen Guard erst glauben, wenn sein Rotlauf stattgefunden hat**, und einen Nullbefund erst, wenn im selben Lauf eine Positivkontrolle angeschlagen hat.
