export interface Signer {
  keyid: string;
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}
