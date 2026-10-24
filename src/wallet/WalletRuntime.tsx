import { useCallback, useEffect, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { darkTheme, RainbowKitProvider, useConnectModal } from "@rainbow-me/rainbowkit";
import { WagmiProvider, useAccount, useDisconnect } from "wagmi";
import { walletConfig } from "../api/walletConfig";
import type { WalletRuntimeProps } from "./WalletConnectionProvider";
import "@rainbow-me/rainbowkit/styles.css";

export default function WalletRuntime({ openRequest, onStateChange }: WalletRuntimeProps) {
  const queryClient = useMemo(() => new QueryClient(), []);
  return <WagmiProvider config={walletConfig}>
    <QueryClientProvider client={queryClient}>
      <RainbowKitProvider theme={darkTheme({
        accentColor: "#b5ef55",
        accentColorForeground: "#11180a",
        borderRadius: "medium",
        fontStack: "system",
        overlayBlur: "small",
      })} modalSize="compact">
        <WalletBridge openRequest={openRequest} onStateChange={onStateChange} />
      </RainbowKitProvider>
    </QueryClientProvider>
  </WagmiProvider>;
}

function WalletBridge({ openRequest, onStateChange }: WalletRuntimeProps) {
  const { address, connector, isConnected } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const { connectModalOpen, openConnectModal } = useConnectModal();
  const disconnectWallet = useCallback(async () => {
    await disconnectAsync();
  }, [disconnectAsync]);

  useEffect(() => {
    onStateChange({
      address: address ?? null,
      connector: connector ?? null,
      connected: isConnected,
      connectModalOpen,
      ready: true,
      disconnectWallet,
    });
  }, [address, connector, isConnected, connectModalOpen, disconnectWallet, onStateChange]);

  useEffect(() => {
    if (openRequest <= 0 || isConnected) return;
    const timeout = window.setTimeout(() => openConnectModal?.(), 0);
    return () => window.clearTimeout(timeout);
  }, [openRequest, isConnected, openConnectModal]);

  return null;
}
