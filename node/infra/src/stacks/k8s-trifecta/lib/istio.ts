import * as k8s from '@pulumi/kubernetes';
import * as urlSlug from 'url-slug';
import * as pulumi from '@pulumi/pulumi';

import { getConfig } from '../../../lib/config';
import { stackConfig } from '../stack';
import { gkeFirewallRule } from '../../../lib/gcp-util/gkeFirewallRule';
import { getIstioOperatorManifest } from '../../../lib/istio-util';

import { crdOnly, nonCrdOnly } from './crdUtil';
import { cloudflareDns01Issuer } from './constants';

export function createIstio({
  certManagerCrds,
}: {
  certManagerCrds: pulumi.Resource;
}) {
  const config = getConfig();

  const k8sTrifectaConfig = stackConfig();
  const cloudConfig = config.cloud();

  const clusterName = urlSlug.convert(cloudConfig.clusterName);
  const cloudProvider = cloudConfig.kubernetesProvider;
  const parentDomain = k8sTrifectaConfig.parentDomain;

  const clusterFqdn = `${clusterName}.mesh.${parentDomain}`;

  const firewallRules: pulumi.Resource[] = [];
  if (cloudConfig.kubernetesProvider === 'gke') {
    const gkeClusterConfig = config.gkeCluster();
    firewallRules.push(
      gkeFirewallRule('istio-webhooks', {
        gkeMasterIpv4CidrBlock: gkeClusterConfig.masterIpv4CidrBlock,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        gkeNetwork: cloudConfig.gkeNetwork!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        gkeNodeTag: cloudConfig.gkeNodeTag!,
        protocol: 'TCP',
        ports: ['15017'],
      }),
    );
  }

  // For Istio's mesh implementation, we must permit requests from other clusters, and to harden the
  // cluster, we will use JWT validation.
  //
  // This means we need to get the cluster CA certificate to validate those tokens.

  const clusterCaCrt = k8s.core.v1.ConfigMap.get(
    'istio-kube-ca-cert',
    'kube-public/kube-root-ca.crt',
  ).data['ca.crt'];

  const namespace = new k8s.core.v1.Namespace(
    'istio-system',
    {
      metadata: {
        name: 'istio-system',
        labels: {
          'topology.istio.io/network': clusterName,
        },
      },
    },
    { protect: true },
  );

  new k8s.core.v1.Secret('cacerts', {
    metadata: {
      name: 'cacerts',
      namespace: namespace.metadata.name,
    },
    stringData: {
      'ca-cert.pem': k8sTrifectaConfig.istioCaCert,
      'ca-key.pem': k8sTrifectaConfig.istioCaKey,
      'root-cert.pem': k8sTrifectaConfig.istioRootCert,
      'cert-chain.pem': pulumi.interpolate`${k8sTrifectaConfig.istioCaCert}\n${k8sTrifectaConfig.istioRootCert}`,
      // 'cert-chain.pem': '',
    },
  });

  const manifest = getIstioOperatorManifest({
    clusterName,
    cloudProvider,
    clusterCaCrt,
  });

  const crds = manifest.apply(
    (manifest) =>
      new k8s.yaml.ConfigGroup(
        'istioctl-manifest-crds',
        {
          // ????
          yaml: manifest,
          objs: [],
          transformations: [crdOnly],
        },
        { dependsOn: [] },
      ),
  );

  const istio = manifest.apply(
    (manifest) =>
      new k8s.yaml.ConfigGroup(
        'istioctl-manifest-resources',
        {
          yaml: manifest,
          transformations: [nonCrdOnly],
        },
        {
          dependsOn: [
            namespace,
            ...firewallRules,
            ...Object.values(crds.resources),
          ],
        },
      ),
  );

  const wildcardTlsSecretName = 'wildcard-tls';
  const wildcardDomain = `*.${parentDomain}`;
  new k8s.apiextensions.CustomResource(
    'ingress-istio-tls-cert-prod',
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        namespace: namespace.metadata.name,
      },
      spec: {
        secretName: wildcardTlsSecretName,
        commonName: wildcardDomain,
        dnsNames: [clusterFqdn, parentDomain, wildcardDomain],
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
      protect: true,
    },
  );

  const istioRemoteSecretData = createRemoteSecret({
    namespace,
    istio,
    clusterFqdn,
    clusterName,
  });

  pulumi.output(crds.resources).apply(() => exposeApiServer(clusterFqdn));

  return { istioCrds: crds, istioRemoteSecretData, istioNamespace: namespace };
}

function createRemoteSecret({
  namespace,
  istio,
  clusterFqdn,
  clusterName,
}: {
  namespace: k8s.core.v1.Namespace;
  istio: pulumi.Output<k8s.yaml.ConfigGroup>;
  clusterFqdn: string;
  clusterName: string;
}) {
  const meshReaderSecret = new k8s.core.v1.Secret(
    'remote-mesh-reader',
    {
      metadata: {
        namespace: namespace.metadata.name,
        annotations: {
          'kubernetes.io/service-account.name': 'istio-reader-service-account',
        },
      },
      type: 'kubernetes.io/service-account-token',
    },
    {
      ignoreChanges: ['data'],
      dependsOn: Object.values(istio.resources),
    },
  );

  const istioReaderToken = pulumi
    .output(meshReaderSecret.data)
    .apply((secretData) =>
      secretData['token']
        ? Buffer.from(secretData['token'], 'base64').toString('utf-8')
        : 'undefined',
    );

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

function exposeApiServer(clusterFqdn: string) {
  const kubeApiServerHost = 'kubernetes.default.svc.cluster.local';

  const kubeApiLabels = {
    component: 'apiserver',
    provider: 'kubernetes',
  };

  const gateway = new k8s.apiextensions.CustomResource('kubernetes-gateway', {
    apiVersion: 'networking.istio.io/v1alpha3',
    kind: 'Gateway',
    metadata: {
      namespace: 'istio-system',
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
            credentialName: 'wildcard-tls',
          },
          hosts: [clusterFqdn],
        },
      ],
    },
  });

  new k8s.apiextensions.CustomResource('kubernetes-virtual-service', {
    apiVersion: 'networking.istio.io/v1alpha3',
    kind: 'VirtualService',
    metadata: {
      namespace: 'istio-system',
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
  });

  new k8s.apiextensions.CustomResource('kubernetes-destination-rule', {
    apiVersion: 'networking.istio.io/v1alpha3',
    kind: 'DestinationRule',
    metadata: {
      name: 'kubernetes',
      namespace: 'istio-system',
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
  });

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

  new k8s.apiextensions.CustomResource('kubernetes-request-authn', {
    apiVersion: 'security.istio.io/v1beta1',
    kind: 'RequestAuthentication',
    metadata: {
      namespace: 'istio-system',
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
  });

  new k8s.apiextensions.CustomResource('kubernetes-authz-policy', {
    apiVersion: 'security.istio.io/v1beta1',
    kind: 'AuthorizationPolicy',
    metadata: {
      namespace: 'istio-system',
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
  });
}
