const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const chromiumMod = require('@sparticuz/chromium');
const chromium = chromiumMod.default || chromiumMod;

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 25975);
const SSE_PORT = 18000;
const MCP_HTTP_PORT = 18001;
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const TMP_DIR = path.join(__dirname, 'tmp');
const BIN_DIR = path.join(__dirname, 'bin');
const CLOUDFLARED_BIN = path.join(BIN_DIR, 'cloudflared');

fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

process.env.TMPDIR = TMP_DIR;
process.env.TEMP = TMP_DIR;
process.env.TMP = TMP_DIR;

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
      console.log(`[free-browser-mcp] HTTPS Streamable MCP: ${baseUrl}/mcp`);
      console.log(`[free-browser-mcp] HTTPS MCP SSE URL:    ${baseUrl}/sse`);
      console.log(`[free-browser-mcp] HTTPS Health URL:     ${baseUrl}/health`);
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

function startProxy() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    const isMcpHttp = req.url.startsWith('/mcp');
    const isSse = req.url.startsWith('/sse');
    const targetPort = isMcpHttp ? MCP_HTTP_PORT : SSE_PORT;

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      },
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        if (isSse) {
          headers['x-accel-buffering'] = 'no';
          headers['cache-control'] = 'no-cache, no-transform';
        }
        res.writeHead(proxyRes.statusCode || 200, headers);
        if (isSse) {
          res.write(`: ${' '.repeat(2048)}\n\n`);
        }
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Upstream error: ${err.message}`);
    });

    req.pipe(proxyReq);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[free-browser-mcp] Proxy listening on 0.0.0.0:${PORT} (/mcp, /sse, /message, /health)`);
  });
  return server;
}

async function main() {
  startProxy();

  let cfChild = null;
  if (await ensureCloudflared()) {
    cfChild = startCloudflared();
  }

  console.log('[free-browser-mcp] Extracting @sparticuz/chromium...');
  const execPath = await chromium.executablePath();
  console.log(`[free-browser-mcp] Chromium executable: ${execPath}`);
  console.log(`[free-browser-mcp] LD_LIBRARY_PATH: ${process.env.LD_LIBRARY_PATH || ''}`);

  const childEnv = {
    ...process.env,
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: 'true',
  };

  const mcpCmd = `npx --no-install @playwright/mcp --executable-path ${execPath} --headless --no-sandbox --user-data-dir ${USER_DATA_DIR} --viewport-size 1280,800`;

  console.log(`[free-browser-mcp] Starting supergateway SSE (${SSE_PORT}) and StreamableHTTP (${MCP_HTTP_PORT})...`);
  console.log(`[free-browser-mcp] MCP command: ${mcpCmd}`);

  const sseChild = spawn(
    'npx',
    [
      '--no-install',
      'supergateway',
      '--stdio',
      mcpCmd,
      '--port',
      String(SSE_PORT),
      '--ssePath',
      '/sse',
      '--messagePath',
      '/message',
    ],
    { stdio: 'inherit', env: childEnv }
  );

  const httpChild = spawn(
    'npx',
    [
      '--no-install',
      'supergateway',
      '--stdio',
      mcpCmd,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(MCP_HTTP_PORT),
      '--streamableHttpPath',
      '/mcp',
    ],
    { stdio: 'inherit', env: childEnv }
  );

  const shutdown = () => {
    if (cfChild) cfChild.kill('SIGTERM');
    sseChild.kill('SIGTERM');
    httpChild.kill('SIGTERM');
    process.exit(0);
  };

  sseChild.on('exit', (code) => {
    console.log(`[free-browser-mcp] supergateway SSE exited with code=${code}`);
  });
  httpChild.on('exit', (code) => {
    console.log(`[free-browser-mcp] supergateway StreamableHTTP exited with code=${code}`);
  });

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
