import Phaser from 'phaser';
/** Tiny app-wide event bus between the Phaser world and the DOM UI. */
export const bus = new Phaser.Events.EventEmitter();
export type PanelKind = 'slots' | 'coinflip' | 'wheel' | 'cashier' | 'plot' | 'altar' | 'offering' | 'missions' | 'candles' | 'dice' | 'roulette' | 'blackjack' | 'harmony' | 'monitor' | 'ledger' | 'board' | 'chat' | 'confessional' | 'market' | 'commission' | 'places' | 'guide';
