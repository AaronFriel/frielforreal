import * as pulumi from '@pulumi/pulumi';
import lazyValue from 'lazy-value';

import { certManager } from './lib/cert-manager';
import { descheduler } from './lib/descheduler';
import { externalDns } from './lib/external-dns';
import { ingressNginx } from './lib/ingress-nginx';
import { istio } from './lib/istio';
import { getLinkerdGatewayApiFqdn, linkerd } from './lib/linkerd';
import { linkerdClusterCredentials } from './lib/linkerdKubeApiProxy';

export const workDir = __dirname;
export const projectName = 'infra-k8s-trifecta';

export const stackConfig = lazyValue(() => {
  const config = new pulumi.Config(projectName);

  return {
    cloudflareApiToken: config.requireSecret('cloudflareApiToken'),
    parentDomain: config.require('parentDomain'),
    deployIstio: config.getBoolean('deployIstio') ?? false,
    deployLinkerd: config.getBoolean('deployLinkerd') ?? true,
  };
});

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { deployIstio, deployLinkerd } = stackConfig();

  descheduler();

  certManager();

  externalDns();

  ingressNginx();

  linkerd();

  let istioRemoteSecretData: pulumi.Output<string> = pulumi.secret('');
  if (deployIstio) {
    ({ istioRemoteSecretData } = istio());
  }

  let linkerdRemoteSecretData: pulumi.Output<string> = pulumi.secret('');
  let linkerdGatewayFqdn: string | undefined;
  if (deployLinkerd) {
    linkerdGatewayFqdn = getLinkerdGatewayApiFqdn();
    linkerdRemoteSecretData = linkerdClusterCredentials();
  }

  return {
    istioRemoteSecretData,
    linkerdRemoteSecretData,
    linkerdGatewayFqdn,
  };
}
