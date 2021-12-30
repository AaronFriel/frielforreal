#!/bin/sh

# Copyright (c) 2021 Tailscale Inc & AUTHORS All rights reserved.
# Use of this source code is governed by a BSD-style
# license that can be found in the LICENSE file.


export PATH="$PATH":/tailscale/bin

AUTH_KEY="${AUTH_KEY:-}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
KUBE_SECRET="${KUBE_SECRET:-tailscale}"

set -e

TAILSCALED_ARGS="--state=kube:${KUBE_SECRET} --socket=/tmp/tailscaled.sock"

if [ ! -d /dev/net ]; then
  mkdir -p /dev/net
fi

if [ ! -c /dev/net/tun ]; then
  mknod /dev/net/tun c 10 200
fi

echo "Starting tailscaled"
# shellcheck disable=SC2086
tailscaled ${TAILSCALED_ARGS} &
PID=$!
echo "$PID" > /run/pid

UP_ARGS="--accept-dns=false"
if [ -n "${AUTH_KEY}" ]; then
  UP_ARGS="--authkey=${AUTH_KEY} ${UP_ARGS}"
fi
if [ -n "${EXTRA_ARGS}" ]; then
  UP_ARGS="${UP_ARGS} ${EXTRA_ARGS:-}"
fi

echo "Running tailscale up"
# shellcheck disable=SC2086
tailscale --socket=/tmp/tailscaled.sock up ${UP_ARGS}

echo "Adding iptables rule for DNAT to local Kubernetes cluster"
iptables -t nat -I PREROUTING -d "$(tailscale --socket=/tmp/tailscaled.sock ip -4)" -j DNAT --to-destination "$KUBERNETES_SERVICE_HOST" --wait

if [ -f "/opt/tailscale/post-up.sh" ]; then
  /opt/tailscale/post-up.sh
fi

wait ${PID}
