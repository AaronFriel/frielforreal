#!/bin/sh

CLUSTER_NAME="$1"
LOCAL_PORT="$2"

retry() {
  _retry_n=1
  _retry_delay=15
  while true; do
    # shellcheck disable=SC2015
    "$@" && break || {
      echo "Connection to ${CLUSTER_NAME} failed on attempt $_retry_n."
      _retry_n=$((_retry_n+1))
      sleep $_retry_delay;
    }
  done
}

connect_cluster() {
  _remote_ip=$(tailscale --socket=/tmp/tailscaled.sock ip -4 "${CLUSTER_NAME}")
  _status="$?"

  if [ "$_status" -ne "0" ] || [ -z "$_remote_ip" ]; then
    echo "Remote cluster connection to ${CLUSTER_NAME} failed, as exit code was ${_status} and/or remote IP [${_remote_ip}] was empty."
    return 1;
  fi

  echo "Adding iptables rule for port forwarding to remote Kubernetes cluster:"
  echo "  Cluster:      ${CLUSTER_NAME}"
  echo "  Local port:   ${LOCAL_PORT}"
  echo "  Tailscale IP: ${_remote_ip}"
  iptables -A PREROUTING -t mangle -i eth0 -p tcp --dport "${LOCAL_PORT}" -j MARK --set-mark 1 --wait
  iptables -A FORWARD -p tcp -s "$(tailscale --socket=/tmp/tailscaled.sock ip -4)" --sport "${LOCAL_PORT}" -j ACCEPT --wait

  iptables -t nat -A PREROUTING -p tcp -m tcp --dport "${LOCAL_PORT}" -j DNAT --to-destination "${_remote_ip}:443" --wait
}

retry connect_cluster
