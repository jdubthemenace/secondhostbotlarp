import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

/** Megapixels reported per processed image when not specified. */
export const TARGET_MEGAPIXELS = 12;

export interface ResizeResult {
  outputPath: string;
  width: number;
  height: number;
  bytes: number;
  /** Always "portrait" — the bot now forces 9:16 portrait output. */
  orientation: "portrait" | "landscape";
}

/**
 * Pick 9:16 portrait dimensions for a given megapixel target. Numbers picked
 * to match plausible iPhone outputs:
 *   - 12 MP → 2268 x 4032 (canonical iPhone 16:9 default Photo mode)
 *   - 24 MP → 3402 x 6048 (Pro / Pro Max ProRAW-style 16:9)
 */
function pickDims(targetMegapixels: number): { width: number; height: number } {
  if (targetMegapixels >= 24) return { width: 3402, height: 6048 };
  if (targetMegapixels >= 18) return { width: 2952, height: 5248 };
  return { width: 2268, height: 4032 };
}

/**
 * Resize the input image to a 9:16 portrait canvas matching the iPhone model's
 * megapixel rating. Landscape inputs get center-cropped to portrait so the
 * orientation is always 9:16.
 */
export async function resizeToAppleSensor(
  inputPath: string,
  targetMegapixels: number = TARGET_MEGAPIXELS,
): Promise<ResizeResult> {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const { width: targetW, height: targetH } = pickDims(targetMegapixels);
  const outputPath = path.join(dir, `${base}_${targetMegapixels}mp.jpg`);

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
    orientation: "portrait",
  };
}

export interface HeicResult {
  outputPath: string;
  bytes: number;
}

export interface ExposureSettings {
  iso: number;
  exposureTimeStr: string;
}

export async function analyzeBrightness(
  input: string | Buffer,
): Promise<number> {
  const stats = await sharp(input, { failOn: "none" }).stats();
  const channels = stats.channels.slice(0, 3);
  if (channels.length === 0) return 128;
  return channels.reduce((s, c) => s + c.mean, 0) / channels.length;
}

export function pickSuggestedModel(meanLuma: number): string {
  if (meanLuma >= 140) return "ip17";
  if (meanLuma >= 60) return "ip17p";
  return "ip17pm";
}

export function pickRealisticExposure(meanLuma: number): ExposureSettings {
  type Pair = { iso: number; shutter: string };
  let bucket: Pair[];

  if (meanLuma >= 180) {
    bucket = [
      { iso: 32, shutter: "1/2000" },
      { iso: 50, shutter: "1/1600" },
      { iso: 64, shutter: "1/1250" },
      { iso: 80, shutter: "1/1000" },
    ];
  } else if (meanLuma >= 140) {
    bucket = [
      { iso: 64, shutter: "1/500" },
      { iso: 80, shutter: "1/400" },
      { iso: 100, shutter: "1/320" },
      { iso: 125, shutter: "1/250" },
    ];
  } else if (meanLuma >= 100) {
    bucket = [
      { iso: 160, shutter: "1/200" },
      { iso: 200, shutter: "1/120" },
      { iso: 250, shutter: "1/100" },
      { iso: 320, shutter: "1/80" },
    ];
  } else if (meanLuma >= 60) {
    bucket = [
      { iso: 400, shutter: "1/60" },
      { iso: 500, shutter: "1/50" },
      { iso: 640, shutter: "1/40" },
      { iso: 800, shutter: "1/30" },
    ];
  } else if (meanLuma >= 30) {
    bucket = [
      { iso: 1000, shutter: "1/30" },
      { iso: 1250, shutter: "1/30" },
      { iso: 1600, shutter: "1/25" },
      { iso: 2000, shutter: "1/20" },
    ];
  } else {
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
 * with the x265 backend.
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
      ["-q", String(quality), "-o", outputPath, inputPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`heif-enc failed (code ${code}): ${stderr.trim()}`));
    });
  });

  const stat = await fs.stat(outputPath);
  return { outputPath, bytes: stat.size };
}
