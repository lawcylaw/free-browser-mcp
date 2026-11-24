const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.SERVER_PORT || process.env.PORT || '25975';
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const PLAYWRIGHT_CACHE = path.join(process.env.HOME || __dirname, '.cache', 'ms-playwright');

fs.mkdirSync(USER_DATA_DIR, { recursive: true });

function hasChromium() {
  if (fs.existsSync(PLAYWRIGHT_CACHE)) {
    const entries = fs.readdirSync(PLAYWRIGHT_CACHE);
    if (entries.some((e) => e.startsWith('chromium'))) {
      return true;
    }
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].some((p) =>
    fs.existsSync(p)
  );
}

if (!hasChromium()) {
  console.log('[free-browser-mcp] Chromium not found, installing via playwright...');
  try {
    execSync('npx --no-install playwright install chromium', {
      stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_CACHE },
    });
  } catch (err) {
    console.error('[free-browser-mcp] Failed to install Chromium:', err.message);
  }
}

const headlessFlag = process.env.DISPLAY ? '' : ' --headless';
const mcpCmd = `npx --no-install @playwright/mcp${headlessFlag} --no-sandbox --user-data-dir ${USER_DATA_DIR} --viewport-size 1280,800`;

console.log(`[free-browser-mcp] Starting supergateway on port ${PORT}...`);
console.log(`[free-browser-mcp] MCP command: ${mcpCmd}`);

const child = spawn(
  'npx',
  [
    '--no-install',
    'supergateway',
    '--stdio',
    mcpCmd,
    '--port',
    PORT,
    '--ssePath',
    '/sse',
    '--messagePath',
    '/message',
    '--healthEndpoint',
    '/health',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_CACHE },
  }
);

child.on('exit', (code, signal) => {
  console.log(`[free-browser-mcp] supergateway exited with code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
