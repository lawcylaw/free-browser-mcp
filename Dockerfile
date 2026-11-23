FROM mcr.microsoft.com/playwright:v1.50.0-noble

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    nginx \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @playwright/mcp@latest supergateway

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 7860

CMD ["/start.sh"]
