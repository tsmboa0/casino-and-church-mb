use anchor_lang::prelude::*;

/// Messages are for developers; the client maps the codes to what players read.
#[error_code]
pub enum RealmError {
    #[msg("not allowed")]
    NotAllowed,
    #[msg("bad arguments")]
    BadArgs,
    #[msg("the game is paused")]
    Paused,
    #[msg("deposits are paused")]
    DepositsPaused,
    #[msg("payouts are paused")]
    PayoutsPaused,
    #[msg("amount outside the limits, or not a whole number of chips")]
    BadAmount,
    #[msg("not enough chips")]
    NoChips,
    #[msg("the vault is too low")]
    VaultLow,
    #[msg("already claimed")]
    AlreadyClaimed,
    #[msg("a bet is still being settled")]
    BetPending,
    #[msg("bad player account")]
    BadPlayer,
    #[msg("session expired or not for this player")]
    BadSession,
    #[msg("too soon")]
    Cooldown,
    #[msg("bad name")]
    BadName,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("bad pick for this game")]
    BadPick,
    #[msg("that bet is not offered")]
    BadWager,
    #[msg("above the table limit")]
    MaxBet,
    #[msg("not enough LUCK")]
    LuckLow,
    #[msg("not enough FAITH")]
    FaithLow,
    #[msg("nothing is pending")]
    NothingPending,
    #[msg("too early")]
    TooEarly,
    #[msg("no blackjack hand to act on")]
    NoHand,
    #[msg("double is for the first two cards")]
    CannotDouble,
    #[msg("the market is closed")]
    MarketClosed,
    #[msg("that round has moved on")]
    RoundMoved,
    #[msg("betting on that round has closed")]
    RoundLocked,
    #[msg("one bet per round")]
    AlreadyBet,
    #[msg("too many unsettled bets")]
    SlotsFull,
    #[msg("bad price feed")]
    BadFeed,
    #[msg("not finished yet")]
    NotDone,
    #[msg("that campaign has ended")]
    CampaignClosed,
    #[msg("the treasury is too low")]
    TreasuryLow,
    #[msg("that plot is taken")]
    PlotTaken,
    #[msg("not enough standing for a plot")]
    PlotGate,
    #[msg("the machine must keep its reserve")]
    Reserve,
    #[msg("the board is full")]
    BoardFull,
}
