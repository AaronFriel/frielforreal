import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { getConfig } from '../../lib/config';
import { MeshConfig } from '../../lib/meshConfig';

export const workDir = __dirname;
export const projectName = 'infra-k8s-linkerd-mesh';

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { clusterName: localClusterName } = getConfig().cloud();

  const mesh = getConfig().mesh();

  mesh.clusters.apply((clusters) => {
    for (const remoteCluster of clusters) {
      if (remoteCluster.clusterName === localClusterName) {
        continue;
      }
      if (
        !remoteCluster.linkerdRemoteSecretData ||
        !remoteCluster.linkerdGatewayFqdn
      ) {
        continue;
      }

      multiclusterLink(remoteCluster);
    }
  });

  return {};
}

function multiclusterLink(config: MeshConfig) {
  const { clusterName, linkerdRemoteSecretData, linkerdGatewayFqdn } = config;

  new k8s.core.v1.Secret(`linkerd-remote-secret-${clusterName}`, {
    metadata: {
      name: `cluster-credentials-${clusterName}`,
      namespace: 'linkerd-multicluster',
    },
    stringData: {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      kubeconfig: linkerdRemoteSecretData!,
    },
    type: 'mirror.linkerd.io/remote-kubeconfig',
  });

  new k8s.apiextensions.CustomResource(`link-${clusterName}`, {
    apiVersion: 'multicluster.linkerd.io/v1alpha1',
    kind: 'Link',
    metadata: {
      name: clusterName,
      namespace: 'linkerd-multicluster',
    },
    spec: {
      clusterCredentialsSecret: `cluster-credentials-${clusterName}`,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      gatewayAddress: linkerdGatewayFqdn!,
      gatewayIdentity:
        'linkerd-gateway.linkerd-multicluster.serviceaccount.identity.linkerd.cluster.local',
      gatewayPort: '4143',
      probeSpec: {
        path: '/ready',
        period: '3s',
        port: '4192',
      },
      selector: {
        matchExpressions: [
          {
            key: 'mirror.linkerd.io/exported',
            operator: 'Exists',
          },
        ],
      },
      targetClusterDomain: 'cluster.local',
      targetClusterLinkerdNamespace: 'linkerd',
      targetClusterName: clusterName,
    },
  });

  new k8s.rbac.v1.ClusterRole(
    `linkerd-service-mirror-access-local-resources-${clusterName}`,
    {
      metadata: {
        name: `linkerd-service-mirror-access-local-resources-${clusterName}`,
        labels: {
          'linkerd.io/extension': 'multicluster',
          'linkerd.io/control-plane-component': 'service-mirror',
          'mirror.linkerd.io/cluster-name': clusterName,
        },
      },
      rules: [
        {
          apiGroups: [''],
          resources: ['endpoints', 'services'],
          verbs: ['list', 'get', 'watch', 'create', 'delete', 'update'],
        },
        {
          apiGroups: [''],
          resources: ['namespaces'],
          verbs: ['create', 'list', 'get', 'watch'],
        },
      ],
    },
  );

  new k8s.rbac.v1.ClusterRoleBinding(
    `linkerd-service-mirror-access-local-resources-${clusterName}`,
    {
      metadata: {
        name: `linkerd-service-mirror-access-local-resources-${clusterName}`,
        labels: {
          'linkerd.io/extension': 'multicluster',
          'linkerd.io/control-plane-component': 'service-mirror',
          'mirror.linkerd.io/cluster-name': `${clusterName}`,
        },
      },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: `linkerd-service-mirror-access-local-resources-${clusterName}`,
      },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: `linkerd-service-mirror-${clusterName}`,
          namespace: 'linkerd-multicluster',
        },
      ],
    },
  );

  new k8s.rbac.v1.Role(
    `linkerd-service-mirror-read-remote-creds-${clusterName}`,
    {
      metadata: {
        name: `linkerd-service-mirror-read-remote-creds-${clusterName}`,
        namespace: 'linkerd-multicluster',
        labels: {
          'linkerd.io/extension': 'multicluster',
          'linkerd.io/control-plane-component': 'service-mirror',
          'mirror.linkerd.io/cluster-name': `${clusterName}`,
        },
      },
      rules: [
        {
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: [`cluster-credentials-${clusterName}`],
          verbs: ['list', 'get', 'watch'],
        },
        {
          apiGroups: ['multicluster.linkerd.io'],
          resources: ['links'],
          verbs: ['list', 'get', 'watch'],
        },
      ],
    },
  );

  new k8s.rbac.v1.RoleBinding(
    `linkerd-service-mirror-read-remote-creds-${clusterName}`,
    {
      kind: 'RoleBinding',
      apiVersion: 'rbac.authorization.k8s.io/v1',
      metadata: {
        name: `linkerd-service-mirror-read-remote-creds-${clusterName}`,
        namespace: 'linkerd-multicluster',
        labels: {
          'linkerd.io/extension': 'multicluster',
          'linkerd.io/control-plane-component': 'service-mirror',
          'mirror.linkerd.io/cluster-name': `${clusterName}`,
        },
      },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: `linkerd-service-mirror-read-remote-creds-${clusterName}`,
      },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: `linkerd-service-mirror-${clusterName}`,
          namespace: 'linkerd-multicluster',
        },
      ],
    },
  );

  new k8s.core.v1.ServiceAccount(`linkerd-service-mirror-${clusterName}`, {
    metadata: {
      name: `linkerd-service-mirror-${clusterName}`,
      namespace: 'linkerd-multicluster',
      labels: {
        'linkerd.io/extension': 'multicluster',
        'linkerd.io/control-plane-component': 'service-mirror',
        'mirror.linkerd.io/cluster-name': `${clusterName}`,
      },
    },
  });

  new k8s.apps.v1.Deployment(`linkerd-service-mirror-${clusterName}`, {
    metadata: {
      labels: {
        'linkerd.io/extension': 'multicluster',
        'linkerd.io/control-plane-component': 'service-mirror',
        'mirror.linkerd.io/cluster-name': `${clusterName}`,
      },
      name: `linkerd-service-mirror-${clusterName}`,
      annotations: {
        'pulumi.com/skipAwait': 'true',
      },
      namespace: 'linkerd-multicluster',
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          'linkerd.io/control-plane-component': 'linkerd-service-mirror',
          'mirror.linkerd.io/cluster-name': `${clusterName}`,
        },
      },
      template: {
        metadata: {
          annotations: {
            'linkerd.io/inject': 'enabled',
          },
          labels: {
            'linkerd.io/control-plane-component': 'linkerd-service-mirror',
            'mirror.linkerd.io/cluster-name': `${clusterName}`,
          },
        },
        spec: {
          containers: [
            {
              args: [
                'service-mirror',
                '-log-level=info',
                '-event-requeue-limit=3',
                '-namespace=linkerd-multicluster',
                `${clusterName}`,
              ],
              image: 'cr.l5d.io/linkerd/controller:edge-21.12.4',
              name: 'service-mirror',
              securityContext: {
                runAsUser: 2103,
              },
              ports: [
                {
                  containerPort: 9999,
                  name: 'admin-http',
                },
              ],
            },
          ],
          serviceAccountName: `linkerd-service-mirror-${clusterName}`,
        },
      },
    },
  });

  new k8s.core.v1.Service(`probe-gateway-${clusterName}`, {
    metadata: {
      name: `probe-gateway-${clusterName}`,
      namespace: 'linkerd-multicluster',
      labels: {
        'mirror.linkerd.io/mirrored-gateway': 'true',
        'mirror.linkerd.io/cluster-name': `${clusterName}`,
      },
      annotations: {
        'pulumi.com/skipAwait': 'true',
      },
    },
    spec: {
      ports: [
        {
          name: 'mc-probe',
          port: 4192,
          protocol: 'TCP',
        },
      ],
    },
  });
}
