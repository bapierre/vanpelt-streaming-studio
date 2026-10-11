import { execFile } from 'node:child_process';
import { describeError } from '../util/errors';

export type OutputList = { outputs: string[]; detail?: string };
export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

const TYPE_IT = 'Type the output name as your computer shows it.';

/** Output device names from `system_profiler SPAudioDataType -json`, in the order macOS lists them. */
export function parseSystemProfiler(text: string): string[] {
  const json = JSON.parse(text) as { SPAudioDataType?: Array<{ _items?: Array<Record<string, unknown>> }> };
  const names = new Set<string>();
  for (const group of json.SPAudioDataType ?? []) {
    for (const item of group._items ?? []) {
      const name = item._name;
      if (typeof name === 'string' && name && Number(item.coreaudio_device_output) > 0) names.add(name);
    }
  }
  return [...names];
}

const runFile: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export async function listOutputDevices(platform: string = process.platform, run: RunCommand = runFile): Promise<OutputList> {
  if (platform !== 'darwin') return { outputs: [], detail: `Output devices can only be listed on macOS. ${TYPE_IT}` };
  try {
    const outputs = parseSystemProfiler(await run('system_profiler', ['SPAudioDataType', '-json']));
    return outputs.length > 0 ? { outputs } : { outputs, detail: `No output devices found. ${TYPE_IT}` };
  } catch (err) {
    return { outputs: [], detail: `Could not list output devices (${describeError(err)}). ${TYPE_IT}` };
  }
}
