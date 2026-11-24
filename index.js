const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

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
const CHROME_WRAPPER = path.join(BIN_DIR, 'headful-chromium.sh');

fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

process.env.TMPDIR = TMP_DIR;
process.env.TEMP = TMP_DIR;
process.env.TMP = TMP_DIR;

function ensureHeadfulEnv() {
  const marker = path.join(ROOTFS_DIR, 'usr', 'bin', 'chromium');
  if (fs.existsSync(PROOT_BIN) && fs.existsSync(marker)) {
    return true;
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const rootfsTar = path.join(TMP_DIR, 'ubuntu-base.tar.gz');
  const rootfsUrl = `https://cdimage.ubuntu.com/ubuntu-base/releases/22.04/release/ubuntu-base-22.04.5-base-${arch}.tar.gz`;

  console.log(`[free-browser-mcp] Installing rootless proot + Xvfb + Fluxbox + Ubuntu 22.04 Chromium (${arch})...`);
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
      `"${PROOT_BIN}" -S "${ROOTFS_DIR}" -0 -k 5.15.0 -w /root /bin/bash -c "rm -f /etc/apt/sources.list.d/debian.list /etc/apt/preferences.d/chromium && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates gnupg software-properties-common xvfb x11vnc novnc websockify fluxbox x11-utils x11-xserver-utils fonts-noto-cjk && add-apt-repository -y ppa:xtradeb/apps && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*"`,
      { stdio: 'inherit' }
    );
    console.log('[free-browser-mcp] Desktop Chromium + Xvfb + noVNC ready.');
    return true;
  } catch (err) {
    console.error('[free-browser-mcp] Failed to install headful-env:', err.message);
    return false;
  }
}

function buildChromiumWrapper() {
  const script = `#!/bin/bash
unset LD_LIBRARY_PATH
exec "${PROOT_BIN}" -S "${ROOTFS_DIR}" -0 -k 5.15.0 -b /tmp:/tmp -b /home/container:/home/container /usr/bin/chromium --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --display=:99 "$@"
`;
  fs.writeFileSync(CHROME_WRAPPER, script, { mode: 0o755 });
}

function startHeadfulDisplay() {
  const children = [];
  if (!ensureHeadfulEnv()) return children;

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
       mkdir -p /root/.fluxbox
       cat << 'EOF' > /root/.fluxbox/init
session.screen0.rootCommand: xsetroot -solid '#1e1e2e'
session.screen0.toolbar.visible: true
EOF
       HOME=/root DISPLAY=:99 fluxbox -rc /root/.fluxbox/init &
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
  const token = (process.env.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
  const args = token
    ? ['tunnel', '--no-autoupdate', 'run', '--token', token]
    : ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'];

  const cf = spawn(CLOUDFLARED_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let printed = false;
  const handleOutput = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (token && !printed && text.includes('Registered tunnel connection')) {
      printed = true;
      console.log('\n==================================================');
      console.log('[free-browser-mcp] Named Tunnel Connected!');
      console.log('[free-browser-mcp] Use your fixed Cloudflare Public Hostname (/mcp, /sse, /vnc.html)');
      console.log('==================================================\n');
      return;
    }
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
  buildChromiumWrapper();
  await new Promise((r) => setTimeout(r, 2500));

  startProxy();

  let cfChild = null;
  if (await ensureCloudflared()) {
    cfChild = startCloudflared();
  }

  const configPath = path.join(TMP_DIR, 'playwright-mcp.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      browser: {
        launchOptions: {
          executablePath: CHROME_WRAPPER,
          headless: false,
          args: [
            '--start-maximized',
            '--window-position=0,0',
            '--window-size=1280,800'
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

  console.log(`[free-browser-mcp] Starting STATEFUL HEADFUL supergateway SSE (${SSE_PORT}) and StreamableHTTP (${MCP_HTTP_PORT})...`);
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
      '--stateful',
      '--sessionTimeout',
      '600000',
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
