import { LocalWorkspace } from '@pulumi/pulumi/automation';
import { Resource } from '@pulumi/pulumi/dynamic';

import type { StackModule, StackOutputMap } from './stackModule';
import type * as pulumi from '@pulumi/pulumi';
import type * as automation from '@pulumi/pulumi/automation';
import type * as dynamic from '@pulumi/pulumi/dynamic';

export interface LocalPulumiProgramResourceInputs {
  stackName: pulumi.Input<string>;
  projectName: pulumi.Input<string>;
  workDir: pulumi.Input<string>;
  config?: pulumi.Input<Record<string, pulumi.Input<automation.ConfigValue>>>;
}

export type LocalPulumiProgramInputs =
  pulumi.Unwrap<LocalPulumiProgramResourceInputs> & { __provider?: string };

const initialConfigCache: Record<string, automation.ConfigMap> = {};
const stackCache: Record<string, automation.Stack> = {};

async function getStack(
  inputs: LocalPulumiProgramInputs,
  id: string = getId(inputs),
) {
  if (stackCache[id]) {
    return { stack: stackCache[id], initialConfig: initialConfigCache[id] };
  }

  id = getId(inputs);
  const stack = await LocalWorkspace.createOrSelectStack(
    {
      stackName: inputs.stackName,
      workDir: inputs.workDir,
    },
    {
      projectSettings: {
        name: inputs.projectName,
        runtime: 'nodejs',
      },
    },
  );

  initialConfigCache[id] =
    initialConfigCache[id] ?? (await stack.getAllConfig());

  const initialConfig = initialConfigCache[id];
  await stack.setAllConfig({
    ...initialConfig,
    ...inputs.config,
  });
  await stack.refresh();

  stackCache[id] = stack;
  return { stack, initialConfig };
}

async function withTemporaryStack(
  id: string,
  props: LocalPulumiProgramInputs | undefined,
): Promise<{ stack: automation.Stack; cleanup: () => void }> {
  let stackName;
  let projectName;
  if (props) {
    ({ stackName, projectName } = props);
  } else {
    [stackName, projectName] = id.split('/');
  }

  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');

  const tempdir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), projectName),
  );

  const stack = await LocalWorkspace.selectStack(
    {
      // projectName,
      stackName,
      workDir: tempdir,
    },
    {
      projectSettings: {
        name: projectName,
        runtime: 'nodejs',
      },
    },
  );

  return {
    stack,
    cleanup: () =>
      fs.promises
        .rm(tempdir, { recursive: true })
        .catch((err) =>
          console.error(`Error deleting temporary directory: ${err}`),
        ),
  };
}

const provider: dynamic.ResourceProvider = {
  async check(olds, news): Promise<dynamic.CheckResult> {
    if (olds?.projectName && olds?.stackName && getId(olds) !== getId(news)) {
      return {
        failures: [
          {
            property: 'projectName',
            reason: `This field is immutable, cannot modify from '${olds?.projectName}' to '${news?.projectName}'`,
          },
          {
            property: 'stackName',
            reason: `This field is immutable, cannot modify from '${olds?.stackName}' to '${news?.stackName}'`,
          },
        ],
      };
    }

    return {
      inputs: news,
    };
  },

  async read(
    id,
    props?: LocalPulumiProgramInputs,
  ): Promise<dynamic.ReadResult> {
    const { stack, cleanup } = await withTemporaryStack(id, props);

    const outputs = await stack.outputs();

    await cleanup();

    return {
      id,
      props: getOutputs(outputs, props),
    };
  },

  async diff(
    _id: string,
    _olds: LocalPulumiProgramInputs,
    _news: LocalPulumiProgramInputs,
  ): Promise<dynamic.DiffResult> {
    // const { stack, initialConfig } = await getStack({ ...news, ...olds }, id);

    // await applyConfig(stack, initialConfig, news);

    // const previewResult = await stack.preview();

    // const diffs = Object.entries(
    //   previewResult.changeSummary ?? ({} as automation.OpMap),
    // )
    //   .filter(([key, _]) => (key as automation.OpType) !== 'same')
    //   .map(([_, value]) => value)
    //   .reduce((a, b) => a + b, 0);

    return {
      changes: true,
    };
  },

  async create(
    inputs: LocalPulumiProgramInputs,
  ): Promise<dynamic.CreateResult> {
    const { stack } = await getStack(inputs);
    const upResult = await stack.up();

    if (upResult.summary.result !== 'succeeded') {
      throw new Error(upResult.stderr);
    }

    if (!upResult.outputs) {
      throw new Error(
        `Unknown error, outputs not defined.\n${upResult.stdout}`,
      );
    }

    const outputs = upResult.outputs;
    return {
      id: getId(inputs),
      outs: getOutputs(outputs, inputs),
    };
  },

  async update(
    id,
    olds: LocalPulumiProgramInputs,
    news: LocalPulumiProgramInputs,
  ): Promise<dynamic.UpdateResult> {
    const { stack } = await getStack({ ...news, ...olds }, id);

    // await applyConfig(stack, initialConfig, news);

    const upResult = await stack.up();

    if (upResult.summary.result !== 'succeeded') {
      throw new Error(upResult.stderr);
    }

    const outputs = upResult.outputs;
    if (!outputs) {
      throw new Error(
        `Unknown error, outputs not defined.\n${upResult.stdout}`,
      );
    }

    return {
      outs: getOutputs(outputs, news),
    };
  },

  async delete(id: string, props: LocalPulumiProgramInputs): Promise<void> {
    const { stack, cleanup } = await withTemporaryStack(id, props);

    const destroyResult = await stack.destroy();

    await cleanup();

    if (destroyResult.summary.result !== 'succeeded') {
      throw new Error(destroyResult.stderr);
    }
  },
};

function getOutputs(
  outputs: automation.OutputMap,
  news?: LocalPulumiProgramInputs,
) {
  return {
    stackOutputs: outputs,
    projectName: news?.projectName,
    stackName: news?.stackName,
    config: news?.config,
  };
}

function getId(inputs: LocalPulumiProgramInputs) {
  return `${inputs.projectName}/${inputs.stackName}`;
}

export class LocalPulumiProgram<T> extends Resource {
  public readonly stackOutputs!: pulumi.Output<StackOutputMap<StackModule<T>>>;
  public readonly projectName!: pulumi.Output<string>;
  public readonly stackName!: pulumi.Output<string>;

  public readonly config?: pulumi.Output<automation.ConfigMap>;

  constructor(
    name: string,
    stackModule: StackModule<T>,
    args: Omit<LocalPulumiProgramResourceInputs, keyof StackModule<T>>,
    opts?: pulumi.CustomResourceOptions,
  ) {
    const { workDir, projectName } = stackModule;
    super(
      provider,
      name,
      {
        config: args.config ?? undefined,
        workDir,
        projectName,
        ...args,
        stackOutputs: undefined,
      },
      {
        ...opts,
        additionalSecretOutputs: ['stackOutputs', 'config'],
        replaceOnChanges: ['projectName', 'stackName'],
      },
    );
  }
}
