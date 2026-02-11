# Installation

## Desktop App (Recommended)

### macOS

1. Download the latest `.dmg` file from the [Releases page](https://github.com/mingly-app/mingly/releases)
2. Open the `.dmg` file
3. Drag **Mingly** into the **Applications** folder
4. Launch Mingly from the Launchpad or Finder

> **Note:** On first launch, macOS may ask for a security confirmation. Go to *System Settings > Privacy & Security* and click *Open Anyway*.

### Windows

1. Download the latest `.exe` installer from the [Releases page](https://github.com/mingly-app/mingly/releases)
2. Run the installer
3. Choose the installation directory (default: `C:\Program Files\Mingly`)
4. Mingly will automatically create a desktop shortcut and Start Menu entry
5. Launch Mingly from the shortcut

## From Source

Prerequisites:
- Node.js 18 or later
- npm 9 or later

```bash
git clone https://github.com/mingly-app/mingly.git
cd mingly
npm install
npm run dev
```

The app will start automatically in development mode.

### Create Production Build

```bash
npm run build
npm run dist
```

The installer will be created in the `release/` directory.

## Docker (Server Mode)

For running as a headless server without a desktop UI:

```bash
git clone https://github.com/mingly-app/mingly.git
cd mingly
docker compose up -d
```

Three services will start:
- **Mingly Server** on port 3939
- **Qdrant** (vector database) on port 6333
- **RAG Server** (embeddings) on port 8001

Check the status:

```bash
curl http://localhost:3939/health
```

## System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| OS | macOS 12+ / Windows 10+ | macOS 14+ / Windows 11 |
| RAM | 4 GB | 8 GB |
| Disk Space | 500 MB | 2 GB (with local models) |
| Node.js | 18.x | 20.x (source install only) |

## Next Steps

After installation, the **Setup Wizard** will start automatically. It guides you through:

1. Language selection (English/German)
2. API key configuration
3. Deployment mode selection
4. Optional knowledge base setup

Next: [Configuration](CONFIGURATION.md)
