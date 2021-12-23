import { runtime, Config, getStack, interpolate } from '@pulumi/pulumi';
import { RandomId } from '@pulumi/random';
import { ManagedCluster } from '@pulumi/azure-native/containerservice';
import { UserAssignedIdentity } from '@pulumi/azure-native/managedidentity';
import { Subnet, VirtualNetwork } from '@pulumi/azure-native/network';
import { ResourceGroup } from '@pulumi/azure-native/resources';
import { RoleAssignment } from '@pulumi/azure-native/authorization';
import * as publicIp from 'public-ip';

export const workDir = __dirname;
export const projectName = 'infra-azure-cluster';

export function config() {
  return {};
}

export async function stack() {
  if (!runtime.hasEngine()) {
    return;
  }

  const azureConfig = new Config('azure-native');
  const subscriptionId = azureConfig.require('subscriptionId');

  const group = new ResourceGroup('resource-group', {
    location: 'northcentralus',
    resourceGroupName: `pulumi-${getStack()}`,
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
        dnsPrefix: interpolate`aks-${getStack()}-${dnsSuffix}`,
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
        protect: true,
      },
    );
  });

  return {
    resourceGroupName: group.name,
    aksIdentityId: aksIdentity.id,
    subscriptionId,
    clusterName: cluster.name,
  };
}
