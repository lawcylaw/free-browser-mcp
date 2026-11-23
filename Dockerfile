FROM mcr.microsoft.com/playwright:v1.50.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PORT=7860 \
    VNC_PASSWORD=""

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    nginx \
    supervisor \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @playwright/mcp@latest supergateway@latest

RUN mkdir -p /data/chrome-profile /var/log/supervisor && chmod -R 777 /data/chrome-profile

COPY nginx.conf /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 7860

CMD ["/start.sh"]
