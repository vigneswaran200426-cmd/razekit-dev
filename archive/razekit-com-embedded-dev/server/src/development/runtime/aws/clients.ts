// The real AWS clients behind the Fargate runtime, loaded only when it is used.
//
// Credentials come from the standard AWS provider chain of the process that
// runs the DEV worker (an IAM role on AWS, or AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY for a worker hosted elsewhere). Nothing here holds a
// credential of its own, and the build tasks get none: they receive only
// pre-signed URLs for their own two objects.
import type { EcsLike, RunStorage } from './fargate.js';

export async function createAwsClients(opts: { region: string; bucket: string }): Promise<{ ecs: EcsLike; storage: RunStorage }> {
  const [{ ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand }, s3mod, { getSignedUrl }] = await Promise.all([
    import('@aws-sdk/client-ecs'),
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
  ]);
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = s3mod;
  const ecsClient = new ECSClient({ region: opts.region, maxAttempts: 3 });
  const s3 = new S3Client({ region: opts.region, maxAttempts: 3 });
  const Bucket = opts.bucket;

  const ecs: EcsLike = {
    runTask: (input) => ecsClient.send(new RunTaskCommand(input)) as any,
    describeTasks: (input) => ecsClient.send(new DescribeTasksCommand(input)) as any,
    stopTask: (input) => ecsClient.send(new StopTaskCommand(input)),
  };
  const storage: RunStorage = {
    async put(Key, Body) {
      await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'application/gzip', ServerSideEncryption: 'AES256' }));
    },
    async get(Key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
        return Buffer.from(await r.Body!.transformToByteArray());
      } catch (e: any) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async remove(Key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    },
    presignGet: (Key, expiresIn) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn }),
    presignPut: (Key, expiresIn) => getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType: 'application/gzip' }), { expiresIn }),
  };
  return { ecs, storage };
}
