import { createHash, createHmac } from "node:crypto";

// Starts, stops and describes the one GPU inference instance, and reads the
// AWS budget, with SigV4-signed calls and no SDK dependency.
//
// Credentials come from the standard places only: the environment, or the EC2
// instance role through IMDSv2. Nothing here accepts a key from a request, and
// nothing is ever written to a log. The control plane runs with an instance
// role scoped to ec2:Start/Stop/DescribeInstances on this one instance (by
// tag), so no long-lived key exists.
//
// "Stop", never "terminate": the model weights live on the instance's
// encrypted EBS volume, which survives a stop.

const IMDS = "http://169.254.169.254";

export class AwsError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "AwsError";
    this.status = status;
    this.code = code;
  }
}

function sha256Hex(data) { return createHash("sha256").update(data, "utf8").digest("hex"); }
function hmac(key, data) { return createHmac("sha256", key).update(data, "utf8").digest(); }

export function signRequest({ method, host, path = "/", body, service, region, headers = {}, credentials, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const allHeaders = { ...headers, host, "x-amz-date": amzDate };
  if (credentials.sessionToken) allHeaders["x-amz-security-token"] = credentials.sessionToken;
  const names = Object.keys(allHeaders).map(name => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(allHeaders).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map(name => name + ":" + lower[name] + "\n").join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, sha256Hex(body)].join("\n");
  const scope = [dateStamp, region, service, "aws4_request"].join("/");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + credentials.secretAccessKey, dateStamp), region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    ...allHeaders,
    authorization: "AWS4-HMAC-SHA256 Credential=" + credentials.accessKeyId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature
  };
}

export class CredentialProvider {
  constructor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.cached = null;
  }

  async get() {
    if (this.env.AWS_ACCESS_KEY_ID && this.env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: this.env.AWS_ACCESS_KEY_ID, secretAccessKey: this.env.AWS_SECRET_ACCESS_KEY, sessionToken: this.env.AWS_SESSION_TOKEN || null, source: "environment" };
    }
    if (this.cached && Date.parse(this.cached.expiration) - Date.now() > 5 * 60_000) return this.cached;
    try {
      const tokenResponse = await this.fetch(IMDS + "/latest/api/token", {
        method: "PUT",
        headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
        signal: AbortSignal.timeout(2000)
      });
      const token = await tokenResponse.text();
      const headers = { "x-aws-ec2-metadata-token": token };
      const role = (await (await this.fetch(IMDS + "/latest/meta-data/iam/security-credentials/", { headers, signal: AbortSignal.timeout(2000) })).text()).trim().split("\n")[0];
      if (!role) throw new Error("no instance role");
      const data = await (await this.fetch(IMDS + "/latest/meta-data/iam/security-credentials/" + role, { headers, signal: AbortSignal.timeout(2000) })).json();
      this.cached = { accessKeyId: data.AccessKeyId, secretAccessKey: data.SecretAccessKey, sessionToken: data.Token, expiration: data.Expiration, source: "instance-role:" + role };
      return this.cached;
    } catch (error) {
      throw new AwsError("No AWS credentials: neither environment keys nor an EC2 instance role are available (" + error.message + ")", { code: "NoCredentials" });
    }
  }
}

function xmlValue(xml, tag) {
  const match = new RegExp("<" + tag + ">([^<]*)</" + tag + ">").exec(xml);
  return match ? match[1] : null;
}

export class GpuController {
  constructor({
    instanceId = process.env.RAZEKIT_GPU_INSTANCE_ID,
    region = process.env.RAZEKIT_AWS_REGION || "us-east-2",
    credentials = new CredentialProvider(),
    fetchImpl = globalThis.fetch
  } = {}) {
    this.instanceId = instanceId || null;
    this.region = region;
    this.credentials = credentials;
    this.fetch = fetchImpl;
  }

  get configured() { return Boolean(this.instanceId); }

  async ec2(action, params = {}) {
    const host = "ec2." + this.region + ".amazonaws.com";
    const form = new URLSearchParams({ Action: action, Version: "2016-11-15", ...params }).toString();
    const credentials = await this.credentials.get();
    const headers = signRequest({
      method: "POST", host, body: form, service: "ec2", region: this.region, credentials,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
    });
    const response = await this.fetch("https://" + host + "/", { method: "POST", headers, body: form, signal: AbortSignal.timeout(20_000) });
    const xml = await response.text();
    if (!response.ok) {
      throw new AwsError("EC2 " + action + " failed: " + (xmlValue(xml, "Code") || response.status) + " " + (xmlValue(xml, "Message") || ""), { status: response.status, code: xmlValue(xml, "Code") });
    }
    return xml;
  }

  async describe() {
    if (!this.configured) return { configured: false, state: "not_configured" };
    const xml = await this.ec2("DescribeInstances", { "InstanceId.1": this.instanceId });
    const stateBlock = /<instanceState>([\s\S]*?)<\/instanceState>/.exec(xml)?.[1] || "";
    return {
      configured: true,
      instanceId: this.instanceId,
      state: xmlValue(stateBlock, "name") || "unknown",
      instanceType: xmlValue(xml, "instanceType"),
      launchTime: xmlValue(xml, "launchTime"),
      privateIp: xmlValue(xml, "privateIpAddress"),
      source: "aws:ec2:DescribeInstances",
      checkedAt: new Date().toISOString()
    };
  }

  async start() {
    if (!this.configured) throw new AwsError("RAZEKIT_GPU_INSTANCE_ID is not configured");
    const xml = await this.ec2("StartInstances", { "InstanceId.1": this.instanceId });
    return { requested: "start", currentState: xmlValue(/<currentState>([\s\S]*?)<\/currentState>/.exec(xml)?.[1] || "", "name") };
  }

  async stop() {
    if (!this.configured) throw new AwsError("RAZEKIT_GPU_INSTANCE_ID is not configured");
    const xml = await this.ec2("StopInstances", { "InstanceId.1": this.instanceId });
    return { requested: "stop", currentState: xmlValue(/<currentState>([\s\S]*?)<\/currentState>/.exec(xml)?.[1] || "", "name") };
  }

  /** Reads an AWS Budgets budget (actual and forecast spend), when one is configured. */
  async budget({ accountId = process.env.RAZEKIT_AWS_ACCOUNT_ID, name = process.env.RAZEKIT_AWS_BUDGET_NAME } = {}) {
    if (!accountId || !name) return { configured: false };
    const host = "budgets.amazonaws.com";
    const body = JSON.stringify({ AccountId: accountId, BudgetName: name });
    const credentials = await this.credentials.get();
    const headers = signRequest({
      method: "POST", host, body, service: "budgets", region: "us-east-1", credentials,
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSBudgetServiceGateway.DescribeBudget" }
    });
    const response = await this.fetch("https://" + host + "/", { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new AwsError("Budgets DescribeBudget failed: " + (data.__type || response.status) + " " + (data.Message || data.message || ""), { status: response.status });
    const budget = data.Budget || {};
    return {
      configured: true,
      name,
      limitUsd: Number(budget.BudgetLimit?.Amount ?? NaN),
      actualUsd: Number(budget.CalculatedSpend?.ActualSpend?.Amount ?? NaN),
      forecastUsd: Number(budget.CalculatedSpend?.ForecastedSpend?.Amount ?? NaN),
      lastUpdatedAt: budget.LastUpdatedTime ? new Date(Number(budget.LastUpdatedTime) * 1000).toISOString() : null,
      source: "aws:budgets:DescribeBudget",
      checkedAt: new Date().toISOString()
    };
  }
}
