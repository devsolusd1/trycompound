// POST /api/launch: everything a launch needs from the server, in steps. The server never holds a key: it builds the
// unsigned transaction, and later passes on one that the wallet and the page signed, once it has read it and seen
// that it is a launch and nothing else. A Vercel function in CommonJS; serve.mjs runs the same file locally.
//
//   { step: "info", wallet? }       the facts the launch page shows
//   { step: "quote", firstBuySol }  what a first buy would get, worked out on the config read from chain
//   { step: "build", wallet, mint, name, symbol, uri, firstBuySol }   the unsigned transaction, already simulated
//   { step: "send", transaction }   checks the fully signed transaction and sends it
//   { step: "status", signature, mint, lastValidBlockHeight? }   what became of it
//
// Answers are JSON. Refusals are HTTP 4xx or 5xx with { error, code }: a short sentence and a slug.
//
//   CLUSTER   devnet (default) or mainnet. The config comes only from "launch" in _configs.json: null closes launches.
//   RPC_URL   the node. Default on devnet: the public one. Never printed, logged or returned.
//
// The transaction: 2 signatures (wallet, mint), legacy, 1043 bytes at the worst case that fits a real Pinata address
// (32-byte name, 10-byte symbol, 120-byte uri, first buy, the wallet with no token accounts yet) and 1123 bytes with
// a 200-byte uri, the most Metaplex allows; the limit is 1232. So no lookup table is needed, the first buy stays
// atomic with the creation, and 109 to 189 bytes stay free for what a wallet adds (97 to 177 on mainnet, where the
// compute price adds 12).

"use strict";

const {
  assertOpen, base58, clusterOf, endpoint, fromBase58, gatewayHost, isAddress, isListed, isSignedBy, launchConfig, limit, localRun, plainText, readJson, Refuse, remember, rpcUrl, scrub,
} = require("./_core.js");

const PACKET = 1232; // the most bytes a transaction may have
const MAX_BODY = 8192;
const MAX_URI = 200; // Metaplex's limit
const MIN_OUT_UNDER_BPS = 50; // the first buy fails if it would get more than 0.5% less than worked out, as create-coin.mjs
const MOST_INSTRUCTIONS = 16; // a launch has 8; the rest is room for a wallet's additions
const CAP_OF_CURVE = 0.99; // the most of the curve one first buy may fill, so that it can never graduate the coin

// What a launch costs with no first buy, in lamports. Measured on devnet on 2026-10-30, from the payer's balance before
// and after the real no-buy launch 3uFv6mFd… through this API, checked against getTransaction's balances: 20,591,641
// spent, 1 of it a compute price the test added as a wallet would. Mint 1,066,800, metadata 13,733,800, pool 2,804,160,
// two vaults 1,488,440 each, network fee 10,000. Rent is the network's to change: measure again before mainnet.
const LAUNCH_COST_LAMPORTS = 20591640;
// On mainnet a launch carries a compute price, so a busy network does not leave it waiting: MAINNET_PRICE micro-lamports
// a compute unit, at most PRIORITY_MOST_LAMPORTS for the most compute a transaction may ask (0.00014 SOL). Devnet: none.
const MAX_UNITS = 1400000;
const MAINNET_PRICE = 100000;
// A wallet may not be left with less than the rent minimum and more than nothing, and the priority allowance above is
// more than a launch really pays, so a balance just over the check could be refused in simulation: the check keeps this
// much more.
const KEEP_LAMPORTS = 890880;
const priorityLamports = (cluster) => (cluster === "mainnet" ? Math.ceil((MAX_UNITS * MAINNET_PRICE) / 1e6) : 0);
// What a first buy adds beyond its own amount: the rent of the buyer's token account (measured on launch 3rPWxaiK…,
// 32,080,080 spent with a 0.01 SOL buy). The wrapped SOL account made for the swap is closed in the same transaction,
// so its rent comes back.
const FIRST_BUY_RENT_LAMPORTS = 1488440;

const WSOL = "So11111111111111111111111111111111111111112";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

// The programs a launch transaction may call directly. Metaplex is not here: the DBC program calls it itself, so it
// is only an account of the create instruction. What each may be asked is in onlyLaunchSteps.
const ALLOWED_PROGRAMS = new Set([
  COMPUTE_BUDGET, // the compute limit; wallets also add a price here
  DBC, // the pool, and the first buy
  ATA, // the buyer's two token accounts
  SYSTEM, // moves the first buy's SOL into wrapped SOL
  TOKEN, // syncs the wrapped SOL, closes it after
  LIGHTHOUSE, // Phantom may add its assertions, which only make a transaction fail
]);

// The DBC instructions a launch uses, by discriminator (from the IDL in the SDK), and where each keeps its accounts.
const CREATE = { tag: "8c55d7b06636684f", config: 0, creator: 2, baseMint: 3, pool: 5, payer: 10 };
const SWAP = { tag: "f8c69e91e17587c8", config: 1, pool: 2, wrappedSol: 3, tokens: 4, baseMint: 7, payer: 9 };

// ---- the libraries, loaded on first need so a plain refusal stays quick ----

let tools = null;
function sdk() {
  if (tools) return tools;
  const { DynamicBondingCurveClient, swapQuote } = require("@meteora-ag/dynamic-bonding-curve-sdk");
  const { ComputeBudgetProgram, Connection, PublicKey } = require("@solana/web3.js");
  const BN = require("bn.js");
  tools = { BN, ComputeBudgetProgram, Connection, DynamicBondingCurveClient, PublicKey, swapQuote };
  return tools;
}

const nodes = new Map(); // cluster -> { connection, client }
function node(cluster) {
  if (nodes.has(cluster)) return nodes.get(cluster);
  const { Connection, DynamicBondingCurveClient } = sdk();
  const connection = new Connection(rpcUrl(cluster, process.env), "confirmed");
  const made = { connection, client: new DynamicBondingCurveClient(connection, "confirmed") };
  nodes.set(cluster, made);
  return made;
}

// ---- the config on chain ----

const FEE_DENOMINATOR = 1e9;

// What every coin of the platform is made under. Compared once against the config on chain, so a wrong entry in
// _configs.json stops launches instead of making coins nobody meant. Field by field as in configDifferences (lib.mjs).
function configFaults(state) {
  const faults = [];
  const expect = (what, has, should) => { if (String(has) !== String(should)) faults.push(`${what} is ${has}, not ${should}`); };
  expect("the quote mint", state.quoteMint?.toBase58?.(), WSOL);
  expect("the token program", state.tokenType, 0);
  expect("the token decimals", state.tokenDecimal, 6);
  expect("the metadata authority", state.tokenUpdateAuthority, 1); // immutable
  expect("the curve fee numerator", state.poolFees?.baseFee?.cliffFeeNumerator, 10000000); // 1%
  expect("the creator's share of the curve fee", state.creatorTradingFeePercentage, 0);
  expect("the fee on a first swap", state.enableFirstSwapWithMinFee, 0);
  expect("where it graduates to", state.migrationOption, 1); // DAMM v2
  expect("the pool kind", state.migratedCollectFeeMode, 2); // Compounding
  expect("the pool fee", state.migratedPoolFeeBps, 200);
  expect("the part of the pool fee put back", state.migratedCompoundingFeeBps, 8000);
  expect("the liquidity locked for good", state.partnerPermanentLockedLiquidityPercentage, 100);
  return faults;
}

let known = null; // the facts of the config, read once per instance; a failed read is not kept

async function platform(cluster) {
  const address = launchConfig(cluster);
  assertOpen(cluster);
  if (known?.address === address) return known;
  const { BN, PublicKey } = sdk();
  const { client, connection } = node(cluster);
  const key = new PublicKey(address);
  const account = await connection.getAccountInfo(key, "confirmed");
  const faults = !account ? ["it is not on chain"] : account.owner.toBase58() !== DBC ? ["its owner is not the DBC program"] : [];
  const state = faults.length ? null : await client.state.getPoolConfig(key);
  if (state) faults.push(...configFaults(state));
  else if (!faults.length) faults.push("it could not be read");
  if (faults.length) {
    console.error(`api/launch: the launch config ${address} is not the platform's: ${faults.join("; ")}`);
    throw new Refuse(500, "bad_config", "The launch config is wrong, so launches are off.");
  }
  const threshold = Number(state.migrationQuoteThreshold.toString());
  const feeNumerator = Number(state.poolFees.baseFee.cliffFeeNumerator.toString());
  // The fee comes off the buy first, so filling the share CAP_OF_CURVE of the curve takes threshold · cap / (1 - fee).
  // Rounded down to a whole microSOL, which also keeps the number short on the page.
  const maxFirstBuySol = Math.floor((threshold * CAP_OF_CURVE) / (1 - feeNumerator / FEE_DENOMINATOR) / 1000) / 1e6;
  known = {
    address, key, state, threshold, maxFirstBuySol,
    maxFirstBuyLamports: Math.round(maxFirstBuySol * 1e9),
    curveFeeBps: feeNumerator / 1e5,
    supply: Number(state.preMigrationTokenSupply.toString()),
    decimals: state.tokenDecimal,
    // the pool as it stands the moment it is created, which is what a first buy trades on
    freshPool: { poolState: { sqrtPrice: state.sqrtStartPrice, quoteReserve: new BN(0), activationPoint: new BN(0), hasSwap: 0, volatilityTracker: { volatilityAccumulator: new BN(0) } } },
  };
  return known;
}

// ---- checks on what the visitor sends ----

function address(value, what) {
  if (!isAddress(value)) throw new Refuse(400, `bad_${what}`, `That ${what} address is not valid.`);
  return value;
}

// SOL as a JSON number, to lamports, within what one first buy may be.
function firstBuyLamports(value, facts) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Refuse(400, "bad_amount", "That is not an amount of SOL.");
  const lamports = Math.round(value * 1e9);
  if (lamports > facts.maxFirstBuyLamports) throw new Refuse(400, "too_much", `A first buy can be at most ${facts.maxFirstBuySol} SOL.`);
  return lamports;
}

// The metadata address must be one this server's own upload gives: the Pinata gateway, or, on devnet in a local run,
// the local file store.
function checkUri(value, cluster) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MAX_URI) throw new Refuse(400, "bad_uri", "That metadata address is not valid.");
  const gateway = gatewayHost(process.env);
  const prefix = gateway ? `https://${gateway}/ipfs/` : null;
  if (prefix && value.startsWith(prefix) && /^[A-Za-z0-9]{32,120}$/.test(value.slice(prefix.length))) return value;
  const local = cluster === "devnet" ? localRun() : null;
  if (local && new RegExp(`^http://localhost:${local.port}/uploads/[0-9a-f]{64}\\.json$`).test(value)) return value;
  throw new Refuse(400, "bad_uri", "That metadata address did not come from this site.");
}

// ---- the first buy ----

// Worked out with the SDK on the config as it is on chain. Gave exactly what the chain gave for the test coins
// TIDE (0.064094 SOL, 137510607.423348 tokens) and MOSS (0.22433 SOL, 377474992.44438 tokens).
function quoteBuy(lamports, facts) {
  const { BN, swapQuote } = sdk();
  let quote;
  try {
    quote = swapQuote(facts.freshPool, facts.state, false, new BN(lamports), 0, false, new BN(0), false, {});
  } catch {
    throw new Refuse(400, "too_small", "That first buy is too small.");
  }
  const out = quote.excludedTransferFeeAmountOut ?? quote.outputAmount;
  if (out.isZero()) throw new Refuse(400, "too_small", "That first buy is too small.");
  return { out, reserve: Number(quote.actualInputAmount.toString()) };
}

// ---- what the network said, in plain words ----

function refusalFrom(text, logs, code) {
  const all = `${text}\n${Array.isArray(logs) ? logs.join("\n") : ""}`;
  if (/blockhash not found/i.test(all)) return new Refuse(409, "expired", "This transaction expired. Build it again.");
  if (/AccountNotFound|prior credit/i.test(all)) return new Refuse(400, "no_funds", "This wallet has no SOL on this network.");
  if (/insufficient (lamports|funds)|InsufficientFundsForRent/i.test(all)) return new Refuse(400, "low_balance", "This wallet does not have enough SOL for this launch.");
  if (/already in use/i.test(all)) return new Refuse(409, "mint_exists", "That coin address is already taken.");
  console.warn(`api/launch: the network refused a transaction: ${scrub(all.slice(-600))}`);
  return new Refuse(400, code, "The network refused this launch.");
}

function chainFailure(err) {
  const failed = err?.InstructionError;
  if (Array.isArray(failed)) return `Instruction ${Number(failed[0]) + 1} failed: ${typeof failed[1] === "string" ? failed[1] : JSON.stringify(failed[1])}.`.slice(0, 200);
  return `The chain refused it: ${typeof err === "string" ? err : JSON.stringify(err)}.`.slice(0, 200);
}

// ---- reading a signed transaction ----

// The wire format by hand: nothing here needs a library, and a parser that throws on the first odd byte suits a check
// better than one built to accept everything a wallet might send. No lookup tables: their accounts cannot be read
// from the bytes alone, and a launch has no use for them.
function readTransaction(wire) {
  const foreign = () => new Refuse(400, "foreign", "This is not a launch transaction.");
  let at = 0;
  const take = (size) => {
    if (at + size > wire.length) throw foreign();
    const part = wire.subarray(at, at + size);
    at += size;
    return part;
  };
  const shortVec = () => {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const byte = take(1)[0];
      value |= (byte & 0x7f) << (7 * i);
      if (!(byte & 0x80)) return value;
    }
    throw foreign();
  };
  const signatures = [];
  const signatureCount = shortVec();
  for (let i = 0; i < signatureCount; i++) signatures.push(take(64));
  const messageAt = at;
  const versioned = (wire[at] & 0x80) !== 0;
  if (versioned && take(1)[0] !== 0x80) throw foreign();
  const [required] = take(3);
  const keyCount = shortVec();
  const keys = [];
  for (let i = 0; i < keyCount; i++) keys.push(base58(take(32)));
  const blockhash = base58(take(32));
  const instructions = [];
  const instructionCount = shortVec();
  for (let i = 0; i < instructionCount; i++) {
    const program = keys[take(1)[0]];
    const accounts = [...take(shortVec())].map((index) => keys[index]);
    const data = take(shortVec());
    if (program === undefined || accounts.includes(undefined)) throw foreign();
    instructions.push({ program, accounts, data });
  }
  if (versioned && shortVec() !== 0) throw foreign(); // lookup tables
  if (at !== wire.length || required !== signatures.length || required > keys.length) throw foreign();
  return { signatures, message: wire.subarray(messageAt), keys, required, blockhash, instructions };
}

// The name, symbol and uri a create instruction carries, after its 8-byte discriminator. Throws on data too short.
function createdMetadata(data) {
  let at = 8;
  const text = () => {
    const size = data.readUInt32LE(at);
    at += 4;
    const value = data.toString("utf8", at, at + size);
    at += size;
    if (at > data.length) throw new RangeError("short");
    return value;
  };
  return { name: text(), symbol: text(), uri: text() };
}

// Whether every instruction is a step of this launch. Compute Budget may set a limit or a price. Without a first buy
// nothing else runs beside the DBC program. With one, System may only move the payer's SOL into its own wrapped SOL
// account, and Token may only sync that account and close it back to the payer. Associated Token may only make the
// payer's own two accounts, which is also what keeps the bought tokens with the payer: the mint is new, so no other
// account of it can exist. Lighthouse is passed on as it came, since its assertions can only fail a transaction.
function onlyLaunchSteps(tx, payer, mint, buy) {
  const wrapped = buy?.accounts[SWAP.wrappedSol], tokens = buy?.accounts[SWAP.tokens];
  return tx.instructions.every((ix) => {
    const kind = ix.data[0];
    switch (ix.program) {
      case DBC: case LIGHTHOUSE: return true;
      case COMPUTE_BUDGET: return kind === 2 || kind === 3 || kind === 4;
      case ATA: return Boolean(buy) && ix.data.length === 1 && kind === 1 && ix.accounts[0] === payer && ix.accounts[2] === payer
        && ((ix.accounts[1] === wrapped && ix.accounts[3] === WSOL) || (ix.accounts[1] === tokens && ix.accounts[3] === mint));
      case SYSTEM: return Boolean(buy) && ix.data.length === 12 && ix.data.readUInt32LE(0) === 2 && ix.accounts[0] === payer && ix.accounts[1] === wrapped;
      case TOKEN: return Boolean(buy) && ix.data.length === 1 && ix.accounts[0] === wrapped && (kind === 17 || (kind === 9 && ix.accounts[1] === payer));
      default: return false;
    }
  });
}

// Throws unless this is one launch under the launch config and nothing else: the fee payer and the mint have really
// signed, the DBC program is asked for one create and at most one first buy within the cap, every other instruction is
// a step of that launch, and the name, symbol and uri pass the same checks as build.
function checkLaunch(wire, config, facts, cluster) {
  const foreign = new Refuse(400, "foreign", "This is not a launch transaction.");
  const unsigned = new Refuse(400, "unsigned", "The transaction is not fully signed.");
  if (wire.length > PACKET) throw foreign;
  const tx = readTransaction(wire);
  if (tx.required !== 2 || tx.instructions.length > MOST_INSTRUCTIONS) throw foreign;
  if (tx.instructions.some((ix) => !ALLOWED_PROGRAMS.has(ix.program))) throw foreign;

  const dbc = tx.instructions.filter((ix) => ix.program === DBC);
  const tag = (ix) => ix.data.subarray(0, 8).toString("hex");
  const creates = dbc.filter((ix) => tag(ix) === CREATE.tag), swaps = dbc.filter((ix) => tag(ix) === SWAP.tag);
  if (creates.length !== 1 || swaps.length > 1 || creates.length + swaps.length !== dbc.length) throw foreign;
  const create = creates[0].accounts;
  const [payer, mint] = tx.keys;
  if (create.length <= CREATE.payer || create[CREATE.config] !== config) throw foreign;
  if (create[CREATE.payer] !== payer || create[CREATE.creator] !== payer || create[CREATE.baseMint] !== mint) throw foreign;
  if (swaps.length) {
    const swap = swaps[0].accounts;
    if (swap.length <= SWAP.payer || swap[SWAP.config] !== config || swap[SWAP.pool] !== create[CREATE.pool] || swap[SWAP.baseMint] !== mint || swap[SWAP.payer] !== payer) throw foreign;
  }
  const buy = swaps[0];
  if (buy && (buy.data.length !== 24 || buy.data.readBigUInt64LE(8) > BigInt(facts.maxFirstBuyLamports))) throw foreign; // discriminator, amount in, minimum out
  if (!onlyLaunchSteps(tx, payer, mint, buy)) throw foreign;
  let made;
  try {
    made = createdMetadata(creates[0].data);
  } catch {
    throw foreign;
  }
  plainText(made.name, "name", 32);
  plainText(made.symbol, "symbol", 10);
  checkUri(made.uri, cluster);
  tx.keys.slice(0, 2).forEach((key, i) => {
    if (!isSignedBy(tx.message, tx.signatures[i], fromBase58(key, 32))) throw unsigned;
  });
  return tx;
}

// ---- the steps ----

const heights = new Map(); // blockhash or signature -> the last block height it can land at, in this instance's memory
const atMost = (x, places) => Number(x.toFixed(places));

async function info(body, cluster) {
  if (body.wallet !== undefined && body.wallet !== null) address(body.wallet, "wallet");
  if (!launchConfig(cluster)) {
    return { cluster, config: null, open: false, graduationSol: null, curveFeeBps: null, balanceSol: null, costSol: null, firstBuyRentSol: null, maxFirstBuySol: null };
  }
  const facts = await platform(cluster);
  const lamports = body.wallet ? await node(cluster).connection.getBalance(new (sdk().PublicKey)(body.wallet), "confirmed") : null;
  return {
    cluster, config: facts.address, open: true, listed: isListed(cluster, facts.address),
    graduationSol: facts.threshold / 1e9, curveFeeBps: facts.curveFeeBps,
    balanceSol: lamports === null ? null : lamports / 1e9,
    costSol: (LAUNCH_COST_LAMPORTS + priorityLamports(cluster)) / 1e9,
    firstBuyRentSol: FIRST_BUY_RENT_LAMPORTS / 1e9, // added on top of costSol and the buy when there is a first buy
    maxFirstBuySol: facts.maxFirstBuySol,
  };
}

async function quote(body, cluster) {
  const facts = await platform(cluster);
  const lamports = firstBuyLamports(body.firstBuySol, facts);
  if (!lamports) return { firstBuySol: 0, tokens: 0, shareOfSupply: 0, progress: 0 };
  const { out, reserve } = quoteBuy(lamports, facts);
  const units = Number(out.toString());
  return {
    firstBuySol: lamports / 1e9,
    tokens: Math.floor(units / 10 ** facts.decimals),
    shareOfSupply: atMost(units / facts.supply, 9),
    progress: atMost(Math.min(1, reserve / facts.threshold), 9),
  };
}

async function build(body, cluster) {
  const wallet = address(body.wallet, "wallet"), mint = address(body.mint, "mint");
  if (wallet === mint) throw new Refuse(400, "same_key", "The wallet and the coin need different addresses.");
  const name = plainText(body.name, "name", 32), symbol = plainText(body.symbol, "symbol", 10);
  const uri = checkUri(body.uri, cluster);
  const facts = await platform(cluster);
  const lamports = firstBuyLamports(body.firstBuySol ?? 0, facts);
  const buy = lamports ? quoteBuy(lamports, facts) : null;

  const { BN, ComputeBudgetProgram, PublicKey } = sdk();
  const { client, connection } = node(cluster);
  const walletKey = new PublicKey(wallet), mintKey = new PublicKey(mint);
  const [mintAccount, walletAccount] = await connection.getMultipleAccountsInfo([mintKey, walletKey], "confirmed");
  if (mintAccount) throw new Refuse(409, "mint_exists", "That coin address is already taken.");
  // A first buy holds the rent of two token accounts while it runs. The wrapped SOL one comes back at the end of the
  // transaction, so it is in this check and not in the cost the page shows.
  const needed = LAUNCH_COST_LAMPORTS + priorityLamports(cluster) + KEEP_LAMPORTS + lamports + (lamports ? 2 * FIRST_BUY_RENT_LAMPORTS : 0);
  if (!walletAccount) throw new Refuse(400, "no_funds", "This wallet has no SOL on this network.");
  if (walletAccount.lamports < needed) throw new Refuse(400, "low_balance", `This launch needs ${needed / 1e9} SOL in the wallet.`);

  const createPoolParam = { name, symbol, uri, payer: walletKey, poolCreator: walletKey, config: facts.key, baseMint: mintKey };
  const tx = buy
    ? await client.creator.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: { buyer: walletKey, receiver: walletKey, buyAmount: new BN(lamports), minimumAmountOut: buy.out.muln(10000 - MIN_OUT_UNDER_BPS).divn(10000), referralTokenAccount: null },
    })
    : await client.creator.createPool(createPoolParam);

  // Simulated with the most compute, then given the limit the simulation showed plus a margin (the rule in prepare(),
  // lib.mjs). No signature exists yet, and with no signers web3.js asks the node to skip checking them.
  const steps = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = walletKey;
  tx.recentBlockhash = blockhash;
  const price = cluster === "mainnet" ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MAINNET_PRICE })] : [];
  tx.instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_UNITS }), ...price, ...steps];
  const simulated = await connection.simulateTransaction(tx);
  if (simulated.value.err) throw refusalFrom(JSON.stringify(simulated.value.err), simulated.value.logs, "simulation");
  const units = Math.min(MAX_UNITS, Math.ceil(((simulated.value.unitsConsumed ?? 200000) * 1.3 + 10000) / 1000) * 1000);
  tx.instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...price, ...steps];
  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (wire.length > PACKET) throw new Refuse(400, "too_big", "This launch does not fit in one transaction.");
  remember(heights, blockhash, lastValidBlockHeight);
  return { transaction: wire.toString("base64"), lastValidBlockHeight, signers: [wallet, mint] };
}

async function send(body, cluster) {
  const text = body.transaction;
  if (typeof text !== "string" || text.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Refuse(400, "foreign", "This is not a launch transaction.");
  const facts = await platform(cluster);
  const wire = Buffer.from(text, "base64");
  const tx = checkLaunch(wire, facts.address, facts, cluster);
  const signature = base58(tx.signatures[0]);
  const { connection } = node(cluster);
  try {
    await connection.sendRawTransaction(wire, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  } catch (error) {
    const said = `${error?.transactionMessage ?? ""} ${error?.message ?? ""}`;
    if (!/already been processed/i.test(said)) {
      if (error?.name === "SendTransactionError" || /simulation failed/i.test(said)) throw refusalFrom(said, error?.logs, "refused");
      throw error;
    }
  }
  // A blockhash lives 150 blocks, so if this instance did not build it the limit is at most that far from now.
  const last = heights.get(tx.blockhash) ?? (await connection.getBlockHeight("confirmed").then((height) => height + 151, () => null));
  if (last !== null) remember(heights, signature, last);
  return { signature };
}

async function status(body, cluster) {
  const signature = body.signature;
  if (fromBase58(signature, 64) === null) throw new Refuse(400, "bad_signature", "That signature is not valid.");
  const mint = address(body.mint, "mint");
  const given = body.lastValidBlockHeight;
  if (given !== undefined && given !== null && !Number.isSafeInteger(given)) throw new Refuse(400, "bad_height", "That block height is not valid.");
  const { connection } = node(cluster);
  const look = () => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).then((answer) => answer.value[0]);
  const [seen, account] = await Promise.all([look(), connection.getAccountInfo(new (sdk().PublicKey)(mint), "confirmed")]);
  const exists = account !== null;
  if (seen?.err) return { state: "failed", error: chainFailure(seen.err), exists };
  if (exists || ["confirmed", "finalized"].includes(seen?.confirmationStatus)) return { state: "confirmed", error: null, exists };
  // This instance's memory first: it holds the limit of the transaction really sent, which a wallet may have given a
  // new blockhash. Else the limit the page has from build. With neither, it stays pending.
  const last = heights.get(signature) ?? given;
  if (!seen && last !== undefined && last !== null && (await connection.getBlockHeight("confirmed")) > last && !(await look())) {
    return { state: "expired", error: null, exists };
  }
  return { state: "pending", error: null, exists };
}

// ---- the route ----

const STEPS = { info, quote, build, send, status };
const PER_MINUTE = { build: 10, send: 10, info: 120, quote: 120, status: 120 };
const SHARED_LIMIT = { info: "read", quote: "read", status: "read" }; // the page polls these

module.exports = endpoint("launch", async (req) => {
  const body = await readJson(req, MAX_BODY);
  const step = body.step;
  if (typeof step !== "string" || !Object.hasOwn(STEPS, step)) throw new Refuse(400, "bad_step", "Unknown step.");
  limit(req, SHARED_LIMIT[step] ?? step, PER_MINUTE[step]);
  const cluster = clusterOf(process.env);
  if (step !== "info") assertOpen(cluster);
  try {
    return await STEPS[step](body, cluster);
  } catch (error) {
    if (error instanceof Refuse) throw error;
    // web3.js gives a node that fails as a plain Error: the cause goes to the log, scrubbed, and the visitor is told. A
    // library that fails to load is not the node, even when its name says socket (rpc-websockets).
    if (/require\(\)|cannot find module|ERR_REQUIRE|ERR_MODULE/i.test(String(error?.message))) {
      console.error(`api/launch: a library failed to load on Node ${process.version}: ${scrub(error?.message ?? error)}`);
      throw new Refuse(500, "library", "The launch service could not start. Try again later.");
    }
    if (!/fetch|network|timed? ?out|socket|econn|429|50[234]|failed to get/i.test(String(error?.message))) throw error;
    console.error(`api/launch: ${scrub(error?.message ?? error)}`);
    // What kind of failure, in words that can't carry the node's address or key: an HTTP status, a socket error's name,
    // and which sort of node is set (helius mainnet, helius devnet or other), so a wrong RPC_URL shows from outside.
    const said = String(error?.message ?? error);
    const why = (said.match(/\b(401|403|404|429|500|502|503|504)\b/) || said.match(/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|timed? ?out/i) || [])[0];
    let kind = "other node";
    try {
      const host = new URL(process.env.RPC_URL).hostname;
      if (host === "mainnet.helius-rpc.com") kind = "helius mainnet";
      else if (host === "devnet.helius-rpc.com") kind = "helius devnet";
      else if (host.endsWith("helius-rpc.com")) kind = "helius";
    } catch { kind = "no valid node address"; }
    throw new Refuse(502, "node", `The network could not be reached (${why ? `${why}, ` : ""}${kind}). Try again.`);
  }
});
