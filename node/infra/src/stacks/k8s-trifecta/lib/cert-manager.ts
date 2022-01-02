import * as path from 'path';

import * as k8s from '@pulumi/kubernetes';
import lazyValue from 'lazy-value';

import { stackConfig } from '../stack';
import { kubernetesWebhookFirewallRule } from '../../../lib/kubernetes-util';

import { cloudflareDns01Issuer } from './constants';

export const certManagerCrds = lazyValue(
  () =>
    new k8s.yaml.ConfigFile('cert-manager-crds', {
      file: path.join(__dirname, 'cert-manager-crds.yaml'),
    }),
);

export function certManager() {
  const k8sTrifectaConfig = stackConfig();

  const firewallRules = kubernetesWebhookFirewallRule('cert-manager', 'TCP', [
    10250,
  ]);

  const namespace = new k8s.core.v1.Namespace('admin-cert-manager');

  const crds = certManagerCrds();

  const chart = new k8s.helm.v3.Chart(
    'cert-manager',
    {
      namespace: namespace.metadata.name,
      chart: 'cert-manager',
      fetchOpts: {
        repo: 'https://charts.jetstack.io',
      },
      version: '1.6.1',
      values: {
        startupapicheck: {
          enabled: false,
        },
      },
    },
    { dependsOn: [crds, ...firewallRules] },
  );

  const CF_API_TOKEN_KEY = 'CF_API_TOKEN';
  const secret = new k8s.core.v1.Secret('cert-manager-cloudflare', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    stringData: {
      [CF_API_TOKEN_KEY]: k8sTrifectaConfig.cloudflareApiToken,
    },
  });

  new k8s.apiextensions.CustomResource(
    'cert-manager-cluster-issuer',
    {
      kind: 'ClusterIssuer',
      apiVersion: 'cert-manager.io/v1',
      metadata: {
        name: cloudflareDns01Issuer,
        namespace: namespace.metadata.name,
      },
      spec: {
        acme: {
          email: 'mayreply@aaronfriel.com',
          server: 'https://acme-v02.api.letsencrypt.org/directory',
          privateKeySecretRef: {
            name: 'secret-key',
          },
          solvers: [
            {
              dns01: {
                cloudflare: {
                  email: 'mayreply@aaronfriel.com',
                  apiTokenSecretRef: {
                    name: secret.metadata.name,
                    key: CF_API_TOKEN_KEY,
                  },
                },
              },
            },
          ],
        },
      },
    },
    { dependsOn: [chart, crds, ...firewallRules], ignoreChanges: ['status'] },
  );
}
