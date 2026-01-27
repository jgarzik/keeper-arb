#!/bin/sh
set -eu

APP_USER=${APP_USER:-keeper}
APP_GROUP=${APP_GROUP:-keeper}
APP_UID=${APP_UID:-1000}
APP_GID=${APP_GID:-1000}
APP_DIR=${APP_DIR:-/app}

ensure_user_group() {
  if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
    addgroup --gid "$APP_GID" "$APP_GROUP"
  fi
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" --uid "$APP_UID" --gid "$APP_GID" "$APP_USER"
  fi
}

ensure_user_group

mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
chown -R "$APP_USER":"$APP_GROUP" "$APP_DIR/data" "$APP_DIR/logs"

exec su -s /bin/sh -c "$*" "$APP_USER"
