import * as k8s from '@pulumi/kubernetes';

import { disableLinkerdAdmissionWebhook } from './linkerd';

export function descheduler() {
  const namespace = new k8s.core.v1.Namespace('admin-descheduler', {
    metadata: {
      labels: {
        ...disableLinkerdAdmissionWebhook,
      },
    },
  });

  new k8s.helm.v3.Chart('descheduler', {
    namespace: namespace.metadata.name,
    chart: 'descheduler',
    fetchOpts: {
      repo: 'https://kubernetes-sigs.github.io/descheduler/',
    },
    version: '0.22.0',
    values: {
      deschedulerPolicy: {
        strategies: {
          PodLifeTime: {
            enabled: true,
            params: {
              podLifeTime: {
                maxPodLifeTimeSeconds: 300,
                podStatusPhases: ['Pending'],
              },
            },
          },
          RemovePodsHavingTooManyRestarts: {
            enabled: true,
            params: {
              podsHavingTooManyRestarts: {
                podRestartThreshold: 100,
                includingInitContainers: true,
              },
            },
          },
          RemoveFailedPods: {
            enabled: true,
            params: {
              failedPods: {
                reasons: ['NodeAffinity'],
                includingInitContainers: true,
                excludeOwnerKinds: ['Job'],
                minPodLifetimeSeconds: 3600,
              },
            },
          },
        },
      },
    },
  });
}
