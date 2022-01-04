import { RoleAssignment } from '@pulumi/azure-native/authorization';
import {
  ManagedCluster,
  listManagedClusterAdminCredentials,
} from '@pulumi/azure-native/containerservice';
import { UserAssignedIdentity } from '@pulumi/azure-native/managedidentity';
import { Subnet, VirtualNetwork } from '@pulumi/azure-native/network';
import { ResourceGroup } from '@pulumi/azure-native/resources';
import * as pulumi from '@pulumi/pulumi';
import { RandomId } from '@pulumi/random';
import * as publicIp from 'public-ip';

import { getConfig } from '../../lib/config';
import { rewriteKubeconfig } from '../../lib/kubectl';

export const workDir = __dirname;
export const projectName = 'infra-azure-cluster';

function stackConfig() {
  const config = new pulumi.Config();

  return {
    location: config.require('location'),
  };
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { location } = stackConfig();
  const azureConfig = new pulumi.Config('azure-native');
  const subscriptionId = azureConfig.require('subscriptionId');
  const { contextName } = getConfig().cloud();

  const group = new ResourceGroup('resource-group', {
    location,
    resourceGroupName: `pulumi-${pulumi.getStack()}`,
  });

  const vnet = new VirtualNetwork(
    'vnet',
    {
      resourceGroupName: group.name,
      addressSpace: {
        addressPrefixes: ['10.0.0.0/8'],
      },
    },
    { ignoreChanges: ['subnets'] },
  );

  const subnet = new Subnet('default', {
    resourceGroupName: group.name,
    virtualNetworkName: vnet.name,
    addressPrefix: '10.240.0.0/16',
  });

  const aksIdentity = new UserAssignedIdentity('aks-identity', {
    resourceGroupName: group.name,
  });

  new RoleAssignment('aks-identity-vnet-role', {
    principalId: aksIdentity.principalId,
    // Network Contributor - https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#network-contributor
    roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/4d97b98b-1d4f-4787-a291-c67834d212e7`,
    scope: subnet.id,
  });

  const dnsSuffix = new RandomId('dns-suffix', {
    byteLength: 8,
  }).hex;

  const cluster = aksIdentity.id.apply(async (aksIdentityId) => {
    return new ManagedCluster(
      'aks-cluster',
      {
        kubernetesVersion: '1.22.2',
        autoUpgradeProfile: {
          upgradeChannel: 'stable', // must ignoreChanges on 'kubernetesVersion', at least.
        },
        enableRBAC: true,
        dnsPrefix: pulumi.interpolate`aks-${pulumi.getStack()}-${dnsSuffix}`,
        resourceGroupName: group.name,
        identityProfile: {},
        agentPoolProfiles: [
          {
            name: 'default',
            osDiskSizeGB: 50,
            count: 1,
            enableAutoScaling: false,
            vmSize: 'Standard_D2as_v4',
            osType: 'Linux',
            type: 'VirtualMachineScaleSets',
            mode: 'System',
            maxPods: 110,
            availabilityZones: [],
            enableNodePublicIP: false,
            vnetSubnetID: subnet.id,
            osDiskType: 'Ephemeral',
          },
        ],
        networkProfile: {
          loadBalancerSku: 'standard',
          networkPlugin: 'azure',
          networkPolicy: 'azure',
          dnsServiceIP: '10.0.0.10',
          dockerBridgeCidr: '172.17.0.1/16',
        },
        apiServerAccessProfile: {
          authorizedIPRanges: [await publicIp.v4()],
          enablePrivateCluster: false,
        },
        addonProfiles: {
          httpApplicationRouting: {
            enabled: false,
          },
          azurepolicy: {
            enabled: false,
          },
        },
        identity: {
          type: 'UserAssigned',
          userAssignedIdentities: {
            [aksIdentityId]: {},
          },
        },
      },
      {
        ignoreChanges: ['kubernetesVersion', 'agentPoolProfiles'],
        protect: false,
      },
    );
  });

  const clusterName = cluster.name;
  const resourceGroupName = group.name;

  const kubeconfig = pulumi
    .secret({ clusterName, resourceGroupName })
    .apply(async ({ clusterName, resourceGroupName }) => {
      if (pulumi.runtime.isDryRun()) {
        return 'undefined';
      }

      const creds = await listManagedClusterAdminCredentials({
        resourceName: clusterName,
        resourceGroupName,
      });

      const base64kubeconfig = creds?.kubeconfigs?.[0]?.value;

      if (!base64kubeconfig) {
        throw new Error(
          `Unable to retrieve kubeconfig for cluster ${clusterName}`,
        );
      }

      const configText = Buffer.from(base64kubeconfig, 'base64').toString(
        'utf-8',
      );

      return rewriteKubeconfig(configText, contextName);
    });

  return {
    resourceGroupName: group.name,
    aksIdentityId: aksIdentity.id,
    subscriptionId,
    clusterName: cluster.name,
    kubeconfig,
  };
}
