/**
 * Shared LLM cost calculator — loads pricing from llm-cost-table.json.
 * Used by Mingly's TrackingEngine and importable by Claude Remote.
 *
 * "Configuration as Data" pattern: prices change faster than code,
 * so the cost table is a JSON file, not hardcoded constants.
 */

import costTableData from './llm-cost-table.json'

// Type for the cost table structure
interface ModelPricing {
  input: number  // USD per 1M input tokens
  output: number // USD per 1M output tokens
}

type CostTable = Record<string, Record<string, ModelPricing>>

// Flatten provider->model structure to a single model->pricing lookup
function buildFlatLookup(table: CostTable): Record<string, ModelPricing> {
  const flat: Record<string, ModelPricing> = {}
  for (const provider of Object.keys(table)) {
    if (provider.startsWith('$') || provider.startsWith('_')) continue // skip meta fields
    const models = table[provider]
    for (const [model, pricing] of Object.entries(models)) {
      flat[model] = pricing as ModelPricing
    }
  }
  return flat
}

const COST_LOOKUP = buildFlatLookup(costTableData as unknown as CostTable)

/**
 * Calculate cost for a given model and token counts.
 * Returns zero cost if model is not found in the cost table.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { inputCost: number; outputCost: number; totalCost: number } {
  const rates = COST_LOOKUP[model]
  if (!rates) {
    return { inputCost: 0, outputCost: 0, totalCost: 0 }
  }

  const inputCost = (inputTokens / 1_000_000) * rates.input
  const outputCost = (outputTokens / 1_000_000) * rates.output
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  }
}

/**
 * Get the flat model->pricing lookup for direct access.
 */
export function getCostTable(): Readonly<Record<string, ModelPricing>> {
  return COST_LOOKUP
}

/**
 * Check if a model has known pricing.
 */
export function hasModelPricing(model: string): boolean {
  return model in COST_LOOKUP
}

export type { ModelPricing, CostTable }
