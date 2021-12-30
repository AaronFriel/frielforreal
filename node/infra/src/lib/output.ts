import { Output } from '@pulumi/pulumi/output';

export function assertOutputNonNull<T>(
  output: Output<T | undefined | null>,
): Output<T> {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return output;
}
