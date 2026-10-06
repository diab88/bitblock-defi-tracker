// Browser-wallet connectors. Read-only: we request the public address and, for EVM,
// the native balance. Nothing is ever signed or sent.

// EIP-6963 lets several injected wallets coexist (MetaMask and Phantom both inject EVM providers).
const announced = new Map();
window.addEventListener('eip6963:announceProvider', (e) => announced.set(e.detail.info.rdns, e.detail));
window.dispatchEvent(new Event('eip6963:requestProvider'));

function metamaskProvider() {
  if (announced.has('io.metamask')) return announced.get('io.metamask').provider;
  const eth = window.ethereum;
  if (!eth) return null;
  const list = eth.providers?.length ? eth.providers : [eth];
  return list.find((p) => p.isMetaMask && !p.isPhantom && !p.isBraveWallet) || null;
}
function phantomEvmProvider() {
  return announced.get('app.phantom')?.provider || (window.phantom?.ethereum?.isPhantom ? window.phantom.ethereum : null);
}
// Trust Wallet's browser extension injects an EVM provider (announced over EIP-6963, or as window.trustwallet).
function trustWalletProvider() {
  if (announced.has('com.trustwallet.app')) return announced.get('com.trustwallet.app').provider;
  const t = window.trustwallet?.ethereum || window.trustwallet;
  if (t?.request) return t;
  const eth = window.ethereum;
  const list = eth?.providers?.length ? eth.providers : eth ? [eth] : [];
  return list.find((p) => p.isTrust || p.isTrustWallet) || null;
}
function phantomSolanaProvider() {
  const p = window.phantom?.solana || window.solana;
  return p?.isPhantom ? p : null;
}

export function walletSupport() {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return { metamask: !!metamaskProvider(), phantomSolana: !!phantomSolanaProvider(), phantomEvm: !!phantomEvmProvider(), trust: !!trustWalletProvider() };
}

async function requestEvmAccount(provider, name) {
  if (!provider) throw new Error(`${name} is not installed in this browser.`);
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw new Error(`${name} returned no account.`);
  return accounts[0];
}

export const connectMetaMask = () => requestEvmAccount(metamaskProvider(), 'MetaMask');
export const connectTrustWallet = () => requestEvmAccount(trustWalletProvider(), 'Trust Wallet');
export const connectPhantomEvm = () => requestEvmAccount(phantomEvmProvider(), 'Phantom (EVM)');

export async function connectPhantomSolana() {
  const p = phantomSolanaProvider();
  if (!p) throw new Error('Phantom is not installed in this browser.');
  const resp = await p.connect();
  return resp.publicKey.toString();
}

const CHAIN_NAMES = { '0x1': ['Ethereum', 'ETH'], '0xa4b1': ['Arbitrum', 'ETH'], '0x2105': ['Base', 'ETH'], '0xa': ['Optimism', 'ETH'], '0x89': ['Polygon', 'POL'], '0x38': ['BNB Chain', 'BNB'], '0xa86a': ['Avalanche', 'AVAX'] };

// Native balance on whatever chain the wallet is currently on.
export async function evmNativeBalance(address) {
  const provider = metamaskProvider() || phantomEvmProvider();
  if (!provider) throw new Error('Needs MetaMask or Phantom in this browser. Use “Open in DeBank” for a full view.');
  const [chainId, hex] = await Promise.all([
    provider.request({ method: 'eth_chainId' }),
    provider.request({ method: 'eth_getBalance', params: [address, 'latest'] }),
  ]);
  const [chain, symbol] = CHAIN_NAMES[chainId] || [`chain ${parseInt(chainId, 16)}`, 'native'];
  return { chain, symbol, balance: Number(BigInt(hex)) / 1e18 };
}
