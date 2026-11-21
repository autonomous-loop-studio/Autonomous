#!/bin/sh
# Fix storage/ ownership after an update. Run as root/sudo.
# Usage: sudo sh tools/fix-permissions.sh [web-user] [web-group]
USER="${1:-www-data}"
GROUP="${2:-www-data}"
if [ ! -d storage ]; then
  echo "storage/ not found; run from the app root." >&2
  exit 1
fi
chown -R "$USER:$GROUP" storage
find storage -type d -exec chmod 775 {} \;
find storage -type f -exec chmod 664 {} \;
echo "storage/ is now owned by $USER:$GROUP"