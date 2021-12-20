import * as pulumi from '@pulumi/pulumi';

import { createCertManager } from './lib/cert-manager';
import { createExternalDns } from './lib/external-dns';
import { createIngressNginx } from './lib/ingress-nginx';

export const workDir = __dirname;
export const projectName = 'infra-k8s-trifecta';

export function config() {
  const config = new pulumi.Config(projectName);

  return {
    cloudflareApiToken: config.requireSecret('cloudflareApiToken'),
    parentDomain: config.require('parentDomain'),
  };
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { certManagerCrds } = await createCertManager();

  await createExternalDns();

  await createIngressNginx({ certManagerCrds });

  return {};
}
