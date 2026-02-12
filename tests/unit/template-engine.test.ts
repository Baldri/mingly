/**
 * Template Engine Tests
 * Tests variable extraction, substitution, validation, and resolution.
 */

import { describe, it, expect } from 'vitest'
import {
  extractVariables,
  substituteVariables,
  validateVariables,
  buildValuesMap,
  resolveTemplate
} from '../../src/main/prompts/template-engine'
import type { TemplateVariable } from '../../src/shared/types'

describe('Template Engine', () => {
  describe('extractVariables', () => {
    it('should extract single variable', () => {
      expect(extractVariables('Hello {{name}}')).toEqual(['name'])
    })

    it('should extract multiple variables', () => {
      const vars = extractVariables('{{greeting}} {{name}}, welcome to {{place}}')
      expect(vars).toEqual(['greeting', 'name', 'place'])
    })

    it('should deduplicate repeated variables', () => {
      const vars = extractVariables('{{name}} and {{name}} again')
      expect(vars).toEqual(['name'])
    })

    it('should return empty array for no variables', () => {
      expect(extractVariables('No variables here')).toEqual([])
    })

    it('should handle empty string', () => {
      expect(extractVariables('')).toEqual([])
    })

    it('should not match single braces', () => {
      expect(extractVariables('{name}')).toEqual([])
    })

    it('should not match triple braces', () => {
      expect(extractVariables('{{{name}}}')).toEqual(['name'])
    })
  })

  describe('substituteVariables', () => {
    it('should replace a single variable', () => {
      expect(substituteVariables('Hello {{name}}', { name: 'World' })).toBe('Hello World')
    })

    it('should replace multiple variables', () => {
      const result = substituteVariables(
        '{{greeting}} {{name}}!',
        { greeting: 'Hi', name: 'Alice' }
      )
      expect(result).toBe('Hi Alice!')
    })

    it('should leave unresolved variables as-is', () => {
      expect(substituteVariables('Hello {{name}}', {})).toBe('Hello {{name}}')
    })

    it('should handle mixed resolved and unresolved', () => {
      const result = substituteVariables(
        '{{a}} and {{b}}',
        { a: 'resolved' }
      )
      expect(result).toBe('resolved and {{b}}')
    })

    it('should handle empty values', () => {
      expect(substituteVariables('Hello {{name}}', { name: '' })).toBe('Hello ')
    })

    it('should handle no variables in template', () => {
      expect(substituteVariables('No vars', { name: 'test' })).toBe('No vars')
    })
  })

  describe('validateVariables', () => {
    const variables: TemplateVariable[] = [
      { name: 'language', label: 'Language', required: true },
      { name: 'style', label: 'Style', required: false },
      { name: 'framework', label: 'Framework', required: true, defaultValue: 'React' }
    ]

    it('should return empty array when all required have values', () => {
      const missing = validateVariables(variables, { language: 'TypeScript', framework: 'Vue' })
      expect(missing).toEqual([])
    })

    it('should report missing required without defaults', () => {
      const missing = validateVariables(variables, {})
      expect(missing).toEqual(['language'])
    })

    it('should not report required with defaults', () => {
      const missing = validateVariables(variables, {})
      expect(missing).not.toContain('framework')
    })

    it('should not report optional as missing', () => {
      const missing = validateVariables(variables, { language: 'JS' })
      expect(missing).not.toContain('style')
    })

    it('should handle empty variables array', () => {
      expect(validateVariables([], {})).toEqual([])
    })
  })

  describe('buildValuesMap', () => {
    const variables: TemplateVariable[] = [
      { name: 'language', label: 'Language', defaultValue: 'TypeScript', required: false },
      { name: 'style', label: 'Style', required: false }
    ]

    it('should use user values when provided', () => {
      const result = buildValuesMap(variables, { language: 'Python' })
      expect(result.language).toBe('Python')
    })

    it('should fall back to defaults', () => {
      const result = buildValuesMap(variables, {})
      expect(result.language).toBe('TypeScript')
    })

    it('should not include variables without values or defaults', () => {
      const result = buildValuesMap(variables, {})
      expect(result.style).toBeUndefined()
    })

    it('should prefer user value over default', () => {
      const result = buildValuesMap(variables, { language: 'Rust' })
      expect(result.language).toBe('Rust')
    })
  })

  describe('resolveTemplate', () => {
    const variables: TemplateVariable[] = [
      { name: 'language', label: 'Language', defaultValue: 'TypeScript', required: false },
      { name: 'topic', label: 'Topic', required: true }
    ]

    it('should resolve template with all values', () => {
      const { result, missing } = resolveTemplate(
        'Help me with {{language}} and {{topic}}',
        variables,
        { topic: 'testing' }
      )
      expect(result).toBe('Help me with TypeScript and testing')
      expect(missing).toEqual([])
    })

    it('should report missing required variables', () => {
      const { missing } = resolveTemplate(
        'Help me with {{topic}}',
        variables,
        {}
      )
      expect(missing).toContain('topic')
    })

    it('should still substitute what it can even with missing', () => {
      const { result } = resolveTemplate(
        '{{language}} and {{topic}}',
        variables,
        {}
      )
      expect(result).toBe('TypeScript and {{topic}}')
    })
  })
})
