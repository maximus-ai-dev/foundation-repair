// Foundation Repair — cancel your Foundation listings before the marketplace shuts down.
// Talks directly to the verified Foundation Market proxy on Ethereum mainnet and Base.
// No backend, no tracking.
//
// Verified source: https://sourcify.dev/#/lookup/0xecb3ce1154af51e117d6cf9e05d6bd7f24e4a0e1
// Market proxy:    0xcDA72070E455bb31C7690a170224Ce43623d0B6f

"use strict";

// Chain registry: every chain this tool supports has its own Foundation Market
// proxy address, a safe starting block for event scans, and an explorer URL for
// transaction links. Adding another chain (e.g. Optimism) is a one-entry
// config change — no code changes elsewhere.
const CHAINS = {
  1n: {
    name: "Ethereum mainnet",
    shortName: "Ethereum",
    hex: "0x1",
    market: "0xcDA72070E455bb31C7690a170224Ce43623d0B6f",
    deployBlock: 13500000n,
    explorer: "https://etherscan.io",
  },
  8453n: {
    name: "Base",
    shortName: "Base",
    hex: "0x2105",
    market: "0x7b503e206dB34148aD77e00afE214034EDF9E3fF",
    deployBlock: 12290626n,
    explorer: "https://basescan.org",
  },
};

function chain(id) { return CHAINS[id] || null; }
function isSupportedChain(id) { return !!chain(id); }

// Fallback used when a foundation.app URL doesn't spell out the contract.
// The shared FND contract on Ethereum mainnet is a reasonable default since
// that's where most pre-2024 Foundation pieces live.
const FND_SHARED = "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405";

const MARKET_ABI = [
  "function cancelReserveAuction(uint256 auctionId) external",
  "function cancelBuyPrice(address nftContract, uint256 tokenId) external",
  "function getReserveAuctionIdFor(address nftContract, uint256 tokenId) view returns (uint256 auctionId)",
  "function getBuyPrice(address nftContract, uint256 tokenId) view returns (address seller, uint256 price)",
  "function getReserveAuction(uint256 auctionId) view returns (tuple(address nftContract, uint256 tokenId, address seller, uint256 duration, uint256 extensionDuration, uint256 endTime, address bidder, uint256 amount) auction)",
  "event BuyPriceSet(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 price)",
  "event ReserveAuctionCreated(address indexed seller, address indexed nftContract, uint256 indexed tokenId, uint256 duration, uint256 extensionDuration, uint256 reservePrice, uint256 auctionId)",
  // Known custom errors from the Foundation Market contract. Declaring these
  // in the ABI lets ethers decode revert data into friendly names instead of
  // the generic "execution reverted (unknown custom error)".
  "error NFTMarketReserveAuction_Cannot_Update_Auction_In_Progress()",
  "error NFTMarketReserveAuction_Not_Matching_Seller(address seller)",
  "error NFTMarketBuyPrice_Cannot_Cancel_Unset_Price()",
  "error NFTMarketBuyPrice_Only_Owner_Can_Cancel_Price(address seller)",
  "error NFTMarketReserveAuction_Already_Listed(uint256 auctionId)",
  "error NFTMarketReserveAuction_Cannot_Cancel_Nonexistent_Auction()"
];

// Per-chain deploy blocks live in CHAINS[chainId].deployBlock now. Helpers
// below read from the currently-connected chain.

// Read the market address for the currently-connected chain. Falls back to
// Ethereum mainnet's market address if no wallet is connected (used by the
// read-only lookup path and for hardcoded comparisons).
function currentMarket() { return (chain(chainId) || CHAINS[1n]).market; }
function currentExplorer() { return (chain(chainId) || CHAINS[1n]).explorer; }
function currentChainName() { return (chain(chainId) || CHAINS[1n]).name; }

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)"
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
let walletCapabilities = null; // result of wallet_getCapabilities, keyed by chain id hex

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
  return { href: `${currentExplorer()}/tx/${hash}`, text: hash.slice(0, 10) + "…" };
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
  if (!isSupportedChain(chainId)) {
    const supported = Object.values(CHAINS).map((c) => c.name).join(" or ");
    throw new Error(`Wrong network (chain ${chainId}). Switch to ${supported} in your wallet.`);
  }
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
        "This auction was cancelled already, or belongs to a different wallet. If you just ran the scanner, click \u201cFind all my listings\u201d again to refresh the list.",
      "NFTMarketReserveAuction_Cannot_Cancel_Nonexistent_Auction":
        "This auction no longer exists \u2014 probably already cancelled. Click \u201cFind all my listings\u201d again to refresh.",
      "NFTMarketBuyPrice_Cannot_Cancel_Unset_Price":
        "There's no buy-now price set on this piece \u2014 probably already cancelled. Click \u201cFind all my listings\u201d again to refresh.",
      "NFTMarketBuyPrice_Only_Owner_Can_Cancel_Price":
        "Only the wallet that set the buy price can cancel it. Make sure you've connected the right wallet.",
      "NFTMarketReserveAuction_Already_Listed":
        "This piece already has an active listing on Foundation.",
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

    const supported = isSupportedChain(chainId);
    const chainInfo = chain(chainId);
    ui.walletStatus.textContent = supported ? "Connected" : "Wrong network";
    ui.walletDetail.replaceChildren();
    const walletName = wallet.info?.name;
    if (walletName && walletName !== "wallet") {
      const nameSpan = document.createElement("span");
      nameSpan.textContent = walletName + " \u00b7 ";
      ui.walletDetail.append(nameSpan);
    }
    // The chain label is also the chain-switcher. Clicking it opens the
    // picker so the user can hop between supported chains without leaving
    // this tool.
    const netSpan = document.createElement("button");
    netSpan.type = "button";
    netSpan.className = "chain-switch " + (supported ? "ok" : "bad");
    netSpan.textContent = supported ? chainInfo.name : friendlyChainName(chainId);
    netSpan.title = "Click to switch network";
    netSpan.addEventListener("click", () => {
      const otherChains = Object.values(CHAINS).filter((c) => c.hex !== chainInfo?.hex);
      if (otherChains.length === 1) {
        switchToChain(otherChains[0]);
      } else if (otherChains.length > 1) {
        showChainPicker(otherChains);
      }
    });
    ui.walletDetail.append(netSpan, " \u00b7 " + shortAddr(account));

    // Toggle the connect button: normal "Reconnect", or a prominent "Switch
    // network" button when the user is on an unsupported chain. With multiple
    // supported chains, "switch" opens a picker rather than going straight to
    // mainnet.
    if (supported) {
      ui.connectBtn.textContent = "Reconnect";
      ui.connectBtn.classList.remove("warn-btn");
      connectBtnMode = "connect";
    } else {
      ui.connectBtn.textContent = "Switch network";
      ui.connectBtn.classList.add("warn-btn");
      connectBtnMode = "switch";
    }

    // Enable the lookup + listings scanner now that we have an address +
    // provider. (Lookups deliberately don't fall back to ethers'
    // getDefaultProvider, so they're gated on the wallet.)
    ui.loadBtn.disabled = !provider;
    ui.loadBtn.title = provider ? "" : "Connect your wallet to enable this";
    ui.scanBtn.disabled = !supported;
    ui.scanBtn.title = supported ? "" : "Switch to a supported network first";

    const networkLabel = supported ? chainInfo.name : friendlyChainName(chainId);
    log(`Connected to ${walletName || "wallet"} as ${shortAddr(account)} on ${networkLabel}.`);
    if (!supported) {
      const supportedNames = Object.values(CHAINS).map((c) => c.name).join(" or ");
      log(`This tool works on ${supportedNames}. Click \u201cSwitch network\u201d above to move your wallet over.`);
    }

    eip1193.on?.("accountsChanged", () => location.reload());
    eip1193.on?.("chainChanged",    () => location.reload());

    // EIP-5792: detect whether the wallet can batch transactions. If so,
    // "Cancel all" will use one signing experience instead of N popups.
    walletCapabilities = null;
    try {
      walletCapabilities = await eip1193.request({
        method: "wallet_getCapabilities",
        params: [account],
      });
    } catch {
      // Method not supported — that's fine, we fall back to sequential signing.
    }
  } catch (err) {
    log(`Connection failed: ${explainRevert(err)}`);
  }
}

// Whether the connected wallet can batch transactions on the current chain
// via EIP-5792 (wallet_sendCalls).
function walletSupportsBatching() {
  if (!walletCapabilities || !chainId) return false;
  const cInfo = chain(chainId);
  if (!cInfo) return false;
  // Look up by either lowercase or canonical hex form.
  const caps = walletCapabilities[cInfo.hex] || walletCapabilities[cInfo.hex.toLowerCase()];
  if (!caps) return false;
  // EIP-5792 declares atomicBatch.supported. Some wallets also use
  // atomic.status === "supported" or "ready". Be permissive.
  if (caps.atomicBatch?.supported === true) return true;
  if (caps.atomic?.status && caps.atomic.status !== "unsupported") return true;
  return false;
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

// When the user is on an unsupported chain, show a picker listing every
// supported chain so they can pick one. If only one chain is supported,
// switch straight to it without a picker.
function switchToMainnet() {
  const supportedChains = Object.values(CHAINS);
  if (supportedChains.length === 1) {
    return switchToChain(supportedChains[0]);
  }
  showChainPicker(supportedChains);
}

async function switchToChain(chainInfo) {
  if (!eip1193Provider) { log("Connect your wallet first."); return; }
  try {
    log(`Asking your wallet to switch to ${chainInfo.name}\u2026`);
    await eip1193Provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainInfo.hex }],
    });
    // chainChanged event handler reloads the page.
  } catch (err) {
    if (err?.code === 4001) {
      log("You cancelled the network switch in your wallet. (Nothing changed.)");
    } else if (err?.code === 4902) {
      log(`Your wallet doesn't have ${chainInfo.name} added. Open your wallet's network settings and add it manually, then reload this page.`);
    } else {
      log(`Couldn't switch network: ${explainRevert(err)}`);
    }
  }
}

function showChainPicker(chains) {
  document.getElementById("chain-picker")?.remove();
  const overlay = el("div", "picker-overlay");
  overlay.id = "chain-picker";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = el("div", "picker-modal");
  modal.append(el("h3", null, "Switch network"));
  modal.append(el("p", "muted small", "Pick the network your stuck Foundation pieces are on."));

  const list = el("div", "picker-list");
  for (const c of chains) {
    const btn = el("button", "picker-item");
    btn.type = "button";
    btn.append(el("span", null, c.name));
    btn.addEventListener("click", () => { overlay.remove(); switchToChain(c); });
    list.append(btn);
  }
  modal.append(list);

  const cancel = el("button", "btn");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  modal.append(cancel);

  overlay.append(modal);
  document.body.append(overlay);
}

// --- lookup ---------------------------------------------------------------

async function lookupState() {
  try {
    if (!provider) {
      log("Connect your wallet first — lookups use your wallet's RPC so nothing leaves your machine through third-party services.");
      return;
    }
    const { nft, tokenId, assumedShared } = parseInputs();

    const market = new ethers.Contract(currentMarket(), MARKET_ABI, provider);
    const nftC   = new ethers.Contract(nft,    ERC721_ABI,  provider);

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

  // Does the connected wallet actually own the listing? Pieces you once listed
  // can end up with a different seller if they were sold/transferred. If so,
  // the contract won't let you cancel — tell the user plainly.
  const userLower = account?.toLowerCase() || null;
  const isAuctionSeller  = !!userLower && s.auction && s.auction.seller?.toLowerCase() === userLower;
  const isBuyPriceSeller = !!userLower && hasBuyPrice && s.buyPriceSeller.toLowerCase() === userLower;
  const isAnySeller      = isAuctionSeller || isBuyPriceSeller;
  const listedButNotBySelf = (hasAuction || hasBuyPrice) && userLower && !isAnySeller;

  let headlineText, headlineClass;
  if (!hasAuction && !hasBuyPrice) {
    headlineText = "This piece isn't currently listed on Foundation. There's nothing here to cancel.";
    headlineClass = "";
  } else if (listedButNotBySelf) {
    headlineText = "This piece is listed on Foundation, but by a different address \u2014 not the wallet you're connected with. Only the current seller can cancel.";
    headlineClass = "bad";
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
    ? (s.owner.toLowerCase() === currentMarket().toLowerCase()
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

  // Inline cancel buttons: attached directly to the state panel when the
  // connected wallet is the current seller. This replaces the old separate
  // "Bring your artwork home" section, which was confusing when empty.
  if (isAuctionSeller || isBuyPriceSeller) {
    const actions = el("div", "state-actions");
    if (isAuctionSeller && !auctionHasBid) {
      const btn = el("button", "btn warn-btn");
      btn.type = "button";
      btn.textContent = "End auction & return NFT";
      btn.addEventListener("click", () => statePanelCancelAuction(s, btn));
      actions.append(btn);
    }
    if (isBuyPriceSeller) {
      const btn = el("button", "btn warn-btn");
      btn.type = "button";
      btn.textContent = "Remove price & return NFT";
      btn.addEventListener("click", () => statePanelCancelBuyPrice(s, btn));
      actions.append(btn);
    }
    ui.statePanel.append(actions);
  }

  ui.statePanel.hidden = false;
}

async function statePanelCancelAuction(s, btn) {
  if (!signer) { log("Connect your wallet first."); return; }
  if (!isSupportedChain(chainId)) { log("Switch to a supported network first."); return; }
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Confirm in your wallet\u2026";
  try {
    const market = new ethers.Contract(currentMarket(), MARKET_ABI, signer);
    log(`Ending auction for token #${s.tokenId} \u2014 confirm in your wallet\u2026`);
    const tx = await market.cancelReserveAuction(s.auctionId);
    btn.textContent = "Mining\u2026";
    log("Transaction submitted.", { link: txLink(tx.hash) });
    await tx.wait();
    log("\u2713 Auction ended.", { link: txLink(tx.hash) });
    await lookupState(); // refresh the state panel
  } catch (err) {
    log(`Couldn't end the auction: ${explainRevert(err)}`);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function statePanelCancelBuyPrice(s, btn) {
  if (!signer) { log("Connect your wallet first."); return; }
  if (!isSupportedChain(chainId)) { log("Switch to a supported network first."); return; }
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Confirm in your wallet\u2026";
  try {
    const market = new ethers.Contract(currentMarket(), MARKET_ABI, signer);
    log(`Removing buy-now price for token #${s.tokenId} \u2014 confirm in your wallet\u2026`);
    const tx = await market.cancelBuyPrice(s.nftContract, s.tokenId);
    btn.textContent = "Mining\u2026";
    log("Transaction submitted.", { link: txLink(tx.hash) });
    await tx.wait();
    log("\u2713 Price removed.", { link: txLink(tx.hash) });
    await lookupState();
  } catch (err) {
    log(`Couldn't remove the price: ${explainRevert(err)}`);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// --- listings scanner -----------------------------------------------------
// Finds every Foundation Market listing (auction or buy price) where the
// connected wallet is the seller. Queries event logs via the wallet's own RPC
// in adaptive-sized chunks, then verifies each hit is still active.

let scanInFlight = false;

async function findMyListings() {
  if (scanInFlight) return;
  if (!signer || !account) { log("Connect your wallet first."); return; }
  if (!isSupportedChain(chainId)) { log("Switch to a supported network first."); return; }

  scanInFlight = true;
  ui.scanBtn.disabled = true;
  const originalLabel = ui.scanBtn.textContent;
  ui.scanBtn.textContent = "Scanning…";

  try {
    const market = new ethers.Contract(currentMarket(), MARKET_ABI, provider);
    const latest = BigInt(await provider.getBlockNumber());
    renderScanProgress("Starting scan…", 0);

    // Event filters: seller indexed on both, our address plugged into the seller slot.
    const buyPriceFilter = market.filters.BuyPriceSet(null, null, account);
    const auctionFilter  = market.filters.ReserveAuctionCreated(account);

    const [buyEvents, auctionEvents] = await Promise.all([
      chunkedQuery(market, buyPriceFilter, chain(chainId).deployBlock, latest, "Scanning buy-price listings"),
      chunkedQuery(market, auctionFilter,  chain(chainId).deployBlock, latest, "Scanning auctions"),
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

    // For each unique (contract, tokenId), check if still active AND that the
    // current seller is the connected user. A piece you once listed may have
    // been sold or transferred and relisted by someone else — historical events
    // catch those, but the contract won't let you cancel them.
    const userLower = account.toLowerCase();
    const results = [];
    for (const entry of seen.values()) {
      const [auctionId, bp] = await Promise.all([
        market.getReserveAuctionIdFor(entry.nftContract, entry.tokenId).catch(() => 0n),
        market.getBuyPrice(entry.nftContract, entry.tokenId).catch(() => [ethers.ZeroAddress, 0n]),
      ]);

      // Buy price must exist AND belong to the current user.
      const hasBuyPrice = bp[0] !== ethers.ZeroAddress && bp[0].toLowerCase() === userLower;

      // Auction must exist AND belong to the current user.
      let auction = null;
      let hasAuction = auctionId > 0n;
      if (hasAuction) {
        try { auction = await market.getReserveAuction(auctionId); } catch {}
        if (!auction || auction.seller.toLowerCase() !== userLower) {
          hasAuction = false;
          auction = null;
        }
      }

      if (!hasAuction && !hasBuyPrice) continue;
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

    renderScanResults(results);
    log(`Scan complete: ${results.length} active listing(s) found.`);
  } catch (err) {
    renderScanError(explainRevert(err));
    log(`Scan failed: ${explainRevert(err)}`);
  } finally {
    scanInFlight = false;
    ui.scanBtn.disabled = !isSupportedChain(chainId);
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

// --- metadata preview ----------------------------------------------------
// Resolve an ipfs:// or ar:// URI to a usable HTTPS URL. For IPFS we produce
// an ordered list of public gateways so callers can try fallbacks — ipfs.io
// is frequently rate-limited, and no single gateway is reliable enough on
// its own.
// Ordered by reliability. Cloudflare's public IPFS gateway was deprecated in
// 2024 and is out. ipfs.io and dweb.link are the most reliable free options
// as of writing; the rest are fallbacks. If the primary fails, buildMediaElement
// rotates through them on <img>/<video> error events.
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://4everland.io/ipfs/",
];

function ipfsPath(uri) {
  // Accepts ipfs://<cid>/<path>, ipfs://ipfs/<cid>/<path>, or just <cid>/<path>.
  if (uri.startsWith("ipfs://")) return uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  return uri;
}

// Return a list of candidate HTTPS URLs for a given URI, in order of
// preference. For ipfs:// that's one entry per gateway; for ar:// or direct
// HTTPS it's a single-element list.
function candidateUrls(uri) {
  if (!uri) return [];
  if (uri.startsWith("ipfs://")) {
    const path = ipfsPath(uri);
    return IPFS_GATEWAYS.map((g) => g + path);
  }
  if (uri.startsWith("ar://")) {
    return ["https://arweave.net/" + uri.slice("ar://".length)];
  }
  if (uri.startsWith("data:") || uri.startsWith("https:")) {
    return [uri];
  }
  return []; // cleartext http or unknown scheme — blocked by CSP, skip
}

// Single-URL resolver used for the modal's primary image src. First gateway
// is the default; <img onerror> rotates through the rest if the first fails.
function resolveMediaUri(uri) {
  const cands = candidateUrls(uri);
  return cands[0] || null;
}

// In-memory cache so the same (contract, tokenId) doesn't get re-fetched
// when the user opens preview after the row has already resolved metadata.
const metaCache = new Map();

// Concatenate Uint8Array chunks into a single Uint8Array. Used by the bounded
// metadata fetcher so we can decode a streamed body without exceeding the size cap.
function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function fetchMetadata(nftContract, tokenId) {
  const key = nftContract.toLowerCase() + "#" + tokenId;
  if (metaCache.has(key)) return metaCache.get(key);

  // Require a connected wallet. We deliberately don't fall back to ethers'
  // default provider, which would silently fan out RPC calls to third-party
  // services (Etherscan, Ankr, Cloudflare) without the user's consent.
  if (!provider) throw new Error("Connect your wallet first.");
  const c = new ethers.Contract(nftContract, ERC721_ABI, provider);
  const tokenURI = await c.tokenURI(tokenId);

  let jsonText = null;
  const cands = candidateUrls(tokenURI);
  if (cands.length === 0) throw new Error("Metadata URI uses a scheme we don't resolve (not ipfs/ar/https).");

  if (cands[0].startsWith("data:")) {
    const comma = cands[0].indexOf(",");
    if (comma < 0) throw new Error("Malformed data URI.");
    const payload = cands[0].slice(comma + 1);
    jsonText = cands[0].slice(5, comma).includes("base64") ? atob(payload) : decodeURIComponent(payload);
  } else {
    // Try each gateway in turn until one succeeds. Each fetch is hard-bounded:
    // 10s timeout via AbortController, and 1 MB max body so a hostile metadata
    // host can't stream gigabytes and OOM the tab. Real NFT metadata is
    // typically <5 KB; 1 MB is comfortably above any legitimate ceiling.
    const FETCH_TIMEOUT_MS = 10_000;
    const MAX_BYTES = 1_048_576;
    let lastErr = null;
    for (const url of cands) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(url, { mode: "cors", signal: ctrl.signal });
        if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status} from ${url}`); continue; }
        // Stream the body so we can stop early if it exceeds MAX_BYTES.
        const reader = resp.body?.getReader();
        if (!reader) { lastErr = new Error("Response had no body"); continue; }
        const chunks = [];
        let received = 0;
        let truncated = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > MAX_BYTES) {
            ctrl.abort();
            truncated = true;
            break;
          }
          chunks.push(value);
        }
        if (truncated) { lastErr = new Error("Metadata response too large"); continue; }
        jsonText = new TextDecoder().decode(concatChunks(chunks));
        break;
      } catch (e) {
        if (e?.name === "AbortError") {
          lastErr = new Error(`Metadata fetch timed out at ${url}`);
        } else {
          lastErr = e;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    if (jsonText === null) throw lastErr || new Error("All gateways failed.");
  }

  let meta;
  try { meta = JSON.parse(jsonText); }
  catch { throw new Error("Metadata is not valid JSON."); }

  const result = {
    name: typeof meta.name === "string" ? meta.name : null,
    description: typeof meta.description === "string" ? meta.description : null,
    imageUri: meta.image || meta.image_url || null,         // raw, for gateway rotation
    animationUri: meta.animation_url || null,
    image: resolveMediaUri(meta.image) || resolveMediaUri(meta.image_url),
    animation: resolveMediaUri(meta.animation_url),
  };
  metaCache.set(key, result);
  return result;
}

// Build an <img> or <video> element that rotates through IPFS gateway
// candidates on error, so a single slow/rate-limited gateway doesn't break
// the preview.
function buildMediaElement(uri, altText, isVideo) {
  const cands = candidateUrls(uri);
  if (cands.length === 0) return null;

  let idx = 0;
  const node = document.createElement(isVideo ? "video" : "img");
  node.className = "preview-media";
  if (isVideo) {
    node.controls = true;
    node.autoplay = false;
    node.loop = true;
    node.muted = true;
  } else {
    node.alt = altText || "";
    node.loading = "lazy";
  }
  node.src = cands[idx];
  node.addEventListener("error", () => {
    idx += 1;
    if (idx < cands.length) {
      node.src = cands[idx];
      return;
    }
    // All gateways failed — show a fallback message. Only render a clickable
    // "open" link if the URL is from one of OUR known IPFS / Arweave gateways.
    // We never want to send users from this page to an arbitrary metadata-
    // supplied HTTPS URL (phishing vector).
    const fallback = el("div", "preview-fallback");
    fallback.append(el("p", "warn small", "Couldn't load the media from any gateway. The file may be offline or the host may be blocking us."));
    const lastCand = cands[cands.length - 1];
    const isKnownGateway =
      IPFS_GATEWAYS.some((g) => lastCand.startsWith(g)) ||
      lastCand.startsWith("https://arweave.net/");
    if (isKnownGateway) {
      const direct = document.createElement("a");
      direct.href = lastCand;
      direct.target = "_blank";
      direct.rel = "noopener noreferrer";
      direct.textContent = "Open the media URL in a new tab";
      fallback.append(direct);
    }
    node.replaceWith(fallback);
  });
  return node;
}

// Fetch metadata asynchronously and replace the "Token #N" placeholder with
// the artwork's real title. Caches failures (sets hasNoName) so we don't
// retry hopeless lookups on every row rebuild. Never throws — failure is
// silent, the placeholder just stays.
async function lazyFillName(r, nameSpan) {
  try {
    const meta = await fetchMetadata(r.nftContract, r.tokenId);
    if (meta.name) {
      nameSpan.textContent = meta.name;
      nameSpan.title = `Token #${r.tokenId}`;
    }
  } catch {
    // Leave "Token #N" as-is.
  }
}

function buildPreviewLink(r) {
  const a = document.createElement("a");
  a.href = "#";
  a.className = "preview-link small";
  a.textContent = "preview";
  a.title = "Show image / video";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    openPreviewModal(r.nftContract, r.tokenId);
  });
  return a;
}

async function openPreviewModal(nftContract, tokenId) {
  // Remove any existing preview modal.
  document.getElementById("preview-modal")?.remove();

  const overlay = el("div", "picker-overlay");
  overlay.id = "preview-modal";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = el("div", "picker-modal preview-modal");

  const closeBtn = el("button", "btn small preview-close");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => overlay.remove());
  modal.append(closeBtn);

  const status = el("p", "muted small preview-status", "Loading metadata\u2026");
  modal.append(status);
  overlay.append(modal);
  document.body.append(overlay);

  try {
    const meta = await fetchMetadata(nftContract, tokenId);
    modal.removeChild(status);

    if (meta.name) {
      const title = el("h3", null, meta.name);
      modal.insertBefore(title, closeBtn.nextSibling);
    }

    // Prefer animation_url (videos/gifs-as-mp4), fall back to image. Use raw
    // URIs so buildMediaElement can rotate through IPFS gateways on failure.
    const mediaUri = meta.animationUri || meta.imageUri;
    if (mediaUri) {
      const lower = (mediaUri || "").toLowerCase();
      const isVideo = !!meta.animationUri && (
        lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov") || lower.includes("video")
      );
      const node = buildMediaElement(mediaUri, meta.name || `Token #${tokenId}`, isVideo);
      if (node) modal.append(node);
      else modal.append(el("p", "muted small", "Media URL couldn't be resolved."));
    } else {
      modal.append(el("p", "muted small", "No image or media in the metadata."));
    }

    if (meta.description) {
      modal.append(el("p", "preview-desc", meta.description));
    }

    modal.append(el("p", "muted small",
      `${nftContract.slice(0, 6)}…${nftContract.slice(-4)} \u00b7 #${tokenId}`));
  } catch (err) {
    status.textContent = "Couldn't load preview: " + (err.message || String(err));
    status.classList.remove("muted");
    status.classList.add("warn");
  }
}

function highlightButton(btn) {
  if (!btn) return;
  btn.classList.add("pulse");
  // Remove after animation completes so repeat clicks retrigger it.
  setTimeout(() => btn.classList.remove("pulse"), 2400);
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

function renderScanResults(results) {
  ui.scanPanel.replaceChildren();

  const header = el("div", "scan-header");
  const h = el("strong", null, results.length === 0
    ? "No active listings found."
    : `Found ${results.length} active listing${results.length === 1 ? "" : "s"}.`);
  header.append(h);
  ui.scanPanel.append(header);

  if (results.length === 0) {
    const note = el("p", "muted small",
      "This scan only covers listings created on the main Foundation Market from this wallet. " +
      "If you have pieces listed in a Foundation World (a custom collection), they won't appear here.");
    ui.scanPanel.append(note);
    ui.scanPanel.hidden = false;
    return;
  }

  const help = el("p", "muted small",
    "Each listing below can be cancelled right here \u2014 no need to scroll. Click the button, approve in your wallet, and the piece comes back to you.");
  ui.scanPanel.append(help);

  // Count cancellable actions (skipping locked auctions). If there are more
  // than one, offer a one-click "Cancel all" that queues each cancel
  // sequentially. Each is still a separate transaction the user signs in
  // their wallet \u2014 there's no contract-level multicall on Foundation's side.
  const totalActions = results.reduce((n, r) => {
    let count = 0;
    if (r.hasAuction && !r.auctionHasBid) count++;
    if (r.hasBuyPrice) count++;
    return n + count;
  }, 0);

  if (totalActions >= 2) {
    ui.scanPanel.append(buildBatchBar(totalActions));
  }

  const list = el("div", "scan-list");
  for (const r of results) {
    list.append(buildScanRow(r));
  }
  ui.scanPanel.append(list);
  ui.scanPanel.hidden = false;
}

// Build the batch-cancel control: label, batch-size input, and the action
// button. Label & button text adapt to whether the wallet supports EIP-5792
// (one signing experience) or only sequential signing (N popups).
function buildBatchBar(totalActions) {
  const bar = el("div", "scan-batch-bar");
  const batched = walletSupportsBatching();

  const note = el("span", "muted small");
  if (batched) {
    note.textContent = "Your wallet supports batched signing \u2014 you'll approve all of them in one wallet interaction.";
  } else {
    note.textContent = "Your wallet doesn't support batched signing on this chain, so you'll see a wallet popup per cancel. Reject any popup to stop the rest.";
  }

  const sizeLabel = el("label", "batch-size-label");
  sizeLabel.append(el("span", "muted small", "How many?"));
  const sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.id = "batch-size-input";
  sizeInput.min = "1";
  sizeInput.max = String(totalActions);
  sizeInput.value = String(totalActions);
  sizeInput.inputMode = "numeric";
  sizeLabel.append(sizeInput);

  const btn = el("button", "btn primary");
  btn.type = "button";
  btn.id = "batch-cancel-btn";

  const updateLabel = () => {
    const n = Math.min(Math.max(1, parseInt(sizeInput.value, 10) || totalActions), totalActions);
    btn.textContent = batched
      ? `Cancel ${n} \u00b7 1 signature`
      : `Cancel ${n} \u00b7 ${n} signature${n === 1 ? "" : "s"}`;
  };
  updateLabel();
  sizeInput.addEventListener("input", updateLabel);

  btn.addEventListener("click", () => {
    const n = Math.min(Math.max(1, parseInt(sizeInput.value, 10) || totalActions), totalActions);
    cancelBatch(n);
  });

  bar.append(btn, sizeLabel, note);
  return bar;
}

// Walks visible scan rows, queues up to `limit` cancellable actions, and
// processes them. Uses EIP-5792 wallet_sendCalls for one signing experience
// when the wallet supports it; otherwise falls back to sequential signing.
let batchInFlight = false;
async function cancelBatch(limit) {
  if (batchInFlight) return;
  batchInFlight = true;
  const btn = document.getElementById("batch-cancel-btn");
  const input = document.getElementById("batch-size-input");
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;

  // Collect cancellable actions from visible rows, capped at `limit`.
  const queue = [];
  for (const rowEl of ui.scanPanel.querySelectorAll(".scan-item:not(.done)")) {
    const r = rowEl.__rowData;
    if (!r) continue;
    if (r.hasAuction && !r.auctionHasBid) queue.push({ rowEl, r, kind: "auction" });
    if (r.hasBuyPrice) queue.push({ rowEl, r, kind: "buyprice" });
    if (queue.length >= limit) break;
  }

  if (queue.length === 0) {
    log("Nothing left to cancel.");
    batchInFlight = false;
    if (btn) btn.disabled = false;
    if (input) input.disabled = false;
    return;
  }

  try {
    if (walletSupportsBatching()) {
      await runBatchedSendCalls(queue, btn);
    } else {
      await runSequentialBatch(queue, btn);
    }
  } finally {
    batchInFlight = false;
    if (input) input.disabled = false;
    // Recompute remaining count and refresh the button label.
    const remaining = countRemainingActions();
    if (btn) {
      btn.disabled = false;
      if (remaining <= 0) {
        btn.parentElement?.remove();
      } else {
        const evt = new Event("input");
        if (input) {
          input.max = String(remaining);
          if (parseInt(input.value, 10) > remaining) input.value = String(remaining);
          input.dispatchEvent(evt);
        }
      }
    }
  }
}

function countRemainingActions() {
  let n = 0;
  for (const rowEl of ui.scanPanel.querySelectorAll(".scan-item:not(.done)")) {
    const r = rowEl.__rowData;
    if (!r) continue;
    if (r.hasAuction && !r.auctionHasBid) n++;
    if (r.hasBuyPrice) n++;
  }
  return n;
}

// EIP-5792 path: encode every cancel as raw call data, send via
// wallet_sendCalls, poll wallet_getCallsStatus until confirmed.
async function runBatchedSendCalls(queue, btn) {
  const cInfo = chain(chainId);
  const iface = new ethers.Interface(MARKET_ABI);
  const calls = queue.map(({ r, kind }) => {
    if (kind === "auction") {
      return {
        to: cInfo.market,
        data: iface.encodeFunctionData("cancelReserveAuction", [r.auctionId]),
        value: "0x0",
      };
    }
    return {
      to: cInfo.market,
      data: iface.encodeFunctionData("cancelBuyPrice", [r.nftContract, r.tokenId]),
      value: "0x0",
    };
  });

  for (const item of queue) setRowBusy(item.rowEl, "Awaiting batch signature\u2026");
  if (btn) btn.textContent = `Sign ${queue.length} cancel${queue.length === 1 ? "" : "s"} in your wallet\u2026`;
  log(`Submitting batch of ${queue.length} cancel(s) for one wallet signature\u2026`);

  let result;
  try {
    result = await eip1193Provider.request({
      method: "wallet_sendCalls",
      params: [{
        version: "1.0",
        chainId: cInfo.hex,
        from: account,
        calls,
      }],
    });
  } catch (err) {
    for (const item of queue) clearRowBusy(item.rowEl);
    if (err?.code === 4001 || err?.code === "ACTION_REJECTED") {
      log("You cancelled the batch in your wallet. Nothing was submitted.");
    } else {
      log(`Batch failed: ${explainRevert(err)}`);
    }
    return;
  }

  // result is either a string id or { id: string } depending on wallet impl.
  const callsId = typeof result === "string" ? result : (result?.id || result?.callsId);
  if (!callsId) {
    log("Wallet returned an unexpected response from wallet_sendCalls. Falling back to sequential.");
    return runSequentialBatch(queue, btn);
  }

  if (btn) btn.textContent = `Mining\u2026 (${queue.length} call${queue.length === 1 ? "" : "s"})`;
  for (const item of queue) setRowBusy(item.rowEl, "Mining\u2026 waiting for confirmation");

  // Poll for confirmation.
  let final = null;
  for (let i = 0; i < 90; i++) {  // ~3 minutes max
    await new Promise((r) => setTimeout(r, 2000));
    let status;
    try {
      status = await eip1193Provider.request({
        method: "wallet_getCallsStatus",
        params: [callsId],
      });
    } catch (err) {
      log(`Couldn't check batch status: ${explainRevert(err)}`);
      break;
    }
    const code = status?.status;
    // Both string ("CONFIRMED") and numeric (200) status formats exist.
    if (code === "CONFIRMED" || code === 200) { final = status; break; }
    if (code === "FAILED" || code === 400 || code === 500) {
      log(`Batch reported failure status: ${code}`);
      final = status;
      break;
    }
  }

  // Re-render every row from on-chain state so the UI catches up regardless
  // of how the wallet reported individual receipts.
  for (const item of queue) await rerenderRowAfterCancel(item.r, item.rowEl);

  const succeeded = ui.scanPanel.querySelectorAll(".scan-item.done").length;
  log(`Batch complete: ${succeeded} cancellation(s) reflected on-chain.`);
}

// Sequential path: pop a wallet popup per cancel.
async function runSequentialBatch(queue, btn) {
  log(`Starting batch cancel: ${queue.length} transaction${queue.length === 1 ? "" : "s"}. You'll see a wallet popup for each.`);
  let done = 0;
  let stopped = false;
  for (let i = 0; i < queue.length; i++) {
    const { rowEl, r, kind } = queue[i];
    if (btn) btn.textContent = `Cancelling ${i + 1} of ${queue.length}\u2026`;
    const result = kind === "auction"
      ? await rowCancelAuction(r, rowEl, null)
      : await rowCancelBuyPrice(r, rowEl, null);
    if (result?.ok) {
      done++;
    } else if (result?.rejected) {
      log(`You rejected the wallet popup. Stopping batch \u2014 ${done} of ${queue.length} cancelled.`);
      stopped = true;
      break;
    } else {
      log(`Skipping row ${i + 1} of ${queue.length} due to error. Continuing with the rest.`);
    }
  }
  if (!stopped) log(`Batch complete: ${done} of ${queue.length} cancelled.`);
}

function buildScanRow(r) {
  const row = el("div", "scan-item");
  // Attach the row data so batch-cancel can iterate without re-parsing.
  row.__rowData = r;

  const info = el("div", "scan-item-info");
  const titleLine = el("div", "scan-item-title");
  const nameSpan = el("span", "scan-item-name", `Token #${r.tokenId}`);
  titleLine.append(nameSpan, " ", buildPreviewLink(r));
  info.append(titleLine);
  info.append(el("div", "scan-item-sub", r.nftContract.slice(0, 6) + "…" + r.nftContract.slice(-4)));
  // Lazy-load the artwork name from metadata so the user sees the piece's
  // real title, not just the token number.
  lazyFillName(r, nameSpan);

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

  const actions = el("div", "scan-item-actions");

  // One button per cancellable listing. If a piece has both an auction and a
  // buy price, both buttons appear — each click is its own transaction.
  if (r.hasAuction) {
    const btn = el("button", "btn scan-item-btn");
    btn.type = "button";
    if (r.auctionHasBid) {
      btn.textContent = "Locked (has bid)";
      btn.disabled = true;
    } else {
      btn.textContent = "End auction";
      btn.addEventListener("click", () => rowCancelAuction(r, row, btn));
    }
    actions.append(btn);
  }

  if (r.hasBuyPrice) {
    const btn = el("button", "btn scan-item-btn");
    btn.type = "button";
    btn.textContent = "Remove price";
    btn.addEventListener("click", () => rowCancelBuyPrice(r, row, btn));
    actions.append(btn);
  }

  row.append(info, actions);
  return row;
}

// Inline per-row cancellation — runs the contract call directly without
// routing through step 2. Makes bulk cleanup practical for artists with
// many listings.

// Returns { ok: true } on success, { ok: false, rejected: true } if the user
// rejected the wallet popup, { ok: false } for any other error. Lets the
// batch-cancel loop decide whether to keep going.
async function rowCancelAuction(r, rowEl, btn) {
  if (!signer) { log("Connect your wallet first."); return { ok: false }; }
  if (!isSupportedChain(chainId)) { log("Switch to a supported network first."); return { ok: false }; }

  setRowBusy(rowEl, "Confirm in your wallet\u2026");
  try {
    const market = new ethers.Contract(currentMarket(), MARKET_ABI, signer);
    log(`Ending auction for token #${r.tokenId} \u2014 confirm in your wallet\u2026`);
    const tx = await market.cancelReserveAuction(r.auctionId);
    setRowBusy(rowEl, "Mining\u2026 waiting for confirmation");
    log("Transaction submitted.", { link: txLink(tx.hash) });
    await tx.wait();
    log("\u2713 Auction ended.", { link: txLink(tx.hash) });
    await rerenderRowAfterCancel(r, rowEl);
    return { ok: true };
  } catch (err) {
    log(`Couldn't end the auction: ${explainRevert(err)}`);
    clearRowBusy(rowEl);
    return { ok: false, rejected: err?.code === "ACTION_REJECTED" };
  }
}

async function rowCancelBuyPrice(r, rowEl, btn) {
  if (!signer) { log("Connect your wallet first."); return { ok: false }; }
  if (!isSupportedChain(chainId)) { log("Switch to a supported network first."); return { ok: false }; }

  setRowBusy(rowEl, "Confirm in your wallet\u2026");
  try {
    const market = new ethers.Contract(currentMarket(), MARKET_ABI, signer);
    log(`Removing buy-now price for token #${r.tokenId} \u2014 confirm in your wallet\u2026`);
    const tx = await market.cancelBuyPrice(r.nftContract, r.tokenId);
    setRowBusy(rowEl, "Mining\u2026 waiting for confirmation");
    log("Transaction submitted.", { link: txLink(tx.hash) });
    await tx.wait();
    log("\u2713 Price removed.", { link: txLink(tx.hash) });
    await rerenderRowAfterCancel(r, rowEl);
    return { ok: true };
  } catch (err) {
    log(`Couldn't remove the price: ${explainRevert(err)}`);
    clearRowBusy(rowEl);
    return { ok: false, rejected: err?.code === "ACTION_REJECTED" };
  }
}

// Row shown when a piece has been successfully cancelled and returned to the
// wallet.
function buildDoneRow(r) {
  const row = el("div", "scan-item done");

  const info = el("div", "scan-item-info");
  const titleLine = el("div", "scan-item-title");
  const nameSpan = el("span", "scan-item-name", `Token #${r.tokenId}`);
  titleLine.append(nameSpan, " ", buildPreviewLink(r));
  info.append(titleLine);
  info.append(el("div", "scan-item-sub", r.nftContract.slice(0, 6) + "…" + r.nftContract.slice(-4)));
  info.append(el("div", "scan-item-status", el("span", "ok", "\u2713 Back in your wallet")));
  row.append(info);
  lazyFillName(r, nameSpan);
  return row;
}

function setRowBusy(rowEl, text) {
  rowEl.classList.add("busy");
  // Disable all buttons in the row while a tx is in flight.
  rowEl.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  // Show a status chip next to the title.
  let chip = rowEl.querySelector(".scan-item-chip");
  if (!chip) {
    chip = el("span", "scan-item-chip");
    rowEl.querySelector(".scan-item-title")?.append(" ", chip);
  }
  chip.textContent = text;
}

function clearRowBusy(rowEl) {
  rowEl.classList.remove("busy");
  rowEl.querySelectorAll("button").forEach((b) => { if (!b.dataset.permanent) b.disabled = false; });
  rowEl.querySelector(".scan-item-chip")?.remove();
}

// Re-check the piece's listing state and re-render the row. If nothing is
// left to cancel, mark the row done. Otherwise show what remains.
async function rerenderRowAfterCancel(r, rowEl) {
  try {
    const market = new ethers.Contract(currentMarket(), MARKET_ABI, provider);
    const [auctionId, bp] = await Promise.all([
      market.getReserveAuctionIdFor(r.nftContract, r.tokenId).catch(() => 0n),
      market.getBuyPrice(r.nftContract, r.tokenId).catch(() => [ethers.ZeroAddress, 0n]),
    ]);
    const userLower = account.toLowerCase();
    const hasBuyPrice = bp[0] !== ethers.ZeroAddress && bp[0].toLowerCase() === userLower;
    let hasAuction = auctionId > 0n;
    let auction = null;
    if (hasAuction) {
      try { auction = await market.getReserveAuction(auctionId); } catch {}
      if (!auction || auction.seller.toLowerCase() !== userLower) {
        hasAuction = false; auction = null;
      }
    }

    if (!hasAuction && !hasBuyPrice) {
      // All done for this piece. Replace the row with a "back in wallet" marker.
      const doneRow = buildDoneRow(r);
      rowEl.replaceWith(doneRow);
    } else {
      // Piece still has one listing left (e.g., auction cancelled, buy price remains).
      // Rebuild with updated state.
      const updated = {
        ...r,
        hasAuction,
        auctionId,
        auctionHasBid: auction && auction.endTime > 0n,
        hasBuyPrice,
        buyPriceWei: bp[1],
      };
      const newRow = buildScanRow(updated);
      rowEl.replaceWith(newRow);
    }
  } catch (err) {
    log(`Couldn't refresh row state: ${explainRevert(err)}`);
    clearRowBusy(rowEl);
  }
}

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
