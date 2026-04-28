import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
/** Long edge of the 4:3 / 48 MP canvas (matches Apple's main camera output). */
export const LONG_EDGE = 8000;
/** Short edge of the 4:3 / 48 MP canvas (matches Apple's main camera output). */
export const SHORT_EDGE = 6000;
/** Megapixels reported per processed image. */
export const TARGET_MEGAPIXELS = 48;
export interface ResizeResult {
  outputPath: string;
  width: number;
  height: number;
  bytes: number;
  /** "portrait" if input was taller than wide, otherwise "landscape". */
  orientation: "portrait" | "landscape";
}
/**
 * Resize the input image to a 48 MP / 4:3 canvas matching Apple iPhone main
 * camera output. Output is `8000 x 6000` (landscape) or `6000 x 8000`
 * (portrait), chosen automatically from the source image's aspect ratio so the
 * orientation feels natural.
 */
export async function resizeToAppleSensor(
  inputPath: string,
): Promise<ResizeResult> {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(dir, `${base}_48mp.jpg`);
  const meta = await sharp(inputPath, { failOn: "none" }).rotate().metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  const isPortrait = srcH > srcW;
  const targetW = isPortrait ? SHORT_EDGE : LONG_EDGE;
  const targetH = isPortrait ? LONG_EDGE : SHORT_EDGE;
  await sharp(inputPath, { failOn: "none" })
    .rotate()
    .resize({
      width: targetW,
      height: targetH,
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
    })
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:2:0" })
    .toFile(outputPath);
  const stat = await fs.stat(outputPath);
  return {
    outputPath,
    width: targetW,
    height: targetH,
    bytes: stat.size,
    orientation: isPortrait ? "portrait" : "landscape",
  };
}
export interface HeicResult {
  outputPath: string;
  bytes: number;
}
export interface ExposureSettings {
  iso: number;
  /** Shutter as an EXIF rational string, e.g. "1/250". */
  exposureTimeStr: string;
}
/**
 * Mean luminance of the input image in the 0-255 range. We use the average of
 * the R, G, B channel means as a fast proxy for perceived brightness — fine
 * for picking believable exposure values, no need for a full Rec.709 conversion.
 */
export async function analyzeBrightness(
  input: string | Buffer,
): Promise<number> {
  const stats = await sharp(input, { failOn: "none" }).stats();
  const channels = stats.channels.slice(0, 3);
  if (channels.length === 0) return 128;
  return channels.reduce((s, c) => s + c.mean, 0) / channels.length;
}
/**
 * Pick a plausible iPhone model to suggest given the scene's mean luminance.
 * Bright outdoor → newest non-Pro (a casual snap), normal/indoor → Pro,
 * dim/night → Pro Max (best low-light reputation). Pure UX hint — the user
 * can still pick anything.
 */
export function pickSuggestedModel(meanLuma: number): string {
  if (meanLuma >= 140) return "ip17";
  if (meanLuma >= 60) return "ip17p";
  return "ip17pm";
}
/**
 * Map a scene-brightness estimate (0-255) to a believable iPhone
 * (ISO, shutter) pair. Buckets follow how an iPhone's auto-exposure actually
 * picks values — bright daylight stays at base ISO with a fast shutter, dim
 * scenes climb the ISO ladder and slow the shutter, and full night drops into
 * the long-exposure / Night-mode range. Each bucket has a few plausible pairs
 * so repeated photos of similar scenes don't always come out with the same
 * numbers.
 */
export function pickRealisticExposure(meanLuma: number): ExposureSettings {
  type Pair = { iso: number; shutter: string };
  let bucket: Pair[];
  if (meanLuma >= 180) {
    // Bright sun / snow / beach.
    bucket = [
      { iso: 32, shutter: "1/2000" },
      { iso: 50, shutter: "1/1600" },
      { iso: 64, shutter: "1/1250" },
      { iso: 80, shutter: "1/1000" },
    ];
  } else if (meanLuma >= 140) {
    // Bright outdoor / open shade.
    bucket = [
      { iso: 64, shutter: "1/500" },
      { iso: 80, shutter: "1/400" },
      { iso: 100, shutter: "1/320" },
      { iso: 125, shutter: "1/250" },
    ];
  } else if (meanLuma >= 100) {
    // Bright indoor / overcast.
    bucket = [
      { iso: 160, shutter: "1/200" },
      { iso: 200, shutter: "1/120" },
      { iso: 250, shutter: "1/100" },
      { iso: 320, shutter: "1/80" },
    ];
  } else if (meanLuma >= 60) {
    // Normal indoor.
    bucket = [
      { iso: 400, shutter: "1/60" },
      { iso: 500, shutter: "1/50" },
      { iso: 640, shutter: "1/40" },
      { iso: 800, shutter: "1/30" },
    ];
  } else if (meanLuma >= 30) {
    // Dim indoor / evening.
    bucket = [
      { iso: 1000, shutter: "1/30" },
      { iso: 1250, shutter: "1/30" },
      { iso: 1600, shutter: "1/25" },
      { iso: 2000, shutter: "1/20" },
    ];
  } else {
    // Low light / night.
    bucket = [
      { iso: 2500, shutter: "1/15" },
      { iso: 3200, shutter: "1/12" },
      { iso: 4000, shutter: "1/10" },
      { iso: 5000, shutter: "1/8" },
    ];
  }
  const pick = bucket[Math.floor(Math.random() * bucket.length)];
  return { iso: pick.iso, exposureTimeStr: pick.shutter };
}
/**
 * Re-encode a JPEG/PNG into a real HEIC (HEVC) file using libheif's `heif-enc`
 * with the x265 backend. iPhones save photos as HEIC by default, so this
 * matches the on-device file format end-to-end (`FileType: HEIC`,
 * `MIMEType: image/heic`).
 *
 * Memory-friendly x265 settings (preset=ultrafast, single pool, no WPP) so
 * encoding a 48 MP frame doesn't get OOM-killed on small containers.
 */
export async function encodeAsHeic(
  inputPath: string,
  quality = 75,
): Promise<HeicResult> {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(dir, `${base}.heic`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "heif-enc",
      [
        "-q", String(quality),
        "-p", "preset=ultrafast",
        "-p", "pools=1",
        "-p", "frame-threads=1",
        "-p", "wpp=0",
        "-o", outputPath,
        inputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      // heif-enc on this host emits harmless `set_mempolicy` warnings on
      // stderr but still exits 0 on success. Treat non-zero codes as fatal
      // and surface stderr in the message.
      if (code === 0) resolve();
      else reject(new Error(`heif-enc failed (code ${code}): ${stderr.trim()}`));
    });
  });
  const stat = await fs.stat(outputPath);
  return { outputPath, bytes: stat.size };
}
