const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const chromiumMod = require('@sparticuz/chromium');
const chromium = chromiumMod.default || chromiumMod;

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 25975);
const SSE_PORT = 18000;
const MCP_HTTP_PORT = 18001;
const VNC_PORT = 5900;
const NOVNC_PORT = 6080;

const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const TMP_DIR = path.join(__dirname, 'tmp');
const BIN_DIR = path.join(__dirname, 'bin');
const ROOTFS_DIR = path.join(__dirname, 'ubuntu-rootfs');
const CLOUDFLARED_BIN = path.join(BIN_DIR, 'cloudflared');
const PROOT_BIN = path.join(BIN_DIR, 'proot');

fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

process.env.TMPDIR = TMP_DIR;
process.env.TEMP = TMP_DIR;
process.env.TMP = TMP_DIR;

function ensureHeadfulEnv() {
  const xvfbMarker = path.join(ROOTFS_DIR, 'usr', 'bin', 'Xvfb');
  const wmMarker = path.join(ROOTFS_DIR, 'usr', 'bin', 'fluxbox');
  if (fs.existsSync(PROOT_BIN) && fs.existsSync(xvfbMarker) && fs.existsSync(wmMarker)) {
    return true;
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const rootfsTar = path.join(TMP_DIR, 'ubuntu-base.tar.gz');
  const rootfsUrl = `https://cdimage.ubuntu.com/ubuntu-base/releases/22.04/release/ubuntu-base-22.04.5-base-${arch}.tar.gz`;

  console.log(`[free-browser-mcp] Installing rootless proot + Ubuntu 22.04.5 Xvfb + Fluxbox + noVNC (${arch})...`);
  try {
    if (!fs.existsSync(PROOT_BIN) || fs.statSync(PROOT_BIN).size < 100000) {
      execSync(
        `curl -fL --retry 3 "https://proot.gitlab.io/proot/bin/proot" -o "${PROOT_BIN}" && chmod +x "${PROOT_BIN}"`,
        { stdio: 'inherit' }
      );
    }
    if (!fs.existsSync(path.join(ROOTFS_DIR, 'bin', 'bash'))) {
      if (fs.existsSync(ROOTFS_DIR)) {
        fs.rmSync(ROOTFS_DIR, { recursive: true, force: true });
      }
      fs.mkdirSync(ROOTFS_DIR, { recursive: true });
      execSync(`curl -fL --retry 3 "${rootfsUrl}" -o "${rootfsTar}"`, { stdio: 'inherit' });
      execSync(`"${PROOT_BIN}" -0 tar -xzf "${rootfsTar}" -C "${ROOTFS_DIR}"`, { stdio: 'inherit' });
      fs.rmSync(rootfsTar, { force: true });
      fs.writeFileSync(path.join(ROOTFS_DIR, 'etc', 'resolv.conf'), 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n');
    }
    execSync(
      `"${PROOT_BIN}" -S "${ROOTFS_DIR}" -0 -k 5.15.0 -w /root /bin/bash -c "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fluxbox x11-utils && rm -rf /var/lib/apt/lists/*"`,
      { stdio: 'inherit' }
    );
    console.log('[free-browser-mcp] Headful Xvfb + Fluxbox + noVNC environment ready.');
    return true;
  } catch (err) {
    console.error('[free-browser-mcp] Failed to install headful-env:', err.message);
    return false;
  }
}

function startHeadfulDisplay() {
  const children = [];
  if (!ensureHeadfulEnv()) return children;

  // 確保外部與 proot 內部共用同一個 /tmp/.X11-unix 目錄
  fs.mkdirSync('/tmp/.X11-unix', { recursive: true });

  console.log('[free-browser-mcp] Starting Xvfb + Fluxbox + x11vnc + noVNC on :99 (1280x800x24)...');
  const displayProc = spawn(
    PROOT_BIN,
    [
      '-S',
      ROOTFS_DIR,
      '-0',
      '-k',
      '5.15.0',
      '-b',
      '/tmp:/tmp',
      '/bin/bash',
      '-c',
      `rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
       Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
       sleep 1
       DISPLAY=:99 fluxbox &
       x11vnc -display :99 -forever -shared -rfbport ${VNC_PORT} -nopw -quiet &
       websockify --web=/usr/share/novnc/ 127.0.0.1:${NOVNC_PORT} 127.0.0.1:${VNC_PORT}`
    ],
    { stdio: 'inherit' }
  );
  children.push(displayProc);
  return children;
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
      console.log(`[free-browser-mcp] HTTPS Streamable MCP: ${baseUrl}/mcp`);
      console.log(`[free-browser-mcp] HTTPS MCP SSE URL:    ${baseUrl}/sse`);
      console.log(`[free-browser-mcp] HTTPS noVNC Viewer:   ${baseUrl}/vnc.html?autoconnect=1&resize=scale`);
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
    const isSse = req.url.startsWith('/sse') || req.url.startsWith('/message');
    const targetPort = isMcpHttp ? MCP_HTTP_PORT : isSse ? SSE_PORT : NOVNC_PORT;

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

  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(NOVNC_PORT, '127.0.0.1', () => {
      const reqHeaders = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${reqHeaders}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[free-browser-mcp] Proxy listening on 0.0.0.0:${PORT} (/mcp, /sse, /message, /vnc.html, /health)`);
  });
  return server;
}

async function main() {
  const displayChildren = startHeadfulDisplay();
  await new Promise((r) => setTimeout(r, 2500));

  startProxy();

  let cfChild = null;
  if (await ensureCloudflared()) {
    cfChild = startCloudflared();
  }

  console.log('[free-browser-mcp] Extracting @sparticuz/chromium...');
  const execPath = await chromium.executablePath();
  console.log(`[free-browser-mcp] Chromium executable: ${execPath}`);

  // 寫入設定檔強制 Chromium 以有頭視窗模式啟動並最大化
  const configPath = path.join(TMP_DIR, 'playwright-mcp.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      browser: {
        launchOptions: {
          executablePath: execPath,
          headless: false,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--start-maximized',
            '--window-position=0,0',
            '--window-size=1280,800',
            '--display=:99'
          ]
        },
        contextOptions: {
          viewport: { width: 1280, height: 800 }
        }
      }
    }, null, 2)
  );

  const childEnv = {
    ...process.env,
    DISPLAY: ':99',
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: 'true',
  };

  const mcpCmd = `npx --no-install @playwright/mcp --config ${configPath} --user-data-dir ${USER_DATA_DIR}`;

  console.log(`[free-browser-mcp] Starting HEADFUL supergateway SSE (${SSE_PORT}) and StreamableHTTP (${MCP_HTTP_PORT})...`);
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
    for (const c of displayChildren) {
      try { c.kill('SIGTERM'); } catch {}
    }
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
