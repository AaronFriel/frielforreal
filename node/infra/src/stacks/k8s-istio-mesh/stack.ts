import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

import { getConfig } from '../../lib/config';
import { getEastWestGatewayManifest } from '../../lib/istio-util';

export const workDir = __dirname;
export const projectName = 'infra-k8s-istio-mesh';

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { clusterName: localClusterName } = getConfig().cloud();

  const mesh = getConfig().mesh();

  pulumi.output(getEastWestGatewayManifest(localClusterName)).apply(
    (manifest) =>
      new k8s.yaml.ConfigGroup('istioctl-eastwest-gateway', {
        yaml: manifest,
      }),
  );

  new k8s.apiextensions.CustomResource('cross-network-gateway', {
    apiVersion: 'networking.istio.io/v1alpha3',
    kind: 'Gateway',
    metadata: {
      namespace: 'istio-system',
      name: 'cross-network-gateway',
    },
    spec: {
      selector: {
        istio: 'eastwestgateway',
      },
      servers: [
        {
          port: {
            number: 15443,
            name: 'tls',
            protocol: 'TLS',
          },
          tls: {
            mode: 'AUTO_PASSTHROUGH',
          },
          hosts: ['*.local'],
        },
      ],
    },
  });

  mesh.clusters.apply((clusters) => {
    for (const remoteCluster of clusters) {
      if (remoteCluster.clusterName === localClusterName) {
        continue;
      }
      if (!remoteCluster.istioRemoteSecretData) {
        continue;
      }

      new k8s.core.v1.Secret(
        `istio-remote-secret-${remoteCluster.clusterName}`,
        {
          metadata: {
            name: `istio-remote-secret-${remoteCluster.clusterName}`,
            namespace: 'istio-system',
            labels: {
              'istio/multiCluster': 'true',
            },
            annotations: {
              'networking.istio.io/cluster': remoteCluster.clusterName,
            },
          },
          stringData: {
            [remoteCluster.clusterName]: remoteCluster.istioRemoteSecretData,
          },
        },
      );
    }
  });

  return {};
}
