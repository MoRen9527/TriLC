export type UpgradeState = 'client' | 'wallet_bound' | 'registered_node';

export class WalletUpgradeService {
  getNextState(consented: boolean): UpgradeState {
    return consented ? 'wallet_bound' : 'client';
  }
}