#!/bin/bash
# Runs docker compose for Aules tutor server with this servers settings.
export AULE_ENV_FILE=/etc/aule/aule.env
export AULE_DB_PORT=5434
export AULE_AGENT_MEMORY=6g
export AULE_UID=1001 AULE_GID=1001
export AULE_FCM_KEY_FILE=/etc/aule/firebase.json
# The commit the images are built from, which they report (RELEASING.md). The
# checkout can belong to another user than the one running this, and git then
# refuses to read it unless it is named safe; a setting given here counts.
AULE_COMMIT="${AULE_COMMIT:-$(git -c safe.directory=/opt/aule-sw -C /opt/aule-sw rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
export AULE_COMMIT
cd /opt/aule-sw && exec docker compose -p aule-sw "$@"
