import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import { Cluster, NodePool } from '@pulumi/gcp/container';
import { Project } from '@pulumi/gcp/organizations';
import { KeyRing, CryptoKey, KeyRingIAMBinding } from '@pulumi/gcp/kms';
import * as publicIp from 'public-ip';
import moment = require('moment');

import { getConfig } from '../../lib/config';

export const workDir = __dirname;
export const projectName = 'infra-gke-cluster';

type NodePoolConfig = {
  name: string;
  machineType: string;
  initialNodeCount?: number;
};

export function config() {
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

  const config = getConfig();

  const gkeNodeTagSuffix = new random.RandomId('gke-node-tag', {
    byteLength: 8,
  }).hex;
  const gkeNodeTag = pulumi.interpolate`gke-nodes-${gkeNodeTagSuffix}`;

  const ipv4Ip = await publicIp.v4();
  const boundKey = gkeKmsKey();

  const gkeCluster = new Cluster(
    'cluster',
    {
      location: config.gkeCluster.location,
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
        masterIpv4CidrBlock: config.gkeCluster.masterIpv4CidrBlock,
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

  for (const nodePoolConfig of config.gkeCluster.nodePools) {
    new NodePool(
      nodePoolConfig.name,
      {
        cluster: gkeCluster.name,
        location: config.gkeCluster.location,
        initialNodeCount: nodePoolConfig.initialNodeCount,
        nodeConfig: {
          imageType: 'cos_containerd',
          machineType: nodePoolConfig.machineType,
          tags: [gkeNodeTag],
        },
      },
      { ignoreChanges: ['initialNodeCount'] },
    );
  }

  return {
    name: gkeCluster.name,
    location: gkeCluster.location,
    locationType: config.gkeCluster.locationType,
    project: gkeCluster.project,
    authorizedIp: ipv4Ip,
    network: gkeCluster.network,
    gkeNodeTag,
  };
}

function gkeKmsKey() {
  const config = getConfig();

  const currentProject = Project.get(
    'current-project',
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    config.gcp.project!,
  );

  const keyring = new KeyRing('gke-keyring', {
    location: config.gcp.region,
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
