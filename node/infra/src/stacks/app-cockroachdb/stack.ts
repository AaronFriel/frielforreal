import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { getConfig } from '../../lib/config';

export const workDir = __dirname;
export const projectName = 'infra-cockroachdb';

export function stackConfig() {
  const config = new pulumi.Config();

  return {
    clusterName: config.require('clusterName'),
  };
}

const ALL_CLUSTERS = [
  'healthy-blowfish', // gke-gcp-us-west1-a-healthy-blowfish
  'absolute-weevil', // lke47958-ctx
  'fit-loon', // do-sfo3-cluster-a2427f2
  'frank-grub', // aks-cluster895c8bcc
];
/**
 *
 *
 * @export
 * @return {*}
 */
export async function stack() {
  if (!pulumi.runtime.hasEngine()) {
    return;
  }

  const { clusterName } = getConfig().cloud();

  const namespaceName = `cockroachdb-${clusterName}`;
  const namespace = new k8s.core.v1.Namespace('cockroachdb', {
    metadata: {
      name: namespaceName,
      labels: {
        'istio-injection': 'enabled',
      },
    },
  });

  const sa = new k8s.core.v1.ServiceAccount('cockroachdb', {
    metadata: {
      namespace: namespace.metadata.name,
    },
  });

  const appLabels = {
    'app.kubernetes.io/name': 'cockroachdb',
  };

  const localLabels = {
    ...appLabels,
  };

  new k8s.core.v1.Service('cockroachdb', {
    metadata: {
      name: 'crdb',
      namespace: namespace.metadata.name,
      labels: {
        ...localLabels,
        'mirror.linkerd.io/exported': 'true',
      },
      annotations: {
        // Consider successful before statefulset is up.
        'service.alpha.kubernetes.io/tolerate-unready-endpoints': 'true',
        'pulumi.com/skipAwait': 'true',
      },
    },
    spec: {
      ports: [
        {
          name: 'cockroach',
          port: 26257,
          protocol: 'TCP',
          targetPort: 26257,
        },
        {
          name: 'http',
          port: 8080,
          protocol: 'TCP',
          targetPort: 8080,
        },
      ],
      clusterIP: 'None',
      type: 'ClusterIP',
      publishNotReadyAddresses: true,
      sessionAffinity: 'None',
      selector: localLabels,
    },
  });

  const ALL_SERVICES = ALL_CLUSTERS.filter((x) => x !== clusterName).map(
    (otherClusterName) =>
      `crdb-${otherClusterName}.cockroachdb-${otherClusterName}.svc.cluster.local`,
  );

  new k8s.apps.v1.StatefulSet(`cockroachdb`, {
    metadata: {
      name: `crdb-node`,
      namespace: namespace.metadata.name,
      annotations: {
        'pulumi.com/skipAwait': 'true',
      },
      labels: localLabels,
    },
    spec: {
      selector: { matchLabels: localLabels },
      serviceName: 'crdb',
      replicas: 2,
      podManagementPolicy: 'Parallel',
      template: {
        metadata: {
          labels: localLabels,
          annotations: {
            'linkerd.io/inject': 'enabled',
          },
        },
        spec: {
          terminationGracePeriodSeconds: 1,
          serviceAccountName: sa.metadata.name,
          containers: [
            {
              name: 'debug',
              image: 'alpine:latest',
              command: ['/bin/sh', '-c', 'sleep 86400'],
            },
            {
              name: 'cockroach',
              image: 'cockroachdb/cockroach:v21.2.3',
              imagePullPolicy: 'Always',
              command: ['/bin/sh'],
              args: [
                '-c',
                pulumi.interpolate`
until curl -fsI http://localhost:4191/ready; do echo \"Waiting for Sidecar...\"; sleep 3; done;
echo \"Sidecar available. Running the command...\";
cockroach start \
  --insecure \
  --locality=cluster=${clusterName},node=${clusterName}-$POD_NAME \
  --locality-advertise-addr=cluster=${clusterName}@"$(hostname -f)" \
  --advertise-addr=$POD_NAME-${clusterName}.${namespaceName}.svc.cluster.local \
  --join=crdb,${ALL_SERVICES.join(',')} \
  --logtostderr=INFO;
x=$(echo $?); curl -fsI -X POST http://localhost:4191/shutdown && exit $x
                `,
              ],
              env: [
                {
                  name: 'POD_NAME',
                  valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
                },
                {
                  name: 'POD_IP',
                  valueFrom: { fieldRef: { fieldPath: 'status.podIP' } },
                },
                { name: 'COCKROACH_CHANNEL', value: 'kubernetes-multiregion' },
              ],
              ports: [
                {
                  name: 'cockroach',
                  containerPort: 26257,
                  protocol: 'TCP',
                },
                {
                  name: 'http',
                  containerPort: 8080,
                  protocol: 'TCP',
                },
              ],
              readinessProbe: {
                httpGet: {
                  path: '/health?ready=1',
                  port: 'http',
                  scheme: 'HTTPS',
                },
                initialDelaySeconds: 10,
                periodSeconds: 5,
                failureThreshold: 2,
              },
              /*
      internal:
        port: 26257
        # If using Istio set it to `cockroach`.
        name: grpc-internal */
            },
          ],
        },
      },
    },
  });

  // docker pull
  // cockroachdb/cockroach

  /*
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sleep
---
apiVersion: v1
kind: Service
metadata:
  name: sleep
  labels:
    app: sleep
    service: sleep
spec:
  ports:
  - port: 80
    name: http
  selector:
    app: sleep
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sleep
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sleep
  template:
    metadata:
      labels:
        app: sleep
    spec:
      terminationGracePeriodSeconds: 0
      serviceAccountName: sleep
      containers:
      - name: sleep
        image: curlimages/curl
        command: ["/bin/sleep", "3650d"]
        imagePullPolicy: IfNotPresent
        volumeMounts:
        - mountPath: /etc/sleep/tls
          name: secret-volume
      volumes:
      - name: secret-volume
        secret:
          secretName: sleep-secret
          optional: true
--- */

  return { foo: 'bar' };
}
