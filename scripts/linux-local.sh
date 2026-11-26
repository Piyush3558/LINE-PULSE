#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
project="$PWD"
pg_bin="$project/data/postgresql-runtime/usr/lib/postgresql/18/bin"
node_bin="$project/data/node-runtime/node_modules/node/bin/node"
pg_cluster="$project/data/pg18"
socket_dir="$project/data/pgsocket"

launch() {
    local name=$1 entry=$2
    if ! systemctl --user is-active --quiet "$name"; then
        if systemctl --user is-failed --quiet "$name"; then systemctl --user reset-failed "$name"; fi
        systemd-run --user --unit="$name" --service-type=exec --working-directory="$project" --property=Restart=on-failure \
            "$node_bin" --env-file=.env --import tsx "$entry"
    fi
}

case "${1:-status}" in
    start|start-db)
        install -d -m 700 "$socket_dir"
        if ! "$pg_bin/pg_ctl" -D "$pg_cluster" status >/dev/null; then
            "$pg_bin/pg_ctl" -D "$pg_cluster" -l "$project/data/postgresql.log" \
                -o "-k '$socket_dir' -p 55432 -c timezone=UTC" -w start
        fi
        if [[ "$1" == start-db ]]; then exit 0; fi
        launch line-pulse-api backend/server.ts
        launch line-pulse-collector backend/worker.ts
        printf 'Open http://127.0.0.1:8765\n'
        ;;
    stop)
        for unit in line-pulse-collector line-pulse-api; do
            if systemctl --user is-active --quiet "$unit"; then systemctl --user stop "$unit"; fi
        done
        if "$pg_bin/pg_ctl" -D "$pg_cluster" status >/dev/null; then
            "$pg_bin/pg_ctl" -D "$pg_cluster" -m fast -w stop
        fi
        ;;
    status)
        "$pg_bin/pg_ctl" -D "$pg_cluster" status || true
        systemctl --user --no-pager status line-pulse-api line-pulse-collector
        ;;
    *)
        printf 'Usage: %s start|start-db|stop|status\n' "$0" >&2
        exit 2
        ;;
esac
