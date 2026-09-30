#!/bin/sh
set -e

# Make sure the mounted folders exist (bind mounts may start empty).
mkdir -p /app/config /app/DATAROOT /app/ASSETS /app/LOG

exec "$@"
