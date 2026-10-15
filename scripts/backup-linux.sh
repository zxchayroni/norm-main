#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly service=normarchive
readonly backup_dir=/var/backups/normarchive
readonly files_dir=/var/lib/normarchive/files
readonly stamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly database_backup="$backup_dir/db-$stamp.dump"
readonly files_backup="$backup_dir/files-$stamp.tar.gz"
readonly database_temporary="$database_backup.partial"
readonly files_temporary="$files_backup.partial"

install -d -m 0700 "$backup_dir"
chmod 0700 "$backup_dir"

exec 9>/run/lock/normarchive-backup.lock
if ! flock -n 9; then
	printf 'Another NormArchive backup is already running.\n' >&2
	exit 1
fi

if ! systemctl is-active --quiet "$service"; then
	printf 'The normarchive service must be active before a backup.\n' >&2
	exit 1
fi

stopped=0
cleanup() {
	local status=$?
	trap - EXIT
	rm -f -- "$database_temporary" "$files_temporary"
	if (( stopped )); then
		if ! systemctl start "$service"; then
			printf 'Failed to restart normarchive after backup.\n' >&2
			status=1
		fi
	fi
	exit "$status"
}
trap cleanup EXIT

stopped=1
systemctl stop "$service"

runuser -u postgres -- pg_dump --format=custom --no-owner --no-acl --dbname=normarchive > "$database_temporary"
tar -czf "$files_temporary" -C "$files_dir" .
mv -- "$database_temporary" "$database_backup"
mv -- "$files_temporary" "$files_backup"

printf 'Created %s\nCreated %s\n' "$database_backup" "$files_backup"
