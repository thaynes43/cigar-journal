import { describe, it, expect } from "vitest";
import { createMemoryPhotoStorage, photoStorageFromEnv } from "./storage.js";

describe("createMemoryPhotoStorage", () => {
  it("round-trips put → get and honors delete", async () => {
    const storage = createMemoryPhotoStorage();
    const body = Buffer.from([1, 2, 3, 4]);
    await storage.put("smoke/abc/one.jpg", body, "image/jpeg");

    const got = await storage.get("smoke/abc/one.jpg");
    expect(got.contentType).toBe("image/jpeg");
    expect(Buffer.isBuffer(got.body)).toBe(true);
    expect(Buffer.compare(got.body as Buffer, body)).toBe(0);

    await storage.delete("smoke/abc/one.jpg");
    await expect(storage.get("smoke/abc/one.jpg")).rejects.toThrow();
  });

  it("defensively copies the stored body", async () => {
    const storage = createMemoryPhotoStorage();
    const body = Buffer.from([9, 9]);
    await storage.put("k", body, "image/jpeg");
    body[0] = 0; // mutate the caller's buffer after storing
    const got = (await storage.get("k")).body as Buffer;
    expect(got[0]).toBe(9);
  });
});

describe("photoStorageFromEnv", () => {
  it("returns null when the bucket is unconfigured (feature disabled)", () => {
    expect(photoStorageFromEnv({})).toBeNull();
    expect(
      photoStorageFromEnv({ PHOTOS_S3_ENDPOINT: "https://rgw", PHOTOS_S3_BUCKET: "photos" }),
    ).toBeNull();
  });

  it("builds a storage client when all required vars are present", () => {
    const storage = photoStorageFromEnv({
      PHOTOS_S3_ENDPOINT: "https://rgw.example",
      PHOTOS_S3_BUCKET: "photos",
      PHOTOS_S3_ACCESS_KEY_ID: "key",
      PHOTOS_S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(storage).not.toBeNull();
    expect(typeof storage?.put).toBe("function");
  });
});
