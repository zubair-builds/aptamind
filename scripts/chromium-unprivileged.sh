#!/usr/bin/env bash
# Development/CI helper — NOT needed in the supported deployment (a non-root worker points
# BROWSER_EXECUTABLE_PATH at Chromium directly).
#
# Chromium refuses to sandbox when started as root, and Aptamind never runs it with
# --no-sandbox. When the worker/test process must run as root (e.g. inside a dev container),
# point BROWSER_EXECUTABLE_PATH at this script: it hands Chromium's profile directory to an
# unprivileged user and executes Chromium as that user, so the sandbox stays enabled.
#
#   CHROMIUM_BIN=/path/to/chrome        Chromium binary (required)
#   CHROMIUM_RUN_AS=aptamind-browser    unprivileged user (created by the caller:
#                                       useradd --system --create-home aptamind-browser)
set -euo pipefail
: "${CHROMIUM_BIN:?set CHROMIUM_BIN to the Chromium executable}"
RUN_AS="${CHROMIUM_RUN_AS:-aptamind-browser}"
if [[ "$(id -u)" != 0 ]]; then exec "$CHROMIUM_BIN" "$@"; fi
for arg in "$@"; do
  case "$arg" in
    --user-data-dir=*) chown -R "$RUN_AS" "${arg#--user-data-dir=}" ;;
  esac
done
HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"
export HOME
exec setpriv --reuid="$RUN_AS" --regid="$RUN_AS" --init-groups -- "$CHROMIUM_BIN" "$@"
