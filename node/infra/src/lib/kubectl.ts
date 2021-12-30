import { YZX, $ } from '@frielforreal/yzx';
import pLimit from 'p-limit';
import { KubeConfig } from '@kubernetes/client-node';
import yaml from 'js-yaml';

/**
 * Commands that interact with kube config should run in closures invoked by this function, to
 * ensure that no race conditions occur editing the config file.
 */
const kubeCriticalSection = pLimit(1);
const kube$ = YZX();
kube$.verbose = false;

/**
 * Evaluate some function `f` in a critical section, providing the function with a shell-executing
 * function that can be used within that section.
 *
 * @param f Function to execute in a critical section.
 * @returns Return value of `f`
 */
export function withKubectl<T>(f: ($: $) => Promise<T>): Promise<T> {
  return kubeCriticalSection(() => f(kube$));
}

/**
 * Load in a kubeconfig string into the local (e.g.: ~/.kube/config) config of the user.
 * @param kubeconfig A valid kubeconfig string, not a file path.
 */
export async function loadKubeConfig(kubeconfig: string) {
  await withKubectl(async ($) => {
    $`
KUBECONFIG_DEFAULT="$HOME/.kube/config"
TMPCONFIG=$(mktemp)
TMPOUTPUT=$(mktemp)
echo -n ${kubeconfig} > "$TMPCONFIG"
KUBECONFIG="$KUBECONFIG_DEFAULT:$TMPCONFIG" kubectl config view --flatten > $TMPOUTPUT
mv $TMPOUTPUT $KUBECONFIG_DEFAULT
rm $TMPCONFIG
`;
  });
}

export async function mergeKubeConfigStrings(configs: string[]) {
  const kc = new KubeConfig();

  configs
    .map((config) => {
      const kubeconfig = new KubeConfig();
      kubeconfig.loadFromString(config);
      return kubeconfig;
    })
    .forEach((x) => kc.mergeConfig(x));

  const jsonConfig = kc.exportConfig();

  return yaml.dump(JSON.parse(jsonConfig));
}
