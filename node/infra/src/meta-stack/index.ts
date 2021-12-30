import * as pulumi from '@pulumi/pulumi';
import { all, output } from '@pulumi/pulumi';

import { INFRA_DIR } from '../../dir';
import { CloudKubernetesProvider } from '../lib/cloudConfig';
import { LocalPulumiProgram } from '../lib/LocalPulumiProgram';
import { mergeKubeConfigStrings } from '../lib/kubectl';
import { MeshConfig } from '../lib/meshConfig';
import * as gcpProjectStack from '../stacks/gcp-project/stack';
import * as gkeClusterStack from '../stacks/gke-cluster/stack';
import * as k8sTrifectaStack from '../stacks/k8s-trifecta/stack';
import * as k8sTailscaleStack from '../stacks/k8s-tailscale/stack';
import * as k8sIstioMeshStack from '../stacks/k8s-istio-mesh/stack';

interface ClusterConfigBase {
  name: string;
  tailscalePort: number;
  result?: ClusterResult;
}

interface GkeCluster extends ClusterConfigBase {
  provider: CloudKubernetesProvider;
  region: string;
  zone?: 'a' | 'b' | 'c';
}

type ClusterConfig = GkeCluster;
export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const currentStack = await pulumi.automation.LocalWorkspace.selectStack({
    stackName: pulumi.getStack(),
    workDir: INFRA_DIR,
  });

  const rootConfig = await currentStack.getAllConfig();

  const clusters: ClusterConfig[] = [
    {
      name: 'healthy-blowfish',
      provider: 'gke',
      region: 'us-west1',
      zone: 'a',
      tailscalePort: 63000,
    },
    {
      name: 'evolving-hen',
      provider: 'gke',
      region: 'us-central1',
      zone: 'b',
      tailscalePort: 63001,
    },
  ];

  output(
    clusters.map(async (cluster) => {
      switch (cluster.provider) {
        case 'gke':
          return await gkeCluster(rootConfig, cluster);
        case 'aks':
          throw new Error('Not yet implemented');
        case 'digitalocean':
          throw new Error('Not yet implemented');
        case 'lke':
          throw new Error('Not yet implemented');
        default:
          assertUnreachable(cluster.provider, 'Unreachable');
      }
    }),
  );

  const deployedClusters = clusters.filter(
    (x): x is ClusterConfig & { result: ClusterResult } =>
      x.result !== undefined,
  );

  const meshConfig = all(deployedClusters).apply((cs) => {
    const meshConfigs: MeshConfig[] = cs.map((c) => ({
      clusterName: c.result.clusterName,
      istioRemoteSecretData: c.result.istioRemoteSecretData,
      tailscalePort: c.result.tailscalePort,
    }));

    return {
      ...rootConfig,
      'mesh:clusters': {
        value: JSON.stringify(meshConfigs),
        secret: true,
      },
    };
  });

  for (const cluster of deployedClusters) {
    const { clusterName, clusterConfig } = cluster.result;
    const localConfig = mergeConfig(clusterConfig, meshConfig);
    new LocalPulumiProgram(`${clusterName}-tailscale`, k8sTailscaleStack, {
      stackName: clusterName,
      config: localConfig,
    });

    new LocalPulumiProgram(`${clusterName}-istio-mesh`, k8sIstioMeshStack, {
      stackName: clusterName,
      config: localConfig,
    });
  }

  return {
    clusters: deployedClusters.map(
      ({ result: { clusterName, contextName } }) => ({
        clusterName,
        contextName,
      }),
    ),
    kubeconfig: pulumi
      .secret(
        deployedClusters.map(({ result: { kubeconfig } }) => kubeconfig.value),
      )
      .apply(mergeKubeConfigStrings),
    istioRemoteSecrets: pulumi
      .secret(
        deployedClusters.map(
          ({ result: { istioRemoteSecretData } }) => istioRemoteSecretData,
        ),
      )
      .apply(mergeKubeConfigStrings),
  };
}

export type InputConfigMap = {
  [key: string]: pulumi.Input<pulumi.automation.ConfigValue>;
};

interface ClusterResult {
  clusterName: string;
  contextName: string;
  kubeconfig: pulumi.Output<pulumi.automation.ConfigValue>;
  istioRemoteSecretData: pulumi.Output<string>;
  tailscalePort: number;
  clusterConfig: pulumi.Output<InputConfigMap>;
}
function gkeCluster(
  rootConfig: pulumi.automation.ConfigMap,
  cluster: GkeCluster,
) {
  const { name: clusterName, region, zone } = cluster;
  const location = zone ? `${region}-${zone}` : region;
  const contextName = `gcp-${location}-${clusterName}`;

  let localConfig: pulumi.Input<InputConfigMap> = {
    ...rootConfig,
    'gcp:region': { value: region },
    'google-native:region': { value: region },
    'infra-gke-cluster:location': { value: location },
    'infra-gke-cluster:locationType': { value: zone ? 'zone' : 'region' },
    'cloud:kubernetesProvider': { value: 'gke' as CloudKubernetesProvider },
    'cloud:clusterName': { value: clusterName },
    'cloud:contextName': { value: contextName },
  };
  if (zone) {
    localConfig['gcp:zone'] = { value: `${region}-${zone}` };
    localConfig['google-native:zone'] = { value: `${region}-${zone}` };
  }

  const gcpProject = new LocalPulumiProgram(
    `${clusterName}-gcp-project`,
    gcpProjectStack,
    {
      stackName: clusterName,
      config: localConfig,
    },
  );

  localConfig = mergeConfig(localConfig, {
    'gcp:project': gcpProject.stackOutputs.projectId,
    'google-native:project': gcpProject.stackOutputs.projectId,
  });

  const gkeCluster = new LocalPulumiProgram(
    `${clusterName}-gke-cluster`,
    gkeClusterStack,
    {
      stackName: clusterName,
      config: localConfig,
    },
  );

  localConfig = mergeConfig(localConfig, {
    'kubernetes:kubeconfig': gkeCluster.stackOutputs.kubeconfig,
    'cloud:gkeNodeTag': gkeCluster.stackOutputs.nodeTag,
    'cloud:gkeNetwork': gkeCluster.stackOutputs.network,
  });

  const k8sTrifecta = new LocalPulumiProgram(
    `${clusterName}-k8s-trifecta`,
    k8sTrifectaStack,
    {
      stackName: clusterName,
      config: localConfig,
    },
  );

  cluster.result = {
    contextName,
    clusterName: clusterName,
    kubeconfig: gkeCluster.stackOutputs.kubeconfig,
    istioRemoteSecretData: k8sTrifecta.stackOutputs.istioRemoteSecretData.value,
    tailscalePort: cluster.tailscalePort,
    clusterConfig: output(localConfig),
  };
}

function mergeConfig(
  localConfig: pulumi.Input<InputConfigMap>,
  additionalConfig: pulumi.Input<InputConfigMap>,
): pulumi.Output<InputConfigMap> {
  return pulumi
    .output({ localConfig, additionalConfig })
    .apply(({ localConfig, additionalConfig }) => ({
      ...localConfig,
      ...additionalConfig,
    }));
}

function assertUnreachable(_: never, message: string): never {
  throw new Error(message);
}
