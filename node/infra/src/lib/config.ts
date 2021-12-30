import * as pulumi from '@pulumi/pulumi';
import lazyValue = require('lazy-value');

import * as gkeCluster from '../stacks/gke-cluster/stack';

import { cloudConfig } from './cloudConfig';
import { meshConfig } from './meshConfig';

export type Config = ReturnType<typeof getConfig>;

export function getConfig() {
  if (!pulumi.runtime.hasEngine()) {
    throw new Error('Config is not available outside of Pulumi context.');
  }

  return {
    gcp: lazyValue(() => {
      const gcpConfig = new pulumi.Config('gcp');

      return {
        project: gcpConfig.require('project'),
        zone: gcpConfig.get('zone'),
        region: gcpConfig.require('region'),
      };
    }),
    gkeCluster: lazyValue(gkeCluster.stackConfig),

    cloud: lazyValue(cloudConfig),
    mesh: lazyValue(meshConfig),
  };
}
