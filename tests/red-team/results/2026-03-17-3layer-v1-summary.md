# Red-Team Run v3 — 3-Layer (Regex+Swiss+NER) — 2026-03-17

## Score

| Mode | Passed | Failed | Total | Rate |
|------|--------|--------|-------|------|
| **2-Layer (Regex+Swiss)** | 115 | 28 | 143 | 80.4% |
| **3-Layer (Regex+Swiss+NER)** | 113 | 20 | 133 | **84.9%** |

> 3-Layer suite excludes Rehydration tests (run only in 2-Layer).

## NER Impact

### Fixed by NER (+7 tests vs 2-Layer NER Degradation baseline)

| Test | Category | Note |
|------|----------|------|
| surname-only | PERSON | NER detects isolated surnames |
| abbreviated-first-name | PERSON | "H. Mueller" now detected |
| compound-name-with-title | PERSON | "Prof. Dr. Hans Mueller" |
| umlaut-compound-surname | PERSON | "Mueller-Haefliger" |
| hyphenated-surname | PERSON | NER handles hyphens |
| id-number | PASSPORT | NER maps IDCARDNUM label |
| decomposed-umlaut | PERSON | NFC preprocessor + NER |

### Still failing with NER (7 tests)

| Test | Category | Root Cause |
|------|----------|------------|
| name-only-no-context | PERSON | "Hans Mueller" without context — piiranha-v1 needs more context |
| multiple-names | PERSON | Multiple names in one sentence — token merge loses some |
| title-abbreviated | PERSON | "Dr. H. Mueller" — abbreviated given name confuses NER |
| apostrophe-in-name | PERSON | "O'Brien" — tokenizer splits at apostrophe |
| company-with-suffix | ORGANIZATION | piiranha-v1 has no ORG label |
| institution-name | ORGANIZATION | piiranha-v1 has no ORG label |
| standard-passport | PASSPORT | Free-form passport numbers not in training data |

## Dedup Fix (Critical)

**Problem found:** The dedup rule "NER > Regex" was too aggressive. NER detects
PERSON/CUSTOM entities overlapping regex EMAIL/PHONE matches, dropping the
structural entities.

**Fix:** Introduced `REGEX_STRUCTURAL_CATEGORIES` — regex entities of types EMAIL,
PHONE, CREDIT_CARD, IP_ADDRESS, URL, IBAN, AHV, DATE_OF_BIRTH are never
overridden by NER. Instead, NER + regex entities with different categories on the
same span **co-exist** (e.g., PERSON + EMAIL on `hans@test.ch`).

**Impact:** Fixed 9 regressions that appeared when NER was enabled.

## Remaining 20 Failures — Categorization

### MEDIUM/LOW Backlog (same as 2-Layer, 10 tests)

| Tier | Count | Tests |
|------|-------|-------|
| MEDIUM | 8 | base64 x2, cyrillic-e-homoglyph, html-entity-at, html-named-entity, fullwidth-at, space-between-chars, at-dot-words |
| LOW | 2 | reversed, concatenation-trick |

### NER Limitations (7 tests)

See "Still failing with NER" table above. piiranha-v1 does not cover ORG labels
and struggles with minimal-context names and apostrophes.

### Language Mixing (3 tests)

| Test | Missing | Note |
|------|---------|------|
| test [high] | PASSPORT | Passport numbers in mixed-language context |
| test [medium] | AGE | Age detection not implemented |
| test [high] | PASSPORT + DOB | Compound assertion, PASSPORT missing |

## How to Run

```bash
# 2-Layer only (fast, ~2s)
npx vitest run tests/red-team/red-team.test.ts

# 3-Layer with NER (~8s, needs piiranha-v1 model on disk)
RUN_3LAYER=1 npx vitest run tests/red-team/red-team.test.ts
```

## Files Changed

| File | Change |
|------|--------|
| `tests/red-team/helpers/direct-ner-detector.ts` | NEW — Direct NER detector for test context |
| `tests/red-team/red-team.test.ts` | 3-Layer test suites + import |
| `src/main/privacy/detector-pipeline.ts` | Dedup fix: structural category protection + co-existence |
