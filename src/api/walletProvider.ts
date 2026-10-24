export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (payload: unknown) => void): void;
  removeListener?(event: string, listener: (payload: unknown) => void): void;
}

export function getEthereumProvider(): EthereumProvider {
  if (!window.ethereum) {
    throw new Error("Install or open an Ethereum wallet, then try again.");
  }
  return window.ethereum as EthereumProvider;
}

export async function requestWalletAddress(provider = getEthereumProvider()): Promise<string> {
  const result = await provider.request({ method: "eth_requestAccounts" });
  return parseWalletAddress(result);
}

/** Confirms the account selected in the wallet picker without prompting a second time. */
export async function readConnectedWalletAddress(provider: EthereumProvider, expectedAddress: string): Promise<string> {
  const result = await provider.request({ method: "eth_accounts" });
  const address = parseWalletAddress(result);
  if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error("The selected wallet account changed. Choose the account again.");
  }
  return address;
}

function parseWalletAddress(result: unknown): string {
  if (!Array.isArray(result) || typeof result[0] !== "string" || !/^0x[\da-fA-F]{40}$/.test(result[0])) {
    throw new Error("The connected wallet did not return a valid Ethereum address.");
  }
  return result[0];
}
