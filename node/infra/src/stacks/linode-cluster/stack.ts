import * as pulumi from '@pulumi/pulumi';
import * as linode from '@pulumi/linode';
import { RandomPet } from '@pulumi/random';
import { secret } from '@pulumi/pulumi';

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
          type: 'g6-standard-4',
          count: 1,
        },
      ],
    },
    { ignoreChanges: ['k8sVersion', 'pools'] },
  );

  return {
    kubeconfig: secret(cluster.kubeconfig).apply((base64data) =>
      base64data ? Buffer.from(base64data, 'base64').toString('utf-8') : '',
    ),
    clusterName: cluster.label,
    contextName: pulumi.interpolate`lke${cluster.id}-ctx`,
  };
}
