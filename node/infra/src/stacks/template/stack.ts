import * as pulumi from '@pulumi/pulumi';

export const workDir = __dirname;
export const projectName = 'infra-template';

export function stackConfig() {
  return {};
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  return { foo: 'bar' };
}
