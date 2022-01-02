import * as timers from 'timers/promises';

import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import lazyValue from 'lazy-value';

import { getConfig } from '../../../lib/config';
import { stackConfig } from '../stack';
import { renderIstioOperatorManifest } from '../../../lib/istio-util';
import {
  getClusterCaCertificate,
  kubernetesWebhookFirewallRule,
} from '../../../lib/kubernetes-util';

import { crdOnly, nonCrdOnly } from './crdUtil';
import { certManagerCrds } from './cert-manager';
import { cloudflareDns01Issuer } from './constants';

const istioWildcardTlsSecretName = 'wildcard-tls';

function getClusterFqdn() {
  const config = getConfig();

  const clusterName = config.cloud().clusterName;
  const parentDomain = stackConfig().parentDomain;
  return `${clusterName}.mesh.${parentDomain}`;
}

export const istioConfig = lazyValue(() => {
  const config = new pulumi.Config();

  return {
    istioCaCert: config.requireSecret('istioCaCert'),
    istioCaKey: config.requireSecret('istioCaKey'),
    istioRootCert: config.requireSecret('istioRootCert'),
    istioCertChain: config.requireSecret('istioCertChain'),
  };
});

export function istio() {
  istioNamespace();

  istioCrds();

  istioOperator();

  istioWildcardCertificate();

  exposeApiServer();

  const istioRemoteSecretData = istioRemoteSecret();

  return { istioRemoteSecretData };
}

const istioNamespace = lazyValue(() => {
  const clusterName = getConfig().cloud().clusterName;

  return new k8s.core.v1.Namespace(
    'istio-system',
    {
      metadata: {
        name: 'istio-system',
        labels: {
          'topology.istio.io/network': clusterName,
        },
      },
    },
    { protect: false },
  );
});

const istioCrds = lazyValue(() =>
  Object.values(
    istioYamlManifest().apply(
      (manifest) =>
        new k8s.yaml.ConfigGroup(
          'istioctl-manifest-crds',
          {
            // ????
            yaml: manifest,
            objs: [],
            transformations: [crdOnly],
          },
          { dependsOn: [istioCaCertsSecret(), istioNamespace()] },
        ),
    ).resources,
  ),
);

const istioFirewallRules = lazyValue(() =>
  kubernetesWebhookFirewallRule('istio-webhooks', 'TCP', [15017]),
);

const istioOperator = lazyValue(() =>
  istioYamlManifest().apply(
    (manifest) =>
      new k8s.yaml.ConfigGroup(
        'istioctl-manifest-resources',
        {
          yaml: manifest,
          transformations: [nonCrdOnly],
        },
        {
          dependsOn: [
            istioNamespace(),
            istioCaCertsSecret(),
            ...istioFirewallRules(),
            ...istioCrds(),
          ],
        },
      ),
  ),
);

function istioWildcardCertificate() {
  const { parentDomain } = stackConfig();
  const wildcardDomain = `*.${parentDomain}`;

  new k8s.apiextensions.CustomResource(
    'ingress-istio-tls-cert-prod',
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        namespace: istioNamespace().metadata.name,
      },
      spec: {
        secretName: istioWildcardTlsSecretName,
        commonName: wildcardDomain,
        dnsNames: [getClusterFqdn(), parentDomain, wildcardDomain],
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
      protect: false,
    },
  );
}

function exposeApiServer() {
  const clusterFqdn = getClusterFqdn();

  const kubeApiServerHost = 'kubernetes.default.svc.cluster.local';

  const kubeApiLabels = {
    component: 'apiserver',
    provider: 'kubernetes',
  };

  const gateway = new k8s.apiextensions.CustomResource(
    'kubernetes-gateway',
    {
      apiVersion: 'networking.istio.io/v1alpha3',
      kind: 'Gateway',
      metadata: {
        namespace: istioNamespace().metadata.name,
        labels: kubeApiLabels,
      },
      spec: {
        selector: { istio: 'ingressgateway' },
        servers: [
          {
            port: { number: 80, name: 'http', protocol: 'HTTP' },
            hosts: [clusterFqdn],
            tls: { httpsRedirect: true },
          },
          {
            port: {
              number: 443,
              name: 'https',
              protocol: 'HTTPS',
            },
            tls: {
              mode: 'SIMPLE',
              credentialName: istioWildcardTlsSecretName,
            },
            hosts: [clusterFqdn],
          },
        ],
      },
    },
    { dependsOn: [...istioCrds()] },
  );

  new k8s.apiextensions.CustomResource(
    'kubernetes-virtual-service',
    {
      apiVersion: 'networking.istio.io/v1alpha3',
      kind: 'VirtualService',
      metadata: {
        namespace: istioNamespace().metadata.name,
        labels: kubeApiLabels,
      },
      spec: {
        hosts: [clusterFqdn],
        gateways: [gateway.metadata.name],
        http: [
          {
            route: [
              {
                destination: {
                  host: kubeApiServerHost,
                  port: { number: 443 },
                },
              },
            ],
          },
        ],
      },
    },
    { dependsOn: [...istioCrds()] },
  );

  new k8s.apiextensions.CustomResource(
    'kubernetes-destination-rule',
    {
      apiVersion: 'networking.istio.io/v1alpha3',
      kind: 'DestinationRule',
      metadata: {
        name: 'kubernetes',
        namespace: istioNamespace().metadata.name,
        labels: kubeApiLabels,
      },
      spec: {
        host: kubeApiServerHost,
        trafficPolicy: {
          tls: {
            mode: 'SIMPLE',
            caCertificates:
              '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
            sni: kubeApiServerHost,
          },
        },
      },
    },
    { dependsOn: [...istioCrds()] },
  );

  new k8s.rbac.v1.ClusterRoleBinding(
    'anonymous-service-account-issuer-discovery',
    {
      metadata: {},
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'system:service-account-issuer-discovery',
      },
      subjects: [
        {
          kind: 'User',
          name: 'system:anonymous',
          namespace: 'default',
        },
      ],
    },
  );

  new k8s.apiextensions.CustomResource(
    'kubernetes-request-authn',
    {
      apiVersion: 'security.istio.io/v1beta1',
      kind: 'RequestAuthentication',
      metadata: {
        namespace: istioNamespace().metadata.name,
      },
      spec: {
        selector: {
          matchLabels: {
            istio: 'ingressgateway',
          },
        },
        jwtRules: [
          {
            issuer: 'kubernetes/serviceaccount',
            jwksUri: `https://${kubeApiServerHost}/openid/v1/jwks`,
            forwardOriginalToken: true,
          },
        ],
      },
    },
    { dependsOn: [...istioCrds()] },
  );

  new k8s.apiextensions.CustomResource(
    'kubernetes-authz-policy',
    {
      apiVersion: 'security.istio.io/v1beta1',
      kind: 'AuthorizationPolicy',
      metadata: {
        namespace: istioNamespace().metadata.name,
      },
      spec: {
        selector: {
          matchLabels: {
            istio: 'ingressgateway',
          },
        },
        action: 'ALLOW',
        rules: [
          { to: [{ operation: { notHosts: [clusterFqdn] } }] },
          {
            from: [{ source: { requestPrincipals: ['*'] } }],
            to: [{ operation: { hosts: [clusterFqdn] } }],
          },
        ],
      },
    },
    { dependsOn: [...istioCrds()] },
  );
}

function istioRemoteSecret() {
  const clusterName = getConfig().cloud().clusterName;
  const clusterFqdn = getClusterFqdn();

  const meshReaderSecret = new k8s.core.v1.Secret(
    'remote-mesh-reader',
    {
      metadata: {
        namespace: istioNamespace().metadata.name,
        annotations: {
          'kubernetes.io/service-account.name': 'istio-reader-service-account',
        },
      },
      type: 'kubernetes.io/service-account-token',
    },
    {
      ignoreChanges: ['data'],
      dependsOn: [istioOperator(), ...Object.values(istioOperator().resources)],
    },
  );

  const istioReaderToken = pulumi
    .output(meshReaderSecret.data)
    .apply(async (_) => {
      // The Kubernetes TokenController runs asynchronously, wait a second, then pull the token off the secret:
      await timers.setTimeout(1000);
      const readSecret = k8s.core.v1.Secret.get(
        `read-remote-mesh-reader-token`,
        pulumi.interpolate`${istioNamespace().metadata.name}/${
          meshReaderSecret.metadata.name
        }`,
        { dependsOn: meshReaderSecret },
      );

      return readSecret.data.apply((data) =>
        data?.['token']
          ? Buffer.from(data?.['token'], 'base64').toString('utf-8')
          : 'undefined',
      );
    });

  const istioRemoteSecretData = pulumi.interpolate`
apiVersion: v1
clusters:
- cluster:
    server: https://${clusterFqdn}
  name: ${clusterName}
contexts:
- context:
    cluster: ${clusterName}
    user: ${clusterName}
  name: ${clusterName}
current-context: ${clusterName}
kind: Config
preferences: {}
users:
- name: ${clusterName}
  user:
    token: ${istioReaderToken}
`.apply((x) => x.trim());
  return istioRemoteSecretData;
}

const istioYamlManifest = lazyValue(() => {
  const config = getConfig();

  const cloudConfig = config.cloud();

  const clusterName = cloudConfig.clusterName;
  const cloudProvider = cloudConfig.kubernetesProvider;

  return renderIstioOperatorManifest({
    clusterName,
    cloudProvider,
    // For Istio's mesh implementation, we must permit requests from other clusters, and to harden the
    // cluster, we will use JWT validation.
    //
    // This means we need to get the cluster CA certificate to validate those tokens.
    jwksResolverExtraRootCA: getClusterCaCertificate(),
  });
});

const istioCaCertsSecret = lazyValue(() => {
  const { istioCaCert, istioCaKey, istioRootCert } = istioConfig();

  return new k8s.core.v1.Secret('cacerts', {
    metadata: {
      name: 'cacerts',
      namespace: istioNamespace().metadata.name,
    },
    stringData: {
      'ca-cert.pem': istioCaCert,
      'ca-key.pem': istioCaKey,
      'root-cert.pem': istioRootCert,
      'cert-chain.pem': pulumi.interpolate`${istioCaCert}\n${istioRootCert}`,
    },
  });
});
