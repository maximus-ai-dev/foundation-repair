// Foundation Repair — cancel listings & burn tokens.
// Talks directly to the verified Foundation Market proxy on Ethereum mainnet.
// No backend, no tracking.
//
// Verified source: https://sourcify.dev/#/lookup/0xecb3ce1154af51e117d6cf9e05d6bd7f24e4a0e1
// Market proxy:    0xcDA72070E455bb31C7690a170224Ce43623d0B6f

"use strict";

const MARKET = "0xcDA72070E455bb31C7690a170224Ce43623d0B6f";
const FND_SHARED = "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405";
const MAINNET_CHAIN_ID = 1n;
const ETHERSCAN = "https://etherscan.io";

const MARKET_ABI = [
  "function cancelReserveAuction(uint256 auctionId) external",
  "function cancelBuyPrice(address nftContract, uint256 tokenId) external",
  "function getReserveAuctionIdFor(address nftContract, uint256 tokenId) view returns (uint256 auctionId)",
  "function getBuyPrice(address nftContract, uint256 tokenId) view returns (address seller, uint256 price)",
  "function getReserveAuction(uint256 auctionId) view returns (tuple(address nftContract, uint256 tokenId, address seller, uint256 duration, uint256 extensionDuration, uint256 endTime, address bidder, uint256 amount) auction)",
  "event BuyPriceSet(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 price)",
  "event ReserveAuctionCreated(address indexed seller, address indexed nftContract, uint256 indexed tokenId, uint256 duration, uint256 extensionDuration, uint256 reservePrice, uint256 auctionId)"
];

// Safe starting block — Foundation Market contract has been active since early 2022.
// Earlier blocks return empty logs quickly, so a conservative lower bound is fine.
const MARKET_DEPLOY_BLOCK = 13500000n;

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function burn(uint256 tokenId) external"
];

// --- DOM refs -------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const ui = {
  walletStatus:  $("wallet-status"),
  walletDetail:  $("wallet-detail"),
  connectBtn:    $("connect-btn"),
  nftUrl:        $("nft-url"),
  nftContract:   $("nft-contract"),
  tokenId:       $("token-id"),
  loadBtn:       $("load-btn"),
  scanBtn:       $("scan-btn"),
  statePanel:    $("state-panel"),
  scanPanel:     $("scan-panel"),
  auctionId:     $("auction-id"),
  cancelAuction: $("cancel-auction-btn"),
  cancelBuy:     $("cancel-buyprice-btn"),
  burnBtn:       $("burn-btn"),
  burnAck:       $("burn-ack"),
  auctionHint:   $("auction-hint"),
  buypriceHint:  $("buyprice-hint"),
  logItems:      $("log-items"),
};

// --- state ----------------------------------------------------------------

let provider = null;      // ethers.BrowserProvider
let signer   = null;      // ethers.Signer
let account  = null;      // string
let chainId  = null;      // bigint
let lastLookup = null;
let eip1193Provider = null; // the raw EIP-1193 provider, retained for chain-switch calls
let connectBtnMode = "connect"; // "connect" | "switch" — controls what the wallet-bar button does

// --- helpers --------------------------------------------------------------

function log(msg, { link } = {}) {
  const li = document.createElement("li");
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = new Date().toLocaleTimeString();
  li.append(ts);
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = link.text || link.href;
    const span = document.createElement("span");
    span.textContent = msg + " ";
    li.append(span, a);
  } else {
    li.appendChild(document.createTextNode(msg));
  }
  const first = ui.logItems.firstElementChild;
  if (ui.logItems.children.length === 1 && first && first.classList.contains("muted")) {
    ui.logItems.replaceChildren(li);
  } else {
    ui.logItems.prepend(li);
  }
}

function txLink(hash) {
  return { href: `${ETHERSCAN}/tx/${hash}`, text: hash.slice(0, 10) + "…" };
}

function shortAddr(a) {
  if (!a) return "—";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function fmtEth(wei) {
  const s = ethers.formatEther(wei);
  // strip trailing zeros after decimal, keep the decimal point only if needed
  return s.replace(/\.?0+$/, "") || "0";
}

// Parse a Foundation or Etherscan URL into { contract, tokenId }.
// Returns null if we can't figure it out.
function parseNftUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const isAddr = (x) => x && /^0x[0-9a-fA-F]{40}$/.test(x);
  const isId   = (x) => x && /^\d+$/.test(x);
  // Normalize address: lowercase before checksumming so mixed-case URLs don't throw.
  const norm = (x) => ethers.getAddress(x.toLowerCase());
  // SECURITY: Exact host match or proper subdomain. Do NOT use .endsWith() directly
  // because it matches "evil-etherscan.io" as a suffix of "etherscan.io".
  const hostMatches = (h, domain) => h === domain || h.endsWith("." + domain);

  // etherscan.io/nft/<contract>/<tokenId>
  if (hostMatches(host, "etherscan.io") && parts[0] === "nft" && isAddr(parts[1]) && isId(parts[2])) {
    return { contract: norm(parts[1]), tokenId: parts[2] };
  }
  // etherscan.io/token/<contract>?a=<tokenId>
  if (hostMatches(host, "etherscan.io") && parts[0] === "token" && isAddr(parts[1])) {
    const a = u.searchParams.get("a");
    if (isId(a)) return { contract: norm(parts[1]), tokenId: a };
  }

  // foundation.app/...
  if (hostMatches(host, "foundation.app")) {
    // /collections/<contract>/<tokenId>
    const iCol = parts.indexOf("collections");
    if (iCol >= 0 && isAddr(parts[iCol + 1]) && isId(parts[iCol + 2])) {
      return { contract: norm(parts[iCol + 1]), tokenId: parts[iCol + 2] };
    }
    // /@handle/~/<tokenId>  or  /@handle/<slug>/<tokenId>  or  /<anything>/<tokenId>
    const last = parts[parts.length - 1];
    if (isId(last)) {
      // We can't reliably distinguish shared FND vs Worlds from the handle alone.
      // Default to the shared FND contract and let the user override.
      return { contract: FND_SHARED, tokenId: last, assumedShared: true };
    }
  }

  return null;
}

function requireWallet() {
  if (!signer) throw new Error("Connect your wallet first.");
  if (chainId !== MAINNET_CHAIN_ID) throw new Error(`Wrong network (chain ${chainId}). Switch to Ethereum mainnet in your wallet.`);
}

function parseInputs() {
  // URL takes precedence if filled in; otherwise fall back to manual fields.
  const url = ui.nftUrl.value.trim();
  if (url) {
    const parsed = parseNftUrl(url);
    if (!parsed) throw new Error("I couldn't make sense of that link. Try an Etherscan NFT URL or a foundation.app URL ending in a token ID — or use the manual fields below.");
    // Reflect parsed values into the manual fields so the user sees what we inferred.
    ui.nftContract.value = parsed.contract;
    ui.tokenId.value = parsed.tokenId;
    return { nft: parsed.contract, tokenId: BigInt(parsed.tokenId), assumedShared: !!parsed.assumedShared };
  }
  const nft = ui.nftContract.value.trim() || FND_SHARED;
  const tokenIdStr = ui.tokenId.value.trim();
  if (!ethers.isAddress(nft)) throw new Error("That NFT contract address doesn't look right — it should start with 0x and be 42 characters long.");
  if (!/^\d+$/.test(tokenIdStr)) throw new Error("Token ID should be a whole number (no decimals, no letters).");
  return { nft: ethers.getAddress(nft), tokenId: BigInt(tokenIdStr), assumedShared: false };
}

function explainRevert(err) {
  const r = err?.revert;
  if (r?.name) {
    const msgs = {
      "NFTMarketReserveAuction_Cannot_Update_Auction_In_Progress":
        "This auction already has a bid, so the contract won't let you cancel it. You'll need to wait for the auction to end.",
      "NFTMarketReserveAuction_Not_Matching_Seller":
        "Only the wallet that created the auction can cancel it. Make sure you've connected the same wallet you used to list the piece.",
      "NFTMarketBuyPrice_Cannot_Cancel_Unset_Price":
        "There's no buy-now price set on this piece, so there's nothing to cancel.",
      "NFTMarketBuyPrice_Only_Owner_Can_Cancel_Price":
        "Only the wallet that set the buy price can cancel it. Make sure you've connected the right wallet.",
    };
    if (msgs[r.name]) return msgs[r.name];
    return `Contract error: ${r.name}`;
  }
  if (err?.code === "ACTION_REJECTED") return "You cancelled the transaction in your wallet. (Nothing changed.)";
  const raw = err?.shortMessage || err?.info?.error?.message || err?.message || String(err);
  return raw;
}

// --- wallet ---------------------------------------------------------------

// EIP-6963: Multi-wallet discovery. Each injected wallet announces itself via a
// CustomEvent. We collect announcements and let the user pick the one they want
// instead of being stuck with whatever hijacked window.ethereum last.

const discoveredWallets = new Map();  // rdns -> { info, provider }

window.addEventListener("eip6963:announceProvider", (event) => {
  const detail = event.detail;
  if (!detail?.info?.rdns || !detail?.provider) return;
  discoveredWallets.set(detail.info.rdns, detail);
});

// Ask all injected wallets to announce themselves.
window.dispatchEvent(new Event("eip6963:requestProvider"));

// Request again shortly after load in case a wallet injects late.
setTimeout(() => {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}, 500);

async function connect() {
  // Re-poll to catch any late-injected wallets.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise(r => setTimeout(r, 50));

  const wallets = Array.from(discoveredWallets.values());

  // No EIP-6963 wallets found. Fall back to window.ethereum (legacy).
  if (wallets.length === 0) {
    if (!window.ethereum) {
      log("No wallet detected. Install MetaMask (metamask.io) or another browser wallet extension, then reload this page.");
      return;
    }
    return connectWith({ info: { name: "wallet", rdns: "legacy" }, provider: window.ethereum });
  }

  // Exactly one wallet — just use it.
  if (wallets.length === 1) {
    return connectWith(wallets[0]);
  }

  // Multiple wallets — let the user pick.
  showWalletPicker(wallets);
}

function showWalletPicker(wallets) {
  // Remove any existing picker.
  document.getElementById("wallet-picker")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "wallet-picker";
  overlay.className = "picker-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const modal = document.createElement("div");
  modal.className = "picker-modal";

  const title = document.createElement("h3");
  title.textContent = "Choose a wallet";
  modal.append(title);

  const note = document.createElement("p");
  note.className = "muted small";
  note.textContent = "You have multiple wallets installed. Pick the one you used on Foundation.";
  modal.append(note);

  const list = document.createElement("div");
  list.className = "picker-list";

  for (const w of wallets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-item";

    if (w.info.icon) {
      const img = document.createElement("img");
      img.src = w.info.icon;      // data: URIs per EIP-6963 spec
      img.alt = "";
      img.width = 28;
      img.height = 28;
      btn.append(img);
    }

    const label = document.createElement("span");
    label.textContent = w.info.name || "Unknown wallet";
    btn.append(label);

    btn.addEventListener("click", () => {
      overlay.remove();
      connectWith(w);
    });

    list.append(btn);
  }
  modal.append(list);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  modal.append(cancel);

  overlay.append(modal);
  document.body.append(overlay);
}

async function connectWith(wallet) {
  try {
    const eip1193 = wallet.provider;
    eip1193Provider = eip1193;
    provider = new ethers.BrowserProvider(eip1193, "any");
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    const net = await provider.getNetwork();
    chainId = net.chainId;

    const onMainnet = chainId === MAINNET_CHAIN_ID;
    ui.walletStatus.textContent = onMainnet ? "Connected" : "Wrong network";
    ui.walletDetail.replaceChildren();
    const walletName = wallet.info?.name;
    if (walletName && walletName !== "wallet") {
      const nameSpan = document.createElement("span");
      nameSpan.textContent = walletName + " \u00b7 ";
      ui.walletDetail.append(nameSpan);
    }
    const netSpan = document.createElement("span");
    netSpan.className = onMainnet ? "ok" : "bad";
    netSpan.textContent = onMainnet ? "Ethereum mainnet" : friendlyChainName(chainId);
    ui.walletDetail.append(netSpan, " \u00b7 " + shortAddr(account));

    // Toggle the connect button: normal "Reconnect", or a prominent "Switch to
    // Ethereum mainnet" button when the user is on the wrong chain. The single
    // click listener on the button (set at wire-up time) dispatches based on
    // this flag, so we don't stack conflicting handlers.
    if (onMainnet) {
      ui.connectBtn.textContent = "Reconnect";
      ui.connectBtn.classList.remove("warn-btn");
      connectBtnMode = "connect";
    } else {
      ui.connectBtn.textContent = "Switch to Ethereum mainnet";
      ui.connectBtn.classList.add("warn-btn");
      connectBtnMode = "switch";
    }

    // Enable the listings scanner now that we have an address + provider.
    ui.scanBtn.disabled = !onMainnet;
    ui.scanBtn.title = onMainnet ? "" : "Switch to Ethereum mainnet first";

    log(`Connected to ${walletName || "wallet"} as ${shortAddr(account)} on ${onMainnet ? "Ethereum mainnet" : friendlyChainName(chainId)}.`);
    if (!onMainnet) log("This tool only works on Ethereum mainnet. Click \u201cSwitch to Ethereum mainnet\u201d above to move your wallet over.");

    eip1193.on?.("accountsChanged", () => location.reload());
    eip1193.on?.("chainChanged",    () => location.reload());
  } catch (err) {
    log(`Connection failed: ${explainRevert(err)}`);
  }
}

// Friendly chain names for common non-mainnet chains so users see "Polygon"
// instead of "chain 137".
function friendlyChainName(id) {
  const names = {
    "1": "Ethereum mainnet",
    "10": "Optimism",
    "56": "BNB Chain",
    "137": "Polygon",
    "8453": "Base",
    "42161": "Arbitrum One",
    "43114": "Avalanche",
    "11155111": "Sepolia testnet",
    "17000": "Holesky testnet",
  };
  return names[String(id)] || ("chain " + id);
}

async function switchToMainnet() {
  if (!eip1193Provider) {
    log("Connect your wallet first.");
    return;
  }
  try {
    log("Asking your wallet to switch to Ethereum mainnet\u2026");
    await eip1193Provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x1" }],
    });
    // The chainChanged event handler will reload the page, so nothing else to do.
  } catch (err) {
    // 4001 = user rejected, 4902 = chain not added (shouldn't happen for mainnet but handle it)
    if (err?.code === 4001) {
      log("You cancelled the network switch in your wallet. (Nothing changed.)");
    } else if (err?.code === 4902) {
      log("Your wallet doesn't have Ethereum mainnet added. Open your wallet's network settings and add it manually, then reload this page.");
    } else {
      log(`Couldn't switch network: ${explainRevert(err)}`);
    }
  }
}

// --- lookup ---------------------------------------------------------------

async function lookupState() {
  try {
    const { nft, tokenId, assumedShared } = parseInputs();

    const readProvider = provider || ethers.getDefaultProvider("mainnet");
    const market = new ethers.Contract(MARKET, MARKET_ABI, readProvider);
    const nftC   = new ethers.Contract(nft,    ERC721_ABI,  readProvider);

    log(`Looking up ${shortAddr(nft)} #${tokenId}…`);

    const [auctionId, buyPrice, owner] = await Promise.all([
      market.getReserveAuctionIdFor(nft, tokenId).catch(() => 0n),
      market.getBuyPrice(nft, tokenId).catch(() => [ethers.ZeroAddress, 0n]),
      nftC.ownerOf(tokenId).catch(() => null),
    ]);

    let auction = null;
    if (auctionId > 0n) {
      try { auction = await market.getReserveAuction(auctionId); } catch {}
    }

    lastLookup = {
      nftContract: nft,
      tokenId,
      auctionId,
      buyPriceSeller: buyPrice[0],
      buyPriceWei:    buyPrice[1],
      auction,
      owner,
      assumedShared,
    };

    renderState(lastLookup);
    if (auctionId > 0n) ui.auctionId.value = auctionId.toString();
    refreshButtons();
  } catch (err) {
    log(`Lookup failed: ${explainRevert(err)}`);
  }
}

// Safe DOM helpers — no innerHTML anywhere in this file.
function el(tag, cls, ...children) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) {
    e.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function stateRow(label, value, cls) {
  const k = el("div", "k", label);
  const v = el("div", "v" + (cls ? " " + cls : ""));
  if (typeof value === "string") {
    v.textContent = value;
  } else {
    v.append(value);
  }
  return el("div", "line", k, v);
}

function renderState(s) {
  const hasAuction    = s.auctionId > 0n;
  const hasBuyPrice   = s.buyPriceSeller !== ethers.ZeroAddress;
  const auctionHasBid = hasAuction && s.auction && s.auction.endTime > 0n;

  let headlineText, headlineClass;
  if (!hasAuction && !hasBuyPrice) {
    headlineText = "This piece isn't currently listed on Foundation. There's nothing here to cancel.";
    headlineClass = "";
  } else if (hasAuction && auctionHasBid && !hasBuyPrice) {
    headlineText = "This piece is in an auction that already has a bid. It can't be cancelled until the auction ends.";
    headlineClass = "bad";
  } else if (hasBuyPrice && hasAuction) {
    headlineText = `Listed with a buy-now price of ${fmtEth(s.buyPriceWei)} ETH and an active auction. Cancel both to get the piece back.`;
    headlineClass = "ok";
  } else if (hasBuyPrice) {
    headlineText = `Listed for ${fmtEth(s.buyPriceWei)} ETH. You can remove the price to bring it home.`;
    headlineClass = "ok";
  } else {
    headlineText = "Auction is open with no bids yet \u2014 you can end it to bring the piece home.";
    headlineClass = "ok";
  }

  const headline = el("div", "headline" + (headlineClass ? " " + headlineClass : ""), headlineText);

  // Contract row — code element + optional note
  const contractVal = document.createDocumentFragment();
  const code = document.createElement("code");
  code.textContent = s.nftContract;
  contractVal.append(code);
  if (s.assumedShared) {
    const note = el("span", "muted", " (assumed shared Foundation contract \u2014 edit if wrong)");
    contractVal.append(note);
  }

  const holderText = s.owner
    ? (s.owner.toLowerCase() === MARKET.toLowerCase()
        ? "Foundation Market (escrow)"
        : shortAddr(s.owner))
    : "unknown";

  const auctionText = hasAuction
    ? (auctionHasBid
        ? `id ${s.auctionId} \u00b7 has a bid, locked`
        : `id ${s.auctionId} \u00b7 no bids, cancellable`)
    : "none";

  const buyText = hasBuyPrice
    ? `${fmtEth(s.buyPriceWei)} ETH (seller ${shortAddr(s.buyPriceSeller)})`
    : "none";

  ui.statePanel.replaceChildren(
    headline,
    stateRow("Contract", contractVal, ""),
    stateRow("Token ID", "#" + s.tokenId, ""),
    stateRow("Current holder", holderText, ""),
    stateRow("Auction", auctionText, hasAuction ? (auctionHasBid ? "bad" : "ok") : "muted"),
    stateRow("Buy-now price", buyText, hasBuyPrice ? "ok" : "muted"),
  );
  ui.statePanel.hidden = false;

  ui.auctionHint.textContent = hasAuction
    ? (auctionHasBid ? "locked \u2014 has a bid" : `auction #${s.auctionId}, ready`)
    : "no auction on this piece";
  ui.buypriceHint.textContent = hasBuyPrice
    ? `listed at ${fmtEth(s.buyPriceWei)} ETH`
    : "no buy-now price set";
}

function refreshButtons() {
  const s = lastLookup;
  if (!s) return;
  const auctionHasBid = s.auction && s.auction.endTime > 0n;
  ui.cancelAuction.disabled = !(s.auctionId > 0n) || auctionHasBid;
  ui.cancelBuy.disabled     = s.buyPriceSeller === ethers.ZeroAddress;
}

// --- listings scanner -----------------------------------------------------
// Finds every Foundation Market listing (auction or buy price) where the
// connected wallet is the seller. Queries event logs via the wallet's own RPC
// in adaptive-sized chunks, then verifies each hit is still active.

let scanInFlight = false;

async function findMyListings() {
  if (scanInFlight) return;
  if (!signer || !account) { log("Connect your wallet first."); return; }
  if (chainId !== MAINNET_CHAIN_ID) { log("Switch to Ethereum mainnet first."); return; }

  scanInFlight = true;
  ui.scanBtn.disabled = true;
  const originalLabel = ui.scanBtn.textContent;
  ui.scanBtn.textContent = "Scanning…";

  try {
    // Check cache first.
    const cacheKey = "fr-listings:" + account.toLowerCase();
    const cached = loadScanCache(cacheKey);
    if (cached) {
      renderScanResults(cached.listings, true);
      log(`Showing cached results from ${new Date(cached.when).toLocaleTimeString()}. Click again to rescan.`);
      localStorage.removeItem(cacheKey); // one-shot cache: second click always rescans
      return;
    }

    const market = new ethers.Contract(MARKET, MARKET_ABI, provider);
    const latest = BigInt(await provider.getBlockNumber());
    renderScanProgress("Starting scan…", 0);

    // Event filters: seller indexed on both, our address plugged into the seller slot.
    const buyPriceFilter = market.filters.BuyPriceSet(null, null, account);
    const auctionFilter  = market.filters.ReserveAuctionCreated(account);

    const [buyEvents, auctionEvents] = await Promise.all([
      chunkedQuery(market, buyPriceFilter, MARKET_DEPLOY_BLOCK, latest, "Scanning buy-price listings"),
      chunkedQuery(market, auctionFilter,  MARKET_DEPLOY_BLOCK, latest, "Scanning auctions"),
    ]);

    renderScanProgress("Verifying current state…", 0.9);

    // Dedupe by (contract, tokenId).
    const seen = new Map();
    for (const ev of [...buyEvents, ...auctionEvents]) {
      const nft = ev.args.nftContract;
      const tid = ev.args.tokenId.toString();
      const key = nft.toLowerCase() + "#" + tid;
      if (!seen.has(key)) seen.set(key, { nftContract: nft, tokenId: tid });
    }

    // For each unique (contract, tokenId), check if still active.
    const results = [];
    for (const entry of seen.values()) {
      const [auctionId, bp] = await Promise.all([
        market.getReserveAuctionIdFor(entry.nftContract, entry.tokenId).catch(() => 0n),
        market.getBuyPrice(entry.nftContract, entry.tokenId).catch(() => [ethers.ZeroAddress, 0n]),
      ]);
      const hasAuction  = auctionId > 0n;
      const hasBuyPrice = bp[0] !== ethers.ZeroAddress;
      if (!hasAuction && !hasBuyPrice) continue;

      let auction = null;
      if (hasAuction) {
        try { auction = await market.getReserveAuction(auctionId); } catch {}
      }
      const auctionHasBid = auction && auction.endTime > 0n;

      results.push({
        nftContract: entry.nftContract,
        tokenId: entry.tokenId,
        hasAuction,
        auctionId,
        auctionHasBid,
        hasBuyPrice,
        buyPriceWei: bp[1],
      });
    }

    saveScanCache(cacheKey, results);
    renderScanResults(results, false);
    log(`Scan complete: ${results.length} active listing(s) found.`);
  } catch (err) {
    renderScanError(explainRevert(err));
    log(`Scan failed: ${explainRevert(err)}`);
  } finally {
    scanInFlight = false;
    ui.scanBtn.disabled = chainId !== MAINNET_CHAIN_ID;
    ui.scanBtn.textContent = originalLabel;
  }
}

// Query events in adaptive-sized block chunks. Halves the range on RPC errors
// that suggest the window is too big ("too many results", "block range").
async function chunkedQuery(contract, filter, from, to, label) {
  const out = [];
  let chunk = 500000n;           // start optimistic
  const minChunk = 5000n;
  let cursor = from;

  while (cursor <= to) {
    const end = cursor + chunk > to ? to : cursor + chunk;
    const pct = Number((cursor - from) * 100n / (to - from + 1n)) / 100;
    renderScanProgress(`${label}: block ${cursor.toLocaleString()}`, pct * 0.9);
    try {
      const logs = await contract.queryFilter(filter, Number(cursor), Number(end));
      out.push(...logs);
      cursor = end + 1n;
      // Ramp back up gently if we'd previously backed off.
      if (chunk < 500000n) chunk = chunk * 2n;
    } catch (err) {
      const msg = (err?.message || "") + (err?.info?.error?.message || "");
      const looksLikeRangeError = /too many|range|limit|timeout|exceed|result window/i.test(msg);
      if (!looksLikeRangeError || chunk <= minChunk) throw err;
      chunk = chunk / 2n;
      if (chunk < minChunk) chunk = minChunk;
    }
  }
  return out;
}

function loadScanCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.when > 3600_000) return null; // 1-hour TTL
    // Re-hydrate BigInts that JSON.stringify turned into strings.
    parsed.listings = parsed.listings.map((l) => ({
      ...l,
      auctionId: BigInt(l.auctionId),
      buyPriceWei: BigInt(l.buyPriceWei),
    }));
    return parsed;
  } catch { return null; }
}

function saveScanCache(key, listings) {
  try {
    const payload = {
      when: Date.now(),
      listings: listings.map((l) => ({
        ...l,
        auctionId: l.auctionId.toString(),
        buyPriceWei: l.buyPriceWei.toString(),
      })),
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {}
}

function renderScanProgress(text, frac) {
  ui.scanPanel.replaceChildren();
  const wrap = el("div", "scan-progress");
  wrap.append(el("div", "scan-progress-label", text));
  const bar = el("div", "scan-progress-bar");
  const fill = el("div", "scan-progress-fill");
  fill.style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + "%";
  bar.append(fill);
  wrap.append(bar);
  ui.scanPanel.append(wrap);
  ui.scanPanel.hidden = false;
}

function renderScanError(msg) {
  ui.scanPanel.replaceChildren();
  ui.scanPanel.append(el("div", "scan-error", "Scan failed: " + msg));
  ui.scanPanel.hidden = false;
}

function renderScanResults(results, isCached) {
  ui.scanPanel.replaceChildren();

  const header = el("div", "scan-header");
  const h = el("strong", null, results.length === 0
    ? "No active listings found."
    : `Found ${results.length} active listing${results.length === 1 ? "" : "s"}.`);
  header.append(h);
  if (isCached) {
    header.append(el("span", "muted small", " (cached — click scan again to refresh)"));
  }
  ui.scanPanel.append(header);

  if (results.length === 0) {
    const note = el("p", "muted small",
      "This scan only covers listings created on the main Foundation Market from this wallet. " +
      "If you have pieces listed in a Foundation World (a custom collection), they won't appear here.");
    ui.scanPanel.append(note);
    ui.scanPanel.hidden = false;
    return;
  }

  const list = el("div", "scan-list");
  for (const r of results) {
    const row = el("div", "scan-item");

    const info = el("div", "scan-item-info");
    const title = el("div", "scan-item-title", `Token #${r.tokenId}`);
    info.append(title);
    const sub = el("div", "scan-item-sub");
    sub.append(r.nftContract.slice(0, 6) + "…" + r.nftContract.slice(-4));
    info.append(sub);

    const status = el("div", "scan-item-status");
    if (r.hasAuction && r.hasBuyPrice) {
      status.append(el("span", "ok", `${fmtEth(r.buyPriceWei)} ETH + auction`));
    } else if (r.hasBuyPrice) {
      status.append(el("span", "ok", `Listed for ${fmtEth(r.buyPriceWei)} ETH`));
    } else if (r.hasAuction && r.auctionHasBid) {
      status.append(el("span", "bad", "Auction (has bid, locked)"));
    } else if (r.hasAuction) {
      status.append(el("span", "ok", "Auction, no bids"));
    }
    info.append(status);

    const action = el("button", "btn scan-item-btn");
    action.type = "button";
    action.textContent = "Open";
    action.addEventListener("click", () => {
      ui.nftUrl.value = "";
      ui.nftContract.value = r.nftContract;
      ui.tokenId.value = r.tokenId;
      lookupState();
      document.getElementById("state-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    row.append(info, action);
    list.append(row);
  }
  ui.scanPanel.append(list);
  ui.scanPanel.hidden = false;
}

// --- write actions --------------------------------------------------------

async function cancelAuction() {
  try {
    requireWallet();
    const idStr = ui.auctionId.value.trim();
    if (!/^\d+$/.test(idStr)) throw new Error("Auction ID should be a whole number. Click \"Check this artwork\" and it'll fill in for you.");
    const auctionId = BigInt(idStr);
    const market = new ethers.Contract(MARKET, MARKET_ABI, signer);
    log(`Ending auction #${auctionId} — confirm the transaction in your wallet…`);
    const tx = await market.cancelReserveAuction(auctionId);
    log("Transaction submitted.", { link: txLink(tx.hash) });
    await tx.wait();
    log("✓ Auction ended. Your NFT should now be back in your wallet (unless it's also listed with a buy-now price).", { link: txLink(tx.hash) });
    await lookupState();
  } catch (err) {
    log(`Couldn't end the auction: ${explainRevert(err)}`);
  }
}

async function cancelBuyPrice() {
  try {
    requireWallet();
    const { nft, tokenId } = parseInputs();
    const market = new ethers.Contract(MARKET, MARKET_ABI, signer);
    log(`Removing buy-now price for ${shortAddr(nft)} #${tokenId} — confirm in your wallet…`);
    const tx = await market.cancelBuyPrice(nft, tokenId);
    log("Transaction submitted.", { link: txLink(tx.hash) });
    await tx.wait();
    log("✓ Price removed. Your NFT is back in your wallet (unless it's also escrowed for an auction).", { link: txLink(tx.hash) });
    await lookupState();
  } catch (err) {
    log(`Couldn't remove the price: ${explainRevert(err)}`);
  }
}

async function burnToken() {
  try {
    requireWallet();
    if (!ui.burnAck.checked) throw new Error("Tick the confirmation box first — this one's permanent.");
    const { nft, tokenId } = parseInputs();

    const readC = new ethers.Contract(nft, ERC721_ABI, provider);
    let owner = null;
    try { owner = await readC.ownerOf(tokenId); } catch {}
    if (owner && owner.toLowerCase() === MARKET.toLowerCase()) {
      throw new Error("This NFT is still held by Foundation Market (escrowed for an auction or buy price). Cancel the listing first, then burn.");
    }
    if (owner && owner.toLowerCase() !== account.toLowerCase()) {
      throw new Error(`You don't own this NFT. Current owner: ${shortAddr(owner)}. The burn function requires ownership.`);
    }

    const nftC = new ethers.Contract(nft, ERC721_ABI, signer);
    log(`Burning ${shortAddr(nft)} #${tokenId} — confirm in your wallet…`);
    const tx = await nftC.burn(tokenId);
    log("Transaction submitted.", { link: txLink(tx.hash) });
    await tx.wait();
    log("✓ Token burned. It's gone from the blockchain forever.", { link: txLink(tx.hash) });
    await lookupState();
  } catch (err) {
    log(`Couldn't burn: ${explainRevert(err)}`);
  }
}

// --- wire up --------------------------------------------------------------

// --- mobile gate ----------------------------------------------------------

function isMobile() {
  // Only check the user-agent. Screen width doesn't matter — a narrow desktop
  // browser still has full extension support, which is what we care about.
  return /Android|iPhone|iPad|iPod|Mobile|webOS/i.test(navigator.userAgent);
}

function enforceDesktop() {
  const gate = document.getElementById("mobile-gate");
  if (!gate) return;
  if (isMobile()) {
    gate.hidden = false;
    // Hide all content after the gate
    let sibling = gate.nextElementSibling;
    while (sibling) {
      sibling.style.display = "none";
      sibling = sibling.nextElementSibling;
    }
  }
}

enforceDesktop();

// --- wire up --------------------------------------------------------------

ui.connectBtn.addEventListener("click", () => {
  if (connectBtnMode === "switch") switchToMainnet();
  else connect();
});
ui.loadBtn.addEventListener("click", lookupState);
ui.scanBtn.addEventListener("click", findMyListings);
ui.cancelAuction.addEventListener("click", cancelAuction);
ui.cancelBuy.addEventListener("click", cancelBuyPrice);
ui.burnBtn.addEventListener("click", burnToken);
ui.burnAck.addEventListener("change", () => { ui.burnBtn.disabled = !ui.burnAck.checked; });

// If the user pastes a URL, try to resolve it immediately so they see progress.
ui.nftUrl.addEventListener("paste", (e) => {
  setTimeout(() => {
    const parsed = parseNftUrl(ui.nftUrl.value);
    if (parsed) {
      ui.nftContract.value = parsed.contract;
      ui.tokenId.value = parsed.tokenId;
    }
  }, 0);
});

// Pressing Enter in any of the three input fields runs the lookup.
[ui.nftUrl, ui.nftContract, ui.tokenId].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); lookupState(); }
  });
});
