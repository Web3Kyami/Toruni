import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface WalletConnectorBridge {
  getProvider(): Promise<unknown>;
}

export interface WalletRuntimeSnapshot {
  address: string | null;
  connector: WalletConnectorBridge | null;
  connected: boolean;
  connectModalOpen: boolean;
  ready: boolean;
  disconnectWallet(): Promise<void>;
}

interface WalletConnectionValue extends WalletRuntimeSnapshot {
  pickerLoading: boolean;
  openWalletPicker(): void;
}

export interface WalletRuntimeProps {
  openRequest: number;
  onStateChange(snapshot: WalletRuntimeSnapshot): void;
}

const WalletRuntime = lazy(() => import("./WalletRuntime"));
const initialSnapshot: WalletRuntimeSnapshot = {
  address: null,
  connector: null,
  connected: false,
  connectModalOpen: false,
  ready: false,
  disconnectWallet: async () => {},
};
const WalletConnectionContext = createContext<WalletConnectionValue>({
  ...initialSnapshot,
  pickerLoading: false,
  openWalletPicker: () => {},
});

export function WalletConnectionProvider({ children }: { children: ReactNode }) {
  const [runtimeLoaded, setRuntimeLoaded] = useState(false);
  const [openRequest, setOpenRequest] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [snapshot, setSnapshot] = useState(initialSnapshot);

  const openWalletPicker = useCallback(() => {
    setPickerLoading(true);
    setRuntimeLoaded(true);
    setOpenRequest(request => request + 1);
  }, []);

  const onStateChange = useCallback((next: WalletRuntimeSnapshot) => {
    setSnapshot(next);
    if (next.ready) setPickerLoading(false);
  }, []);

  const value = useMemo(() => ({ ...snapshot, pickerLoading, openWalletPicker }), [snapshot, pickerLoading, openWalletPicker]);
  return <WalletConnectionContext.Provider value={value}>
    {children}
    {runtimeLoaded && <Suspense fallback={null}><WalletRuntime openRequest={openRequest} onStateChange={onStateChange} /></Suspense>}
  </WalletConnectionContext.Provider>;
}

export function useWalletConnection(): WalletConnectionValue {
  return useContext(WalletConnectionContext);
}
