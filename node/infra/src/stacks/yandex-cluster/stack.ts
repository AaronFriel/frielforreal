import * as pulumi from '@pulumi/pulumi';

export const workDir = __dirname;
export const projectName = 'infra-yandex-cluster';

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  return { foo: 'bar' };
}
