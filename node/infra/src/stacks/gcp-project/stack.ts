import { Network } from '@pulumi/gcp/compute';
import { getBillingAccount, Project } from '@pulumi/gcp/organizations';
import { Service } from '@pulumi/gcp/projects';
import { Router } from '@pulumi/google-native/compute/v1';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

import { getConfig } from '../../lib/config';

export const workDir = __dirname;
export const projectName = 'infra-gcp-project';
export function stackConfig() {
  const config = new pulumi.Config(projectName);

  return {
    billingAccountId: config.get('optionalBillingAccountId'),
    folderId: config.get('optionalFolderId'),
    projectName: config.get('optionalProjectName'),
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

  const localConfig = stackConfig();
  const globalConfig = getConfig();

  const suffix = new random.RandomId('project-id', { byteLength: 4 });

  const gcpConfig = globalConfig.gcp();
  const activeProject = gcpConfig.project;

  const billingAccountId =
    localConfig.billingAccountId ??
    (
      await getBillingAccount({
        displayName: 'My Billing Account',
        open: true,
      })
    ).id;

  for (const api of apis) {
    new Service(`${api}`, {
      service: api,
      project: activeProject,
      disableOnDestroy: false,
    });
  }

  const projectName = localConfig.projectName ?? pulumi.getStack();
  const project = new Project(
    'project',
    {
      projectId: pulumi.interpolate`${projectName}-${suffix.hex}`,
      folderId: localConfig.folderId,
      name: projectName,
      autoCreateNetwork: false,
      billingAccount: billingAccountId,
    },
    { ignoreChanges: ['orgId', 'folderId'] }, // cannot set both orgId and folderId on update, bug?
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
      region: gcpConfig.region,
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
