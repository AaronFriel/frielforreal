import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import lazyValue from 'lazy-value';

import { getConfig } from '../../../lib/config';
import { kubernetesWebhookFirewallRule } from '../../../lib/kubernetes-util';
import { stackConfig } from '../stack';

import { certManagerCrds } from './cert-manager';
import { cloudflareDns01Issuer } from './constants';
import { linkerdControlPlane } from './linkerd';

export const ingressNginxWildcardTlsSecretName = 'wildcard-tls';

export const ingressNginxNamespace = lazyValue(() => {
  return new k8s.core.v1.Namespace('admin-ingress-nginx', {
    metadata: {},
  });
});

export async function ingressNginx() {
  const { deployLinkerd } = stackConfig();

  kubernetesWebhookFirewallRule('ingress-nginx', 'TCP', [8443]);

  const namespace = ingressNginxNamespace();

  new k8s.helm.v3.Chart(
    'ingress-nginx',
    {
      namespace: namespace.metadata.name,
      chart: 'ingress-nginx',
      fetchOpts: {
        repo: 'https://kubernetes.github.io/ingress-nginx',
      },
      version: '4.0.13',
      values: {
        controller: {
          podAnnotations: {
            'linkerd.io/inject': deployLinkerd ? 'enabled' : 'disabled',
          },
          watchIngressWithoutClass: true,
          extraArgs: {
            'default-ssl-certificate': pulumi.interpolate`${namespace.metadata.name}/${ingressNginxWildcardTlsSecretName}`,
          },
          publishService: {
            enabled: true,
          },
          resources: {
            requests: {
              cpu: '5m',
              memory: '90Mi',
            },
          },
        },
      },
    },
    { dependsOn: deployLinkerd ? linkerdControlPlane() : [] },
  );

  nginxWildcardCertificate();

  return {};
}

const nginxWildcardCertificate = lazyValue(() => {
  const { clusterName } = getConfig().cloud();

  const { parentDomain } = stackConfig();

  // Istio & Nginx ingress wildcard certificates:
  const wildcardDomain = `*.${parentDomain}`;
  const clusterSubdomains = `*.${clusterName}.${parentDomain}`;
  new k8s.apiextensions.CustomResource(
    'ingress-nginx-tls-cert-prod',
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        namespace: ingressNginxNamespace().metadata.name,
      },
      spec: {
        secretName: ingressNginxWildcardTlsSecretName,
        commonName: clusterSubdomains,
        dnsNames: [clusterSubdomains, wildcardDomain, parentDomain],
        subject: { organizations: ['Aaron Friel'] },
        issuerRef: {
          name: cloudflareDns01Issuer,
          kind: 'ClusterIssuer',
        },
      },
    },
    {
      dependsOn: [certManagerCrds()],
      ignoreChanges: ['status'],
    },
  );
});
