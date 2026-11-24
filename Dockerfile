FROM mcr.microsoft.com/playwright:v1.50.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    nginx \
    xvfb \
    xfce4 \
    xfce4-terminal \
    dbus-x11 \
    x11vnc \
    novnc \
    websockify \
    xdotool \
    scrot \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json desktop-mcp.mjs ./
RUN npm install --omit=dev

RUN npm install -g @playwright/mcp@latest supergateway

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 7860

CMD ["/start.sh"]
