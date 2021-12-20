import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { RandomPassword } from '@pulumi/random';

export const workDir = __dirname;
export const projectName = 'infra-k8s-quotes-app';

export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const namespace = new k8s.core.v1.Namespace('quotes-app');

  new k8s.apiextensions.CustomResource('db', {
    apiVersion: 'crdb.cockroachlabs.com/v1alpha1',
    kind: 'CrdbCluster',
    metadata: {
      name: 'cockroachdb',
      namespace: namespace.metadata.name,
    },
    spec: {
      dataStore: {
        pvc: {
          spec: {
            accessModes: ['ReadWriteOnce'],
            // TODO: GCP specific.
            storageClassName: 'premium-rwo',
            resources: {
              requests: {
                storage: '5Gi',
              },
            },
            volumeMode: 'Filesystem',
          },
        },
      },
      resources: {},
      tlsEnabled: true,
      image: {
        name: 'cockroachdb/cockroach:v21.1.11',
      },
      nodes: 3,
    },
  });

  const dbUser = 'quotes';
  const dbPassword = new RandomPassword('db-password', {
    length: 20,
  }).result;

  new k8s.core.v1.Secret('quotes-db-acct', {
    metadata: {
      namespace: namespace.metadata.name,
    },
    stringData: {
      dbuser: dbUser,
      dbpassword: dbPassword,
    },
  });

  const jobLabels = { 'app.kubernetes.io/name': 'init-job' };
  new k8s.batch.v1.Job('init', {
    metadata: {
      namespace: namespace.metadata.name,
      labels: jobLabels,
    },
    spec: {
      template: {
        metadata: {
          labels: jobLabels,
        },
        spec: {
          serviceAccountName: 'cockroachdb-sa',
          containers: [
            {
              name: 'cockroachdb-client-secure',
              image: 'cockroachdb/cockroach:v21.1.11',
              imagePullPolicy: 'IfNotPresent',
              volumeMounts: [
                {
                  name: 'client-certs',
                  mountPath: '/cockroach/cockroach-certs/',
                },
              ],
              command: ['sleep', '2147483648'],
            },
          ],
          volumes: [
            {
              name: 'client-certs',
              projected: {
                sources: [
                  {
                    secret: {
                      name: 'cockroachdb-node',
                      items: [{ key: 'ca.crt', path: 'ca.crt' }],
                    },
                  },
                  {
                    secret: {
                      name: 'cockroachdb-root',
                      items: [
                        { key: 'tls.crt', path: 'client.root.crt' },
                        { key: 'tls.key', path: 'client.root.key' },
                      ],
                    },
                  },
                ],
                defaultMode: 256,
              },
            },
          ],
        },
      },
    },
  });

  // const labels = { app: 'quotes' };

  // new k8s.apps.v1.Deployment('quotes', {
  //   metadata: {
  //     labels,
  //     namespace: namespace.metadata.name,
  //   },
  //   spec: {
  //     selector: { matchLabels: labels },
  //     replicas: 1,
  //     template: {
  //       metadata: { labels },
  //       spec: {
  //         containers: [
  //           {
  //             name: 'quotes',
  //             image: 'ghcr.io/cockroachlabs/quotes/quotes:latest',
  //             args: [
  //               '-b',
  //               '0.0.0.0:3000',
  //               '-c',
  //               'postgresql://quotes:foobar@cockroachdb:26257/quotes?sslmode=disable',
  //             ],
  //             ports: [
  //               {
  //                 containerPort: 3000,
  //               },
  //             ],
  //           },
  //         ],
  //       },
  //     },
  //   },
  // });

  // const service = new k8s.core.v1.Service('quotes', {
  //   metadata: { labels },
  //   spec: {
  //     ports: [
  //       {
  //         port: 3000,
  //         targetPort: 3000,
  //         protocol: 'TCP',
  //       },
  //     ],
  //     selector: labels,
  //     type: 'ClusterIP',
  //   },
  // });

  // new k8s.networking.v1.Ingress('quotes', {
  //   metadata: {
  //     labels,
  //     // annotations: {
  //     //   'kubernetes.io/ingress.class': 'nginx',
  //     // },
  //   },
  //   spec: {
  //     ingressClassName: 'nginx',
  //     tls: [
  //       {
  //         hosts: ['quotes.frielforreal.io'],
  //       },
  //     ],
  //     rules: [
  //       {
  //         host: 'quotes.frielforreal.io',
  //         http: {
  //           paths: [
  //             {
  //               backend: {
  //                 service: {
  //                   name: service.metadata.name,
  //                   port: {
  //                     number: 3000,
  //                   },
  //                 },
  //               },
  //               pathType: 'Prefix',
  //               path: '/',
  //             },
  //           ],
  //         },
  //       },
  //     ],
  //   },
  // });
}
