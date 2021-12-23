import * as k8s from '@pulumi/kubernetes';
import { YZX } from '@frielforreal/yzx';
import intoStream from 'into-stream';
import urlSlug from 'url-slug';
import { interpolate } from '@pulumi/pulumi';

import { getConfig, KubernetesCloudProvider } from '../../../lib/config';

import { crdOnly, nonCrdOnly } from './crdUtil';

export async function createIstio() {
  const config = getConfig();

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const clusterName = urlSlug(config.k8s.context!);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const cloudProvider: KubernetesCloudProvider = config.k8s.cloudProvider!;

  const namespace = new k8s.core.v1.Namespace('istio-system', {
    metadata: {
      name: 'istio-system',
      labels: {
        'topology.istio.io/network': clusterName,
      },
    },
  });

  new k8s.core.v1.Secret('cacerts', {
    metadata: {
      name: 'cacerts',
      namespace: namespace.metadata.name,
    },
    stringData: {
      'ca-cert.pem': config.k8sTrifectaConfig.istioCaCert,
      'ca-key.pem': config.k8sTrifectaConfig.istioCaKey,
      'root-cert.pem': config.k8sTrifectaConfig.istioRootCert,
      'cert-chain.pem': interpolate`${config.k8sTrifectaConfig.istioCaCert}\n${config.k8sTrifectaConfig.istioRootCert}`,
      // 'cert-chain.pem': '',
    },
  });

  const manifest = await getIstioOperatorManifest({
    clusterName,
    cloudProvider,
  });

  const crds = new k8s.yaml.ConfigGroup(
    'istioctl-manifest-crds',
    {
      yaml: manifest,
      transformations: [crdOnly],
    },
    { dependsOn: [] },
  );

  const istio = new k8s.yaml.ConfigGroup(
    'istioctl-manifest-resources',
    {
      yaml: manifest,
      transformations: [nonCrdOnly],
    },
    { dependsOn: [namespace, crds] },
  );

  const eastWestGateway = await getEastWestGatewayManifest(clusterName);

  new k8s.yaml.ConfigGroup(
    'istioctl-eastwest-gateway',
    {
      yaml: eastWestGateway,
    },
    { dependsOn: [namespace, crds, istio] },
  );

  return { istioCrds: crds };
}
async function getEastWestGatewayManifest(clusterName: string) {
  const $ = YZX();
  $.verbose = false;

  const istioCtlInput = `
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: eastwest
spec:
  revision: ""
  profile: empty
  components:
    ingressGateways:
      - name: istio-eastwestgateway
        label:
          istio: eastwestgateway
          app: istio-eastwestgateway
          topology.istio.io/network: ${clusterName}
        enabled: true
        k8s:
          env:
            # traffic through this gateway should be routed inside the network
            - name: ISTIO_META_REQUESTED_NETWORK_VIEW
              value: ${clusterName}
          service:
            ports:
              - name: status-port
                port: 15021
                targetPort: 15021
              - name: tls
                port: 15443
                targetPort: 15443
              - name: tls-istiod
                port: 15012
                targetPort: 15012
              - name: tls-webhook
                port: 15017
                targetPort: 15017
  values:
    gateways:
      istio-ingressgateway:
        injectionTemplate: gateway
    global:
      network: ${clusterName}
`.trim();

  const istioCmd = $`istioctl manifest generate -f -`;
  intoStream(istioCtlInput).pipe(istioCmd.stdin);
  const output = await istioCmd;

  const manifest2 = output.stdout;
  return manifest2;
}

async function getIstioOperatorManifest({
  clusterName,
  cloudProvider,
}: {
  clusterName: string;
  cloudProvider: KubernetesCloudProvider;
}) {
  const $ = YZX();
  $.verbose = false;
  let istioCtlInput = `
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  components:
    base:
      enabled: true
    cni:
      enabled: true
  profile: demo
  values:
    global:
      meshID: mesh1
      multiCluster:
        clusterName: ${clusterName}
      network: ${clusterName}
`.trim();

  if (cloudProvider === 'gke') {
    // Sets:
    // spec.components.cni.namespace
    // spec.values.cni.cniBinDir
    istioCtlInput = `
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  components:
    base:
      enabled: true
    cni:
      enabled: true
      namespace: kube-system
  profile: demo
  values:
    global:
      meshID: mesh1
      multiCluster:
        clusterName: ${clusterName}
      network: ${clusterName}
    cni:
      cniBinDir: /home/kubernetes/bin
`.trim();
  }

  const istioCmd = $`istioctl manifest generate -f -`;
  intoStream(istioCtlInput).pipe(istioCmd.stdin);
  const output = await istioCmd;

  const manifest = output.stdout;
  return manifest;
}
