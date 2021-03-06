import * as k8s from '@pulumi/kubernetes';
import { interpolate } from '@pulumi/pulumi';
import { RandomUuid } from '@pulumi/random';

import { stackConfig } from '../stack';

import { disableLinkerdAdmissionWebhook } from './linkerd';

export function externalDns() {
  const k8sTrifectaConfig = stackConfig();

  const namespace = new k8s.core.v1.Namespace('admin-external-dns', {
    metadata: {
      labels: {
        ...disableLinkerdAdmissionWebhook,
      },
    },
  });

  const serviceAccount = new k8s.core.v1.ServiceAccount('external-dns', {
    metadata: {
      namespace: namespace.metadata.name,
    },
  });

  const clusterRole = new k8s.rbac.v1.ClusterRole('external-dns', {
    rules: [
      {
        apiGroups: [''],
        resources: ['services', 'endpoints', 'pods'],
        verbs: ['get', 'watch', 'list'],
      },
      {
        apiGroups: ['extensions', 'networking.k8s.io'],
        resources: ['ingresses'],
        verbs: ['get', 'watch', 'list'],
      },
      {
        apiGroups: [''],
        resources: ['nodes'],
        verbs: ['list'],
      },
      {
        apiGroups: ['networking.istio.io'],
        resources: ['gateways', 'virtualservices'],
        verbs: ['get', 'watch', 'list'],
      },
    ],
  });

  new k8s.rbac.v1.ClusterRoleBinding('external-dns-viewer', {
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: clusterRole.metadata.name,
    },
    subjects: [
      {
        kind: 'ServiceAccount',
        name: serviceAccount.metadata.name,
        namespace: serviceAccount.metadata.namespace,
      },
    ],
  });

  const CF_API_TOKEN_KEY = 'CF_API_TOKEN';
  const secret = new k8s.core.v1.Secret('external-dns-cloudflare', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    stringData: {
      [CF_API_TOKEN_KEY]: k8sTrifectaConfig.cloudflareApiToken,
    },
  });

  const ownerId = new RandomUuid('txt-owner-id');

  new k8s.apps.v1.Deployment('external-dns', {
    kind: 'Deployment',
    metadata: {
      namespace: namespace.metadata.name,
    },
    spec: {
      strategy: {
        type: 'Recreate',
      },
      selector: {
        matchLabels: {
          app: 'external-dns',
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'external-dns',
          },
        },
        spec: {
          serviceAccountName: serviceAccount.metadata.name,
          containers: [
            {
              name: 'external-dns',
              image: 'k8s.gcr.io/external-dns/external-dns:v0.10.2',
              args: [
                '--source=ingress',
                '--source=service',
                ...(k8sTrifectaConfig.deployIstio
                  ? ['--source=istio-gateway']
                  : []),
                '--domain-filter=frielforreal.io',
                '--provider=cloudflare',
                '--registry=txt',
                interpolate`--txt-owner-id=${ownerId.result}`,
              ],
              env: [
                {
                  name: 'CF_API_TOKEN',
                  valueFrom: {
                    secretKeyRef: {
                      name: secret.metadata.name,
                      key: CF_API_TOKEN_KEY,
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  });

  return {};
}
