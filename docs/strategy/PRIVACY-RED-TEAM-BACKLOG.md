# Privacy Red-Team Backlog

Living Document — nicht umgesetzte Szenarien, Ideen, zukuenftige Angriffsvektoren.

## Nicht umgesetzte Szenarien (Phase 7b.5)

### Hohe Prioritaet
- [ ] LLM-generierte Attacks via promptfoo redteam Plugin (Phase B, Teil 2)
- [ ] Multi-Provider Tests (Claude + GPT-4 + lokales LLM)
- [ ] Cross-Session Rehydration-Tests (Session A → Session B)
- [ ] Platzhalter-Format Haertung (kryptische Tokens statt Fake-Namen)
- [ ] Response-Validation: LLM-Response vor Rehydration auf PII scannen
- [ ] Fake-Name Collision: User-Input enthaelt zufaellig denselben Text wie generierter Fake-Wert

### Mittlere Prioritaet
- [ ] Base64-Dekodierung in Pipeline (Pre-Processing Layer)
- [ ] URL-Encoding-Dekodierung in Pipeline
- [ ] HTML-Entity-Dekodierung in Pipeline
- [ ] Zero-Width-Character-Stripping vor Detection
- [ ] Unicode-Normalisierung (NFC) vor Detection
- [ ] IBAN Mod97-Validierung bei Fake-Generierung
- [ ] NER-Retry bei Timeout (einmal, mit reduziertem Text)
- [ ] Testdaten-Generator fuer checksum-valide AHV/IBAN

### Niedrige Prioritaet
- [ ] Raetoromanisch (RM) NER-Support
- [ ] Leetspeak-Normalisierung
- [ ] Reversed-Text-Detection
- [ ] Emoji-Digit-Normalisierung
- [ ] Audio/Bild PII (OCR, Speech-to-Text)

## Ideen fuer zukuenftige Runden

### Runde 2: Advanced Attacks
- Adversarial ML: Inputs die NER-Modell gezielt taeuschen
- Timing Attacks: NER-Latenz als Indikator fuer PII-Praesenz
- Side-Channel: Token-Count-Unterschied zwischen anonymisiert/original
- Multi-Modal: PII in Bildern die als Text beschrieben werden
- Fake-Data Fingerprinting: Statistisches Pattern in generierten Fake-Daten

### Runde 3: Compliance
- GDPR Art. 17 (Recht auf Loeschung) — Session-Map Persistence
- nDSG Konformitaet — Logging von PII-Detektionen
- Audit Trail — wer hat wann welche PII gesehen

### Runde 4: Production
- Rate Limiting bei PII-intensiven Requests
- Alert bei ungewoehnlich vielen PII-Leaks
- A/B Testing verschiedener Anonymisierungs-Strategien
- User-Feedback Loop: False Positive/Negative Reporting

## Neue Angriffsvektoren (Community/Forschung)

_Hier werden neue Vektoren dokumentiert sobald sie bekannt werden._

---

Letzte Aktualisierung: 2026-03-16
