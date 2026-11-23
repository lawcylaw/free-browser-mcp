#!/usr/bin/env bash
set -e

mkdir -p /data/chrome-profile
rm -f /tmp/.X99-lock

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
