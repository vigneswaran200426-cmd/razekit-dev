import { CredentialProvider, signRequest } from "./gpu-controller.js";
import { logEvent } from "./ops-state.js";
import { id, loadDb, transact } from "./store.js";
import { redactText } from "./ops-domain.js";

// Operational email to the one administrator address, and nobody else.
//
// ADMIN_EMAIL is never guessed: when it is not set, a notification is recorded
// as not sent, with the reason, and the dashboard says so. The only transport
// is Amazon SES through the control plane's instance role; there is no bulk
// path and no recipient parameter, so this cannot become a mailing tool.
// A per-hour cap stops an alert storm from turning into an email storm.

export function notificationConfig(env = process.env) {
  return {
    adminEmail: env.ADMIN_EMAIL || null,
    provider: env.RAZEKIT_NOTIFY_PROVIDER || null,
    from: env.RAZEKIT_NOTIFY_FROM || null,
    region: env.RAZEKIT_SES_REGION || env.RAZEKIT_AWS_REGION || "us-east-2",
    maxPerHour: Number(env.RAZEKIT_NOTIFY_MAX_PER_HOUR || 12)
  };
}

async function withinRateLimit(maxPerHour) {
  const hour = new Date().toISOString().slice(0, 13);
  return transact(db => {
    let row = db.opsSettings.find(item => item.id === "notify-rate");
    if (!row) { row = { id: "notify-rate", value: { hour, count: 0 } }; db.opsSettings.push(row); }
    if (row.value.hour !== hour) row.value = { hour, count: 0 };
    if (row.value.count >= maxPerHour) return false;
    row.value.count += 1;
    return true;
  });
}

export async function notifyAdmin({ subject, text, kind = "alert", source = "auditor" }, env = process.env, { fetchImpl = globalThis.fetch, credentials = new CredentialProvider({ env }) } = {}) {
  const config = notificationConfig(env);
  const record = async (sent, reason) => {
    await logEvent({ source, severity: sent ? "info" : "warn", action: "notify." + kind, result: sent ? "sent" : "not_sent", message: subject + (reason ? " — " + reason : "") }).catch(() => {});
    return { sent, reason: reason || null, at: new Date().toISOString() };
  };
  if (!config.adminEmail) return record(false, "ADMIN_EMAIL is not configured");
  if (config.provider !== "ses" || !config.from) return record(false, "No notification provider configured (RAZEKIT_NOTIFY_PROVIDER=ses and RAZEKIT_NOTIFY_FROM)");
  if (!(await withinRateLimit(config.maxPerHour))) return record(false, "Hourly notification cap reached");
  try {
    const host = "email." + config.region + ".amazonaws.com";
    const path = "/v2/email/outbound-emails";
    const body = JSON.stringify({
      FromEmailAddress: config.from,
      Destination: { ToAddresses: [config.adminEmail] },
      Content: { Simple: { Subject: { Data: redactText(subject).slice(0, 200) }, Body: { Text: { Data: redactText(text).slice(0, 20_000) } } } }
    });
    const creds = await credentials.get();
    const headers = signRequest({ method: "POST", host, path, body, service: "ses", region: config.region, credentials: creds, headers: { "content-type": "application/json" } });
    const response = await fetchImpl("https://" + host + path, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return record(false, "SES HTTP " + response.status + ": " + (await response.text()).slice(0, 200));
    return record(true, null);
  } catch (error) {
    return record(false, error.message);
  }
}

// ── Outbox: System B decides, the gateway delivers ─────────────────────────
//
// On the control plane only the gateway may reach the instance metadata
// service, and so the instance role that SES needs; System B is firewalled
// from it on purpose. So System B queues its notifications here
// (RAZEKIT_NOTIFY_VIA=gateway) and the gateway sends them with its own
// ADMIN_EMAIL and sender settings. Every row ends as "sent" or "not_sent" with
// a reason; nothing is reported as delivered until SES accepted it.

const OUTBOX_MAX = 500;

export async function notify(message, env = process.env, options = {}) {
  if (env.RAZEKIT_NOTIFY_VIA !== "gateway") return notifyAdmin(message, env, options);
  const row = await transact(db => {
    const entry = {
      id: id("opsntf"),
      kind: message.kind || "alert",
      subject: redactText(message.subject).slice(0, 200),
      text: redactText(message.text).slice(0, 20_000),
      findingId: message.findingId || null,
      status: "queued",
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      result: null
    };
    db.opsNotifications.push(entry);
    if (db.opsNotifications.length > OUTBOX_MAX) db.opsNotifications.splice(0, db.opsNotifications.length - OUTBOX_MAX);
    return entry;
  });
  return { sent: false, queued: true, notificationId: row.id, reason: "Queued for the inference gateway to deliver", at: row.createdAt };
}

/** Run by the gateway: sends what is queued, oldest first, and records the outcome. */
export async function deliverQueuedNotifications(env = process.env, options = {}, { limit = 10 } = {}) {
  const queued = (await loadDb()).opsNotifications.filter(item => item.status === "queued").slice(0, limit);
  for (const item of queued) {
    const result = await notifyAdmin({ subject: item.subject, text: item.text, kind: item.kind, source: "gateway" }, env, options);
    await transact(db => {
      const row = db.opsNotifications.find(entry => entry.id === item.id);
      if (row) { row.status = result.sent ? "sent" : "not_sent"; row.deliveredAt = result.at; row.result = result; }
      if (item.findingId) {
        const finding = db.opsFindings.find(entry => entry.id === item.findingId);
        if (finding) finding.notification = { ...result, notificationId: item.id };
      }
    });
  }
  return queued.length;
}
