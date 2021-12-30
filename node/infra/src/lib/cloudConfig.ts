import * as pulumi from '@pulumi/pulumi';

export function cloudConfig(): CloudProviderConfig {
  const cloudConfig = new pulumi.Config('cloud');

  const kubernetesProvider = cloudConfig.get('kubernetesProvider', {
    allowedValues: ['aks', 'digitalocean', 'gke', 'lke'],
  });

  if (kubernetesProvider === 'gke') {
    return {
      kubernetesProvider,
      clusterName: cloudConfig.require('clusterName'),
      contextName: cloudConfig.require('contextName'),
      gkeNodeTag: cloudConfig.get('gkeNodeTag'),
      gkeNetwork: cloudConfig.get('gkeNetwork'),
    };
  }

  return {
    kubernetesProvider,
    clusterName: cloudConfig.require('clusterName'),
  };
}

export type CloudKubernetesProvider = 'aks' | 'gke' | 'digitalocean' | 'lke';

export interface CloudConfigBase<K> {
  clusterName: string;
  kubernetesProvider?: K;
  contextName?: string;
}

export interface GkeCloudConfig extends CloudConfigBase<'gke'> {
  gkeNetwork?: string;
  gkeNodeTag?: string;
}

export type CloudProviderConfig =
  | GkeCloudConfig
  | CloudConfigBase<Exclude<CloudKubernetesProvider, 'gke'>>;
