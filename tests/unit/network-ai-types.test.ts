/**
 * Network AI Types Tests
 * Tests pure utility functions and constant templates.
 */

import { describe, it, expect } from 'vitest'
import {
  isLocalNetwork,
  buildAPIUrl,
  NETWORK_AI_TEMPLATES
} from '../../src/shared/network-ai-types'
import type { NetworkAIServerConfig } from '../../src/shared/network-ai-types'

describe('isLocalNetwork', () => {
  it('should return true for localhost', () => {
    expect(isLocalNetwork('localhost')).toBe(true)
  })

  it('should return true for 127.0.0.1', () => {
    expect(isLocalNetwork('127.0.0.1')).toBe(true)
  })

  it('should return true for IPv6 loopback', () => {
    expect(isLocalNetwork('::1')).toBe(true)
  })

  it('should return true for 192.168.x.x', () => {
    expect(isLocalNetwork('192.168.1.100')).toBe(true)
    expect(isLocalNetwork('192.168.0.1')).toBe(true)
  })

  it('should return true for 10.x.x.x', () => {
    expect(isLocalNetwork('10.0.0.1')).toBe(true)
    expect(isLocalNetwork('10.255.255.255')).toBe(true)
  })

  it('should return true for 172.16-31.x.x', () => {
    expect(isLocalNetwork('172.16.0.1')).toBe(true)
    expect(isLocalNetwork('172.31.255.255')).toBe(true)
  })

  it('should return false for public IPs', () => {
    expect(isLocalNetwork('8.8.8.8')).toBe(false)
    expect(isLocalNetwork('1.1.1.1')).toBe(false)
    expect(isLocalNetwork('203.0.113.1')).toBe(false)
  })

  it('should return false for hostnames', () => {
    expect(isLocalNetwork('google.com')).toBe(false)
    expect(isLocalNetwork('example.org')).toBe(false)
  })

  it('should return false for 172.15.x.x (not private)', () => {
    expect(isLocalNetwork('172.15.0.1')).toBe(false)
  })

  it('should return false for 172.32.x.x (not private)', () => {
    expect(isLocalNetwork('172.32.0.1')).toBe(false)
  })
})

describe('buildAPIUrl', () => {
  it('should build http URL without basePath', () => {
    const config = {
      protocol: 'http',
      host: 'localhost',
      port: 11434
    } as NetworkAIServerConfig

    expect(buildAPIUrl(config)).toBe('http://localhost:11434')
  })

  it('should build https URL with basePath', () => {
    const config = {
      protocol: 'https',
      host: '192.168.1.100',
      port: 8000,
      basePath: '/v1'
    } as NetworkAIServerConfig

    expect(buildAPIUrl(config)).toBe('https://192.168.1.100:8000/v1')
  })

  it('should handle empty basePath', () => {
    const config = {
      protocol: 'http',
      host: 'ai-server.local',
      port: 5000,
      basePath: undefined
    } as NetworkAIServerConfig

    expect(buildAPIUrl(config)).toBe('http://ai-server.local:5000')
  })
})

describe('NETWORK_AI_TEMPLATES', () => {
  it('should define ollama-local template', () => {
    const tmpl = NETWORK_AI_TEMPLATES['ollama-local']
    expect(tmpl.type).toBe('ollama')
    expect(tmpl.host).toBe('localhost')
    expect(tmpl.port).toBe(11434)
    expect(tmpl.isLocal).toBe(true)
  })

  it('should define ollama-network template', () => {
    const tmpl = NETWORK_AI_TEMPLATES['ollama-network']
    expect(tmpl.type).toBe('ollama')
    expect(tmpl.isLocal).toBe(false)
    expect(tmpl.isLAN).toBe(true)
  })

  it('should define vllm-server template', () => {
    const tmpl = NETWORK_AI_TEMPLATES['vllm-server']
    expect(tmpl.type).toBe('vllm')
    expect(tmpl.port).toBe(8000)
  })

  it('should define text-gen-webui template', () => {
    const tmpl = NETWORK_AI_TEMPLATES['text-gen-webui']
    expect(tmpl.type).toBe('text-generation-webui')
    expect(tmpl.port).toBe(5000)
  })

  it('should define llamacpp-server template', () => {
    const tmpl = NETWORK_AI_TEMPLATES['llamacpp-server']
    expect(tmpl.type).toBe('llamacpp')
    expect(tmpl.port).toBe(8080)
  })

  it('should not require API key for local templates', () => {
    for (const key of Object.keys(NETWORK_AI_TEMPLATES)) {
      const tmpl = NETWORK_AI_TEMPLATES[key]
      expect(tmpl.apiKeyRequired).toBe(false)
    }
  })
})
