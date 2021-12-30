import * as k8s from '@pulumi/kubernetes';
import * as nginx from '@pulumi/kubernetes-ingress-nginx';
import * as pulumi from '@pulumi/pulumi';

import { stackConfig } from '../stack';
import { kubernetesWebhookFirewallRule } from '../../../lib/kubernetes-util';

import { cloudflareDns01Issuer } from './constants';

export async function createIngressNginx({
  certManagerCrds,
}: {
  certManagerCrds: pulumi.Resource;
}) {
  const k8sTrifectaConfig = stackConfig();

  kubernetesWebhookFirewallRule('ingress-nginx', 'TCP', [8443]);

  const namespace = new k8s.core.v1.Namespace('admin-ingress-nginx');

  const wildcardTlsSecretName = 'wildcard-tls';

  pulumi
    .output({
      namespace: namespace.metadata.name,
    })
    .apply(({ namespace }) => {
      const parentDomain = k8sTrifectaConfig.parentDomain;
      const wildcardDomain = `*.${parentDomain}`;
      new k8s.apiextensions.CustomResource(
        'ingress-nginx-tls-cert-prod',
        {
          apiVersion: 'cert-manager.io/v1',
          kind: 'Certificate',
          metadata: {
            namespace,
          },
          spec: {
            secretName: wildcardTlsSecretName,
            commonName: wildcardDomain,
            dnsNames: [parentDomain, wildcardDomain],
            subject: { organizations: ['Aaron Friel'] },
            issuerRef: {
              name: cloudflareDns01Issuer,
              kind: 'ClusterIssuer',
            },
          },
        },
        {
          dependsOn: [certManagerCrds],
          ignoreChanges: ['status'],
        },
      );

      return new nginx.IngressController('ingress-nginx', {
        helmOptions: {
          namespace,
          name: 'ingress-nginx',
          atomic: true,
        },
        controller: {
          watchIngressWithoutClass: true,
          extraArgs: {
            'default-ssl-certificate': `${namespace}/${wildcardTlsSecretName}`,
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

  return {};
}
