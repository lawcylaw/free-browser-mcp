const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

const PORT = process.env.SERVER_PORT || process.env.PORT || '25975';
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const PLAYWRIGHT_CACHE = path.join(__dirname, '.cache', 'ms-playwright');
const TMP_DIR = path.join(__dirname, 'tmp');
const BIN_DIR = path.join(__dirname, 'bin');
const CLOUDFLARED_BIN = path.join(BIN_DIR, 'cloudflared');

fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(PLAYWRIGHT_CACHE, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

const childEnv = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_CACHE,
  TMPDIR: TMP_DIR,
  TEMP: TMP_DIR,
  TMP: TMP_DIR,
};

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

async function ensureCloudflared() {
  if (fs.existsSync(CLOUDFLARED_BIN)) return true;
  const asset =
    process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  console.log(`[free-browser-mcp] Downloading cloudflared from ${url}...`);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const fileStream = fs.createWriteStream(CLOUDFLARED_BIN);
    await finished(Readable.fromWeb(res.body).pipe(fileStream));
    fs.chmodSync(CLOUDFLARED_BIN, 0o755);
    console.log('[free-browser-mcp] cloudflared downloaded.');
    return true;
  } catch (err) {
    console.error('[free-browser-mcp] Failed to download cloudflared:', err.message);
    return false;
  }
}

function startCloudflared() {
  const cf = spawn(
    CLOUDFLARED_BIN,
    ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let printed = false;
  const handleOutput = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !printed) {
      printed = true;
      const baseUrl = match[0];
      console.log('\n==================================================');
      console.log(`[free-browser-mcp] HTTPS MCP SSE URL: ${baseUrl}/sse`);
      console.log(`[free-browser-mcp] HTTPS Health URL:  ${baseUrl}/health`);
      console.log('==================================================\n');
    }
  };

  cf.stdout.on('data', handleOutput);
  cf.stderr.on('data', handleOutput);
  cf.on('exit', (code) => {
    console.log(`[free-browser-mcp] cloudflared exited with code=${code}`);
  });
  return cf;
}

async function main() {
  let cfChild = null;
  if (await ensureCloudflared()) {
    cfChild = startCloudflared();
  }

  if (!hasChromium()) {
    console.log('[free-browser-mcp] Chromium not found, installing via playwright (TMPDIR=/home/container/tmp)...');
    try {
      execSync('npx --no-install playwright install chromium-headless-shell', {
        stdio: 'inherit',
        env: childEnv,
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
      env: childEnv,
    }
  );

  child.on('exit', (code, signal) => {
    console.log(`[free-browser-mcp] supergateway exited with code=${code} signal=${signal}`);
    if (cfChild) cfChild.kill('SIGTERM');
    process.exit(code ?? 1);
  });

  const shutdown = () => {
    if (cfChild) cfChild.kill('SIGTERM');
    child.kill('SIGTERM');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
