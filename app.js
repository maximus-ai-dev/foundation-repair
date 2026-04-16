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
  "function getReserveAuction(uint256 auctionId) view returns (tuple(address nftContract, uint256 tokenId, address seller, uint256 duration, uint256 extensionDuration, uint256 endTime, address bidder, uint256 amount) auction)"
];

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
  statePanel:    $("state-panel"),
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

  // etherscan.io/nft/<contract>/<tokenId>
  if (host.endsWith("etherscan.io") && parts[0] === "nft" && isAddr(parts[1]) && isId(parts[2])) {
    return { contract: ethers.getAddress(parts[1]), tokenId: parts[2] };
  }
  // etherscan.io/token/<contract>?a=<tokenId>
  if (host.endsWith("etherscan.io") && parts[0] === "token" && isAddr(parts[1])) {
    const a = u.searchParams.get("a");
    if (isId(a)) return { contract: ethers.getAddress(parts[1]), tokenId: a };
  }

  // foundation.app/...
  if (host.endsWith("foundation.app")) {
    // /collections/<contract>/<tokenId>
    const iCol = parts.indexOf("collections");
    if (iCol >= 0 && isAddr(parts[iCol + 1]) && isId(parts[iCol + 2])) {
      return { contract: ethers.getAddress(parts[iCol + 1]), tokenId: parts[iCol + 2] };
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

async function connect() {
  if (!window.ethereum) {
    log("No wallet detected. Install MetaMask (metamask.io) or another browser wallet and reload this page.");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    const net = await provider.getNetwork();
    chainId = net.chainId;

    const onMainnet = chainId === MAINNET_CHAIN_ID;
    ui.walletStatus.textContent = onMainnet ? "Connected" : "Connected (wrong network)";
    ui.walletDetail.replaceChildren();
    const netSpan = document.createElement("span");
    netSpan.className = onMainnet ? "ok" : "bad";
    netSpan.textContent = onMainnet ? "Ethereum mainnet" : "chain " + chainId;
    ui.walletDetail.append(netSpan, " \u00b7 " + shortAddr(account));
    ui.connectBtn.textContent = "Reconnect";
    log(`Connected as ${shortAddr(account)} on ${onMainnet ? "Ethereum mainnet" : "chain " + chainId}.`);
    if (!onMainnet) log("⚠ Switch to Ethereum mainnet in your wallet before cancelling anything.");

    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged",    () => location.reload());
  } catch (err) {
    log(`Connection failed: ${explainRevert(err)}`);
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

ui.connectBtn.addEventListener("click", connect);
ui.loadBtn.addEventListener("click", lookupState);
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
