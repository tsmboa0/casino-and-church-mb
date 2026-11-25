import { ER_RPC } from '../wallet';
export const l1Tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const erTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(ER_RPC)}`;
export const l1Address = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
