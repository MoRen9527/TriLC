export type NodeRegistration = {
  nodeId: string;
  ownerUserId?: string;
  consentStatus: 'pending' | 'granted' | 'revoked';
};