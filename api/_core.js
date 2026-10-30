// What /api/launch and /api/upload share: answers and refusals, reading a request, the rate limit, which cluster
// and config this run serves, addresses, and plain-text checks. No packages. The underscore keeps Vercel from
// making a route of it.

"use strict";

const { createPublicKey, verify } = require("node:crypto");
const CONFIGS = require("./_configs.json");

const DEVNET_RPC = "https://api.devnet.solana.com";
const MINUTE = 60000;
const HOUR = 3600000;

// ---- answers ----

// A refusal: its message is shown to the visitor, so it is one short sentence and never holds a URL or a key.
class Refuse extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

// Takes the RPC address, its parts and the Pinata key out of anything logged.
function scrub(text, env = process.env) {
  const secrets = [env.PINATA_JWT];
  if (env.RPC_URL) {
    secrets.push(env.RPC_URL);
    try {
      const url = new URL(env.RPC_URL);
      secrets.push(url.href, url.host + url.pathname + url.search, url.host, ...url.searchParams.values(), ...url.pathname.split("/"));
    } catch { /* the text itself is still taken out */ }
  }
  return secrets.filter((part) => part && part.length >= 6).sort((a, b) => b.length - a.length).reduce((shown, part) => shown.split(part).join("<hidden>"), String(text));
}

// Wraps a POST route: `run` gives the answer or throws a Refuse; anything else is logged, scrubbed, and said plainly.
function endpoint(name, run) {
  return async function handler(req, res) {
    try {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        throw new Refuse(405, "post_only", "POST only.");
      }
      reply(res, 200, await run(req));
    } catch (error) {
      if (error instanceof Refuse) {
        if (error.status === 429) res.setHeader("Retry-After", "60");
        reply(res, error.status, { error: error.message, code: error.code });
        return;
      }
      console.error(`api/${name}: ${scrub(error?.stack ?? error)}`);
      reply(res, 500, { error: "Something went wrong on the server.", code: "server" });
    }
  };
}

// ---- requests ----

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (part) => {
      size += part.length;
      if (size > limit) reject(new Refuse(413, "too_large", "That is too large."));
      else parts.push(part);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", () => reject(new Refuse(400, "bad_json", "The request did not arrive whole.")));
  });
}

// The request's JSON object. On Vercel the body has already been read and sits in req.body (reading the getter
// throws on bad JSON); under serve.mjs it is read here. Asking for application/json keeps other sites' plain forms
// out, since a browser cannot send that type across sites without a preflight, which nothing here answers.
async function readJson(req, limit) {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new Refuse(415, "bad_type", "Send JSON.");
  if (Number(req.headers["content-length"]) > limit) throw new Refuse(413, "too_large", "That is too large.");
  let value;
  try {
    value = req.body;
  } catch {
    throw new Refuse(400, "bad_json", "That is not JSON.");
  }
  if (value === undefined) value = await readBody(req, limit);
  if (Buffer.isBuffer(value) || typeof value === "string") {
    if (value.length > limit) throw new Refuse(413, "too_large", "That is too large.");
    try {
      value = JSON.parse(value.toString("utf8"));
    } catch {
      throw new Refuse(400, "bad_json", "That is not JSON.");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Refuse(400, "bad_json", "That is not a JSON object.");
  return value;
}

// ---- the rate limit ----
// Per IP, in this instance's memory. Serverless memory is per instance, so on Vercel the real limit is this number
// times the instances running, and it resets when one starts: enough for devnet. Mainnet needs a shared store.

const windows = new Map(); // "what:ip" -> { at, used }
const MOST_WINDOWS = 20000;

// Vercel writes these two itself; anywhere else they could be typed by the visitor, so only the socket counts.
function clientIp(req) {
  if (process.env.VERCEL) return String(req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  return req.socket?.remoteAddress ?? "unknown";
}

function limit(req, what, perMinute) {
  const now = Date.now();
  if (windows.size >= MOST_WINDOWS) {
    for (const [key, window] of windows) if (now - window.at >= MINUTE) windows.delete(key);
    for (const key of windows.keys()) {
      if (windows.size < MOST_WINDOWS) break;
      windows.delete(key);
    }
  }
  const key = `${what}:${clientIp(req)}`;
  let window = windows.get(key);
  if (!window || now - window.at >= MINUTE) {
    window = { at: now, used: 0 };
    windows.set(key, window);
  }
  window.used += 1;
  if (window.used > perMinute) throw new Refuse(429, "slow_down", "Too many tries. Wait a minute.");
}

// A ceiling on something every visitor shares, counted per hour, whatever their address. Per instance as well, so it
// slows abuse and does not stop it: a hard ceiling has to live with whoever is paid, such as a key's own use limit.
const budgets = new Map(); // what -> { at, used }

function budget(what, perHour) {
  const now = Date.now();
  let spent = budgets.get(what);
  if (!spent || now - spent.at >= HOUR) {
    spent = { at: now, used: 0 };
    budgets.set(what, spent);
  }
  spent.used += 1;
  if (spent.used > perHour) throw new Refuse(503, "busy", "Uploads are paused for now. Try again later.");
}

// ---- where this run points ----

function clusterOf(env) {
  const name = String(env.CLUSTER || "devnet").trim().toLowerCase();
  if (name === "devnet") return "devnet";
  if (name === "mainnet" || name === "mainnet-beta") return "mainnet";
  throw new Refuse(500, "bad_cluster", "The server's cluster is not set right.");
}

// The config launches run under: only ever from _configs.json. Null means launches are closed.
const launchConfig = (cluster) => CONFIGS.launch?.[cluster] ?? null;
const assertOpen = (cluster) => {
  if (!launchConfig(cluster)) throw new Refuse(403, "closed", "Launches are closed here.");
};

function rpcUrl(cluster, env) {
  const url = env.RPC_URL || (cluster === "devnet" ? DEVNET_RPC : "");
  if (!url) throw new Refuse(500, "no_node", "The server has no network node set.");
  return url;
}

// Set by serve.mjs only: { uploads, port }. A symbol on globalThis, not an environment variable, so nothing that is
// configured on Vercel can turn the local file store on there.
function localRun() {
  if (process.env.VERCEL) return null;
  return globalThis[Symbol.for("compound.local")] ?? null;
}

// The Pinata gateway's host, or null when it is unset or not a host.
function gatewayHost(env) {
  const host = String(env.PINATA_GATEWAY ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? host : null;
}

// ---- bytes and addresses ----

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGIT = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let text = "";
  for (; n > 0n; n /= 58n) text = ALPHABET[Number(n % 58n)] + text;
  for (const b of bytes) { if (b !== 0) break; text = `1${text}`; }
  return text;
}

// The bytes of a base58 text of exactly `size` bytes, or null.
function fromBase58(text, size) {
  if (typeof text !== "string" || !text || text.length > Math.ceil(size * 1.4)) return null;
  let n = 0n;
  for (const c of text) {
    const digit = DIGIT.get(c);
    if (digit === undefined) return null;
    n = n * 58n + digit;
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  return bytes.length === size ? Buffer.from(bytes) : null;
}

const isAddress = (text) => fromBase58(text, 32) !== null;

// Whether a 64-byte signature over `message` is the holder of `publicKey`'s. Ed25519 in Node takes a DER key.
const ED25519_DER_HEAD = Buffer.from("302a300506032b6570032100", "hex");
function isSignedBy(message, signature, publicKey) {
  try {
    return verify(null, message, createPublicKey({ key: Buffer.concat([ED25519_DER_HEAD, publicKey]), format: "der", type: "spki" }), signature);
  } catch {
    return false;
  }
}

// ---- text ----

// A coin's name or symbol: trimmed, then 1 to maxBytes bytes of UTF-8 with no control characters or line breaks.
function plainText(value, what, maxBytes) {
  const code = `bad_${what}`;
  if (typeof value !== "string") throw new Refuse(400, code, `The ${what} is missing.`);
  const text = value.trim();
  if (!text) throw new Refuse(400, code, `The ${what} is empty.`);
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Refuse(400, code, `The ${what} can be at most ${maxBytes} bytes.`);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) || !text.isWellFormed()) throw new Refuse(400, code, `The ${what} holds a character that cannot be used.`);
  return text;
}

// Keeps a small map from growing without end: the oldest entries go first.
function remember(map, key, value, most = 2000) {
  map.set(key, value);
  for (const old of map.keys()) {
    if (map.size <= most) break;
    map.delete(old);
  }
}

module.exports = {
  assertOpen, base58, budget, clusterOf, endpoint, fromBase58, gatewayHost, isAddress, isSignedBy, launchConfig, limit, localRun, plainText, readJson, Refuse, remember, reply, rpcUrl, scrub,
};
