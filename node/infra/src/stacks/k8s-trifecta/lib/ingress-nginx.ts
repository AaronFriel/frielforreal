import * as k8s from '@pulumi/kubernetes';
import { IngressController } from '@pulumi/kubernetes-ingress-nginx';
import * as pulumi from '@pulumi/pulumi';
import lazyValue from 'lazy-value';

import { getConfig } from '../../../lib/config';
import { kubernetesWebhookFirewallRule } from '../../../lib/kubernetes-util';
import { stackConfig } from '../stack';

import { certManagerCrds } from './cert-manager';
import { cloudflareDns01Issuer } from './constants';

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

  pulumi
    .output({
      namespace: namespace.metadata.name,
    })
    .apply(({ namespace }) => {
      return new IngressController('ingress-nginx', {
        helmOptions: {
          namespace,
          name: 'ingress-nginx',
          atomic: true,
        },
        controller: {
          podAnnotations: {
            'linkerd.io/inject': deployLinkerd ? 'enabled' : 'disabled',
          },
          watchIngressWithoutClass: true,
          extraArgs: {
            'default-ssl-certificate': `${namespace}/${ingressNginxWildcardTlsSecretName}`,
            // eslint-disable-next-line @typescript-eslint/ban-types
          } as {},
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
      });
    });

  nginxWildcardCertificate();

  return {};
}

function nginxWildcardCertificate() {
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
}
