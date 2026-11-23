FROM ghcr.io/steel-dev/steel-browser:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends socat \
    && npm install -g @playwright/mcp@latest supergateway \
    && rm -rf /var/lib/apt/lists/*

ENV PORT=3000
EXPOSE 7860

COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/start.sh"]
