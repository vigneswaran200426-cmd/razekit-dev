// Where finished builds are kept: RazeKit's private object storage.
//
// The worker that built an artifact and the API that serves it may be on
// different machines, so the artifact cannot stay on the worker's disk. It goes
// to the private bucket — never the public one — and is handed out only as a
// short-lived signed URL to the account that owns the build.
import { createSignedUrl, uploadPrivate } from '../integrations/storage.js';
import type { ArtifactStore } from './orchestrator.js';

export function createPrivateArtifactStore(): ArtifactStore {
  return {
    async put(task, bytes) {
      const { file_uri } = await uploadPrivate(bytes, `${task.id}.tar.gz`, 'application/gzip', `dev-artifacts/${task.tenantId}/${task.id}`);
      return file_uri;
    },
    async signedUrl(uri, ttlSeconds) {
      const { signed_url } = await createSignedUrl(uri, ttlSeconds);
      return signed_url;
    },
  };
}
