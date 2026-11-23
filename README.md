---
title: Free Headful Browser MCP
emoji: 🖥️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Free Headful Browser MCP

Zero-usage remote **Headful** Playwright MCP server (`@playwright/mcp` wrapped with `supergateway`) + **noVNC** web GUI on a single port (`7860`) for free Hugging Face Spaces Docker hosting.

## Endpoints (on port `7860`)
- `/vnc/` — Live Headful Chrome GUI (noVNC) for manual login / 2FA / CAPTCHA intervention
- `/sse` — Remote MCP SSE endpoint (`supergateway` -> `@playwright/mcp`)
- `/message` — Remote MCP SSE message POST endpoint
- `/health` — Health check endpoint
