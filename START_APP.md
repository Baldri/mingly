# Mingly - Developer Quick Start

## Start the App

```bash
cd /path/to/mingly
npm install
npm run dev
```

The Electron app opens automatically with the Vite dev server on `http://localhost:5173`.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start in development mode (Vite + Electron) |
| `npm run build` | Build for production |
| `npm run dist` | Create platform installer |
| `npm run test` | Run test suite |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | Lint source files |
| `npm run build:server` | Build headless server variant |
| `npm run start:server` | Start headless server |

## Stop the App

```bash
# In the terminal where npm run dev is running:
Ctrl + C
```

## Troubleshooting

### Port conflict

```bash
lsof -ti:5173 | xargs kill -9
npm run dev
```

### Module not found

```bash
rm -rf node_modules dist
npm install
npm run dev
```

### TypeScript errors

```bash
npm run typecheck
```

## Project Structure

```
src/
  main/          # Electron main process
  renderer/      # React frontend
  preload/       # IPC bridge
  shared/        # Shared types and utilities
  server/        # Headless server entry point
```

## Documentation

- [User Guide (EN)](docs/en/INSTALLATION.md)
- [Benutzerhandbuch (DE)](docs/de/INSTALLATION.md)
- [Contributing](CONTRIBUTING.md)
