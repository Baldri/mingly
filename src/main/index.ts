import { app, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { registerIPCHandlers } from './ipc-handlers'
import { initializeDatabase, closeDatabase } from './database'
import { getMCPClientManager } from './mcp/mcp-client-manager'
import { getDeploymentManager } from './server/deployment-manager'
import { getLocalAIBridge } from './network/local-ai-bridge'
import { getDocMindIntegration } from './integrations/docmind-integration'
import { getAutoUpdater } from './updater/auto-updater'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Mingly',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Required for keytar — cannot enable
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    backgroundColor: '#ffffff',
    show: false
  })

  // Show window when ready to prevent flicker
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Prevent DevTools in production
  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools()
    })
  }

  // Block navigation to external URLs (prevents navigation-based attacks)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigins = ['http://localhost:5173', 'file://']
    if (!allowedOrigins.some(origin => url.startsWith(origin))) {
      event.preventDefault()
      console.warn(`[Security] Blocked navigation to: ${url}`)
    }
  })

  // Block new window creation (popup attacks)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[Security] Blocked window.open to: ${url}`)
    return { action: 'deny' }
  })

  // Load the app
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// App lifecycle
app.whenReady().then(async () => {
  // Set app name for macOS dock and menu bar
  if (process.platform === 'darwin') {
    app.setName('Mingly')
  }

  // Initialize database (sql.js / WASM)
  try {
    await initializeDatabase()
    console.log('Database initialized successfully')
  } catch (error) {
    console.error('Failed to initialize database:', error)
  }

  // Register all IPC handlers
  await registerIPCHandlers()

  // Initialize deployment manager (auto-starts server if in server mode)
  try {
    await getDeploymentManager().initialize()
  } catch (error) {
    console.error('Failed to initialize deployment manager:', error)
  }

  // Initialize local AI bridge (registers network AI servers as chat providers)
  try {
    await getLocalAIBridge().initialize()
  } catch (error) {
    console.error('Failed to initialize local AI bridge:', error)
  }

  // Initialize DocMind integration (MCP + REST + Context Injection)
  try {
    const docMindResult = await getDocMindIntegration().initialize()
    console.log('DocMind integration initialized:', docMindResult)
  } catch (error) {
    console.error('Failed to initialize DocMind integration (non-blocking):', error)
  }

  // Set Content Security Policy headers — stricter in production
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
  const connectSrc = isDev
    ? "'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com http://localhost:* http://127.0.0.1:* ws://localhost:*"
    : "'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com http://localhost:* http://127.0.0.1:*"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ${connectSrc}; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
        ]
      }
    })
  })

  createWindow()

  // Initialize auto-updater (after window is created)
  if (mainWindow) {
    const updater = getAutoUpdater()
    updater.setWindow(mainWindow)
    updater.initialize()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  getAutoUpdater().shutdown()
  getLocalAIBridge().shutdown()
  await getDocMindIntegration().disconnectMCP()
  await getDeploymentManager().shutdown()
  await getMCPClientManager().shutdown()
  closeDatabase()
})

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
