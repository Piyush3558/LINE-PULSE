#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
address="${1:-}"
clients="${2:-}"
if [[ -z "$address" || -z "$clients" ]]; then
    printf 'Usage: %s CERTIFICATE_IPV4 CLIENT_IPV4_CIDR\n' "$0" >&2
    exit 2
fi

project="$PWD"
node_bin="$project/data/node-runtime/node_modules/node/bin/node"
pg_bin="$project/data/postgresql-runtime/usr/lib/postgresql/18/bin"
pg_cluster="$project/data/pg18"
socket="$project/data/pgsocket"
certificates="$project/data/pg-tls"
"$node_bin" --input-type=module - "$address" "$clients" <<'NODE'
import { isIP } from 'node:net';
const [address,cidr]=process.argv.slice(2);
const [client,bits,...rest]=cidr.split('/');
const privateAddress = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/.test(ip);
const anyIpv4 = cidr === '0.0.0.0/0';
if (isIP(address)!==4 || !privateAddress(address) || (!anyIpv4 &&
    (isIP(client)!==4 || !privateAddress(client) || rest.length || !/^(2[4-9]|3[0-2])$/.test(bits)))) {
  throw new Error('Use a private certificate IPv4 address and a private client CIDR between /24 and /32, or 0.0.0.0/0 for all IPv4 clients');
}
NODE
listen_address="$address"
if [[ "$clients" == '0.0.0.0/0' ]]; then listen_address='0.0.0.0'; fi
if ! ip -o -4 address show | awk -v ip="$address" '{ split($4,a,"/"); if (a[1]==ip) found=1 } END { exit !found }'; then
    printf 'The database address must be assigned to this Linux device.\n' >&2
    exit 2
fi
test -f "$pg_cluster/postgresql.conf"
if "$pg_bin/pg_ctl" -D "$pg_cluster" status >/dev/null; then
    active=$(psql -X -v ON_ERROR_STOP=1 -h "$socket" -p 55432 -d line_pulse -Atc "SELECT count(*) FROM line_pulse_v2.collector_state WHERE status='running'")
    if [[ "$active" != 0 ]]; then
        printf 'Stop any active PLC collection before restarting PostgreSQL.\n' >&2
        exit 1
    fi
fi

umask 077
install -d -m 700 "$certificates"
if [[ ! -s "$certificates/ca.key" && ! -s "$certificates/ca.crt" ]]; then
    openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 1825 -subj '/CN=Line Pulse Local Database CA' \
        -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
        -keyout "$certificates/ca.key" -out "$certificates/ca.crt" 2>"$certificates/certificate.log"
fi
test -s "$certificates/ca.key"
test -s "$certificates/ca.crt"
openssl req -new -newkey rsa:2048 -nodes -sha256 -subj "/CN=$address" \
    -keyout "$certificates/server.key" -out "$certificates/server.csr" 2>>"$certificates/certificate.log"
printf 'subjectAltName=IP:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$address" > "$certificates/server.ext"
openssl x509 -req -in "$certificates/server.csr" -CA "$certificates/ca.crt" -CAkey "$certificates/ca.key" \
    -CAcreateserial -sha256 -days 397 -extfile "$certificates/server.ext" -out "$certificates/server.crt"
openssl verify -CAfile "$certificates/ca.crt" -verify_ip "$address" "$certificates/server.crt"
install -m 600 "$certificates/server.key" "$pg_cluster/line-pulse-lan.key"
install -m 600 "$certificates/server.crt" "$pg_cluster/line-pulse-lan.crt"

printf "listen_addresses = '%s'\nssl = on\nssl_cert_file = 'line-pulse-lan.crt'\nssl_key_file = 'line-pulse-lan.key'\n" "$listen_address" > "$pg_cluster/line-pulse-lan.conf"
printf 'hostssl line_pulse line_pulse_api,line_pulse_worker %s scram-sha-256\nhostnossl line_pulse line_pulse_api,line_pulse_worker %s reject\n' \
    "$clients" "$clients" > "$pg_cluster/line-pulse-lan.hba.conf"
if ! rg -Fq "include_if_exists = 'line-pulse-lan.conf'" "$pg_cluster/postgresql.conf"; then
    printf "\n# Line Pulse local database\nlisten_addresses = ''\ninclude_if_exists = 'line-pulse-lan.conf'\n" >> "$pg_cluster/postgresql.conf"
fi
include_line='include_if_exists line-pulse-lan.hba.conf'
if [[ "$(head -n 1 "$pg_cluster/pg_hba.conf")" != "$include_line" ]]; then
    hba_file="$(mktemp "$pg_cluster/.line-pulse-hba-XXXXXX")"
    { printf '%s\n' "$include_line"; sed '/^include_if_exists line-pulse-lan\.hba\.conf$/d' "$pg_cluster/pg_hba.conf"; } > "$hba_file"
    mv "$hba_file" "$pg_cluster/pg_hba.conf"
fi
test "$("$pg_bin/postgres" -D "$pg_cluster" -C listen_addresses)" = "$listen_address"
if "$pg_bin/pg_ctl" -D "$pg_cluster" status >/dev/null; then
    invalid=$(psql -X -v ON_ERROR_STOP=1 -h "$socket" -p 55432 -d line_pulse -Atc "SELECT
        (SELECT count(*) FROM pg_file_settings WHERE error IS NOT NULL AND name IS DISTINCT FROM 'listen_addresses')
        + (SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL)
        + CASE WHEN EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE file_name LIKE '%/line-pulse-lan.hba.conf'
            AND type='hostssl' AND error IS NULL) THEN 0 ELSE 1 END")
    if [[ "$invalid" != 0 ]]; then
        printf 'PostgreSQL rejected its configuration files. Inspect pg_file_settings before restarting.\n' >&2
        exit 1
    fi
    "$pg_bin/pg_ctl" -D "$pg_cluster" -m fast -w stop
fi
./scripts/linux-local.sh start-db
psql -X -v ON_ERROR_STOP=1 -h "$socket" -p 55432 -d line_pulse -c "SELECT current_setting('listen_addresses') AS listen_address,current_setting('ssl') AS tls"
printf 'Shared PostgreSQL listens on %s:55432 for %s. Use %s:55432 in the client profile.\n' "$listen_address" "$clients" "$address"
