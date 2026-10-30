// GET /api/coins: every coin launched under the platform's configs, read from the chain, so the page never
// needs an RPC address. A Vercel Node function in CommonJS with no packages; serve.mjs runs the same file for
// the local preview.
//
//   CLUSTER   devnet (default) or mainnet: which list in _configs.json is read
//   RPC_URL   the node to read from. Default on devnet: the public https://api.devnet.solana.com; required on
//             mainnet once a mainnet config is listed. Never printed, logged or returned.
//
// Answer: { cluster, updated, solUsd, token, note, coins: [...] }, the coins sorted by the SOL in their curve or
// pool, largest first. Kept 15 s in memory. On failure: HTTP 502 { error }.
//
// Each coin: mint, name, symbol, state ("curve" | "graduated"), solInPool, progress, priceSol, marketCapSol,
// marketCapUsd, floorSol (graduated only), pool, config, createdAt, image; and two fields beyond the shared contract:
// graduationSol (the SOL its curve must hold to graduate) and graduatedAt (unix seconds its pool opened).
// image is the address of the coin's picture on this site's own image host, read once from its metadata file, or null
// while unknown and for a coin made outside the site. On a local devnet run through serve.mjs it can also be
// http://localhost:<port>/uploads/..., the file store of that run. Changing PINATA_GATEWAY hides older pictures.
// floorSol counts the pool's locked liquidity only: with nothing else in the pool it is tokens · SOL / supply, and
// it is null for a pool that is not in Compounding mode. solUsd and marketCapUsd are null on devnet, where SOL is
// worth nothing. The devnet note says which coins run at the reduced test size: their configs are listed under
// "demoSize" in _configs.json.

"use strict";

const { createHash } = require("node:crypto");
const CONFIGS = require("./_configs.json");

const DEVNET_RPC = "https://api.devnet.solana.com";
// Devnet configs made at a reduced test size (_configs.json "demoSize"): their coins graduate far smaller than real
// ones. The other devnet configs use the platform's real setup, so the note says which coins are which.
const DEMO_SIZE = new Set(Array.isArray(CONFIGS.demoSize) ? CONFIGS.demoSize : []);

function sizeText(sol) { return String(Number(sol.toPrecision(3))); }
function listText(words) { return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`; }

// The line shown above the coins on devnet: true for every coin listed, whatever mix of configs they come from.
function devnetNote(coins) {
  const head = "Devnet test coins, not real money.";
  const small = coins.filter((coin) => DEMO_SIZE.has(coin.config)), real = coins.filter((coin) => !DEMO_SIZE.has(coin.config));
  if (!coins.length) return `${head} Test coins graduate at a smaller size than real ones.`;
  if (!small.length) return head;
  const sizes = [...new Set(small.map((coin) => sizeText(coin.graduationSol)))];
  const at = sizes.length === 1 ? `, with ${sizes[0]} SOL in the curve` : "";
  if (!real.length) return `${head} They graduate at a smaller size than real ones${at}.`;
  const named = real.length <= 2 && real.every((coin) => coin.symbol.length <= 12) ? `the ${real.length === 1 ? "coin" : "coins"} ${listText(real.map((coin) => coin.symbol))}` : real.length === 1 ? "the other one" : `the other ${real.length}`;
  return `${head} ${small.length} of ${coins.length} ${small.length === 1 ? "graduates" : "graduate"} at a smaller size than real ones${at}; ${named} ${real.length === 1 ? "is" : "are"} full size.`;
}

// ---- addresses ----

const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"; // DYNAMIC_BONDING_CURVE_PROGRAM_ID, @meteora-ag/dynamic-bonding-curve-sdk 2.0.0
const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"; // CP_AMM_PROGRAM_ID, @meteora-ag/cp-amm-sdk 1.5.1 (= DAMM_V2_PROGRAM_ID in the DBC SDK)
const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"; // METAPLEX_PROGRAM_ID in the DBC SDK; the one FLOOR's creation transaction called
const WSOL = "So11111111111111111111111111111111111111112";
// The DBC program's pool authority (deriveDbcPoolAuthority() in the DBC SDK). Every DAMM v2 pool a DBC curve
// migrates into has it as creator (offset 648 of pool 45pWzXM1…). That field is only a filter: creator is not a
// signer when a customizable pool is made, so anyone can write this key there. The real check is the pool's
// address, derived from the DBC config's DAMM v2 config and the two mints.
const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
// The DAMM v2 config a DBC config migrates under, by its migration fee option (DAMM_V2_MIGRATION_FEE_ADDRESS in
// the DBC SDK: FixedBps25, 30, 100, 200, 400, 600, Customizable). The pool is a PDA of it and the two mints.
const DAMM_V2_CONFIGS = [
  "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd", "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k",
  "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp", "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq",
  "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD", "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u",
  "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
];

// ---- where each value sits in an account ----
// Found by decoding real devnet accounts with the SDKs' own coders (DBC client.program.coder.accounts,
// cp-amm cpAmmCoder.accounts) and finding each decoded value's bytes in the raw data, then checked against the
// field order and sizes in the SDKs' IDLs (all are zero-copy accounts: an 8-byte discriminator, then the
// fields in order with their padding written out). Accounts used: virtual pools AAKopU5v… (FLOOR, on its
// curve) and Dt9C6VZF… (an older test coin, migrated), configs CVo2E8M2… and GXtqEfQ5…, DAMM v2 pool 45pWzXM1…
// and the mints 7rou2mx8… and EHhrHyvP….
const VPOOL = { // DBC VirtualPool, 424 bytes
  size: 424, config: 72, baseMint: 136, baseReserve: 232, quoteReserve: 240, sqrtPrice: 280,
  activationPoint: 296, // the slot (or time, by the config's activation type) the pool was created at
  isMigrated: 305, finishCurveTimestamp: 344,
};
const CONFIG = { // DBC PoolConfig, 1048 bytes
  size: 1048, quoteMint: 8, activationType: 234 /* 0 slot, 1 timestamp */, migrationFeeOption: 243, migrationQuoteThreshold: 264,
};
const DAMM = { // DAMM v2 Pool, 1112 bytes
  size: 1112, tokenAMint: 168, tokenBMint: 200, liquidity: 360, sqrtPrice: 456, activationPoint: 472, activationType: 480,
  collectFeeMode: 484 /* 2 = Compounding */, permanentLockLiquidity: 552, creator: 648, tokenAAmount: 680, tokenBAmount: 688,
};
const DEAD_LIQUIDITY = 100n << 64n; // DEAD_LIQUIDITY in the cp-amm SDK: a Compounding pool holds this much for good from the start
const MINT = { size: 82, supply: 36, decimals: 44 }; // SPL Token mint (Token-2022 keeps the same first 82 bytes)
const META = { key: 0, mint: 33, name: 65 }; // Metaplex metadata: key (4 = MetadataV1), update authority, mint, then name, symbol and uri as u32-length strings

// ---- how long anything may take (ms) ----
const WAIT = { programAccounts: 2500, accounts: 2000, metadata: 1500, blockTime: 1200, price: 1500, fallback: 2000 };
const FRESH = 15000; // the answer is rebuilt at most this often
const STALE_LIMIT = 120000; // a failed rebuild may still serve an answer this young
const LONE_TIMES_PER_REFRESH = 10; // block times asked one by one per rebuild, from a node that takes no batches
// The metadata files, read for each coin's picture. Anyone can make a coin under a config, so only what ownFile allows
// is read at all, and that stays small, quick, and never holds up the answer.
const IMAGE = { fetch: 1500, wait: 700 /* the most a rebuild waits for them; later ones are kept for the next rebuild */, maxBytes: 32768, maxUrl: 512, perRebuild: 12, retry: 60000 };

// ---- bytes ----

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

function fromBase58(text) {
  let n = 0n;
  for (const c of text) {
    const digit = DIGIT.get(c);
    if (digit === undefined) throw new Error("not base58");
    n = n * 58n + digit;
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  if (bytes.length !== 32) throw new Error("not an address");
  return Buffer.from(bytes);
}

const isAddress = (text) => { try { return typeof text === "string" && fromBase58(text).length === 32; } catch { return false; } };
const key = (data, at) => base58(data.subarray(at, at + 32));
const u64 = (data, at) => data.readBigUInt64LE(at);
const u128 = (data, at) => data.readBigUInt64LE(at) + (data.readBigUInt64LE(at + 8) << 64n);

// ---- program addresses ----
// A PDA is the first sha256(seeds, bump, program, "ProgramDerivedAddress") from bump 255 down that is NOT a
// point on ed25519. The test Solana applies (curve25519-dalek's decompress): y is the low 255 bits, read mod p;
// the point exists when x² = (y² - 1) / (d·y² + 1) has a root, that is when (y² - 1)(d·y² + 1) is zero or a
// square mod p (Euler's criterion; d·y² + 1 is never zero since -1/d is not a square).

const P = (1n << 255n) - 19n;
function power(b, e) {
  let r = 1n;
  for (b %= P; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}
const D = ((P - 121665n) * power(121666n, P - 2n)) % P;

function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y = (y & ((1n << 255n) - 1n)) % P;
  const y2 = (y * y) % P;
  const uv = (((y2 + P - 1n) % P) * ((D * y2 + 1n) % P)) % P;
  return uv === 0n || power(uv, (P - 1n) / 2n) === 1n;
}

const pdas = new Map(); // they never change: kept for the life of the instance
function pda(seeds, program) {
  const id = `${program}:${seeds.map((s) => s.toString("hex")).join(":")}`;
  if (pdas.has(id)) return pdas.get(id);
  const programBytes = fromBase58(program);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    const candidate = hash.update(Buffer.from([bump])).update(programBytes).update("ProgramDerivedAddress").digest();
    if (!onCurve(candidate)) {
      const address = base58(candidate);
      pdas.set(id, address);
      return address;
    }
  }
  throw new Error("no program address");
}

const metadataAddress = (mint) => pda([Buffer.from("metadata"), fromBase58(METADATA_PROGRAM), fromBase58(mint)], METADATA_PROGRAM);
function dammPoolAddress(dammConfig, mint) {
  const a = fromBase58(mint), b = fromBase58(WSOL);
  const [first, second] = Buffer.compare(a, b) === 1 ? [a, b] : [b, a]; // the larger key first, as the program seeds it
  return pda([Buffer.from("pool"), fromBase58(dammConfig), first, second], DAMM_V2_PROGRAM);
}

// ---- the node ----

// An error whose message may be shown and logged: it never carries the RPC address.
class Plain extends Error {}

function rpcCaller(url) {
  async function post(body, what, ms, again = true) {
    let answer;
    try {
      answer = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    } catch (error) {
      throw new Plain(error?.name === "TimeoutError" || error?.name === "AbortError" ? `${what} timed out` : `${what}: the node could not be reached`);
    }
    // a busy node (the public one limits each address to a few calls a second) is asked once more
    if (again && (answer.status === 429 || answer.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return post(body, what, ms, false);
    }
    if (!answer.ok) throw new Plain(`${what}: the node answered HTTP ${answer.status}`);
    try { return await answer.json(); } catch { throw new Plain(`${what}: the node's answer was not JSON`); }
  }
  async function call(method, params, ms) {
    const answer = await post({ jsonrpc: "2.0", id: 1, method, params }, method, ms);
    if (!answer || answer.error || !("result" in answer)) {
      const code = Number.isInteger(answer?.error?.code) ? ` ${answer.error.code}` : "";
      throw new Plain(`${method}: the node returned error${code}`);
    }
    return answer.result;
  }
  // Several calls in one request; a result is undefined where that call failed. Null when the node takes no batches.
  async function batch(calls, ms) {
    const answer = await post(calls.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params })), "batch", ms);
    if (!Array.isArray(answer)) return null;
    const results = new Array(calls.length);
    for (const item of answer) if (item && Number.isInteger(item.id) && "result" in item) results[item.id] = item.result;
    return results;
  }
  // Accounts in the order asked, 100 a call; null where an account does not exist.
  async function accounts(keys, ms) {
    const chunks = [];
    for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
    const parts = await Promise.all(chunks.map((chunk) => call("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }], ms)));
    return parts.flatMap((part, i) => chunks[i].map((_, j) => readAccount(part?.value?.[j])));
  }
  async function programAccounts(program, filters, ms) {
    const result = await call("getProgramAccounts", [program, { encoding: "base64", commitment: "confirmed", filters }], ms);
    const rows = Array.isArray(result) ? result : result?.value;
    if (!Array.isArray(rows)) throw new Plain("getProgramAccounts: an answer of an unknown shape");
    return rows.map((row) => ({ address: row.pubkey, ...readAccount(row.account) })).filter((row) => row.data);
  }
  return { call, batch, accounts, programAccounts };
}

function readAccount(account) {
  if (!account || !Array.isArray(account.data) || account.data[1] !== "base64") return null;
  return { owner: account.owner, data: Buffer.from(account.data[0], "base64") };
}

async function solUsd() {
  try {
    const answer = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, { signal: AbortSignal.timeout(WAIT.price) });
    if (!answer.ok) return null;
    const price = Number((await answer.json())?.[WSOL]?.usdPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

// ---- reading the coins ----

// SOL per whole token from a Q64.64 square root of the price in base units: (sqrt / 2^64)^2 · 10^(decimals - 9).
function priceFromSqrt(sqrt, decimals) {
  const root = Number(sqrt) / 2 ** 64;
  return root * root * 10 ** (decimals - 9);
}

const SOL = (lamports) => Number(lamports) / 1e9;
const round = (x, places) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(places)));
const significant = (x) => (Number.isFinite(x) ? Number(x.toPrecision(12)) : null);
const clean = (text) => text.replace(/[\u0000-\u001f\u007f]/g, "").trim();

// Name, symbol and uri from a Metaplex metadata account, or null when it is missing or not this mint's.
function readMetadata(account, mint) {
  try {
    if (!account || account.owner !== METADATA_PROGRAM || account.data[META.key] !== 4) return null;
    const data = account.data;
    if (key(data, META.mint) !== mint) return null;
    const nameLength = data.readUInt32LE(META.name);
    if (nameLength > 200) return null;
    const symbolAt = META.name + 4 + nameLength;
    const symbolLength = data.readUInt32LE(symbolAt);
    if (symbolLength > 50 || symbolAt + 4 + symbolLength > data.length) return null;
    const name = clean(data.subarray(META.name + 4, symbolAt).toString("utf8"));
    const symbol = clean(data.subarray(symbolAt + 4, symbolAt + 4 + symbolLength).toString("utf8"));
    const uriAt = symbolAt + 4 + symbolLength;
    const uriLength = uriAt + 4 <= data.length ? data.readUInt32LE(uriAt) : 0;
    const uri = uriLength <= 200 && uriAt + 4 + uriLength <= data.length ? clean(data.subarray(uriAt + 4, uriAt + 4 + uriLength).toString("utf8")) : "";
    return name || symbol ? { name: name || symbol, symbol: symbol || name, uri } : null;
  } catch {
    return null;
  }
}

// The DAMM v2 pool's facts when its mints and creator fit this coin, else null.
function readDammPool(account, mint) {
  if (!account || account.owner !== DAMM_V2_PROGRAM || account.data.length !== DAMM.size) return null;
  const data = account.data;
  if (key(data, DAMM.tokenAMint) !== mint || key(data, DAMM.tokenBMint) !== WSOL || key(data, DAMM.creator) !== DBC_POOL_AUTHORITY) return null;
  return {
    tokens: u64(data, DAMM.tokenAAmount), lamports: u64(data, DAMM.tokenBAmount), sqrtPrice: u128(data, DAMM.sqrtPrice),
    liquidity: u128(data, DAMM.liquidity), locked: u128(data, DAMM.permanentLockLiquidity) + DEAD_LIQUIDITY,
    collectFeeMode: data[DAMM.collectFeeMode],
    openedAt: data[DAMM.activationType] === 1 ? Number(u64(data, DAMM.activationPoint)) : null,
  };
}

// For a migrated coin whose pool is not where its config says. The creator field is only a filter, so a pool is
// taken only when it alone fits: with two, nothing here tells which one the curve migrated into.
async function searchDammPool(node, mint) {
  const rows = await node.programAccounts(DAMM_V2_PROGRAM, [
    { dataSize: DAMM.size }, { memcmp: { offset: DAMM.tokenAMint, bytes: mint } },
    { memcmp: { offset: DAMM.tokenBMint, bytes: WSOL } }, { memcmp: { offset: DAMM.creator, bytes: DBC_POOL_AUTHORITY } },
  ], WAIT.fallback);
  const found = rows.map((row) => ({ address: row.address, ...readDammPool(row, mint) })).filter((pool) => pool.lamports !== undefined);
  if (found.length > 1) console.warn(`api/coins: ${found.length} DAMM v2 pools fit the coin ${mint}; none is taken`);
  return found.length === 1 ? found[0] : null;
}

const createdTimes = new Map(); // pool -> unix seconds; a coin's creation time never changes
const names = new Map(); // mint -> { name, symbol }; one failed read must not take a coin's name away
const foundPools = new Map(); // mint -> a pool found by search, so such a coin costs one search, not one every rebuild

// Creation times: the pool's activation point is the slot it was created in (checked on both test pools
// against their creation transactions), so its block time is when the coin was made.
async function fillCreatedTimes(node, coins) {
  const wanted = coins.filter((coin) => !createdTimes.has(coin.pool));
  for (const coin of wanted) if (coin.activationType === 1) createdTimes.set(coin.pool, Number(coin.activationPoint));
  const bySlot = wanted.filter((coin) => coin.activationType === 0);
  const remember = (coin, time) => { if (Number.isInteger(time) && time > 0) createdTimes.set(coin.pool, time); };
  const chunks = [];
  for (let i = 0; i < bySlot.length; i += 100) chunks.push(bySlot.slice(i, i + 100));
  const missed = await Promise.all(chunks.map(async (chunk) => {
    const times = await node.batch(chunk.map((coin) => ["getBlockTime", [Number(coin.activationPoint)]]), WAIT.blockTime).catch(() => null);
    if (!times) return chunk;
    chunk.forEach((coin, i) => remember(coin, times[i]));
    return [];
  }));
  // a batch that failed, or a node that takes none: a few one by one now, the rest on later rebuilds
  await Promise.all(missed.flat().slice(0, LONE_TIMES_PER_REFRESH).map((coin) => node.call("getBlockTime", [Number(coin.activationPoint)], WAIT.blockTime).then((time) => remember(coin, time), () => {})));
}

// ---- the coins' pictures ----

const images = new Map(); // mint -> { image, until }: an answer read from the file lasts; a failure only until `until`

// Whether the server may read this address, or show it as a picture: only what this site's own upload hands out. That
// is a file on the Pinata gateway, or, on a local devnet run, a file in the store of this same serve.mjs, which sets the
// symbol; nothing configured on Vercel can. Any other address on chain was written by a stranger, and reading it would
// make this machine, or every visitor's browser, contact a place the stranger chose. kind is "json" or "image".
function ownFile(text, kind, cluster) {
  const gateway = String(process.env.PINATA_GATEWAY ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (gateway && text.startsWith(`https://${gateway}/ipfs/`) && /^[A-Za-z0-9]{32,120}$/.test(text.slice(gateway.length + 14))) return true;
  const local = cluster === "devnet" && !process.env.VERCEL ? globalThis[Symbol.for("compound.local")] : null;
  const ext = kind === "image" ? "png|jpg|gif|webp" : "json";
  return Boolean(local) && new RegExp(`^http://localhost:${local.port}/uploads/[0-9a-f]{64}\\.(?:${ext})$`).test(text);
}

// The image field of the metadata file at `uri`: its address, or null if it has none that can be used. Throws when
// the file could not be read at all, which is worth another try later.
async function readImage(uri, cluster) {
  const answer = await fetch(uri, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(IMAGE.fetch) });
  if (!answer.ok || !answer.body) throw new Error("no file");
  const reader = answer.body.getReader(), parts = [];
  for (let size = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > IMAGE.maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    parts.push(value);
  }
  const image = JSON.parse(Buffer.concat(parts).toString("utf8"))?.image;
  return typeof image === "string" && image.length <= IMAGE.maxUrl && ownFile(image, "image", cluster) ? image : null;
}

// Fills `images` for coins that have none yet, first ones first, coins never tried before those being tried again.
// A coin with no uri (its metadata read fine but names no file) is settled at once and costs no fetch; a coin whose
// metadata was not read waits for a rebuild that reads it.
async function fillImages(coins, cluster) {
  const now = Date.now();
  const wanted = [];
  for (const { mint, uri } of coins) {
    if (uri === undefined || images.get(mint)?.until > now) continue;
    if (uri === "" || !ownFile(uri, "json", cluster)) images.set(mint, { image: null, until: Infinity });
    else wanted.push({ mint, uri });
  }
  wanted.sort((a, b) => Number(images.has(a.mint)) - Number(images.has(b.mint)));
  const reads = wanted.slice(0, IMAGE.perRebuild).map(({ mint, uri }) => readImage(uri, cluster).then(
    (image) => images.set(mint, { image, until: Infinity }),
    () => images.set(mint, { image: null, until: Date.now() + IMAGE.retry }),
  ));
  if (!reads.length) return;
  let timer;
  await Promise.race([Promise.all(reads), new Promise((resolve) => { timer = setTimeout(resolve, IMAGE.wait); })]);
  clearTimeout(timer);
}

function clusterOf(env) {
  const name = String(env.CLUSTER || "devnet").trim().toLowerCase();
  if (name === "devnet") return "devnet";
  if (name === "mainnet" || name === "mainnet-beta") return "mainnet";
  throw new Plain("CLUSTER must be devnet or mainnet");
}

async function build(env) {
  const cluster = clusterOf(env);
  const configs = [...new Set((Array.isArray(CONFIGS[cluster]) ? CONFIGS[cluster] : []).filter(isAddress))];
  const price = cluster === "mainnet" ? solUsd() : Promise.resolve(null); // the page shows dollars on mainnet only
  const answer = { cluster, updated: 0, solUsd: null, token: null, note: cluster === "devnet" ? devnetNote([]) : null, coins: [] };
  if (!configs.length) {
    answer.solUsd = await price;
    answer.updated = Math.floor(Date.now() / 1000);
    return answer;
  }
  const url = env.RPC_URL || (cluster === "devnet" ? DEVNET_RPC : "");
  if (!url) throw new Plain("no RPC is set for mainnet");
  const node = rpcCaller(url);

  // 1. the configs, and the curves made under each
  const [configAccounts, perConfig] = await Promise.all([
    node.accounts(configs, WAIT.accounts),
    Promise.all(configs.map((config) => node.programAccounts(DBC_PROGRAM, [{ dataSize: VPOOL.size }, { memcmp: { offset: VPOOL.config, bytes: config } }], WAIT.programAccounts))),
  ]);
  const coins = [];
  configs.forEach((config, i) => {
    const account = configAccounts[i];
    if (!account || account.owner !== DBC_PROGRAM || account.data.length !== CONFIG.size || key(account.data, CONFIG.quoteMint) !== WSOL) {
      console.warn(`api/coins: ${config} is not a DBC config priced in SOL; skipped`);
      return;
    }
    const facts = {
      threshold: u64(account.data, CONFIG.migrationQuoteThreshold),
      activationType: account.data[CONFIG.activationType],
      dammConfig: DAMM_V2_CONFIGS[account.data[CONFIG.migrationFeeOption]] ?? null,
    };
    for (const row of perConfig[i]) {
      const data = row.data;
      if (row.owner !== DBC_PROGRAM || data.length !== VPOOL.size || key(data, VPOOL.config) !== config) continue;
      coins.push({
        pool: row.address, config, ...facts, mint: key(data, VPOOL.baseMint),
        quoteReserve: u64(data, VPOOL.quoteReserve), sqrtPrice: u128(data, VPOOL.sqrtPrice),
        activationPoint: u64(data, VPOOL.activationPoint), migrated: data[VPOOL.isMigrated] === 1,
        curveFilledAt: Number(u64(data, VPOOL.finishCurveTimestamp)),
      });
    }
  });

  // 2. their mints, their pools after graduation, their names, and when they were made
  if (coins.length) {
    for (const coin of coins) {
      coin.metadata = metadataAddress(coin.mint);
      if (coin.migrated) coin.dammGuess = foundPools.get(coin.mint) ?? (coin.dammConfig ? dammPoolAddress(coin.dammConfig, coin.mint) : undefined);
    }
    const graduating = coins.filter((coin) => coin.dammGuess);
    const [mainAccounts, metadata] = await Promise.all([
      node.accounts([...coins.map((coin) => coin.mint), ...graduating.map((coin) => coin.dammGuess)], WAIT.accounts),
      node.accounts(coins.map((coin) => coin.metadata), WAIT.metadata).catch(() => null), // without names the coins still show
      fillCreatedTimes(node, coins).catch(() => {}), // without times too
    ]);
    coins.forEach((coin, i) => {
      coin.mintAccount = mainAccounts[i];
      coin.named = readMetadata(metadata?.[i], coin.mint) ?? names.get(coin.mint) ?? null;
      if (coin.named) names.set(coin.mint, coin.named);
    });
    graduating.forEach((coin, i) => {
      const damm = readDammPool(mainAccounts[coins.length + i], coin.mint);
      if (damm) coin.damm = { address: coin.dammGuess, ...damm };
    });
    const lost = coins.filter((coin) => coin.migrated && !coin.damm);
    await Promise.all(lost.map(async (coin) => {
      coin.damm = await searchDammPool(node, coin.mint).catch(() => null);
      if (coin.damm) foundPools.set(coin.mint, coin.damm.address);
    }));
  }

  // 3. the numbers
  const usd = await price;
  for (const coin of coins) {
    const mint = coin.mintAccount;
    if (!mint || !TOKEN_PROGRAMS.includes(mint.owner) || mint.data.length < MINT.size) {
      console.warn(`api/coins: the mint ${coin.mint} could not be read; skipped`);
      continue;
    }
    if (coin.migrated && !coin.damm) {
      console.warn(`api/coins: no DAMM v2 pool found for the graduated coin ${coin.mint}; skipped`);
      continue;
    }
    const supply = u64(mint.data, MINT.supply), decimals = mint.data[MINT.decimals];
    const tokens = Number(supply) / 10 ** decimals;
    const graduated = coin.migrated;
    const lamports = graduated ? coin.damm.lamports : coin.quoteReserve;
    const priceSol = priceFromSqrt(graduated ? coin.damm.sqrtPrice : coin.sqrtPrice, decimals);
    const marketCapSol = priceSol * tokens;
    const short = `${coin.mint.slice(0, 4)}…${coin.mint.slice(-4)}`;
    answer.coins.push({
      mint: coin.mint,
      name: coin.named?.name ?? short,
      symbol: coin.named?.symbol ?? coin.mint.slice(0, 4),
      state: graduated ? "graduated" : "curve",
      solInPool: SOL(lamports),
      progress: graduated ? 1 : coin.threshold > 0n ? round(Math.min(1, Number(coin.quoteReserve) / Number(coin.threshold)), 9) : 0,
      priceSol: significant(priceSol),
      marketCapSol: round(marketCapSol, 9),
      // devnet SOL is worth nothing, so a devnet coin has no market cap in dollars
      marketCapUsd: usd === null || cluster === "devnet" ? null : round(marketCapSol * usd, 2),
      // the SOL left in the pool's locked liquidity if every token were sold into it. Anyone can add liquidity and
      // take it out again, so only the locked share counts: it holds locked / liquidity of each reserve, which gives
      // tokens · SOL · (locked / liquidity)² / supply. With only locked liquidity in the pool that is tokens · SOL /
      // supply. It holds for Compounding pools only, where the reserves follow the liquidity.
      floorSol: graduated && coin.damm.collectFeeMode === 2 && supply > 0n && coin.damm.liquidity > 0n
        ? SOL((coin.damm.tokens * coin.damm.lamports * coin.damm.locked * coin.damm.locked) / (coin.damm.liquidity * coin.damm.liquidity * supply))
        : null,
      pool: graduated ? coin.damm.address : coin.pool,
      config: coin.config,
      createdAt: createdTimes.get(coin.pool) ?? null,
      graduationSol: SOL(coin.threshold),
      graduatedAt: graduated ? coin.damm.openedAt ?? (coin.curveFilledAt || null) : null,
    });
  }
  answer.coins.sort((x, y) => y.solInPool - x.solInPool || (x.mint < y.mint ? -1 : 1));
  const uris = new Map(coins.map((coin) => [coin.mint, coin.named?.uri]));
  await fillImages(answer.coins.map(({ mint }) => ({ mint, uri: uris.get(mint) })), cluster);
  for (const coin of answer.coins) coin.image = images.get(coin.mint)?.image ?? null;
  if (cluster === "devnet") answer.note = devnetNote(answer.coins);
  answer.solUsd = usd;
  answer.updated = Math.floor(Date.now() / 1000);
  return answer;
}

// ---- the handler ----

let kept = null; // { at, body }: the last answer built
let building = null; // the rebuild under way, shared by every request that arrives meanwhile

// Takes the RPC address and its parts out of anything logged.
function scrub(text, url) {
  if (!url) return text;
  const parts = [url];
  try {
    const u = new URL(url);
    parts.push(u.href, u.host + u.pathname + u.search, u.host, ...u.searchParams.values(), ...u.pathname.split("/"));
  } catch { /* the text itself is still taken out */ }
  return parts.filter((part) => part && part.length >= 6).sort((a, b) => b.length - a.length).reduce((shown, part) => shown.split(part).join("<hidden>"), text);
}

function reply(res, status, body, cache, head) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(head ? undefined : body);
}

module.exports = async function coins(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    reply(res, 405, JSON.stringify({ error: "GET only" }), "no-store", false);
    return;
  }
  const head = req.method === "HEAD";
  if (!kept || Date.now() - kept.at >= FRESH) {
    building ??= build(process.env)
      .then((answer) => { kept = { at: Date.now(), body: JSON.stringify(answer) }; })
      .finally(() => { building = null; });
    try {
      await building;
    } catch (error) {
      const reason = error instanceof Plain ? error.message : "could not read the coins";
      console.error(`api/coins: ${error instanceof Plain ? reason : scrub(String(error?.stack ?? error), process.env.RPC_URL)}`);
      if (!kept || Date.now() - kept.at > STALE_LIMIT) {
        reply(res, 502, JSON.stringify({ error: reason }), "no-store", head);
        return;
      }
    }
  }
  reply(res, 200, kept.body, "s-maxage=15, stale-while-revalidate=60", head);
};
