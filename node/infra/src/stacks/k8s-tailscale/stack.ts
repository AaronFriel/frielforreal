import { readFile } from 'fs/promises';
import path from 'path';

import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

import { getConfig } from '../../lib/config';

export const workDir = __dirname;
export const projectName = 'infra-k8s-tailscale';

export function stackConfig() {
  const config = new pulumi.Config();

  return {
    tailscaleKey: config.requireSecret('tailscaleKey'),
    enableCrossCluster: config.get('enableCrossCluster') ?? false,
  };
}

const tailscaleStateSecretName = 'tailscale-state';
const tailscaleLabels = {
  'app.kubernetes.io/name': 'tailscale',
};

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }
  const { clusters } = getConfig().mesh();
  const { clusterName } = getConfig().cloud();

  const { tailscaleKey, enableCrossCluster } = stackConfig();

  const namespace = new k8s.core.v1.Namespace('tailscale-system', {
    metadata: {
      name: 'tailscale-system',
    },
  });

  const secret = new k8s.core.v1.Secret('tailscale-auth', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    stringData: {
      AUTH_KEY: tailscaleKey,
    },
  });

  const postUp = clusters.apply((clusters) => {
    let rules = '';

    for (const cluster of clusters) {
      if (cluster.clusterName === clusterName) {
        // skip mapping to own cluster.
        continue;
      }
      rules += `
/opt/tailscale/add-proxy.sh "${cluster.clusterName}" "${cluster.tailscalePort}" &
`;
    }

    return pulumi.interpolate`#!/bin/sh
${rules}

echo "Adding iptables rule for source NAT to remote Kubernetes clusters"
iptables -A POSTROUTING -t nat --match mark --mark 1 -j SNAT --to-source "$(tailscale --socket=/tmp/tailscaled.sock ip -4)" --wait
    `;
  });

  const configMap = new k8s.core.v1.ConfigMap('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    data: {
      'run.sh': readFile(path.join(__dirname, './scripts/run.sh'), {
        encoding: 'utf-8',
      }),
      'add-proxy.sh': readFile(path.join(__dirname, './scripts/add-proxy.sh'), {
        encoding: 'utf-8',
      }),
      'post-up.sh': enableCrossCluster ? postUp : '',
    },
  });

  const { serviceAccount } = tailscaleRbac(namespace);

  const headlessService = new k8s.core.v1.Service('tailscale', {
    metadata: {
      name: 'tailscale',
      namespace: namespace.metadata.name,
      labels: tailscaleLabels,
      annotations: {
        // Consider successful before statefulset is up.
        'pulumi.com/skipAwait': 'true',
      },
    },
    spec: {
      ports: [],
      clusterIP: 'None',
      selector: tailscaleLabels,
    },
  });

  new k8s.apps.v1.StatefulSet('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    spec: {
      selector: { matchLabels: tailscaleLabels },
      serviceName: headlessService.metadata.name,
      replicas: 1,
      template: {
        metadata: {
          labels: tailscaleLabels,
        },
        spec: {
          serviceAccountName: serviceAccount.metadata.name,
          initContainers: [
            {
              name: 'sysctler',
              image: 'busybox',
              securityContext: { privileged: true },
              command: ['/bin/sh'],
              args: ['-c', 'sysctl -w net.ipv4.ip_forward=1'],
              resources: {
                requests: {
                  cpu: '1m',
                  memory: '1Mi',
                },
              },
            },
          ],
          containers: [
            {
              name: 'tailscale',
              imagePullPolicy: 'Always',
              image: 'ghcr.io/tailscale/tailscale:v1.18.2',
              command: ['/bin/sh'],
              args: ['/opt/tailscale/run.sh'],
              env: [
                {
                  name: 'KUBE_SECRET',
                  value: tailscaleStateSecretName,
                },
                {
                  name: 'AUTH_KEY',
                  valueFrom: {
                    secretKeyRef: {
                      name: secret.metadata.name,
                      key: 'AUTH_KEY',
                    },
                  },
                },
                {
                  name: 'EXTRA_ARGS',
                  value: `--hostname ${clusterName}`,
                },
              ],
              securityContext: { capabilities: { add: ['NET_ADMIN'] } },
              volumeMounts: [
                {
                  mountPath: '/opt/tailscale',
                  name: 'scripts',
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'scripts',
              configMap: {
                defaultMode: 0o555,
                name: configMap.metadata.name,
              },
            },
          ],
        },
      },
    },
  });

  return {};
}

function tailscaleRbac(namespace: k8s.core.v1.Namespace) {
  const serviceAccount = new k8s.core.v1.ServiceAccount('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
  });

  const role = new k8s.rbac.v1.Role('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    rules: [
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['create'],
      },
      {
        apiGroups: [''],
        resourceNames: [tailscaleStateSecretName],
        resources: ['secrets'],
        verbs: ['get', 'update'],
      },
    ],
  });

  new k8s.rbac.v1.RoleBinding('tailscale', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    subjects: [
      {
        kind: 'ServiceAccount',
        name: serviceAccount.metadata.name,
      },
    ],
    roleRef: {
      kind: 'Role',
      name: role.metadata.name,
      apiGroup: 'rbac.authorization.k8s.io',
    },
  });
  return { serviceAccount };
}
