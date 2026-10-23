export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export function getEthereumProvider(): EthereumProvider {
  if (!window.ethereum) {
    throw new Error("Install or open an Ethereum wallet, then try again.");
  }
  return window.ethereum;
}

export async function requestWalletAddress(provider = getEthereumProvider()): Promise<string> {
  const result = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(result) || typeof result[0] !== "string" || !/^0x[\da-fA-F]{40}$/.test(result[0])) {
    throw new Error("The connected wallet did not return a valid Ethereum address.");
  }
  return result[0];
}
