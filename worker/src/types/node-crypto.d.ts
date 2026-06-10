declare module "node:crypto" {
  type Pbkdf2Digest = {
    toString(encoding: "hex"): string;
  };

  export function pbkdf2(
    password: string,
    salt: string,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (error: Error | null, derivedKey: Pbkdf2Digest) => void
  ): void;
}
