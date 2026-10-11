import { z } from 'zod';

export const CameraIdSchema = z.string().regex(/^[a-z0-9-]+$/, 'use lowercase letters, digits and dashes').max(40);

/** Keys starting with `obs.` belong to the hub (OBS-side controls); drivers use any other key. */
const ControlKey = z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(64);
const ControlBase = {
  key: ControlKey,
  label: z.string().max(80),
  hint: z.string().max(200).optional(),
  /** Why the control cannot be used right now; the dashboard shows it greyed out. */
  disabled: z.string().max(200).optional(),
};

export const CameraControlSchema = z.discriminatedUnion('kind', [
  z.object({
    ...ControlBase,
    kind: z.literal('select'),
    value: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).max(50),
  }),
  z.object({
    ...ControlBase,
    kind: z.literal('range'),
    value: z.number(),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
  }),
  z.object({ ...ControlBase, kind: z.literal('toggle'), value: z.boolean() }),
  z.object({ ...ControlBase, kind: z.literal('action') }),
]);
export type CameraControl = z.infer<typeof CameraControlSchema>;

export const ControlValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ControlValue = z.infer<typeof ControlValueSchema>;

export const CameraStatusSchema = z.enum(['disconnected', 'connecting', 'ready', 'streaming', 'error']);
export type CameraStatus = z.infer<typeof CameraStatusSchema>;

export const CameraTelemetrySchema = z.object({
  battery: z.number().min(0).max(100).optional(),
  overheating: z.boolean().optional(),
});
export type CameraTelemetry = z.infer<typeof CameraTelemetrySchema>;

/** The OBS input a driver needs, so the hub can offer to create the camera's scene. */
export const ObsInputSuggestionSchema = z.object({
  kind: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
});
export type ObsInputSuggestion = z.infer<typeof ObsInputSuggestionSchema>;

export const CameraStateSchema = z.object({
  id: CameraIdSchema,
  name: z.string(),
  driver: z.string().nullable(),
  status: CameraStatusSchema,
  detail: z.string().optional(),
  /** Set when the camera's OBS scene or source is unusable. */
  obsDetail: z.string().optional(),
  scene: z.string(),
  onAir: z.boolean(),
  telemetry: CameraTelemetrySchema.optional(),
  controls: z.array(CameraControlSchema).max(60),
});
export type CameraState = z.infer<typeof CameraStateSchema>;

/** What a driver reports about recording to the camera's own card. Omitted means the driver cannot. */
export const CardRecordingSchema = z.object({
  supported: z.boolean(),
  recording: z.boolean(),
  detail: z.string().max(300).optional(),
});
export type CardRecording = z.infer<typeof CardRecordingSchema>;

export const CameraDriverStateSchema = z
  .object({
    id: CameraIdSchema,
    status: CameraStatusSchema,
    detail: z.string().max(300).optional(),
    telemetry: CameraTelemetrySchema.optional(),
    controls: z.array(CameraControlSchema).max(40),
    obsInput: ObsInputSuggestionSchema.optional(),
    card: CardRecordingSchema.optional(),
  })
  .refine((s) => !s.controls.some((c) => c.key.startsWith('obs.')), {
    message: 'driver control keys may not start with "obs."',
    path: ['controls'],
  });
export type CameraDriverState = z.infer<typeof CameraDriverStateSchema>;

export const CameraSetSchema = z.object({ id: CameraIdSchema, key: ControlKey, value: ControlValueSchema });
