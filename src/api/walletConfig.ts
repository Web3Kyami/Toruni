import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();

const walletGroups = walletConnectProjectId
  ? [{
      groupName: "Wallets",
      wallets: [injectedWallet, walletConnectWallet],
    }]
  : [{
      groupName: "Installed wallets",
      wallets: [injectedWallet],
    }];

const connectors = connectorsForWallets(walletGroups, {
  appName: "Toruni",
  projectId: walletConnectProjectId ?? "",
});

export const walletConfig = createConfig({
  chains: [sepolia],
  connectors,
  transports: { [sepolia.id]: http() },
  ssr: false,
});
