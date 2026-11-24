#!/usr/bin/env bash
set -e

mkdir -p /data/chrome-profile
rm -f /tmp/.X99-lock

LISTEN_PORT="${PORT:-7860}"
sed -i "s/listen 7860;/listen ${LISTEN_PORT};/" /etc/nginx/nginx.conf

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
