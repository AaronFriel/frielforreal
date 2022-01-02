import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import lazyValue from 'lazy-value';
import * as tls from '@pulumi/tls';

import { kubernetesWebhookFirewallRule } from '../../../lib/kubernetes-util';
import { getConfig } from '../../../lib/config';
import { stackConfig } from '../stack';

import { linkerdKubeApiProxy } from './linkerdKubeApiProxy';

export const linkerdConfig = lazyValue(() => {
  const config = new pulumi.Config();

  return {
    linkerdIssuerCert: config.requireSecret('linkerdIssuerCert'),
    linkerdIssuerExpiry: config.requireSecret('linkerdIssuerExpiry'),
    linkerdIssuerKey: config.requireSecret('linkerdIssuerKey'),
    linkerdTrustAnchors: config.requireSecret('linkerdTrustAnchors'),
  };
});

export function linkerd() {
  linkerdFirewallRules();

  linkerdCni();

  linkerdCrds();

  linkerdControlPlane();

  linkerdMulticluster();

  linkerdKubeApiProxy();
}

const linkerdFirewallRules = lazyValue(() =>
  kubernetesWebhookFirewallRule(`linkerd-webhooks`, 'TCP', [8089, 8443]),
);

const linkerdNamespace = lazyValue(() => {
  return new k8s.core.v1.Namespace('linkerd', {
    metadata: {
      name: 'linkerd',
      annotations: {
        'linkerd.io/inject': 'disabled',
      },
      labels: {
        'linkerd.io/is-control-plane': 'true',
        'config.linkerd.io/admission-webhooks': 'disabled',
        'linkerd.io/control-plane-ns': 'linkerd',
      },
    },
  });
});

const linkerdCrds = lazyValue(() => {
  const chart = new k8s.helm.v3.Chart('linkerd2-crds', {
    namespace: linkerdNamespace().metadata.name,
    chart: 'linkerd-crds',
    fetchOpts: {
      repo: 'https://helm.linkerd.io/edge',
    },
    version: '1.0.0-edge',
    values: {},
  });

  return chart.ready;
});

const linkerdCni = lazyValue(() => {
  const { kubernetesProvider } = getConfig().cloud();

  // if (kubernetesProvider === 'lke') {
  //   return [];
  // }

  const namespace = new k8s.core.v1.Namespace('linkerd-cni', {
    metadata: {
      name: 'linkerd-cni',
      annotations: {
        'linkerd.io/inject': 'disabled',
      },
      labels: {
        'linkerd.io/cni-resource': 'true',
        'config.linkerd.io/admission-webhooks': 'disabled',
      },
    },
  });

  const values: pulumi.Inputs = {
    useWaitFlag: true,
  };

  if (kubernetesProvider === 'gke') {
    values['destCNIBinDir'] = '/home/kubernetes/bin';
    values['destCNINetDir'] = '/etc/cni/net.d';
  }

  const chart = new k8s.helm.v3.Chart('linkerd2-cni', {
    namespace: namespace.metadata.name,
    chart: 'linkerd2-cni',
    fetchOpts: {
      repo: 'https://helm.linkerd.io/edge',
    },
    version: '21.12.4',
    values,
  });

  return chart.ready;
});

export const linkerdControlPlane = lazyValue(() => {
  const { kubernetesProvider } = getConfig().cloud();

  const config = linkerdConfig();

  const namespace = linkerdNamespace().metadata.name;

  const policyValidatorTls = generateCertificatePair(
    'policyValidator',
    pulumi.interpolate`linkerd-policy-validator.${namespace}.svc`,
  );
  const profileValidatorTls = generateCertificatePair(
    'profileValidator',
    pulumi.interpolate`linkerd-sp-validator.${namespace}.svc`,
  );
  const proxyInjectorTls = generateCertificatePair(
    'proxyInjector',
    pulumi.interpolate`linkerd-proxy-injector.${namespace}.svc`,
  );

  const values: pulumi.Inputs = {
    cniEnabled: true,
    identityTrustAnchorsPEM: config.linkerdTrustAnchors,
    identity: {
      issuer: {
        tls: {
          crtPEM: config.linkerdIssuerCert,
          keyPEM: config.linkerdIssuerKey,
        },
        crtExpiry: config.linkerdIssuerExpiry,
      },
    },
    proxyInjector: proxyInjectorTls,
    profileValidator: profileValidatorTls,
    policyValidator: policyValidatorTls,
  };

  // if (kubernetesProvider === 'lke') {
  //   values.cniEnabled = false;
  //   values.proxyInit = {
  //     ...values.proxyInit,
  //     runAsRoot: true,
  //   };
  // }

  const chart = new k8s.helm.v3.Chart(
    'linkerd2-control-plane',
    {
      namespace: namespace,
      chart: 'linkerd-control-plane',
      fetchOpts: {
        repo: 'https://helm.linkerd.io/edge',
      },
      version: '1.0.1-edge',
      values: values,
      transformations: [
        (obj, opts) => {
          if (
            obj?.kind === 'CronJob' &&
            obj?.metadata?.name === 'linkerd-heartbeat'
          ) {
            opts.ignoreChanges = ['spec.schedule'];
          }
        },
      ],
    },
    {
      dependsOn: pulumi
        .output([linkerdCni(), linkerdCrds(), linkerdFirewallRules()])
        .apply((x) => x.flat()),
    },
  );

  return chart.ready;
});

export function getLinkerdGatewayApiFqdn() {
  const { clusterName } = getConfig().cloud();

  const { parentDomain } = stackConfig();

  return `linkerd-gateway.${clusterName}.${parentDomain}`;
}

export const linkerdMulticlusterNamespace = lazyValue(
  () =>
    new k8s.core.v1.Namespace('linkerd-multicluster', {
      metadata: {
        name: 'linkerd-multicluster',
        labels: {
          'linkerd.io/extension': 'multicluster',
        },
      },
    }),
);

export const linkerdMulticluster = lazyValue(() => {
  const namespace = linkerdMulticlusterNamespace();

  const chart = new k8s.helm.v3.Chart(
    'linkerd2-multicluster',
    {
      namespace: namespace.metadata.name,
      chart: 'linkerd-multicluster',
      fetchOpts: {
        repo: 'https://helm.linkerd.io/edge',
      },
      version: '21.12.4',
      values: {
        gateway: {
          serviceAnnotations: {
            'external-dns.alpha.kubernetes.io/hostname':
              getLinkerdGatewayApiFqdn(),
          },
        },
      },
      transformations: [
        (o) => {
          if (
            o?.kind === 'ServerAuthorization' &&
            o?.metadata?.name === 'proxy-admin'
          ) {
            o.spec = {
              ...o.spec,
              client: {
                networks: [{ cidr: '0.0.0.0/0' }, { cidr: '::/0' }],
                unauthenticated: true,
              },
            };
          }
        },
      ],
    },
    {
      dependsOn: linkerdControlPlane(),
    },
  );

  return chart.ready;
});

function generateCertificatePair(
  keyName: string,
  dnsName: pulumi.Output<string>,
) {
  const temporaryKeyName = `${keyName}-${new Date().getFullYear()}`;
  const privateKey = new tls.PrivateKey(temporaryKeyName, {
    algorithm: 'RSA',
    rsaBits: 2048,
  });
  const certificate = new tls.SelfSignedCert(temporaryKeyName, {
    subjects: [
      {
        commonName: dnsName,
      },
    ],
    dnsNames: [dnsName],
    allowedUses: ['server_auth', 'client_auth'],
    privateKeyPem: privateKey.privateKeyPem,
    keyAlgorithm: 'RSA',
    validityPeriodHours: 24 * 365 * 2,
  });
  return {
    crtPEM: certificate.certPem,
    keyPEM: privateKey.privateKeyPem,
    caBundle: certificate.certPem,
  };
}
