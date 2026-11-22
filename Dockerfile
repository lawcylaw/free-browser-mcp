FROM mcr.microsoft.com/playwright:v1.50.0-noble

RUN npm install -g @playwright/mcp@latest supergateway

ENV PORT=8000
EXPOSE 8000

CMD ["npx", "-y", "supergateway", "--stdio", "npx @playwright/mcp@latest --headless --no-sandbox --isolated", "--port", "8000", "--ssePath", "/sse", "--messagePath", "/message"]
