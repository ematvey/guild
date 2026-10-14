// S3-compatible object storage client (rustfs/MinIO; spec §4.4/§4.9): same
// object keys, same put/get/delete surface across the eras.

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export class ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: { s3Url: string; s3Bucket: string; s3AccessKeyId: string; s3SecretAccessKey: string }) {
    this.bucket = cfg.s3Bucket;
    this.client = new S3Client({
      endpoint: cfg.s3Url,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.s3AccessKeyId,
        secretAccessKey: cfg.s3SecretAccessKey,
      },
    });
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    // @ts-expect-error Body is a Readable in the Node runtime.
    for await (const chunk of res.Body) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async destroy(): Promise<void> {
    this.client.destroy();
  }
}
