// Dev script (`pnpm storage:init` at the root): creates the local RustFS/S3
// bucket when missing. Idempotent — safe to run repeatedly.
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { getServerEnv, isConfigured } from "@crm/config";

const env = getServerEnv();

if (!isConfigured(env, "storage")) {
  console.error(
    "storage:init: storage is not configured (set STORAGE_S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY)",
  );
  process.exit(1);
}

const client = new S3Client({
  region: env.storage.region ?? "us-east-1",
  ...(env.storage.endpoint ? { endpoint: env.storage.endpoint } : {}),
  forcePathStyle: env.storage.forcePathStyle,
  credentials: {
    accessKeyId: env.storage.accessKeyId!,
    secretAccessKey: env.storage.secretAccessKey!,
  },
});

const bucket = env.storage.bucket!;

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`storage:init: bucket "${bucket}" already exists`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`storage:init: created bucket "${bucket}"`);
}
