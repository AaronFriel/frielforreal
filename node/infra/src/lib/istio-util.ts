import { YZX } from '@frielforreal/yzx';
import intoStream = require('into-stream');
import * as pulumi from '@pulumi/pulumi';
import yaml from 'js-yaml';

import { CloudKubernetesProvider } from './cloudConfig';

interface IstioOperatorManifestOptions {
  /**
   * Short name of cluster, e.g.: "finer-redfish"
   */
  clusterName: string;
  /**
   * Cloud provider, e.g.: "gke"
   */
  cloudProvider: CloudKubernetesProvider | undefined;
  /**
   * Kubernetes Cluster CA certificate.
   */
  clusterCaCrt: pulumi.Input<string>;
}

/**
 * Uses `istioctl manifest generate` to create a string containing YAML resources to deploy.
 */
export function getIstioOperatorManifest({
  clusterName,
  cloudProvider,
  clusterCaCrt,
}: IstioOperatorManifestOptions): pulumi.Output<string> {
  const $ = YZX();
  $.verbose = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const istioCtlInput: any = {
    apiVersion: 'install.istio.io/v1alpha1',
    kind: 'IstioOperator',
    spec: {
      components: {
        base: {
          enabled: true,
        },
        cni: {
          enabled: true,
        },
      },
      profile: 'demo',
      values: {
        pilot: {
          // Required to securely expose the Kubernetes API over an Istio ingress gateway.
          jwksResolverExtraRootCA: clusterCaCrt,
        },
        global: {
          meshID: 'mesh1',
          multiCluster: {
            clusterName: clusterName,
          },
          network: clusterName,
        },
        cni: {},
      },
    },
  };

  if (cloudProvider === 'gke') {
    istioCtlInput.spec.values.cni.cniBinDir = '/home/kubernetes/bin';
    istioCtlInput.spec.components.cni.namespace = 'kube-system';
  }

  return pulumi.output(istioCtlInput).apply(async (istioCtlJson) => {
    const istioYaml = yaml.dump(istioCtlJson);

    const istioCmd = $`istioctl manifest generate -f -`;
    intoStream(istioYaml).pipe(istioCmd.stdin);
    const output = await istioCmd;

    return output.stdout;
  });
}

export async function getEastWestGatewayManifest(clusterName: string) {
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
          resources:
            requests:
              cpu: 10m
              memory: 40Mi
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

  const manifest = output.stdout;
  return manifest;
}
