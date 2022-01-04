import * as linode from '@pulumi/linode';
import * as pulumi from '@pulumi/pulumi';
import { secret } from '@pulumi/pulumi';
import { RandomPet } from '@pulumi/random';

import { getConfig } from '../../lib/config';
import { rewriteKubeconfig } from '../../lib/kubectl';

export const workDir = __dirname;
export const projectName = 'infra-linode-cluster';

export function config() {
  const config = new pulumi.Config();

  return {
    region: config.require('region'),
  };
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { clusterName, contextName } = getConfig().cloud();

  const { region } = config();

  const label = new RandomPet('cluster-label', {
    separator: '-',
    length: 2,
    prefix: 'lke',
  }).id;

  const cluster = new linode.LkeCluster(
    'cluster',
    {
      k8sVersion: '1.21',
      label,
      region,
      controlPlane: {
        highAvailability: false,
      },
      pools: [
        {
          type: 'g6-dedicated-4',
          count: 1,
        },
      ],
    },
    { ignoreChanges: ['k8sVersion', 'pools'] },
  );

  return {
    kubeconfig: secret(cluster.kubeconfig).apply((base64kubeconfig) => {
      if (pulumi.runtime.isDryRun()) {
        return 'undefined';
      }

      if (!base64kubeconfig) {
        throw new Error(
          `Unable to retrieve kubeconfig for cluster ${clusterName}`,
        );
      }

      const configText = Buffer.from(base64kubeconfig, 'base64').toString(
        'utf-8',
      );

      return rewriteKubeconfig(configText, contextName);
    }),
    clusterName: cluster.label,
    contextName: pulumi.interpolate`lke${cluster.id}-ctx`,
  };
}
