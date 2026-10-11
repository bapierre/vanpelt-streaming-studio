import { describe, expect, it } from 'vitest';
import { listOutputDevices, parseSystemProfiler } from './outputs';

/** Trimmed from a real `system_profiler SPAudioDataType -json` on macOS. */
const SAMPLE = JSON.stringify({
  SPAudioDataType: [
    {
      _name: 'coreaudio_device',
      _items: [
        { _name: 'AirPods Pro', coreaudio_device_input: 1, coreaudio_device_transport: 'coreaudio_device_type_bluetooth' },
        {
          _name: 'AirPods Pro',
          coreaudio_default_audio_output_device: 'spaudio_yes',
          coreaudio_device_output: 2,
          coreaudio_device_transport: 'coreaudio_device_type_bluetooth',
        },
        { _name: 'MacBook Pro Microphone', coreaudio_device_input: 1 },
        { _name: 'MacBook Pro Speakers', coreaudio_device_output: 2 },
        { _name: 'Scarlett 4i4 USB', coreaudio_device_input: 4, coreaudio_device_output: 4 },
      ],
    },
  ],
});

describe('parseSystemProfiler', () => {
  it('lists only devices with outputs, once each', () => {
    expect(parseSystemProfiler(SAMPLE)).toEqual(['AirPods Pro', 'MacBook Pro Speakers', 'Scarlett 4i4 USB']);
  });
  it('copes with no audio section', () => {
    expect(parseSystemProfiler('{}')).toEqual([]);
  });
});

describe('listOutputDevices', () => {
  it('runs system_profiler on macOS', async () => {
    const calls: string[][] = [];
    const r = await listOutputDevices('darwin', async (cmd, args) => {
      calls.push([cmd, ...args]);
      return SAMPLE;
    });
    expect(calls).toEqual([['system_profiler', 'SPAudioDataType', '-json']]);
    expect(r.outputs).toHaveLength(3);
    expect(r.detail).toBeUndefined();
  });
  it('asks for a typed name when listing fails', async () => {
    const r = await listOutputDevices('darwin', async () => 'not json');
    expect(r.outputs).toEqual([]);
    expect(r.detail).toMatch(/Could not list output devices.*Type the output name/);
  });
  it('asks for a typed name on other systems without running anything', async () => {
    const r = await listOutputDevices('win32', async () => {
      throw new Error('should not run');
    });
    expect(r).toEqual({ outputs: [], detail: expect.stringContaining('only be listed on macOS') });
  });
});
