/**
 * Compares candidate NER models on the ground-truth battery.
 *
 * Usage:  npx tsx scripts/ner-eval/run.ts <modelId> [dtype]
 *
 * Downloads into the same cache the app uses (~/.mingly/models) with remote
 * models ENABLED — that is an evaluation-only deviation; production keeps
 * `env.allowRemoteModels = false` (see model-manager.ts).
 *
 * Writes a machine-readable summary line and a human table. Always run with
 * output redirected to a file: a model worker can keep the event loop alive.
 */
import os from 'os'
import path from 'path'
import fs from 'fs'
import { BATTERY, PERSON_LABELS, ADDRESS_LABELS, LOCATION_LABELS, DOB_LABELS } from './battery'

const CACHE = path.join(os.homedir(), '.mingly', 'models')

/** Strip sub-word markers so a token can be compared against plain text. */
function normaliseWord(w: string): string {
  return String(w).replace(/^##/, '').replace(/^▁/, '').replace(/^\s+/, '').toLowerCase()
}

function labelOf(tok: any): string {
  return String(tok.entity ?? tok.entity_group ?? '').toUpperCase()
}

/** Bare label without B-/I- prefix, for the *_LABELS sets. */
function bare(label: string): string {
  return label.replace(/^[BI]-/, '')
}

function isIn(set: Set<string>, label: string): boolean {
  return set.has(label) || set.has(bare(label))
}

async function main() {
  const modelId = process.argv[2]
  const dtype = (process.argv[3] || 'fp32') as any
  if (!modelId) { console.log('usage: run.ts <modelId> [dtype]'); process.exit(2) }

  const tf: any = await import('@huggingface/transformers')
  tf.env.cacheDir = CACHE
  tf.env.allowRemoteModels = true // evaluation only

  const t0 = Date.now()
  const pipe: any = await tf.pipeline('token-classification', modelId, { dtype })
  const loadMs = Date.now() - t0

  console.log(`MODELL   : ${modelId}  (dtype=${dtype})`)
  console.log(`LADEZEIT : ${loadMs} ms`)
  const labels = Object.values(pipe.model?.config?.id2label ?? {})
  console.log(`LABELS   : ${JSON.stringify(labels)}`)
  console.log('')

  let personsExpected = 0, personsFound = 0, falsePersons = 0
  let addrExpected = 0, addrFound = 0
  let locExpected = 0, locFound = 0
  let dobExpected = 0, dobFound = 0
  let totalInferMs = 0

  for (const c of BATTERY) {
    const t1 = Date.now()
    const raw = await pipe(c.text, { ignore_labels: [] })
    totalInferMs += Date.now() - t1

    const hits = raw.filter((r: any) => labelOf(r) !== 'O' && labelOf(r) !== '')
    const personToks = hits.filter((r: any) => isIn(PERSON_LABELS, labelOf(r)))

    // Recall per expected name: at least one person-token that is part of it.
    const foundNames = c.persons.filter(name => {
      const needle = name.toLowerCase()
      return personToks.some((t: any) => {
        const w = normaliseWord(t.word)
        return w.length > 1 && needle.includes(w)
      })
    })
    personsExpected += c.persons.length
    personsFound += foundNames.length

    // False positives: person-token that belongs to no expected name.
    const fp = personToks.filter((t: any) => {
      const w = normaliseWord(t.word)
      return w.length > 1 && !c.persons.some(n => n.toLowerCase().includes(w))
    })
    falsePersons += fp.length

    const countCat = (exp: string[] | undefined, set: Set<string>) => {
      if (!exp?.length) return [0, 0] as const
      const toks = hits.filter((r: any) => isIn(set, labelOf(r)))
      const found = exp.filter(e => toks.some((t: any) => {
        const w = normaliseWord(t.word)
        return w.length > 1 && e.toLowerCase().includes(w)
      }))
      return [exp.length, found.length] as const
    }
    const [ae, af] = countCat(c.alsoExpected?.address, ADDRESS_LABELS); addrExpected += ae; addrFound += af
    const [le, lf] = countCat(c.alsoExpected?.location, LOCATION_LABELS); locExpected += le; locFound += lf
    const [de, df] = countCat(c.alsoExpected?.dob, DOB_LABELS); dobExpected += de; dobFound += df

    const mark = c.persons.length === 0
      ? (fp.length === 0 ? '✓' : '✗ FEHLALARM')
      : (foundNames.length === c.persons.length ? '✓' : `✗ ${foundNames.length}/${c.persons.length}`)
    console.log(`${mark}  ${JSON.stringify(c.text).slice(0, 70)}`)
    console.log(`     -> ${JSON.stringify(hits.map((r: any) => bare(labelOf(r)) + ':' + String(r.word).trim()))}`)
  }

  const dir = path.join(CACHE, ...modelId.split('/'))
  let sizeMb = 0
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name)
      if (e.isDirectory()) walk(full); else sizeMb += fs.statSync(full).size / 1e6
    }
  }
  try { walk(dir) } catch { /* size is informational */ }

  console.log('')
  console.log('SUMMARY ' + JSON.stringify({
    model: modelId, dtype,
    persons: `${personsFound}/${personsExpected}`,
    falsePersons,
    address: `${addrFound}/${addrExpected}`,
    location: `${locFound}/${locExpected}`,
    dob: `${dobFound}/${dobExpected}`,
    loadMs, avgInferMs: Math.round(totalInferMs / BATTERY.length),
    sizeMb: Math.round(sizeMb)
  }))
  if (pipe.dispose) await pipe.dispose()
}

main().then(() => { console.log('DONE'); process.exit(0) })
  .catch(e => { console.log('THREW: ' + (e?.message ?? e)); process.exit(2) })
