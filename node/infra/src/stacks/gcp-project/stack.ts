import { Service } from '@pulumi/gcp/projects';
import { getBillingAccount, Project } from '@pulumi/gcp/organizations';
import { Network } from '@pulumi/gcp/compute';
import { Router } from '@pulumi/google-native/compute/v1';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

import { getConfig } from '../../lib/config';

export const workDir = __dirname;
export const projectName = 'infra-gcp-project';
export function config() {
  const config = new pulumi.Config(projectName);

  return {
    billingAccountId: config.get('gcpBillingAccountId'),
  };
}

const apis = [
  'cloudbilling.googleapis.com',
  'cloudkms.googleapis.com',
  'container.googleapis.com',
  'cloudresourcemanager.googleapis.com',
];

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const config = getConfig();

  const suffix = new random.RandomId('project-id', { byteLength: 4 });

  const activeProject = config.gcp.project;

  const billingAccount = await getBillingAccount({
    displayName: 'My Billing Account',
    open: true,
  });

  for (const api of apis) {
    new Service(`${api}`, {
      service: api,
      project: activeProject,
      disableOnDestroy: false,
    });
  }

  const project = new Project(
    'project',
    {
      projectId: pulumi.interpolate`frielforreal-${pulumi.getStack()}-${
        suffix.hex
      }`,
      name: pulumi.interpolate`frielforreal-${pulumi.getStack()}`,
      autoCreateNetwork: false,
      billingAccount: billingAccount.id,
    },
    { ignoreChanges: ['folderId', 'orgId'] },
  );

  for (const api of apis) {
    new Service(`TARGETPROJECT-${api}`, {
      service: api,
      project: project.projectId,
      disableOnDestroy: false,
    });
  }

  const network = new Network('default-network', {
    name: 'default',
    project: project.projectId,
  });

  new Router(
    'default-router',
    {
      network: network.selfLink,
      project: project.projectId,
      region: config.gcp.region,
      nats: [
        {
          name: 'default-nat',
          sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES',
          natIpAllocateOption: 'AUTO_ONLY',
        },
      ],
    },
    { replaceOnChanges: ['project'], deleteBeforeReplace: true },
  );

  return { projectId: project.projectId };
}
