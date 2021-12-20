import { Firewall } from '@pulumi/gcp/compute';

export function gkeFirewallRule(
  name: string,
  {
    gkeNetwork,
    gkeNodeTag,
    gkeMasterIpv4CidrBlock,
    protocol,
    ports,
  }: {
    gkeNetwork: string;
    gkeNodeTag: string;
    gkeMasterIpv4CidrBlock: string;
    protocol: string;
    ports: string[];
  },
) {
  return new Firewall(name, {
    direction: 'INGRESS',
    network: gkeNetwork,
    sourceRanges: [gkeMasterIpv4CidrBlock],
    allows: [
      {
        protocol,
        ports,
      },
    ],
    targetTags: [gkeNodeTag],
  });
}
