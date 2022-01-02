import * as timers from 'timers/promises';

import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import lazyValue from 'lazy-value';

import { getConfig } from '../../../lib/config';
import { stackConfig } from '../stack';

import {
  linkerdControlPlane,
  linkerdMulticluster,
  linkerdMulticlusterNamespace,
} from './linkerd';

export function getLinkerdKubeApiFqdn(): pulumi.Input<string> | undefined {
  const { clusterName } = getConfig().cloud();

  const { parentDomain } = stackConfig();

  return `kube.${clusterName}.${parentDomain}`;
}

export const linkerdClusterCredentials = lazyValue(() => {
  const { clusterName } = getConfig().cloud();

  const linkerdReaderToken = linkerdMulticluster().apply(async (_) => {
    if (pulumi.runtime.isDryRun()) {
      return;
    }

    // The Kubernetes TokenController runs asynchronously, wait a second, then pull the token off the secret:
    await timers.setTimeout(1000);
    const namespace = linkerdMulticlusterNamespace().metadata.name;
    const linkerdSaName = 'linkerd-service-mirror-remote-access-default';
    const serviceAccount = k8s.core.v1.ServiceAccount.get(
      'linkerd-mirror-sa',
      pulumi.interpolate`${namespace}/${linkerdSaName}`,
      {
        dependsOn: linkerdMulticluster(),
      },
    );

    const secretName = serviceAccount.secrets[0].name;

    const readSecret = k8s.core.v1.Secret.get(
      `linkerd-remote-mesh-reader-token`,
      pulumi.interpolate`${namespace}/${secretName}`,
    );

    return readSecret.data.apply((data) =>
      data?.['token']
        ? Buffer.from(data?.['token'], 'base64').toString('utf-8')
        : 'undefined',
    );
  });

  return pulumi.interpolate`
apiVersion: v1
clusters:
- cluster:
    server: https://${getLinkerdKubeApiFqdn()}
  name: ${clusterName}
contexts:
- context:
    cluster: ${clusterName}
    user: linkerd-service-mirror-remote-access-default
  name: ${clusterName}
current-context: ${clusterName}
kind: Config
preferences: {}
users:
- name: linkerd-service-mirror-remote-access-default
  user:
    token: ${linkerdReaderToken}
`.apply((x) => x.trim());
});

export function linkerdKubeApiProxy() {
  const namespace = new k8s.core.v1.Namespace('linkerd-kube-api-proxy', {
    metadata: {
      name: 'linkerd-kube-api-proxy',
      annotations: {
        'linkerd.io/inject': 'enabled',
      },
    },
  });

  const labels = { 'app.kubernetes.io/name': 'kube-api-proxy' };

  new k8s.rbac.v1.ClusterRoleBinding('kube-api-proxy-jwks-access', {
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
  });

  const configDir = '/opt/bitnami/envoy/conf/';
  const configFile = 'envoy.yaml';
  const configMap = new k8s.core.v1.ConfigMap('kube-api-proxy', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    data: {
      [configFile]: `
static_resources:
  listeners:
  - name: listener_0
    address:
      socket_address: { address: 0.0.0.0, port_value: 8000 }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress_http
          codec_type: AUTO
          route_config:
            name: local_route
            virtual_hosts:
            - name: local_service
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: kube_api_server }
          http_filters:
          - name: envoy.filters.http.jwt_authn
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.jwt_authn.v3.JwtAuthentication
              providers:
                default_provider:
                  payload_in_metadata: "payload"
                  issuer: kubernetes/serviceaccount
                  remote_jwks:
                    http_uri:
                      uri: https://kubernetes.default.svc.cluster.local/openid/v1/jwks
                      cluster: kube_api_server
                      timeout: 1s
                    cache_duration: { seconds: 300 }
                    async_fetch: { fast_listener: true }
                    retry_policy: { num_retries: 5 }
              rules:
              - match: {prefix: /}
                requires: {provider_name: default_provider}
          - name: envoy.filters.http.rbac
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC
              rules:
                action: ALLOW
                policies:
                  "any":
                    principals:
                      - metadata:
                          filter: envoy.filters.http.jwt_authn
                          path:
                            - key: payload
                            - key: sub
                          value:
                            string_match: { exact: "system:serviceaccount:linkerd-multicluster:linkerd-service-mirror-remote-access-default" }
                    permissions:
                      - any: true
          - name: envoy.filters.http.router
  clusters:
  - name: kube_api_server
    connect_timeout: 0.25s
    type: LOGICAL_DNS
    lb_policy: ROUND_ROBIN
    load_assignment:
      cluster_name: kube_api_server
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address:
                address: kubernetes.default.svc.cluster.local
                port_value: 443
    transport_socket:
      name: envoy.transport_sockets.tls
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
        sni: kubernetes.default.svc.cluster.local
`.trim(),
    },
  });

  const configVolumeName = 'config';

  new k8s.apps.v1.Deployment(
    'kube-api-proxy',
    {
      metadata: {
        namespace: namespace.metadata.name,
        annotations: {
          'pulumi.com/skipAwait': 'true',
        },
        labels,
      },
      spec: {
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
          },
          spec: {
            terminationGracePeriodSeconds: 1,
            containers: [
              {
                name: 'envoy',
                image: 'bitnami/envoy:latest',
                volumeMounts: [
                  {
                    name: configVolumeName,
                    mountPath: `${configDir}/${configFile}`,
                    subPath: `${configFile}`,
                  },
                ],
                ports: [
                  {
                    name: 'http',
                    containerPort: 8000,
                    protocol: 'TCP',
                  },
                ],
              },
            ],
            volumes: [
              {
                name: configVolumeName,
                configMap: {
                  name: configMap.metadata.name,
                },
              },
            ],
          },
        },
      },
    },
    { dependsOn: linkerdControlPlane() },
  );

  const service = new k8s.core.v1.Service('kube-api-proxy', {
    metadata: {
      namespace: namespace.metadata.name,
      labels,
    },
    spec: {
      type: 'ClusterIP',
      selector: labels,
      ports: [
        {
          name: 'http',
          port: 80,
          appProtocol: 'http',
          targetPort: 'http',
        },
      ],
    },
  });

  new k8s.networking.v1.Ingress('kube-api-proxy', {
    metadata: {
      namespace: namespace.metadata.name,
      labels,
      annotations: {
        'nginx.ingress.kubernetes.io/service-upstream': 'true',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: getLinkerdKubeApiFqdn(),
          http: {
            paths: [
              {
                pathType: 'Prefix',
                path: '/',
                backend: {
                  service: {
                    name: service.metadata.name,
                    port: { name: 'http' },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  });
}
