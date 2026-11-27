// Prints the addresses whose histories hold the README's proofs: a player's account and wallet, the boards, the plots.
import { addr } from '../../packages/realm/src/index.ts';
const w = process.argv[2]; console.log([addr.player(w), w, addr.board(0), addr.board(1), addr.plots(), addr.decisions()].join(','));
process.exit(0);
