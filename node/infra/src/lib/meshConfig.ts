import * as pulumi from '@pulumi/pulumi';

export type MeshConfig = {
  clusterName: string;
  tailscalePort: number;
  istioRemoteSecretData?: string;
};

export function meshConfig() {
  const config = new pulumi.Config('mesh');

  return {
    clusters: config.requireSecretObject<MeshConfig[]>('clusters'),
  };
}
