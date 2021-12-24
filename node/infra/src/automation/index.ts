import {
  ConfigMap,
  LocalProgramArgs,
  LocalWorkspace,
  Stack,
} from '@pulumi/pulumi/automation';
import { YZX } from '@frielforreal/yzx';
import chalk from 'chalk';
import pLimit from 'p-limit';

import { INFRA_DIR } from '../../index.js';
import {
  getOutputProjectName,
  StackModule,
  StackOutputMap,
} from '../lib/stackModule';
import * as gkeClusterModule from '../stacks/gke-cluster/stack';
import * as k8sTrifectaModule from '../stacks/k8s-trifecta/stack';
import * as k8sIstioEndpointDiscoveryModule from '../stacks/k8s-istio-endpoint-discovery/stack';
import * as gcpProjectModule from '../stacks/gcp-project/stack';
import * as azureClusterModule from '../stacks/azure-cluster/stack';
import * as linodeClusterModule from '../stacks/linode-cluster/stack';
import * as doClusterModule from '../stacks/do-cluster/stack';
import { KubernetesCloudProvider } from '../lib/config';

import { outputFormatter } from './outputFormatter';

const STACK_NAME = process.env.STACK_NAME ?? 'dev';
const DRY_RUN = process.env.DRY_RUN === 'false' ? false : true;

/**
 * Commands that interact with kube config should run in closures invoked by this function, to
 * ensure that no race conditions occur editing the config file.
 */
const kubeCriticalSection = pLimit(1);

interface StackUpResult<T> {
  stack: Stack;
  projectName: string;
  outputs: StackOutputMap<T>;
}

export async function stackUp<T extends StackModule<unknown>>({
  sharedProject,
  stackModule,
  stackName = STACK_NAME,
  dryrun = DRY_RUN,
  additionalConfig,
}: {
  sharedProject: Stack;
  stackModule: T;
  stackName?: string;
  dryrun?: boolean;
  additionalConfig: ConfigMap;
}): Promise<StackUpResult<T>> {
  const formatter = outputFormatter(`${stackModule.projectName}/${stackName}`);

  const localProgramArgs: LocalProgramArgs = {
    stackName,
    workDir: stackModule.workDir,
  };
  const stack = await LocalWorkspace.createOrSelectStack(localProgramArgs, {
    projectSettings: {
      name: stackModule.projectName,
      runtime: 'nodejs',
    },
  });
  formatter(`Spinning up stack ${stackModule.projectName}/${stackName}`);
  const sharedConfig = await sharedProject.getAllConfig();
  await stack.setAllConfig({
    ...sharedConfig,
    ...additionalConfig,
  });

  formatter('Refreshing');
  await stack.refresh();

  if (dryrun) {
    const outputs = await stack.outputs();
    return {
      stack,
      projectName: stackModule.projectName,
      outputs: outputs as StackOutputMap<T>,
    };
  }
  formatter('Deploying');
  const result = await stack.up();

  if (result.summary.result !== 'succeeded') {
    formatter(result.stdout);
    formatter(result.stderr);
    throw new Error(result.summary.message);
  }

  formatter('Succeeded! Resource summary:');
  const fmtNum = (num?: number) => `${num}`.padStart(3);
  const changes = result.summary.resourceChanges;
  if (changes?.create) {
    formatter(`${fmtNum(changes?.create)} ${chalk.green('created')}`);
  }
  if (changes?.replace) {
    formatter(`${fmtNum(changes?.replace)} ${chalk.magenta('replaced')}`);
  }
  if (changes?.update) {
    formatter(`${fmtNum(changes?.update)} ${chalk.yellow('updated')}`);
  }
  if (changes?.same) {
    formatter(`${fmtNum(changes?.same)} ${chalk.bold('unchanged')}`);
  }

  return {
    stack,
    projectName: stackModule.projectName,
    outputs: result.outputs as StackOutputMap<T>,
  };
}

export async function stackPreview<T extends StackModule<unknown>>(
  stackModule: T,
  stackName: string = STACK_NAME,
) {
  const stack = await LocalWorkspace.createOrSelectStack({
    stackName,
    workDir: stackModule.workDir,
  });

  const formatter = outputFormatter(`${stackModule}/${stackName}`);
  await stack.preview({ onOutput: formatter });

  return {
    stack,
    projectName: stackModule.projectName,
    outputs: (await stack.outputs()) as StackOutputMap<T>,
  };
}

interface ClusterUpResult {
  kubeContext?: string;
}

async function main() {
  console.log('Hello multi-cloud!');
  const sharedProject = await LocalWorkspace.createOrSelectStack({
    stackName: STACK_NAME,
    workDir: INFRA_DIR,
  });
  const results = await Promise.allSettled<Promise<ClusterUpResult>[]>([
    gcpUp(sharedProject),
    azureUp(sharedProject),
    digitalOceanUp(sharedProject),
    linodeUp(sharedProject),
  ]);

  const errors = results.filter(
    (x): x is PromiseRejectedResult => x.status === 'rejected',
  );

  if (errors.length > 0) {
    for (const { reason } of errors) {
      console.error(reason);
    }

    throw new Error(errors.map((x) => x.reason.toString()).join('\n'));
  }

  const outputs = results
    .filter(
      <T>(x: PromiseSettledResult<T>): x is PromiseFulfilledResult<T> =>
        x.status === 'fulfilled' && x.value !== undefined,
    )
    .map((x) => x.value);

  const mergeConfigOutputs = makeMergeConfigOutputs(sharedProject);
  const istioEndpointDiscoveryResult = await stackUp({
    sharedProject,
    stackModule: k8sIstioEndpointDiscoveryModule,
    additionalConfig: {
      [`${k8sIstioEndpointDiscoveryModule.projectName}:contexts`]: {
        value: JSON.stringify(outputs.map((x) => x?.kubeContext)),
      },
    },
  });
  await mergeConfigOutputs(istioEndpointDiscoveryResult);
}

async function azureUp(sharedProject: Stack): Promise<ClusterUpResult> {
  if (process.env.SKIP) {
    return {};
  }

  const additionalConfig: ConfigMap = {};

  const mergeConfigOutputs = makeMergeConfigOutputs(sharedProject);

  const azureClusterResult = await stackUp({
    sharedProject,
    stackModule: azureClusterModule,
    additionalConfig: {},
  });
  await mergeConfigOutputs(azureClusterResult);

  const subscriptionId = azureClusterResult.outputs.subscriptionId.value;
  const resourceGroupName = azureClusterResult.outputs.resourceGroupName.value;
  const clusterName = azureClusterResult.outputs.clusterName.value;
  const contextName = clusterName;

  await kubeCriticalSection(async () => {
    await YZX()`kubectl config get-contexts ${contextName}`.catch(async () => {
      console.info(`Getting credentials for GKE cluster ${clusterName}`);
      await YZX()`az aks get-credentials --subscription ${subscriptionId}  --resource-group ${resourceGroupName} --name ${clusterName}`;
    });
  });

  additionalConfig['kubernetes:context'] = { value: contextName };
  additionalConfig['kubernetes:cloudProvider'] = {
    value: 'azure' as KubernetesCloudProvider,
  };

  const k8sTrifectaResult = await stackUp({
    sharedProject,
    stackModule: k8sTrifectaModule,
    stackName: `${STACK_NAME}-azure-${clusterName}`,
    additionalConfig,
  });
  await mergeConfigOutputs(k8sTrifectaResult);

  return {
    kubeContext: contextName,
  };
}

async function digitalOceanUp(sharedProject: Stack): Promise<ClusterUpResult> {
  if (process.env.SKIP) {
    return {};
  }

  const additionalConfig: ConfigMap = {};

  const mergeConfigOutputs = makeMergeConfigOutputs(sharedProject);

  const doClusterResult = await stackUp({
    sharedProject,
    stackModule: doClusterModule,
    additionalConfig: {},
  });
  await mergeConfigOutputs(doClusterResult);

  const clusterName = doClusterResult.outputs.clusterName.value;
  const region = doClusterResult.outputs.region.value;
  const contextName = `do-${region}-${clusterName}`;

  await kubeCriticalSection(async () => {
    await YZX()`kubectl config get-contexts ${contextName}`.catch(async () => {
      console.info(`Getting credentials for GKE cluster ${clusterName}`);
      await YZX()`doctl kubernetes cluster kubeconfig save ${clusterName}`;
    });
  });
  additionalConfig['kubernetes:context'] = { value: contextName };
  additionalConfig['kubernetes:cloudProvider'] = {
    value: 'digitalocean' as KubernetesCloudProvider,
  };

  const k8sTrifectaResult = await stackUp({
    sharedProject,
    stackModule: k8sTrifectaModule,
    stackName: `${STACK_NAME}-do-${clusterName}`,
    additionalConfig,
  });
  await mergeConfigOutputs(k8sTrifectaResult);

  return {
    kubeContext: contextName,
  };
}

async function gcpUp(sharedProject: Stack): Promise<ClusterUpResult> {
  const additionalConfig: ConfigMap = {};

  const mergeConfigOutputs = makeMergeConfigOutputs(sharedProject);

  const gcpProject = await stackUp({
    sharedProject,
    stackModule: gcpProjectModule,
    additionalConfig,
  });

  const projectId = gcpProject.outputs.projectId.value;

  if (gcpProject.outputs.projectId) {
    additionalConfig['gcp:project'] = gcpProject.outputs.projectId;
  }

  const gkeClusterResult = await stackUp({
    sharedProject,
    stackModule: gkeClusterModule,
    additionalConfig,
  });
  await mergeConfigOutputs(gkeClusterResult);

  const clusterName = gkeClusterResult.outputs.name.value;
  const locationType:
    | '--zone'
    | '--region' = `--${gkeClusterResult.outputs.locationType.value}`;
  const location = gkeClusterResult.outputs.location.value;
  const contextName = `gke_${projectId}_${location}_${clusterName}`;

  await kubeCriticalSection(async () => {
    await YZX()`kubectl config get-contexts ${contextName}`.catch(async () => {
      console.info(`Getting credentials for GKE cluster ${clusterName}`);
      await YZX()`gcloud --project ${projectId} container clusters get-credentials ${clusterName} ${locationType} ${location}`;
    });
  });
  additionalConfig['kubernetes:context'] = { value: contextName };
  additionalConfig['kubernetes:cloudProvider'] = {
    value: 'gke' as KubernetesCloudProvider,
  };

  const k8sTrifectaResult = await stackUp({
    sharedProject,
    stackModule: k8sTrifectaModule,
    stackName: `${STACK_NAME}-gcp-${clusterName}`,
    additionalConfig,
  });
  await mergeConfigOutputs(k8sTrifectaResult);

  return {
    kubeContext: contextName,
  };
}

async function linodeUp(sharedProject: Stack): Promise<ClusterUpResult> {
  const additionalConfig: ConfigMap = {};

  const mergeConfigOutputs = makeMergeConfigOutputs(sharedProject);

  const linodeClusterResult = await stackUp({
    sharedProject,
    stackModule: linodeClusterModule,
    additionalConfig: {},
  });
  await mergeConfigOutputs(linodeClusterResult);

  let kubeconfig = linodeClusterResult.outputs.kubeconfig.value;
  kubeconfig = Buffer.from(kubeconfig, 'base64').toString('utf-8');
  const contextName = linodeClusterResult.outputs.contextName.value;
  const clusterName = linodeClusterResult.outputs.clusterName.value;

  await mergeKubeConfig(kubeconfig);

  additionalConfig['kubernetes:context'] = { value: contextName };
  additionalConfig['kubernetes:cloudProvider'] = {
    value: 'lke' as KubernetesCloudProvider,
  };

  const k8sTrifectaResult = await stackUp({
    sharedProject,
    stackModule: k8sTrifectaModule,
    stackName: `${STACK_NAME}-${clusterName}`,
    additionalConfig,
  });
  await mergeConfigOutputs(k8sTrifectaResult);

  return {
    kubeContext: contextName,
  };
}

const makeMergeConfigOutputs =
  (sharedProject: Stack) =>
  async <T>(result: StackUpResult<T>) => {
    for (const [key, entry] of Object.entries(result.outputs)) {
      if (entry?.value !== undefined) {
        await sharedProject.setConfig(
          `${getOutputProjectName(result.projectName)}:${key}`,
          {
            value: entry.value,
            secret: entry.secret,
          },
        );
      }
    }
  };

main();
async function mergeKubeConfig(kubeconfig: string) {
  await kubeCriticalSection(async () => {
    const $ = YZX();
    $.verbose = false;
    $`
KUBECONFIG_DEFAULT="$HOME/.kube/config"
TMPCONFIG=$(mktemp)
TMPOUTPUT=$(mktemp)
echo -n ${kubeconfig} > "$TMPCONFIG"
KUBECONFIG="$KUBECONFIG_DEFAULT:$TMPCONFIG" kubectl config view --flatten > $TMPOUTPUT
mv $TMPOUTPUT $KUBECONFIG_DEFAULT
rm $TMPCONFIG
`;
  });
}
