#!/bin/bash
# BC Fleet — nightly database backup
# Backs up SQLite DB locally (14 day retention) and pushes to a private GitHub repo for off-site safety

set -e

DB_PATH="/var/www/becopenhagen-fleet/data/fleet.db"
BACKUP_DIR="/var/backups/bc-fleet"
GIT_BACKUP_DIR="/var/backups/bc-fleet-git"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M)
RETENTION_DAYS=14

mkdir -p "$BACKUP_DIR"

# 1. Local backup — sqlite3 .backup gives a consistent snapshot even while the app is running
LOCAL_FILE="$BACKUP_DIR/fleet_${TIMESTAMP}.db"
sqlite3 "$DB_PATH" ".backup '$LOCAL_FILE'"
gzip "$LOCAL_FILE"
echo "Local backup created: ${LOCAL_FILE}.gz"

# 2. Clean up local backups older than retention period
find "$BACKUP_DIR" -name "fleet_*.db.gz" -mtime +$RETENTION_DAYS -delete

# 3. Push to off-site git backup repo
if [ -d "$GIT_BACKUP_DIR/.git" ]; then
  mkdir -p "$GIT_BACKUP_DIR/history"
  cp "${LOCAL_FILE}.gz" "$GIT_BACKUP_DIR/latest.db.gz"
  cp "${LOCAL_FILE}.gz" "$GIT_BACKUP_DIR/history/fleet_${TIMESTAMP}.db.gz"

  # Keep only last 30 days in the git history folder too, so the repo doesn't grow forever
  find "$GIT_BACKUP_DIR/history" -name "fleet_*.db.gz" -mtime +30 -delete

  cd "$GIT_BACKUP_DIR"
  git add -A
  git commit -m "Backup ${TIMESTAMP}" --quiet || echo "No changes to commit"
  git push --quiet
  echo "Off-site backup pushed to GitHub"
else
  echo "WARNING: Off-site git backup repo not configured at $GIT_BACKUP_DIR"
  echo "Run setup-backup-repo.sh first"
fi

echo "Backup complete: ${TIMESTAMP}"
