/* eslint-disable @typescript-eslint/no-explicit-any */

const isCrd = (o: any) => {
  return o?.kind === 'CustomResourceDefinition';
};

export const omitObject = (o: any) => {
  o.kind = 'List';
  o.apiVersion = 'v1';
  o.metadata = {};
  o.spec = {};
  o.items = [];
};

export const crdOnly = (o: any) => {
  if (!isCrd(o)) {
    omitObject(o);
  }
};

export const nonCrdOnly = (o: any) => {
  if (isCrd(o)) {
    omitObject(o);
  }
};
