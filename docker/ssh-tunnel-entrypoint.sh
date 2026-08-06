#!/bin/sh
set -eu

: "${SSH_HOST:?SSH_HOST is required}"
: "${SSH_PORT:?SSH_PORT is required}"
: "${SSH_USER:?SSH_USER is required}"
: "${SSH_REMOTE_DB_HOST:?SSH_REMOTE_DB_HOST is required}"
: "${SSH_REMOTE_DB_PORT:?SSH_REMOTE_DB_PORT is required}"
: "${SSH_TUNNEL_PORT:?SSH_TUNNEL_PORT is required}"

key_source=/run/secrets/id_ed25519
known_hosts_source=/run/secrets/known_hosts
runtime_dir=/tmp/ssh-tunnel
runtime_key=${runtime_dir}/id_ed25519
runtime_known_hosts=${runtime_dir}/known_hosts

if [ ! -r "${key_source}" ]; then
  echo "SSH private key secret is missing or unreadable" >&2
  exit 1
fi

if [ ! -r "${known_hosts_source}" ]; then
  echo "SSH known_hosts secret is missing or unreadable" >&2
  exit 1
fi

umask 077
mkdir -p "${runtime_dir}"
cp "${key_source}" "${runtime_key}"
cp "${known_hosts_source}" "${runtime_known_hosts}"
chmod 0600 "${runtime_key}" "${runtime_known_hosts}"

exec ssh \
  -N \
  -T \
  -g \
  -i "${runtime_key}" \
  -p "${SSH_PORT}" \
  -l "${SSH_USER}" \
  -L "0.0.0.0:${SSH_TUNNEL_PORT}:${SSH_REMOTE_DB_HOST}:${SSH_REMOTE_DB_PORT}" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o PreferredAuthentications=publickey \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o ConnectTimeout=15 \
  -o ConnectionAttempts=1 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=${runtime_known_hosts}" \
  "${SSH_HOST}"
