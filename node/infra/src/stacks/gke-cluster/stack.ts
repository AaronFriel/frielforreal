import { Cluster, NodePool } from '@pulumi/gcp/container';
import { KeyRing, CryptoKey, KeyRingIAMBinding } from '@pulumi/gcp/kms';
import { Project } from '@pulumi/gcp/organizations';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import moment = require('moment');
import * as publicIp from 'public-ip';

import { getConfig } from '../../lib/config';
import { assertOutputNonNull } from '../../lib/output';

export const workDir = __dirname;
export const projectName = 'infra-gke-cluster';

type NodePoolConfig = {
  name: string;
  machineType: string;
  initialNodeCount?: number;
};

export function stackConfig() {
  const config = new pulumi.Config(projectName);

  return {
    masterIpv4CidrBlock: config.require('masterIpv4CidrBlock'),
    location: config.require('location'),
    locationType: config.require('locationType') as 'zone' | 'region',
    nodePools: config.requireObject<NodePoolConfig[]>('nodePools'),
  };
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const localConfig = stackConfig();
  const globalConfig = getConfig();

  const gkeNodeTagSuffix = new random.RandomId('gke-node-tag', {
    byteLength: 8,
  }).hex;
  const nodeTag = pulumi.interpolate`gke-nodes-${gkeNodeTagSuffix}`;

  const ipv4Ip = await publicIp.v4();
  const boundKey = gkeKmsKey();

  const gkeCluster = new Cluster(
    'cluster',
    {
      location: localConfig.location,
      releaseChannel: { channel: 'REGULAR' },
      loggingConfig: {
        enableComponents: ['SYSTEM_COMPONENTS', 'WORKLOADS'],
      },
      monitoringConfig: {
        enableComponents: ['SYSTEM_COMPONENTS'],
      },
      networkingMode: 'VPC_NATIVE',
      ipAllocationPolicy: {},
      datapathProvider: 'ADVANCED_DATAPATH',
      databaseEncryption: {
        state: 'ENCRYPTED',
        keyName: boundKey,
      },
      privateClusterConfig: {
        enablePrivateEndpoint: false,
        enablePrivateNodes: true,
        masterIpv4CidrBlock: localConfig.masterIpv4CidrBlock,
      },
      masterAuthorizedNetworksConfig: {
        cidrBlocks: [
          {
            displayName: 'local-ip',
            cidrBlock: `${ipv4Ip}/32`,
          },
        ],
      },
      removeDefaultNodePool: true,
      initialNodeCount: 1,
    },
    { ignoreChanges: ['nodePools', 'nodeConfig'] },
  );

  for (const nodePoolConfig of localConfig.nodePools) {
    new NodePool(
      nodePoolConfig.name,
      {
        cluster: gkeCluster.name,
        location: localConfig.location,
        initialNodeCount: nodePoolConfig.initialNodeCount,
        nodeConfig: {
          imageType: 'cos_containerd',
          machineType: nodePoolConfig.machineType,
          tags: [nodeTag],
        },
      },
      { ignoreChanges: ['initialNodeCount'] },
    );
  }

  const contextName =
    globalConfig.cloud().contextName ??
    pulumi.interpolate`gke-${gkeCluster.name}`;

  const kubeconfig = pulumi
    .secret(
      pulumi.interpolate`
apiVersion: v1
kind: Config
clusters:
- name: gke-${contextName}
  cluster:
    server: https://${gkeCluster.endpoint}
    certificate-authority-data: ${gkeCluster.masterAuth.clusterCaCertificate}
users:
- name: gke-${contextName}
  user:
    auth-provider:
      name: gcp
contexts:
- context:
    cluster: gke-${contextName}
    user: gke-${contextName}
  name: gke-${contextName}
current-context: gke-${contextName}
`,
    )
    .apply((x) => x.trim());

  return {
    name: gkeCluster.name,
    location: gkeCluster.location,
    locationType: localConfig.locationType,
    project: gkeCluster.project,
    authorizedIp: ipv4Ip,
    network: assertOutputNonNull(gkeCluster.network),
    kubeconfig,
    nodeTag,
  };
}

function gkeKmsKey() {
  const config = getConfig();
  const gcpConfig = config.gcp();

  const currentProject = Project.get('current-project', gcpConfig.project);

  const keyring = new KeyRing('gke-keyring', {
    location: gcpConfig.region,
  });

  const key = new CryptoKey('gke-key', {
    keyRing: keyring.id,
    rotationPeriod: `${moment.duration({ days: 30 }).asSeconds()}s`,
    purpose: 'ENCRYPT_DECRYPT',
  });

  const keyBinding = new KeyRingIAMBinding('gke-key-binding', {
    keyRingId: keyring.id,
    members: [
      pulumi.interpolate`serviceAccount:service-${currentProject.number}@container-engine-robot.iam.gserviceaccount.com`,
    ],
    role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
  });

  // Bind the key ID and keybinding together, to ensure that anything that depends on the key waits for the IAM binding.
  const boundKey = pulumi.all([key.id, keyBinding.id])[0];
  return boundKey;
}
