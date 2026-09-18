import { id, loadDb, transact } from "./store.js";

export const ALERT_SEVERITY = {
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical"
};

export async function recordObservabilityEvent({
  tenantId = null,
  taskId = null,
  agentInstanceId = null,
  type,
  severity = ALERT_SEVERITY.INFO,
  message,
  metadata = {}
}) {
  if (!type?.trim()) throw new Error("Observability event type is required");
  if (!message?.trim()) throw new Error("Observability event message is required");

  return transact(db => {
    const event = {
      id: id("obs"),
      tenantId,
      taskId,
      agentInstanceId,
      type,
      severity,
      message,
      metadata,
      createdAt: new Date().toISOString()
    };
    db.observabilityEvents.push(event);
    return event;
  });
}

export async function recordMetric({ name, value, unit = "count", tags = {} }) {
  if (!name?.trim()) throw new Error("Metric name is required");
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error("Metric value must be finite");

  return transact(db => {
    const metric = {
      id: id("metric"),
      name,
      value: numeric,
      unit,
      tags,
      createdAt: new Date().toISOString()
    };
    db.metrics.push(metric);
    return metric;
  });
}

export async function evaluateInfrastructureAlerts({
  queueDepthWarning = 10,
  queueDepthCritical = 50,
  workerStaleMs = 120_000
} = {}) {
  const db = await loadDb();
  const now = Date.now();
  const queuedJobs = db.jobs.filter(job => ["queued", "retrying"].includes(job.status)).length;
  const staleWorkers = db.productionWorkers.filter(worker =>
    ["ready", "busy"].includes(worker.status) &&
    Date.parse(worker.heartbeatAt || 0) <= now - workerStaleMs
  );

  const alerts = [];
  if (queuedJobs >= queueDepthCritical) {
    alerts.push({
      key: "queue_depth",
      severity: ALERT_SEVERITY.CRITICAL,
      message: "Production queue depth is critically high",
      metadata: { queueDepth: queuedJobs }
    });
  } else if (queuedJobs >= queueDepthWarning) {
    alerts.push({
      key: "queue_depth",
      severity: ALERT_SEVERITY.WARNING,
      message: "Production queue depth is elevated",
      metadata: { queueDepth: queuedJobs }
    });
  }

  if (staleWorkers.length > 0) {
    alerts.push({
      key: "worker_heartbeat",
      severity: ALERT_SEVERITY.CRITICAL,
      message: "Production worker heartbeat is stale",
      metadata: { workers: staleWorkers.map(worker => worker.workerId) }
    });
  }

  return transact(state => alerts.map(alert => {
    const active = state.alerts.find(item =>
      item.status === "open" &&
      item.key === alert.key &&
      JSON.stringify(item.metadata) === JSON.stringify(alert.metadata)
    );
    if (active) return active;

    const record = {
      id: id("alert"),
      key: alert.key,
      severity: alert.severity,
      message: alert.message,
      metadata: alert.metadata,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    state.alerts.push(record);
    return record;
  }));
}

export async function resolveAlert(alertId) {
  return transact(db => {
    const alert = db.alerts.find(item => item.id === alertId);
    if (!alert) throw new Error("Alert not found");
    alert.status = "resolved";
    alert.resolvedAt = new Date().toISOString();
    return alert;
  });
}

export async function listAlerts({ status = null, severity = null } = {}) {
  const db = await loadDb();
  return db.alerts
    .filter(item => !status || item.status === status)
    .filter(item => !severity || item.severity === severity)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function metricsSnapshot() {
  const db = await loadDb();
  const counts = {
    queuedJobs: db.jobs.filter(job => ["queued", "retrying"].includes(job.status)).length,
    runningJobs: db.jobs.filter(job => job.status === "running").length,
    failedJobs: db.jobs.filter(job => ["failed", "dead_letter"].includes(job.status)).length,
    productionWorkers: db.productionWorkers.length,
    healthyProductionWorkers: db.productionWorkers.filter(worker => ["ready", "busy"].includes(worker.status)).length,
    gpuWorkers: db.productionWorkers.filter(worker => worker.resourceClass === "gpu").length,
    openAlerts: db.alerts.filter(alert => alert.status === "open").length
  };

  for (const [name, value] of Object.entries(counts)) {
    await recordMetric({ name, value, unit: "count" });
  }

  return counts;
}
