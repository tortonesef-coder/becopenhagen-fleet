#!/bin/bash
# BC Fleet — restore database from a backup
# Usage: ./restore.sh /path/to/backup.db.gz

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <path-to-backup.db.gz>"
  echo ""
  echo "Available local backups:"
  ls -lh /var/backups/bc-fleet/*.db.gz 2>/dev/null | tail -10
  echo ""
  echo "Latest off-site backup: /var/backups/bc-fleet-git/latest.db.gz"
  exit 1
fi

BACKUP_FILE="$1"
DB_PATH="/var/www/becopenhagen-fleet/data/fleet.db"
SAFETY_COPY="/var/backups/bc-fleet/pre-restore-$(date +%Y-%m-%d_%H-%M).db"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "This will REPLACE the live database with: $BACKUP_FILE"
echo "A safety copy of the current database will be saved to: $SAFETY_COPY"
read -p "Continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

# Stop the app to avoid writes during restore
pm2 stop bc-fleet

# Safety copy of current DB before overwriting
cp "$DB_PATH" "$SAFETY_COPY"
echo "Safety copy saved: $SAFETY_COPY"

# Decompress and restore
gunzip -c "$BACKUP_FILE" > "$DB_PATH"
rm -f "$DB_PATH-shm" "$DB_PATH-wal"

echo "Database restored from: $BACKUP_FILE"

pm2 start bc-fleet
echo "App restarted. Verify everything looks correct."
