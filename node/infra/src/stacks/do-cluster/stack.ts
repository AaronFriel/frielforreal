import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import { RandomId } from '@pulumi/random';

import { getConfig } from '../../lib/config';
import { rewriteKubeconfig } from '../../lib/kubectl';

export const workDir = __dirname;
export const projectName = 'infra-do-cluster';

function stackConfig() {
  const config = new pulumi.Config();

  return {
    region: config.require('region'),
  };
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { contextName } = getConfig().cloud();

  const { region } = stackConfig();

  const defaultPoolSuffix = new RandomId('default-pool-suffix', {
    byteLength: 8,
  }).hex;

  const cluster = new digitalocean.KubernetesCluster(
    'cluster',
    {
      nodePool: {
        name: pulumi.interpolate`default-${defaultPoolSuffix}`,
        size: 's-2vcpu-4gb',
        nodeCount: 1,
      },
      region,
      autoUpgrade: true,
      version: '1.21.5-do.0',
      surgeUpgrade: true,
    },
    { ignoreChanges: ['version', 'nodePool', 'name'] },
  );

  const kubeconfig = pulumi.secret(
    cluster.kubeConfigs[0].rawConfig.apply((kubeconfig) =>
      rewriteKubeconfig(kubeconfig, contextName),
    ),
  );

  return { clusterName: cluster.name, region: cluster.region, kubeconfig };
}
