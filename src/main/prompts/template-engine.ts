import type { TemplateVariable } from '../../shared/types'

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g

/**
 * Extract variable names from a template string.
 * Finds all {{variableName}} patterns.
 */
export function extractVariables(template: string): string[] {
  const variables = new Set<string>()
  let match: RegExpExecArray | null
  const pattern = new RegExp(VARIABLE_PATTERN.source, 'g')
  while ((match = pattern.exec(template)) !== null) {
    variables.add(match[1])
  }
  return Array.from(variables)
}

/**
 * Substitute variables in a template string.
 * Replaces {{variableName}} with values from the provided map.
 * Unresolved variables remain as-is.
 */
export function substituteVariables(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(VARIABLE_PATTERN, (fullMatch, varName) => {
    return values[varName] !== undefined ? values[varName] : fullMatch
  })
}

/**
 * Validate that all required variables have values.
 * Returns an array of missing variable names (empty = valid).
 */
export function validateVariables(
  variables: TemplateVariable[],
  values: Record<string, string>
): string[] {
  const missing: string[] = []
  for (const v of variables) {
    if (v.required && !values[v.name] && !v.defaultValue) {
      missing.push(v.name)
    }
  }
  return missing
}

/**
 * Build a full values map by merging user values with defaults.
 */
export function buildValuesMap(
  variables: TemplateVariable[],
  userValues: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const v of variables) {
    if (userValues[v.name] !== undefined && userValues[v.name] !== '') {
      result[v.name] = userValues[v.name]
    } else if (v.defaultValue) {
      result[v.name] = v.defaultValue
    }
  }
  return result
}

/**
 * Resolve a template: extract variables, merge defaults, substitute.
 */
export function resolveTemplate(
  template: string,
  variables: TemplateVariable[],
  userValues: Record<string, string>
): { result: string; missing: string[] } {
  const values = buildValuesMap(variables, userValues)
  const missing = validateVariables(variables, values)
  const result = substituteVariables(template, values)
  return { result, missing }
}
