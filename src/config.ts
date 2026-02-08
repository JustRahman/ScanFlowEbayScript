export const SELLERS = ['booksrun'];

export const CATEGORIES = [
  { id: '2228', name: 'Textbooks' },
];

// Price range in cents
export const MIN_PRICE = 400;   // $4.00
export const MAX_PRICE = 3000;  // $30.00

// Keepa rate limit delay (ms)
export const KEEPA_DELAY_MS = 1200;

// Decision thresholds (matching ScanFlow-ScapBooksRun)
export const DECISION = {
  BUY: {
    MULTIPLIER: 6,                // Amazon price >= 6x buy price
    MAX_SALES_RANK: 1500000,      // Rank < 1.5M
    MAX_SALES_RANK_CHEAP: 2000000,// Rank < 2M if buy price < $6
    CHEAP_PRICE_THRESHOLD: 6,     // Books under $6 get relaxed rank
    MIN_DROPS_90: 3,              // At least 3 sales in 90 days
    HIGH_PROFIT_MIN_FBM: 60,      // FBM profit >= $60 for high-profit exception
    HIGH_PROFIT_MAX_RANK: 1000000,// Rank < 1M for high-profit exception
    HIGH_PROFIT_MIN_DROPS: 10,    // 10+ sales for high-profit exception
  },
  REVIEW: {
    MULTIPLIER: 4,                // Amazon price >= 4x buy price
    MAX_SALES_RANK: 2500000,      // Rank < 2.5M
    MIN_DROPS_90: 2,              // At least 2 sales in 90 days
  },
  KNOCKOUT: {
    MAX_SALES_RANK: 3000000,      // Rank > 3M = auto-reject
  },
};

// Fee structure
export const FEES = {
  REFERRAL_FEE_PERCENT: 0.15,     // 15% of sell price
  CLOSING_FEE: 1.80,              // $1.80 fixed (media)
  FBA_FULFILLMENT_FEE: 3.50,      // $3.50 per book
  FBM_SHIPPING_COST: 4.00,        // $4.00 shipping (estimated)
};
