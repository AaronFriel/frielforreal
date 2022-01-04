import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import * as tls from '@pulumi/tls';
import lazyValue from 'lazy-value';

import { getConfig } from '../../../lib/config';
import { kubernetesWebhookFirewallRule } from '../../../lib/kubernetes-util';
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

  linkerdPatchKubeSystemLabels();

  linkerdCni();

  linkerdCrds();

  linkerdControlPlane();

  linkerdMulticluster();

  linkerdKubeApiProxy();
}

const linkerdFirewallRules = lazyValue(() =>
  kubernetesWebhookFirewallRule(`linkerd-webhooks`, 'TCP', [8089, 8443]),
);

export const disableLinkerdAdmissionWebhook = {
  'config.linkerd.io/admission-webhooks': 'disabled',
};

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
    version: '21.12.3',
    values,
  });

  return chart.ready;
});

export const linkerdControlPlane = lazyValue(() => {
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
    controllerImage: 'docker.io/afriel/linkerd2-controller',
    controllerImageVersion: 'dev-58944efd-friel',
    proxy: {
      image: {
        name: 'docker.io/afriel/linkerd2-proxy',
        version: '2ffa7d5d',
      },
    },
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
          obj = {
            ...obj,
            metadata: {
              ...obj?.metadata,
              annotations: {
                ...obj?.annotations,
                'pulumi.com/skipAwait': true,
              },
            },
          };
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
      version: '21.12.3',
      values: {
        gateway: {
          serviceAnnotations: {
            'external-dns.alpha.kubernetes.io/hostname':
              getLinkerdGatewayApiFqdn(),
          },
          probe: {
            port: 4192,
          },
        },
      },
      transformations: [
        // (o) => {
        //   if (
        //     o?.kind === 'ServerAuthorization' &&
        //     o?.metadata?.name === 'proxy-admin' /* ||
        //       o?.metadata?.name === 'service-mirror-proxy-admin' */
        //   ) {
        //     // omitObject(o);
        //     // o.spec = {
        //     //   ...o.spec,
        //     //   client: {
        //     //     networks: [{ cidr: '0.0.0.0/0' }, { cidr: '::/0' }],
        //     //     unauthenticated: true,
        //     //   },
        //     // };
        //   }
        // },
      ],
    },
    { dependsOn: linkerdControlPlane() },
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

function linkerdPatchKubeSystemLabels() {
  const sa = new k8s.core.v1.ServiceAccount('linkerd-kube-system-patch', {
    metadata: {
      namespace: 'kube-system',
    },
  });

  const role = new k8s.rbac.v1.Role('linkerd-kube-system-patch', {
    metadata: {
      namespace: 'kube-system',
      name: 'namespace-metadata',
    },
    rules: [
      {
        apiGroups: [''],
        resources: ['namespaces'],
        verbs: ['get', 'patch'],
        resourceNames: ['kube-system'],
      },
    ],
  });

  new k8s.rbac.v1.RoleBinding('linkerd-kube-system-patch', {
    metadata: {
      namespace: 'kube-system',
      name: 'namespace-metadata',
    },
    roleRef: {
      kind: 'Role',
      name: role.metadata.name,
      apiGroup: 'rbac.authorization.k8s.io',
    },
    subjects: [
      {
        kind: 'ServiceAccount',
        name: sa.metadata.name,
        namespace: 'kube-system',
      },
    ],
  });

  new k8s.batch.v1.Job('linkerd-kube-system-patch', {
    metadata: {
      name: 'linkerd-kube-system-patch',
      namespace: 'kube-system',
      labels: {
        'app.kubernetes.io/name': 'linkerd-kube-system-patch',
      },
      annotations: {
        'pulumi.com/skipAwait': 'true',
      },
    },
    spec: {
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'linkerd-kube-system-patch',
          },
        },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: sa.metadata.name,
          containers: [
            {
              name: 'namespace-metadata',
              image: 'curlimages/curl:7.78.0',
              command: ['/bin/sh'],
              args: [
                '-c',
                String.raw`
ops=''
token=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
ns=$(curl -s --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt -H "Authorization: Bearer $token" \
  "https://kubernetes.default.svc/api/v1/namespaces/kube-system")

if echo "$ns" | grep -vq 'annotations'; then
  ops="$ops{\"op\": \"add\",\"path\": \"/metadata/annotations\",\"value\": {}},"
fi

ops="$ops{\"op\": \"add\", \"path\": \"/metadata/annotations/config.linkerd.io~1admission-webhooks\", \"value\": \"disabled\"}"

curl \
     -XPATCH -H "Content-Type: application/json-patch+json" -H "Authorization: Bearer $token" \
     --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
     -d "[$ops]" \
     "https://kubernetes.default.svc/api/v1/namespaces/kube-system?fieldManager=kubectl-annotate"
`.trim(),
              ],
            },
          ],
        },
      },
    },
  });
}
