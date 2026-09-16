/**
 * Desktop shell.
 *
 * The app is a local Next.js server plus a window pointed at it. Electron owns
 * both, which is what makes packaging worthwhile: its bundled Chromium is also
 * the browser we will use to capture an ESPN sign-in, so there is no second
 * browser engine to ship. Driving that with Playwright instead would add a
 * ~433 MB Chromium download on top of this one.
 *
 * Three things this file is careful about:
 *   - The server binds loopback on a port chosen at runtime, so two copies of
 *     the app never collide and nothing is exposed to the network.
 *   - Credentials live under Electron's userData directory, not next to the
 *     executable, so an upgrade or reinstall does not discard them.
 *   - The server child is killed on every exit path, including a hard quit.
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const { fork } = require('node:child_process');
const { createServer } = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Set the name before anything reads a user path.
 *
 * Electron derives userData from the npm `name` field, which here is the scoped
 * workspace name `@ds-nfl/desktop` — that produces a nested
 * %APPDATA%\@ds-nfl\desktop directory. Pinning it keeps the credential store at
 * a stable, predictable location regardless of how the package is named.
 */
app.setName('ds-nfl');

const isPackaged = app.isPackaged;

/**
 * Where the staged Next standalone build lives.
 *
 * The whole standalone tree is copied verbatim rather than flattened, because
 * server.js resolves node_modules relative to the workspace root above it.
 */
function serverEntry() {
  const root = isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, 'resources', 'server');
  return path.join(root, 'apps', 'web', 'server.js');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
      if (res.status > 0) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let serverProcess = null;
let mainWindow = null;

function startServer(port) {
  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Server build not found at ${entry}. Run "npm run stage" in apps/desktop first.`,
    );
  }

  serverProcess = fork(entry, [], {
    cwd: path.dirname(entry),
    env: {
      ...process.env,
      // Runs the Electron binary as plain Node for this child.
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      // Keep league credentials with the user's data, not beside the binary.
      DS_NFL_CREDENTIALS: path.join(app.getPath('userData'), 'credentials.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => {
    serverProcess = null;
    // If the server dies while the window is open, the app is useless; say so
    // rather than leaving a blank window.
    if (mainWindow && !mainWindow.isDestroyed() && code !== 0) {
      dialog.showErrorBox('ds-nfl stopped', `The local server exited with code ${code}.`);
      app.quit();
    }
  });
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e1116', // matches the dark theme ground, so no white flash
    title: 'ds-nfl',
    webPreferences: {
      // The page is our own local server, but there is no reason for it to have
      // Node privileges, so it does not get them.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External links open in the real browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const port = await findFreePort();
  startServer(port);

  if (!(await waitForServer(port))) {
    dialog.showErrorBox('ds-nfl could not start', 'The local server did not respond in time.');
    app.quit();
    return;
  }

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

// One instance only; a second launch focuses the existing window instead of
// starting a second server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow().catch((err) => {
      dialog.showErrorBox('ds-nfl failed to start', String(err?.message ?? err));
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    stopServer();
    if (process.platform !== 'darwin') app.quit();
  });

  // Covers quit paths that skip window-all-closed.
  app.on('before-quit', stopServer);
  process.on('exit', stopServer);
}
