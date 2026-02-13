/**
 * MCP Input Sanitizer
 *
 * Validates and sanitizes command, args, and env vars before
 * spawning MCP server child processes to prevent command injection.
 */

// Allowed command executables (whitelist approach)
const ALLOWED_COMMANDS = new Set([
  'node', 'npx', 'python', 'python3', 'pip', 'pip3',
  'uvx', 'uv', 'deno', 'bun', 'bunx',
  'docker', 'podman',
  'cargo', 'go',
])

// Dangerous shell metacharacters that could enable injection
const SHELL_METACHAR_PATTERN = /[;&|`$(){}!<>]/

// Dangerous env var names that could alter process behavior
const BLOCKED_ENV_KEYS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE',
  'PYTHONSTARTUP', 'PYTHONPATH',
  'JAVA_TOOL_OPTIONS', 'JAVA_OPTIONS', '_JAVA_OPTIONS',
  'PERLLIB', 'PERL5LIB', 'PERL5OPT',
  'RUBYOPT', 'RUBYLIB',
  'GCONV_PATH', 'GETCONF_DIR',
  'BASH_ENV', 'ENV', 'CDPATH',
  'PROMPT_COMMAND',
])

// Safe directories for absolute paths (platform-aware)
const SAFE_COMMAND_DIRS = [
  '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/',
  '/usr/sbin/', '/usr/local/sbin/',
  '/bin/', '/sbin/',
]

// Max argument length to prevent excessively long payloads
const MAX_ARG_LENGTH = 4096

export interface SanitizeResult {
  valid: boolean
  error?: string
}

/**
 * Validate a command name before spawning.
 * Must be a known executable or an absolute/relative path to a script.
 */
export function validateCommand(command: string): SanitizeResult {
  if (!command || command.trim().length === 0) {
    return { valid: false, error: 'Command cannot be empty' }
  }

  const trimmed = command.trim()

  // Block shell metacharacters in the command itself
  if (SHELL_METACHAR_PATTERN.test(trimmed)) {
    return { valid: false, error: `Command contains dangerous characters: ${trimmed}` }
  }

  // Extract base command name (handle paths like /usr/bin/python3)
  const baseName = trimmed.split('/').pop()?.split('\\').pop() || ''

  // Allow whitelisted commands
  if (ALLOWED_COMMANDS.has(baseName)) {
    return { valid: true }
  }

  // Allow absolute paths only from safe directories
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || /^[A-Z]:\\/.test(trimmed)) {
    const resolved = trimmed.startsWith('~')
      ? trimmed // tilde paths resolve at spawn time; validate structure only
      : trimmed
    const inSafeDir = SAFE_COMMAND_DIRS.some(dir => resolved.startsWith(dir))
    if (!inSafeDir && !trimmed.startsWith('~')) {
      return {
        valid: false,
        error: `Absolute path "${trimmed}" is outside safe directories. Allowed: ${SAFE_COMMAND_DIRS.join(', ')}`
      }
    }
    return { valid: true }
  }

  // Allow npx/bunx package runners — validate package name
  if (trimmed.startsWith('npx ') || trimmed.startsWith('bunx ')) {
    const packagePart = trimmed.slice(trimmed.indexOf(' ') + 1).trim()
    // Package names: @scope/name or name, optionally @version
    if (!/^(@[\w-]+\/)?[\w.-]+(@[\w.-]+)?$/.test(packagePart)) {
      return {
        valid: false,
        error: `Package name "${packagePart}" contains invalid characters. Only alphanumeric, hyphens, dots, and scoped packages are allowed.`
      }
    }
    return { valid: true }
  }

  return {
    valid: false,
    error: `Command "${baseName}" is not in the allowed list. Allowed: ${Array.from(ALLOWED_COMMANDS).join(', ')}`
  }
}

/**
 * Validate arguments array - no shell metacharacters allowed.
 */
export function validateArgs(args: string[]): SanitizeResult {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg.length > MAX_ARG_LENGTH) {
      return {
        valid: false,
        error: `Argument ${i} exceeds maximum length of ${MAX_ARG_LENGTH} characters`
      }
    }

    if (SHELL_METACHAR_PATTERN.test(arg)) {
      return {
        valid: false,
        error: `Argument ${i} contains dangerous characters: "${arg}"`
      }
    }
  }
  return { valid: true }
}

/**
 * Validate environment variables.
 * Blocks dangerous keys that could alter process loading behavior.
 */
export function validateEnv(env: Record<string, string>): SanitizeResult {
  for (const [key, value] of Object.entries(env)) {
    // Block dangerous env var names
    const upperKey = key.toUpperCase()
    if (BLOCKED_ENV_KEYS.has(upperKey)) {
      return {
        valid: false,
        error: `Environment variable "${key}" is blocked for security reasons`
      }
    }

    // Block shell metacharacters in env values
    if (SHELL_METACHAR_PATTERN.test(value)) {
      return {
        valid: false,
        error: `Environment variable "${key}" contains dangerous characters in its value`
      }
    }
  }
  return { valid: true }
}

/**
 * Validate a complete MCP server configuration before spawning.
 */
export function validateMCPConfig(config: {
  command: string
  args?: string[]
  env?: Record<string, string>
}): SanitizeResult {
  const cmdResult = validateCommand(config.command)
  if (!cmdResult.valid) return cmdResult

  if (config.args) {
    const argsResult = validateArgs(config.args)
    if (!argsResult.valid) return argsResult
  }

  if (config.env) {
    const envResult = validateEnv(config.env)
    if (!envResult.valid) return envResult
  }

  return { valid: true }
}
