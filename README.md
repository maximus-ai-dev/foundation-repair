# Foundation Repair

**A free, browser-based tool to get your art off the [Foundation](https://foundation.app)
NFT marketplace before it shuts down.** Cancel auctions and fixed-price listings so
your pieces come home to your wallet — all by talking directly to Foundation's
verified smart contracts from your own wallet. No accounts, no fees to anyone but
Ethereum gas, no tracking.

> ⚠️ Foundation has announced a wind-down. The platform's UI may disappear before
> your listings expire. This tool bypasses the UI and talks to the contract directly,
> so it keeps working as long as Ethereum does.

## For artists: quick start

You need two things:

1. The **browser wallet** you used to list the piece on Foundation
   (usually [MetaMask](https://metamask.io)).
2. The **link** to the listed piece — either a `foundation.app` URL or an
   `etherscan.io/nft/…` URL.

Then:

1. Open this tool in the browser where your wallet is installed.
2. Click **Connect wallet**. The tool supports **Ethereum mainnet** and **Base**.
   If your wallet is on a different chain, a "Switch network" button will
   appear with a picker of supported chains.
3. Paste the link to your piece in the first box. Click **Check this artwork**.
4. The tool will tell you in plain English what's going on — is there an auction?
   A buy-now price? Can it be cancelled?
5. Click the right button. Approve the transaction in your wallet. Done.

**You'll pay Ethereum gas** for each cancel (typically a few dollars), but nothing
goes to the tool or to anyone else. The transaction goes straight to Foundation's
contract.

## What the tool does

| Panel | What it calls | When to use it |
| --- | --- | --- |
| End the auction | `cancelReserveAuction(uint256 auctionId)` on the Foundation Market | Your piece is in a reserve auction and **nobody has bid yet**. (Auctions with bids are locked — even this tool can't cancel them, because the contract forbids it.) |
| Remove the buy-now price | `cancelBuyPrice(address nftContract, uint256 tokenId)` on the Foundation Market | Your piece has a fixed buy-now price. Removing it brings the NFT back to your wallet. |

## Contracts it talks to

Foundation runs on multiple networks. The tool auto-detects which chain your
wallet is on and points transactions at the right contract:

### Ethereum mainnet (chain 1)

| Purpose | Address |
| --- | --- |
| Foundation Market (proxy) | [`0xcDA72070E455bb31C7690a170224Ce43623d0B6f`](https://etherscan.io/address/0xcDA72070E455bb31C7690a170224Ce43623d0B6f) |
| Foundation Market (verified implementation) | [`0xecb3ce1154af51e117d6cf9e05d6bd7f24e4a0e1`](https://sourcify.dev/#/lookup/0xecb3ce1154af51e117d6cf9e05d6bd7f24e4a0e1) |
| Shared FND ERC-721 (default NFT contract) | [`0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405`](https://etherscan.io/token/0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405) |

### Base (chain 8453)

| Purpose | Address |
| --- | --- |
| Foundation Market (proxy) | [`0x7b503e206dB34148aD77e00afE214034EDF9E3fF`](https://basescan.org/address/0x7b503e206dB34148aD77e00afE214034EDF9E3fF) |

Foundation's Base market uses the same function selectors as the L1 market —
`cancelReserveAuction(uint256)`, `cancelBuyPrice(address,uint256)`, etc. — so
the tool's ABI is chain-agnostic.

## Finding your NFT's contract + token ID (if you need to)

In almost all cases, pasting the `foundation.app` URL of your piece is enough.
If Foundation's site is down when you try this, here's the fallback method
(from [@LoveFromGaia's thread](https://x.com/LoveFromGaia/status/2044848357516939692)):

1. Open Etherscan. Paste your wallet address into the search.
2. Click the **NFT Transfers** tab, then *View all NFT transfers*.
3. Find a row labeled **Set Buy Price** (for a fixed-price listing) or
   **Create Reserve Auction** (for an auction). Click the transaction hash.
4. Open the **Logs** tab. The NFT contract address and token ID are in the log
   data. Paste the Etherscan NFT URL (`etherscan.io/nft/<contract>/<tokenId>`)
   into this tool and you're done.

## Running it

### Just use it

Download the repo, unzip it, and double-click `index.html`. That's it — there's no
build step and no server.

### Serve it locally

```bash
python -m http.server 8000
# then open http://localhost:8000
```

### Host it on GitHub Pages (free, sharable URL)

```bash
git init
git add .
git commit -m "Foundation Repair"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in your repo on GitHub: **Settings → Pages → Source: `main` branch / root**.
GitHub gives you a URL like `https://<you>.github.io/<repo>/` you can share with
other artists.

## Security

This is a wallet-connected tool — security is not optional. Here's what's in place
and why.

### No external scripts

ethers.js (v6.13.4) is **vendored** — downloaded and served from the same origin
as the page, not loaded from a CDN at runtime. If a CDN were compromised, a
tampered ethers.js could silently rewrite transactions to drain wallets. Vendoring
eliminates that vector entirely.

As a second layer, the `<script>` tag carries a
[Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
(SRI) hash. If even a single byte of the file is changed, the browser refuses to
execute it.

### No innerHTML

Every piece of DOM content is built with `document.createElement` /
`textContent` / `append`. The codebase has **zero `innerHTML` calls**. This
closes the most common XSS vector in browser dApps — a crafted input that
injects a `<script>` or event handler into the page.

### Content Security Policy (CSP)

Deployed via `vercel.json` headers:

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'none'` | Deny everything by default; each resource type is explicitly allowed below. |
| `script-src` | `'self'` | Only scripts from the same origin. No CDN, no inline scripts, no `eval`. |
| `style-src` | `'self'` | Only stylesheets from the same origin. No inline styles. |
| `connect-src` | `https:` | Allow JSON-RPC and metadata fetch calls to any HTTPS endpoint (the user's wallet determines the RPC URL; NFT metadata lives on arbitrary IPFS gateways / CDNs). Cleartext `http:`, `ws://`, and `data:` connections are blocked. |
| `img-src` / `media-src` | `'self' data: https:` | Allow preview images and videos from any HTTPS source. Needed for the NFT preview modal since artwork lives at arbitrary URLs. `<img>` / `<video>` tags cannot execute JavaScript, so this is privacy-loosening (a third-party host can see your IP when you click Preview) but not a code-execution risk. |
| `frame-src` / `frame-ancestors` | `'none'` | Prevents the page from being embedded in an iframe (clickjacking defense). |
| `object-src` | `'none'` | No Flash, Java, or other plugin content. |
| `form-action` | `'none'` | The page has no forms that submit to a server. |
| `base-uri` | `'self'` | Prevents `<base>` tag injection that could redirect relative URLs. |

### Other headers

- **`X-Frame-Options: DENY`** — iframe clickjacking defense for older browsers
  that don't support CSP `frame-ancestors`.
- **`X-Content-Type-Options: nosniff`** — prevents MIME-type confusion attacks.
- **`Referrer-Policy: strict-origin-when-cross-origin`** — outbound links (e.g. to
  Etherscan) only see the domain, not the full URL. Wallet addresses and token IDs
  in the URL never leak via the Referer header.
- **`Permissions-Policy`** — disables camera, microphone, geolocation, payment,
  USB, and Bluetooth APIs. Defense-in-depth; this page doesn't need any of them.
- **`Strict-Transport-Security` (HSTS)** — forces HTTPS for 2 years with
  `includeSubDomains` and `preload`. Prevents protocol-downgrade attacks.

### Runtime safety

- **Chain check** — the tool refuses to send any write transaction unless the wallet
  is on a supported chain (Ethereum mainnet or Base).
- **Seller-match verification** — before enabling a cancel button, the tool reads
  the current listing's seller from the Foundation contract and confirms it matches
  the connected wallet. Buttons stay disabled if not, so users never spend gas on a
  transaction that's guaranteed to revert.
- **User-approved signing only** — every transaction is surfaced in the user's wallet
  for review. The tool never constructs raw transactions or touches private keys.

### What you can verify yourself

- Read `app.js` — it's ~420 lines, single file, no build step.
- Search for `innerHTML` — there are zero uses.
- Diff `vendor/ethers-6.13.4.umd.min.js` against the
  [npm release](https://www.npmjs.com/package/ethers/v/6.13.4) to confirm it's
  unmodified.
- Check the SRI hash: `shasum -a 384 vendor/ethers-6.13.4.umd.min.js | base64`.

## Credit

The recovery method — talking to the Foundation Market contract directly — comes
from [@LoveFromGaia's 14-post thread on X](https://x.com/LoveFromGaia/status/2044848357516939692).
That thread walks you through doing it manually on Etherscan: connecting your wallet
to the contract page, then digging through your wallet's NFT-transfer history to find
each piece's contract/tokenId/auctionId by hand.

Foundation Repair automates that grunt work. You paste a link, the tool reads the
contract's view functions (`getReserveAuctionIdFor`, `getBuyPrice`) to tell you what's
listed, and one click sends the right cancel transaction from your own wallet.

## License

MIT. Fork it, host it, remix it, distribute it. The more copies of this tool exist,
the harder it is for anyone to be locked out of their art.
