import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { processPhoto } from "./pipeline.js";
import { UnsupportedImageTypeError } from "./errors.js";

// A synthetic solid-color JPEG tagged with an EXIF orientation. Orientation 6
// means "rotate 90° CW for display", so a 3000×1000 landscape source displays as
// 1000×3000 portrait — the pipeline must bake that in.
async function orientedJpeg(width: number, height: number, orientation: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg()
    .withMetadata({ orientation })
    .toBuffer();
}

describe("processPhoto", () => {
  it("applies EXIF orientation (dimensions swap) and strips metadata", async () => {
    const fixture = await orientedJpeg(3000, 1000, 6);
    const before = await sharp(fixture).metadata();
    expect(before.width).toBe(3000);
    expect(before.orientation).toBe(6);

    const result = await processPhoto(fixture, "image/jpeg");
    expect(result.contentType).toBe("image/jpeg");

    // Orientation 6 rotates the landscape source to portrait before resizing, so
    // the output is taller than it is wide — proof the rotation was applied, not
    // merely recorded.
    expect(result.height).toBeGreaterThan(result.width);

    const fullMeta = await sharp(result.full).metadata();
    expect(result.width).toBe(fullMeta.width);
    expect(result.height).toBe(fullMeta.height);
    // Re-encode carries no EXIF/GPS forward, and orientation is normalized away.
    expect(fullMeta.exif).toBeUndefined();
    expect(fullMeta.orientation ?? 1).toBe(1);
    // Full image capped to a 2048 longest edge.
    expect(Math.max(fullMeta.width ?? 0, fullMeta.height ?? 0)).toBeLessThanOrEqual(2048);
  });

  it("emits a thumbnail no larger than 480 on its longest edge", async () => {
    const fixture = await orientedJpeg(3000, 1000, 1);
    const result = await processPhoto(fixture, "image/jpeg");
    const thumbMeta = await sharp(result.thumb).metadata();
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(480);
    expect(thumbMeta.exif).toBeUndefined();
  });

  it("normalizes a PNG source to JPEG output", async () => {
    const png = await sharp({
      create: { width: 600, height: 400, channels: 4, background: { r: 10, g: 120, b: 40, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const result = await processPhoto(png, "image/png");
    const meta = await sharp(result.full).metadata();
    expect(meta.format).toBe("jpeg");
    expect(result.width).toBe(600);
    expect(result.height).toBe(400);
  });

  it("accepts a content type with charset parameters and mixed case", async () => {
    const fixture = await orientedJpeg(400, 400, 1);
    const result = await processPhoto(fixture, "IMAGE/JPEG; charset=binary");
    expect(result.contentType).toBe("image/jpeg");
  });

  it("rejects an unsupported content type before decoding", async () => {
    await expect(processPhoto(Buffer.from("not an image"), "image/gif")).rejects.toBeInstanceOf(
      UnsupportedImageTypeError,
    );
  });
});
