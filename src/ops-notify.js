import { CredentialProvider, signRequest } from "./gpu-controller.js";
import { logEvent } from "./ops-state.js";
import { transact } from "./store.js";
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

export async function notifyAdmin({ subject, text, kind = "alert" }, env = process.env, { fetchImpl = globalThis.fetch, credentials = new CredentialProvider({ env }) } = {}) {
  const config = notificationConfig(env);
  const record = async (sent, reason) => {
    await logEvent({ source: "auditor", severity: sent ? "info" : "warn", action: "notify." + kind, result: sent ? "sent" : "not_sent", message: subject + (reason ? " — " + reason : "") }).catch(() => {});
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
