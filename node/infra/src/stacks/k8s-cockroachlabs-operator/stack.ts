import * as path from 'path';

import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export const workDir = __dirname;
export const projectName = 'infra-k8s-cockroachlabs-operator';

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const crds = new k8s.yaml.ConfigFile('cockroachlabs-crds', {
    file: path.join(__dirname, './lib/cockroachlabs-crds.yaml'),
  });

  new k8s.yaml.ConfigFile(
    'cockroachlabs-operator',
    {
      file: path.join(__dirname, './lib/cockroachlabs-operator.yaml'),
    },
    { dependsOn: [crds] },
  );

  return {};
}
