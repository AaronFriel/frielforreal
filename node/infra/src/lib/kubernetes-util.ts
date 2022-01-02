import * as k8s from '@pulumi/kubernetes';
import { Resource } from '@pulumi/pulumi';
import lazyValue from 'lazy-value';

import { getConfig } from './config';
import { gkeFirewallRule } from './gcp-util/gkeFirewallRule';

/**
 * Some environments, such as GKE, require firewall rules to be configured to allow webhooks from
 * the Kubernetes control plane to cluster nodes.
 *
 * @param {string} name Unique ID used to define the Pulumi IDs of the firewall rule(s) created.
 */
export function kubernetesWebhookFirewallRule(
  name: string,
  protocol: 'TCP' | 'UDP',
  ports: number[],
): Resource[] {
  const config = getConfig();

  const cloudConfig = config.cloud();
  const firewallRules: Resource[] = [];
  if (cloudConfig.kubernetesProvider === 'gke') {
    if (!cloudConfig.gkeNetwork || !cloudConfig.gkeNodeTag) {
      throw new Error(
        `gkeNetwork or gkeNodeTag not defined on cloud config, required for firewall rule ${name}`,
      );
    }

    const gkeClusterConfig = config.gkeCluster();
    firewallRules.push(
      gkeFirewallRule(name, {
        gkeMasterIpv4CidrBlock: gkeClusterConfig.masterIpv4CidrBlock,
        gkeNetwork: cloudConfig.gkeNetwork,
        gkeNodeTag: cloudConfig.gkeNodeTag,
        protocol,
        ports: ports.map((x) => `${x}`),
      }),
    );
  }

  return firewallRules;
}

export const getClusterCaCertificate = lazyValue(
  () =>
    k8s.core.v1.ConfigMap.get(
      'istio-kube-ca-cert',
      'kube-public/kube-root-ca.crt',
    ).data['ca.crt'],
);
