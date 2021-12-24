import * as pulumi from '@pulumi/pulumi';
import * as linode from '@pulumi/linode';
import { RandomPet } from '@pulumi/random';
import { secret } from '@pulumi/pulumi';

export const workDir = __dirname;
export const projectName = 'infra-linode-cluster';

export function config() {
  return {};
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const label = new RandomPet('cluster-label', {
    separator: '-',
    length: 2,
    prefix: 'lke',
  }).id;

  const cluster = new linode.LkeCluster('cluster', {
    k8sVersion: '1.22',
    label,
    region: 'us-central',
    controlPlane: {
      highAvailability: false,
    },
    pools: [
      {
        type: 'g6-dedicated-2',
        count: 1,
      },
    ],
  });

  return {
    kubeconfig: secret(cluster.kubeconfig),
    clusterName: cluster.label,
    contextName: pulumi.interpolate`lke${cluster.id}-ctx`,
  };
}
