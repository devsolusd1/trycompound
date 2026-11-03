// POST /api/upload { name, symbol, image: "data:image/...;base64,..." } -> { uri, image }: puts a coin's picture and
// its metadata file where wallets and explorers can read them. A Vercel function in CommonJS; serve.mjs runs it too.
//
// Where they go: Pinata when PINATA_JWT and PINATA_GATEWAY are both set. Without them, only when running through
// serve.mjs, the folder .uploads next to the site, served at /uploads/<sha256>.<ext>: acceptable on devnet. On
// Vercel with no key: HTTP 503. PINATA_JWT is never printed, logged or returned. The picture is at most 1 MiB
// (1,048,576 bytes), and PNG, JPEG, GIF or WebP by its first bytes, whatever the data URL claims. No SVG. A PNG or GIF
// must also state a size of at most 4096 pixels a side.
//
// Nothing here proves a launch stands behind an upload, so an anonymous visitor can pin files with the site's key. Each
// address gets 4 uploads a minute and each instance 60 an hour; neither is a hard ceiling. Give PINATA_JWT a scoped key
// with only the upload permission and a limit on its uses, and before mainnet tie uploads to a wallet's proof and a
// shared store.

"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { mkdir, rename, rm, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { assertOpen, budget, clusterOf, endpoint, gatewayHost, limit, localRun, plainText, readJson, Refuse, remember } = require("./_core.js");

const MAX_IMAGE = 1048576;
const MAX_SIDE = 4096; // pixels: a file can claim a size that strains the browser of whoever views the coins page
const MAX_BODY = 1500000; // the picture in base64, the data URL's head, the name and the symbol
const WAIT = 8000; // ms for one upload to Pinata

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// What the bytes really are. Their first bytes decide.
function imageKind(bytes) {
  const ascii = (from, to) => bytes.subarray(from, to).toString("latin1");
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", ext: "png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return { type: "image/gif", ext: "gif" };
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { type: "image/webp", ext: "webp" };
  return null;
}

// The width and height a PNG or GIF states in its header. Null when they are not there. JPEG and WebP are not read:
// their size can sit anywhere in the file.
function statedSize(bytes, type) {
  if (type === "image/png") return bytes.length >= 24 && bytes.toString("latin1", 12, 16) === "IHDR" ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : null;
  if (type === "image/gif") return bytes.length >= 10 ? [bytes.readUInt16LE(6), bytes.readUInt16LE(8)] : null;
  return [1, 1];
}

function readImage(value) {
  const unknown = () => new Refuse(400, "bad_image", "Use a PNG, JPEG, GIF or WebP image.");
  const svg = () => new Refuse(400, "svg", "SVG images are not accepted.");
  if (typeof value !== "string") throw unknown();
  if (/^data:image\/svg/i.test(value)) throw svg();
  const data = value.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!data) throw unknown();
  const bytes = Buffer.from(data[1], "base64");
  if (bytes.length > MAX_IMAGE) throw new Refuse(413, "too_large", "The image can be at most 1 MB.");
  const kind = imageKind(bytes);
  if (kind) {
    const size = statedSize(bytes, kind.type);
    if (!size || size.some((side) => side < 1)) throw unknown();
    if (size.some((side) => side > MAX_SIDE)) throw new Refuse(400, "bad_image", `The image can be at most ${MAX_SIDE} pixels a side.`);
    return { bytes, ...kind };
  }
  if (bytes.subarray(0, 1024).toString("latin1").trimStart().startsWith("<")) throw svg();
  throw unknown();
}

// The metadata file wallets read: the same for the same coin, so it dedupes too.
const metadataBytes = (name, symbol, imageUrl, type) => Buffer.from(JSON.stringify({
  name, symbol, description: "", image: imageUrl, properties: { category: "image", files: [{ uri: imageUrl, type }] },
}));

// ---- Pinata ----

const pinned = new Map(); // sha256 of the bytes -> CID: the same bytes are not sent twice from one instance

// One file to Pinata, public; gives its CID. The current upload API first, then the older pinning API for keys made
// before it, as holder-fee/upload-metadata.mjs does. Only status numbers are logged: Pinata's words stay out.
async function pin(bytes, name, type, jwt) {
  const hash = sha256(bytes);
  if (pinned.has(hash)) return pinned.get(hash);
  const headers = { Authorization: `Bearer ${jwt}` };
  const file = () => new Blob([bytes], { type });
  const cidFrom = (value) => (typeof value === "string" && /^[A-Za-z0-9]{32,120}$/.test(value) ? value : null);
  const attempt = async (url, form, read) => {
    try {
      const answer = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(WAIT) });
      const cid = answer.ok ? cidFrom(read(await answer.json())) : null;
      return { cid, status: answer.status };
    } catch {
      return { cid: null, status: 0 };
    }
  };
  const form = new FormData();
  form.append("file", file(), name);
  form.append("network", "public");
  form.append("name", name);
  const first = await attempt("https://uploads.pinata.cloud/v3/files", form, (body) => body?.data?.cid);
  let cid = first.cid;
  if (!cid) {
    const legacy = new FormData();
    legacy.append("file", file(), name);
    legacy.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    legacy.append("pinataMetadata", JSON.stringify({ name }));
    const second = await attempt("https://api.pinata.cloud/pinning/pinFileToIPFS", legacy, (body) => body?.IpfsHash);
    cid = second.cid;
    if (!cid) {
      console.error(`api/upload: Pinata refused an upload (HTTP ${first.status}, then ${second.status})`);
      throw new Refuse(502, "host", "The image host refused the upload. Try again.");
    }
  }
  remember(pinned, hash, cid);
  return cid;
}

async function toPinata(image, name, symbol, jwt, gateway) {
  const imageCid = await pin(image.bytes, `${sha256(image.bytes)}.${image.ext}`, image.type, jwt);
  const imageUrl = `https://${gateway}/ipfs/${imageCid}`;
  const metadata = metadataBytes(name, symbol, imageUrl, image.type);
  const metadataCid = await pin(metadata, `${sha256(metadata)}.json`, "application/json", jwt);
  return { uri: `https://${gateway}/ipfs/${metadataCid}`, image: imageUrl };
}

// ---- the local folder ----

// Named by content, so a file already there is the same file. Written beside its place and moved in, so a server
// stopped half way leaves no broken file under a good name.
async function keep(folder, file, bytes) {
  const place = join(folder, file), draft = `${place}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(draft, bytes);
  await rename(draft, place).catch(async (error) => {
    await rm(draft, { force: true }).catch(() => {});
    throw error;
  });
}

async function toFolder(image, name, symbol, local) {
  await mkdir(local.uploads, { recursive: true });
  const origin = `http://localhost:${local.port}/uploads`;
  const imageFile = `${sha256(image.bytes)}.${image.ext}`;
  await keep(local.uploads, imageFile, image.bytes);
  const imageUrl = `${origin}/${imageFile}`;
  const metadata = metadataBytes(name, symbol, imageUrl, image.type);
  const metadataFile = `${sha256(metadata)}.json`;
  await keep(local.uploads, metadataFile, metadata);
  return { uri: `${origin}/${metadataFile}`, image: imageUrl };
}

// ---- the route ----

module.exports = endpoint("upload", async (req) => {
  assertOpen(clusterOf(process.env)); // with launches closed there is nothing to host, and the key stays unused
  limit(req, "upload", 4); // a launch needs one
  const body = await readJson(req, MAX_BODY);
  const name = plainText(body.name, "name", 32), symbol = plainText(body.symbol, "symbol", 10);
  const image = readImage(body.image);
  const jwt = process.env.PINATA_JWT, gateway = gatewayHost(process.env);
  if (jwt && gateway) {
    budget("pin", 60);
    return toPinata(image, name, symbol, jwt, gateway);
  }
  const local = localRun();
  if (local && clusterOf(process.env) === "devnet") return toFolder(image, name, symbol, local);
  throw new Refuse(503, "no_host", "Image hosting is not set up yet.");
});
