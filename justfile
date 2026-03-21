# Mingly — Multi-LLM Desktop App (Swiss AI Privacy)
# Electron + React + TypeScript

# === Standard Tasks ===
setup:
    npm install

dev:
    npx concurrently "npm run dev:vite" "npm run dev:electron"

dev-vite:
    npm run dev:vite

dev-electron:
    npm run build:preload && npx wait-on http://localhost:5173 && npx electron .

# === Quality Gate ===
tier1:
    npx tsc --noEmit
    npx tsc -p tsconfig.main.json --noEmit

tier2:
    npx vitest run

test: tier1 tier2

test-all: tier1 tier2 tier3

tier3:
    npx promptfoo eval --config tests/red-team/promptfooconfig.yaml

# === Build ===
build:
    npm run build

build-main:
    npm run build:main

build-preload:
    npm run build:preload

build-renderer:
    npm run build:renderer

# === Package ===
package:
    npm run build && npx electron-builder -m

# === Health ===
health:
    @echo "Desktop app — no health endpoint. Run 'just dev' to start."

# === Red Team ===
red-team: tier3

red-team-view:
    npx promptfoo view --config tests/red-team/promptfooconfig.yaml

# === Coverage ===
coverage:
    npx vitest run --coverage
