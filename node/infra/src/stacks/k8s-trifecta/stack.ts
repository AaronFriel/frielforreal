import * as pulumi from '@pulumi/pulumi';

import { getConfig } from '../../lib/config';

import { createCertManager } from './lib/cert-manager';
import { createExternalDns } from './lib/external-dns';
import { createIngressNginx } from './lib/ingress-nginx';
import { createIstio } from './lib/istio';

export const workDir = __dirname;
export const projectName = 'infra-k8s-trifecta';

export function stackConfig() {
  const config = new pulumi.Config(projectName);

  return {
    cloudflareApiToken: config.requireSecret('cloudflareApiToken'),
    parentDomain: config.require('parentDomain'),
    istioCaCert: config.requireSecret('istioCaCert'),
    istioCaKey: config.requireSecret('istioCaKey'),
    istioRootCert: config.requireSecret('istioRootCert'),
    istioCertChain: config.requireSecret('istioCertChain'),
  };
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { certManagerCrds } = createCertManager();

  createExternalDns();

  createIngressNginx({ certManagerCrds });

  const { istioRemoteSecretData } = createIstio({
    certManagerCrds,
  });

  return {
    istioRemoteSecretData,
  };
}
