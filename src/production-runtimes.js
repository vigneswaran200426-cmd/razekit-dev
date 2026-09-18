export function buildContainerSpec({
  image,
  command = [],
  workspacePath,
  networkPolicyId,
  cpu = 2,
  memoryMiB = 4096,
  pidsLimit = 512,
  readOnlyRootFs = true,
  privileged = false,
  gpu = null,
  environment = {}
} = {}) {
  if (!image?.trim()) throw new Error("Container image is required");
  if (!workspacePath?.trim()) throw new Error("Container workspacePath is required");
  if (!networkPolicyId?.trim()) throw new Error("Container networkPolicyId is required");
  if (privileged) throw new Error("Privileged containers are not permitted");
  if (!Array.isArray(command)) throw new Error("Container command must be an array");
  if (Object.keys(environment).some(key => /secret|token|password|key/i.test(key))) {
    throw new Error("Secrets must not be embedded in container environment configuration");
  }

  return {
    runtime: "container",
    image,
    command: command.map(String),
    workspacePath,
    networkPolicyId,
    resources: {
      cpu: Math.max(0.1, Number(cpu)),
      memoryMiB: Math.max(128, Number(memoryMiB)),
      pidsLimit: Math.max(64, Math.floor(Number(pidsLimit)))
    },
    security: {
      privileged: false,
      readOnlyRootFs: Boolean(readOnlyRootFs),
      dropAllCapabilities: true,
      noNewPrivileges: true
    },
    gpu: gpu ? {
      vendor: gpu.vendor,
      count: Math.max(1, Number(gpu.count || 1))
    } : null,
    environment: { ...environment }
  };
}

export class ContainerRuntimeDriver {
  async create() {
    throw new Error("ContainerRuntimeDriver.create() is not implemented");
  }

  async start() {
    throw new Error("ContainerRuntimeDriver.start() is not implemented");
  }

  async stop() {
    throw new Error("ContainerRuntimeDriver.stop() is not implemented");
  }

  async remove() {
    throw new Error("ContainerRuntimeDriver.remove() is not implemented");
  }
}

export class DockerContainerRuntime extends ContainerRuntimeDriver {
  constructor(driver) {
    super();
    if (!driver) throw new Error("Docker runtime driver is required");
    this.driver = driver;
  }

  async provision(spec) {
    const container = await this.driver.create(spec);
    await this.driver.start(container.id);
    return { runtimeId: container.id, runtime: "container", status: "running" };
  }

  async terminate(runtimeId) {
    await this.driver.stop(runtimeId);
    await this.driver.remove(runtimeId);
    return { runtimeId, status: "terminated" };
  }
}

export function buildMicroVMRuntimeSpec({
  image,
  kernel,
  rootDisk,
  workspaceDisk,
  networkPolicyId,
  vcpus = 4,
  memoryMiB = 8192,
  gpu = null
} = {}) {
  if (!image?.trim()) throw new Error("MicroVM image is required");
  if (!kernel?.trim()) throw new Error("MicroVM kernel is required");
  if (!rootDisk?.trim()) throw new Error("MicroVM rootDisk is required");
  if (!workspaceDisk?.trim()) throw new Error("MicroVM workspaceDisk is required");
  if (!networkPolicyId?.trim()) throw new Error("MicroVM networkPolicyId is required");

  return {
    runtime: "microvm",
    image,
    kernel,
    rootDisk,
    workspaceDisk,
    networkPolicyId,
    resources: {
      vcpus: Math.max(1, Math.floor(Number(vcpus))),
      memoryMiB: Math.max(256, Number(memoryMiB))
    },
    gpu: gpu ? {
      vendor: gpu.vendor,
      deviceIds: [...new Set((gpu.deviceIds || []).map(String))]
    } : null
  };
}

export class MicroVMRuntimeDriver {
  async create() {
    throw new Error("MicroVMRuntimeDriver.create() is not implemented");
  }

  async start() {
    throw new Error("MicroVMRuntimeDriver.start() is not implemented");
  }

  async stop() {
    throw new Error("MicroVMRuntimeDriver.stop() is not implemented");
  }

  async destroy() {
    throw new Error("MicroVMRuntimeDriver.destroy() is not implemented");
  }
}

export class FirecrackerMicroVMRuntime extends MicroVMRuntimeDriver {
  constructor(driver) {
    super();
    if (!driver) throw new Error("MicroVM runtime driver is required");
    this.driver = driver;
  }

  async provision(spec) {
    const vm = await this.driver.create(spec);
    await this.driver.start(vm.id);
    return { runtimeId: vm.id, runtime: "microvm", status: "running" };
  }

  async terminate(runtimeId) {
    await this.driver.stop(runtimeId);
    await this.driver.destroy(runtimeId);
    return { runtimeId, status: "terminated" };
  }
}

export function buildGpuWorkerSpec({
  vendor = "nvidia",
  deviceCount = 1,
  resourceClass = "gpu",
  runtime = "container"
} = {}) {
  if (resourceClass !== "gpu") throw new Error("GPU worker must use gpu resource class");
  if (!["nvidia", "amd", "apple"].includes(vendor)) {
    throw new Error("Unsupported GPU vendor");
  }
  const numericCount = Number(deviceCount);
  if (!Number.isFinite(numericCount) || numericCount < 1) {
    throw new Error("GPU deviceCount must be at least 1");
  }
  return {
    resourceClass,
    runtime,
    gpu: {
      vendor,
      deviceCount: Math.floor(numericCount)
    }
  };
}
