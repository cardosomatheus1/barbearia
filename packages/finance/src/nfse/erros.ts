export class NfseError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = 'NfseError';
  }
}

export function recusarNfse(code: string, message: string, status = 409): never {
  throw new NfseError(code, message, status);
}
