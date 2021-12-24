import * as pulumi from '@pulumi/pulumi';

import * as gcpProject from '../stacks/gcp-project/stack';
import * as gkeCluster from '../stacks/gke-cluster/stack';
import * as k8sTrifecta from '../stacks/k8s-trifecta/stack';

import {
  getOutputProjectName,
  StackModule,
  StackOutputGetter,
  StackOutputValues,
} from './stackModule';

const k8sConfig = new pulumi.Config('kubernetes');
const gcpConfig = new pulumi.Config('gcp');

export type Config = ReturnType<typeof getConfig>;

function stackOutputConfig<T extends StackModule<unknown>>(
  stackModule: T,
): StackOutputGetter<T> {
  type Outputs = StackOutputValues<T>;

  const config = new pulumi.Config(
    getOutputProjectName(stackModule.projectName),
  );

  return <K extends keyof Outputs & string>(key: K): Outputs[K] => {
    return config.require(key) as Outputs[K];
  };
}

export const getGkeClusterOutputs = () => stackOutputConfig(gkeCluster);

export type KubernetesCloudProvider = 'aks' | 'gke' | 'digitalocean' | 'lke';

export function getConfig() {
  if (!pulumi.runtime.hasEngine()) {
    throw new Error('Config is not available outside of Pulumi context.');
  }

  return {
    gcp: {
      project: gcpConfig.get('project'),
      zone: gcpConfig.require('zone'),
      region: gcpConfig.require('region'),
    },
    k8s: {
      context: k8sConfig.get('context'),
      cloudProvider: k8sConfig.get<KubernetesCloudProvider>('cloudProvider'),
    },
    gcpProject: gcpProject.config(),
    gkeCluster: gkeCluster.config(),
    k8sTrifectaConfig: k8sTrifecta.config(),
  };
}
