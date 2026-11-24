---
title: Free Headful Linux & Browser MCP
emoji: 🖥️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Free Headful Linux & Browser MCP

Zero-usage remote **Headful Linux Desktop (XFCE4)** + **Playwright MCP** (`@playwright/mcp` wrapped with `supergateway`) + **Computer Use Desktop MCP** (`xdotool` / `scrot` / `bash_exec`) + **noVNC** web GUI on a single port (`7860`) for free Hugging Face Spaces or self-hosted Docker hosting.

## Endpoints (on port `7860`)
- `/vnc/` — Live Headful Linux XFCE4 & Chrome GUI (noVNC) for manual login / 2FA / CAPTCHA intervention
- `/desktop/mcp` — Remote OS-level Computer Use MCP Streamable HTTP endpoint (`desktop_screenshot`, `mouse_action`, `keyboard_action`, `bash_exec`)
- `/mcp` — Remote Playwright Browser MCP Streamable HTTP endpoint (`supergateway` -> `@playwright/mcp`)
- `/sse` — Remote Playwright Browser MCP SSE endpoint (`supergateway` -> `@playwright/mcp`)
- `/message` — Remote Playwright Browser MCP SSE message POST endpoint
- `/health` — Health check endpoint
