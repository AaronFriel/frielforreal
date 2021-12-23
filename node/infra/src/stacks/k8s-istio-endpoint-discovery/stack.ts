import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { YZX } from '@frielforreal/yzx';
import { Config } from '@pulumi/pulumi';
import urlSlug from 'url-slug';

export const workDir = __dirname;
export const projectName = 'infra-k8s-istio-endpoint-discovery';

export function config() {
  const config = new Config();

  return {
    contexts: config.requireObject<string[]>('contexts'),
  };
}

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const $ = YZX();
  $.verbose = false;

  process.stdout.write('Hello, world!');

  const { contexts } = config();

  for (const localContext of contexts) {
    const provider = new k8s.Provider(`${localContext}-provider`, {
      context: localContext,
    });

    const remoteSecrets = await Promise.all(
      contexts
        .filter((remoteContext) => remoteContext !== localContext)
        .map(async (remoteContext) => {
          const name = urlSlug(remoteContext);
          const output =
            await $`istioctl x create-remote-secret --context=${remoteContext} --name=${name}`;
          return output.stdout;
        }),
    );

    new k8s.yaml.ConfigGroup(
      `${localContext}-remote-secrets`,
      {
        yaml: remoteSecrets,
        resourcePrefix: localContext,
      },
      { provider },
    );
  }

  return {};
}
