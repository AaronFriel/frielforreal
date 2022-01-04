import * as pulumi from '@pulumi/pulumi';
import { all, output } from '@pulumi/pulumi';

import { INFRA_DIR } from '../../dir';
import { CloudKubernetesProvider } from '../lib/cloudConfig';
import { mergeKubeConfigStrings } from '../lib/kubectl';
import { LocalPulumiProgram } from '../lib/LocalPulumiProgram';
import { MeshConfig } from '../lib/meshConfig';
import * as aksClusterStack from '../stacks/azure-cluster/stack';
import * as doClusterStack from '../stacks/do-cluster/stack';
import * as gcpProjectStack from '../stacks/gcp-project/stack';
import * as gkeClusterStack from '../stacks/gke-cluster/stack';
import * as k8sLinkerdMeshStack from '../stacks/k8s-linkerd-mesh/stack';
import * as k8sTailscaleStack from '../stacks/k8s-tailscale/stack';
import * as k8sTrifectaStack from '../stacks/k8s-trifecta/stack';
import * as linodeClusterStack from '../stacks/linode-cluster/stack';

interface ClusterConfigBase {
  name: string;
  provider: CloudKubernetesProvider;
  tailscalePort: number;
  result?: ClusterResult;
}

interface GkeCluster extends ClusterConfigBase {
  provider: 'gke';
  region: string;
  zone?: 'a' | 'b' | 'c';
}

interface LkeCluster extends ClusterConfigBase {
  provider: 'lke';
  region: string;
}

interface DigitalOceanCluster extends ClusterConfigBase {
  provider: 'digitalocean';
  region: string;
}

interface AksCluster extends ClusterConfigBase {
  provider: 'aks';
  location: string;
}

type ClusterConfig = GkeCluster | AksCluster | LkeCluster | DigitalOceanCluster;

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
      name: 'absolute-weevil',
      provider: 'lke',
      region: 'us-central',
      tailscalePort: 63002,
    },
    {
      name: 'fit-loon',
      provider: 'digitalocean',
      region: 'sfo3',
      tailscalePort: 63004,
    },
    {
      name: 'frank-grub',
      provider: 'aks',
      location: 'northcentralus',
      tailscalePort: 63005,
    },
  ];

  clusters.forEach((cluster) => {
    switch (cluster.provider) {
      case 'gke':
        return gkeCluster(rootConfig, cluster);
      // case 'aks':
      //   throw new Error('Not yet implemented');
      case 'digitalocean':
        return digitalOceanCluster(rootConfig, cluster);
      case 'lke':
        return lkeCluster(rootConfig, cluster);
      case 'aks':
        return aksCluster(rootConfig, cluster);
      default:
        assertUnreachable(cluster, 'Unreachable');
    }
  });

  const deployedClusters = clusters.filter(
    (x): x is ClusterConfig & { result: ClusterResult } =>
      x.result !== undefined,
  );

  const meshConfig = all(deployedClusters).apply((cs) => {
    const meshConfigs: MeshConfig[] = cs.map((c) => ({
      clusterName: c.result.clusterName,
      istioRemoteSecretData: c.result.istioRemoteSecretData,
      tailscalePort: c.result.tailscalePort,
      linkerdGatewayFqdn: c.result.linkerdGatewayFqdn,
      linkerdRemoteSecretData: c.result.linkerdRemoteSecretData,
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

    new LocalPulumiProgram(`${clusterName}-linkerd-mesh`, k8sLinkerdMeshStack, {
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
  linkerdRemoteSecretData: pulumi.Output<string | undefined>;
  linkerdGatewayFqdn: pulumi.Output<string | undefined>;
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
    clusterName,
    kubeconfig: gkeCluster.stackOutputs.kubeconfig,
    istioRemoteSecretData: k8sTrifecta.stackOutputs.istioRemoteSecretData.value,
    linkerdRemoteSecretData:
      k8sTrifecta.stackOutputs.linkerdRemoteSecretData.value,
    linkerdGatewayFqdn: k8sTrifecta.stackOutputs.linkerdGatewayFqdn.value,
    tailscalePort: cluster.tailscalePort,
    clusterConfig: output(localConfig),
  };
}

function lkeCluster(
  rootConfig: pulumi.automation.ConfigMap,
  cluster: LkeCluster,
) {
  const { name: clusterName, region } = cluster;
  const contextName = `linode-${region}-${clusterName}`;

  let localConfig: pulumi.Input<InputConfigMap> = {
    ...rootConfig,
    [`${linodeClusterStack.projectName}:region`]: { value: region },
    'cloud:kubernetesProvider': { value: 'lke' as CloudKubernetesProvider },
    'cloud:clusterName': { value: clusterName },
    'cloud:contextName': { value: contextName },
  };

  const lkeCluster = new LocalPulumiProgram(
    `${clusterName}-lke-cluster`,
    linodeClusterStack,
    {
      stackName: clusterName,
      config: localConfig,
    },
  );

  localConfig = mergeConfig(localConfig, {
    'kubernetes:kubeconfig': lkeCluster.stackOutputs.kubeconfig,
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
    clusterName,
    kubeconfig: lkeCluster.stackOutputs.kubeconfig,
    istioRemoteSecretData: k8sTrifecta.stackOutputs.istioRemoteSecretData.value,
    linkerdRemoteSecretData:
      k8sTrifecta.stackOutputs.linkerdRemoteSecretData.value,
    linkerdGatewayFqdn: k8sTrifecta.stackOutputs.linkerdGatewayFqdn.value,
    tailscalePort: cluster.tailscalePort,
    clusterConfig: output(localConfig),
  };
}

function digitalOceanCluster(
  rootConfig: pulumi.automation.ConfigMap,
  cluster: DigitalOceanCluster,
) {
  const { name: clusterName, region } = cluster;
  const contextName = `digitalocean-${region}-${clusterName}`;

  let localConfig: pulumi.Input<InputConfigMap> = {
    ...rootConfig,
    [`${doClusterStack.projectName}:region`]: { value: region },
    'cloud:kubernetesProvider': {
      value: 'digitalocean' as CloudKubernetesProvider,
    },
    'cloud:clusterName': { value: clusterName },
    'cloud:contextName': { value: contextName },
  };

  const doCluster = new LocalPulumiProgram(
    `${clusterName}-do-cluster`,
    doClusterStack,
    {
      stackName: clusterName,
      config: localConfig,
    },
  );

  localConfig = mergeConfig(localConfig, {
    'kubernetes:kubeconfig': doCluster.stackOutputs.kubeconfig,
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
    clusterName,
    kubeconfig: doCluster.stackOutputs.kubeconfig,
    istioRemoteSecretData: k8sTrifecta.stackOutputs.istioRemoteSecretData.value,
    linkerdRemoteSecretData:
      k8sTrifecta.stackOutputs.linkerdRemoteSecretData.value,
    linkerdGatewayFqdn: k8sTrifecta.stackOutputs.linkerdGatewayFqdn.value,
    tailscalePort: cluster.tailscalePort,
    clusterConfig: output(localConfig),
  };
}

function aksCluster(
  rootConfig: pulumi.automation.ConfigMap,
  cluster: AksCluster,
) {
  const { name: clusterName, location } = cluster;
  const contextName = `aks-${location}-${clusterName}`;

  let localConfig: pulumi.Input<InputConfigMap> = {
    ...rootConfig,
    [`${aksClusterStack.projectName}:location`]: { value: location },
    'cloud:kubernetesProvider': {
      value: 'aks' as CloudKubernetesProvider,
    },
    'cloud:clusterName': { value: clusterName },
    'cloud:contextName': { value: contextName },
  };

  const aksCluster = new LocalPulumiProgram(
    `${clusterName}-aks-cluster`,
    aksClusterStack,
    {
      stackName: clusterName,
      config: localConfig,
    },
  );

  localConfig = mergeConfig(localConfig, {
    'kubernetes:kubeconfig': aksCluster.stackOutputs.kubeconfig,
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
    clusterName,
    kubeconfig: aksCluster.stackOutputs.kubeconfig,
    istioRemoteSecretData: k8sTrifecta.stackOutputs.istioRemoteSecretData.value,
    linkerdRemoteSecretData:
      k8sTrifecta.stackOutputs.linkerdRemoteSecretData.value,
    linkerdGatewayFqdn: k8sTrifecta.stackOutputs.linkerdGatewayFqdn.value,
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
