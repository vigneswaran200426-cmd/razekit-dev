import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { id } from "./store.js";

async function collectFiles(root, current, output = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "artifacts" || entry.name === ".git") continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, fullPath, output);
    } else if (entry.isFile()) {
      const info = await stat(fullPath);
      output.push({
        path: path.relative(root, fullPath),
        sizeBytes: info.size
      });
    }
  }
  return output;
}

export async function createGameArtifactManifest(workspaceRoot, {
  engine,
  artifactName = "razekit-game",
  outputDir = "artifacts"
} = {}) {
  const root = path.resolve(workspaceRoot);
  const destination = path.resolve(root, outputDir);
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Artifact output directory escapes the workspace");
  }

  await mkdir(destination, { recursive: true });
  const files = await collectFiles(root, root);
  const artifactId = id("artifact");
  const manifest = {
    artifactId,
    artifactName,
    engine,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    files
  };
  const manifestPath = path.join(destination, artifactId + ".manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    artifactId,
    artifactName,
    engine,
    outputDir: path.relative(root, destination),
    manifest: path.relative(root, manifestPath),
    fileCount: files.length
  };
}
