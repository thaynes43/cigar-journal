import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A throwaway object store for the e2e rig. The photo surfaces are only reachable
// when `photoStorageFromEnv` finds a bucket (@cj/photos, ADR-007) — without one
// `photosEnabled` is false, every photo route answers 503, and the drop page
// (ADR-014) has nothing to click through. So the harness brings its own.
//
// It speaks the three S3 operations @cj/photos actually issues — PutObject,
// GetObject, DeleteObject — path-style, which is how `createS3PhotoStorage`
// addresses Ceph RGW in production (`forcePathStyle: true`), so the app talks to
// this through the SAME S3 client and the same code path it uses against the real
// bucket. Authorization headers are ignored: the server is bound to loopback on
// an ephemeral port and dies with the run.
//
// The alternative — an env-selected in-memory backend inside @cj/photos — was
// not taken: it would put a test-only branch in the module whose whole job is to
// be the one way bytes reach storage, and the e2e suite would then be exercising
// a path production never runs.

export interface ObjectStorageShim {
  // The variables the app process needs for photoStorageFromEnv to wire up.
  env: Record<string, string>;
  stop: () => Promise<void>;
}

// S3 says missing keys are NoSuchKey; the SDK turns this into the error the
// callers already handle, rather than a parse failure on an empty body.
function noSuchKey(res: ServerResponse): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`;
  res.writeHead(404, { "Content-Type": "application/xml" });
  res.end(body);
}

export async function startObjectStorage(bucket = "e2e-photos"): Promise<ObjectStorageShim> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const prefix = `/${bucket}/`;

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    if (!path.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const key = path.slice(prefix.length);

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(key, {
          body: Buffer.concat(chunks),
          contentType: req.headers["content-type"] ?? "application/octet-stream",
        });
        res.writeHead(200, { ETag: `"${key.length}"` }).end();
      });
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const object = objects.get(key);
      if (!object) return noSuchKey(res);
      res.writeHead(200, {
        "Content-Type": object.contentType,
        "Content-Length": String(object.body.byteLength),
      });
      res.end(req.method === "HEAD" ? undefined : object.body);
      return;
    }

    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }

    res.writeHead(405).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    env: {
      PHOTOS_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      PHOTOS_S3_BUCKET: bucket,
      PHOTOS_S3_ACCESS_KEY_ID: "e2e",
      PHOTOS_S3_SECRET_ACCESS_KEY: "e2e-secret",
      PHOTOS_S3_REGION: "us-east-1",
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
