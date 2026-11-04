// Local preview of the site: node compound-pad/site/serve.mjs [port]   (default 5050)
// Clean URLs: a path with no extension that is not a file is served from that path + ".html" (/coins, /launch).
// /api/coins, /api/launch and /api/upload run the files in api/, the same ones Vercel runs as functions; nothing else
// under /api/ is served. /uploads/<sha256>.<ext> serves what api/upload.js stored locally, from compound-pad/.uploads.
// RPC_URL, CLUSTER, PINATA_JWT and PINATA_GATEWAY come from the environment or from compound-pad/.env (the environment
// wins); .env is read once at start, and its values are never printed. It listens on this machine only (127.0.0.1) and
// answers only to the names localhost and 127.0.0.1.
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2]) || 5050;
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// Reads a .env the way people on Windows really save one (byte order marks, UTF-16, \r\n, quotes, "export"), as
// readEnv in lib.mjs, which cannot be imported here without loading the whole SDK at start.
function readEnv(bytes) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString("utf16le");
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2))).swap16().toString("utf16le");
  else if (bytes.length > 1 && bytes[0] !== 0 && bytes[1] === 0) text = bytes.toString("utf16le");
  else text = bytes.toString("utf8");
  const edges = /^[\s﻿​]+|[\s﻿​]+$/g;
  const found = {};
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(edges, "");
    const equals = line.indexOf("=");
    if (line.startsWith("#") || equals < 1) continue;
    const name = line.slice(0, equals).replace(/^export\s+/i, "").replace(edges, "").toUpperCase();
    let value = line.slice(equals + 1).replace(edges, "");
    const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
    value = quoted ? quoted[1] : value.replace(/\s+#.*$/, "");
    if (value) found[name] = value;
  }
  return found;
}

const envFile = join(root, "..", ".env");
if (existsSync(envFile)) {
  const found = readEnv(readFileSync(envFile));
  for (const name of ["RPC_URL", "CLUSTER", "PINATA_JWT", "PINATA_GATEWAY"]) if (found[name] && process.env[name] === undefined) process.env[name] = found[name];
}

// Tells api/ this is a local run, and where uploads go. A symbol and not an environment variable, so no setting on
// Vercel can turn the local file store on there.
const uploads = join(root, "..", ".uploads");
globalThis[Symbol.for("compound.local")] = { uploads, port };
const uploadTypes = { json: "application/json; charset=utf-8", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

// The functions under /api/ are CommonJS, as Vercel runs them. They are compiled here with a require of their own and
// loaded again when a file under api/ changes (a function, _core.js or _configs.json), so an edit needs no restart.
const functions = { "/api/coins": join(root, "api", "coins.js"), "/api/launch": join(root, "api", "launch.js"), "/api/upload": join(root, "api", "upload.js") };
const loaded = new Map();
function loadFunction(file) {
  const folder = dirname(file);
  const changed = readdirSync(folder).map((name) => statSync(join(folder, name)).mtimeMs).join(":");
  const known = loaded.get(file);
  if (known?.changed === changed) return known.handler;
  const require = createRequire(file);
  for (const cached of Object.keys(require.cache)) if (cached.startsWith(folder + sep)) delete require.cache[cached];
  const module = { exports: {} };
  const body = compileFunction(readFileSync(file, "utf8"), ["exports", "require", "module", "__filename", "__dirname"], { filename: file });
  body.call(module.exports, module.exports, require, module, file, folder);
  loaded.set(file, { changed, handler: module.exports });
  return module.exports;
}

createServer(async (req, res) => {
  // This machine only, by name too, so a web page that points its own domain at this address (DNS rebinding) gets nothing.
  const host = String(req.headers.host ?? "").toLowerCase();
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
  let path;
  try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
  if (Object.hasOwn(functions, path)) {
    try {
      await loadFunction(functions[path])(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" }).end('{"error":"the function failed"}');
      else res.end();
    }
    return;
  }
  // uploaded files: the exact shape of a name upload.js writes, from that one folder, as their own type and nothing else
  if (path.startsWith("/uploads/")) {
    const name = path.match(/^\/uploads\/([0-9a-f]{64})\.(json|png|jpg|gif|webp)$/);
    if (!name || (req.method !== "GET" && req.method !== "HEAD")) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(join(uploads, `${name[1]}.${name[2]}`));
      res.writeHead(200, { "content-type": uploadTypes[name[2]], "x-content-type-options": "nosniff", "cache-control": "public, max-age=3600" }).end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  let file = normalize(join(root, path.endsWith("/") ? `${path}index.html` : path));
  if (!file.startsWith(root)) { res.writeHead(404).end(); return; }
  // nothing under api/ is a static file, however its folder is spelled (Windows ignores case and trailing dots and spaces)
  const top = relative(root, file).split(sep)[0].replace(/[. ]+$/, "").toLowerCase();
  if (top === "api" || path.includes(":")) { res.writeHead(404).end(); return; }
  if (!extname(file) && !(await isFile(file))) file += ".html";
  // only the site's own file types, matched exactly: no .mjs source, no other case, no NTFS stream names
  if (!Object.hasOwn(types, extname(file))) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`compound site on http://localhost:${port}`));
