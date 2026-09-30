import type { Address } from "viem";

export function rotationKey(sellerId: Address, network: string, asset: Address): string {
  return `${sellerId.toLowerCase()}|${network}|${asset.toLowerCase()}`;
}
