# The RazeKit DEV build runner image. Build from the repository root:
#   docker build --platform linux/amd64 -f infra/aws/dev-runtime/runner.Dockerfile -t razekit-dev-runner .
# The base is pinned by digest (node:22-slim as of 2026-09-26). To move it:
# docker pull public.ecr.aws/docker/library/node:22-slim, then use its RepoDigest.
FROM public.ecr.aws/docker/library/node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
WORKDIR /runner
COPY server/src/development/runtime/aws/runner.mjs /runner/runner.mjs
# The build workspace. The task definition mounts its `work` volume here over a
# read-only root filesystem, so the directory must exist in the image, owned by
# the runner's UID, and be declared a volume. The chown has to come before
# VOLUME: changes to a volume path after it are discarded.
RUN mkdir -p /work && chown 1000:1000 /work && chmod 0755 /work
VOLUME ["/work"]
# Unprivileged; the task definition also runs it read-only with no capabilities.
USER 1000:1000
ENTRYPOINT ["node", "/runner/runner.mjs"]
