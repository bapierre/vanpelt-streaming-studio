import { z } from 'zod';

/**
 * One scene thumbnail from OBS. Transient by design: never retained, never in history, so a
 * dashboard that reconnects sees the next capture instead of a stale picture.
 */
export const ScenePreviewSchema = z.object({
  scene: z.string().min(1),
  /** `data:` URL of the thumbnail OBS returned (jpeg or png). */
  image: z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, 'a base64 data URL image'),
  /** Epoch ms OBS answered, so a client can drop a picture for a scene that no longer exists. */
  capturedAt: z.number(),
});
export type ScenePreview = z.infer<typeof ScenePreviewSchema>;

/**
 * The preview lease: a dashboard that is showing scene previews publishes this every ~5 s, and the
 * hub captures only while the leases arrive (stopping ~12 s after the last one), so OBS does no
 * thumbnail work while nobody is watching.
 */
export const PreviewsWatchSchema = z.object({}).strict();
export type PreviewsWatch = z.infer<typeof PreviewsWatchSchema>;
