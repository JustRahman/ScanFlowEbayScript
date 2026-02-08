/**
 * Keepa API Service — matching ScanFlow-ScapBooksRun logic
 *
 * Key differences from previous version:
 * - history=1 in Keepa request for price history CSV data
 * - analyzeAmazonPresence() for Amazon 1P stockout analysis
 * - Realistic price = median buy box price during Amazon stockout periods
 * - Amazon flag (green/yellow/red) based on stockout percentage
 * - 180-day avg sales rank (stats.avg[3]) instead of current rank
 * - Multiplier-based decisions instead of score-based
 * - Fee calc: sellPrice - buyPrice - fees (no eBay fee)
 */

import { DECISION, FEES } from './config.js';

const KEEPA_API_BASE = 'https://api.keepa.com';
const KEEPA_API_KEY = process.env.KEEPA_API_KEY || '';

// Keepa CSV indices
const CSV = {
  AMAZON: 0,        // Amazon 1P price history
  NEW: 1,           // New 3rd party (FBM)
  USED: 2,          // Used price
  SALES_RANK: 3,    // Sales rank history
  NEW_FBA: 10,      // New FBA price (index 10 in raw csv, mapped to 7 in stats)
  BUY_BOX: 18,      // Buy box price history
};

// Stats array indices (different from CSV indices)
const STATS = {
  AMAZON: 0,
  NEW: 1,
  USED: 2,
  SALES_RANK: 3,
  NEW_FBA: 10,
};

// Keepa base time: 2011-01-01 in ms
const KEEPA_BASE_TIME = new Date('2011-01-01').getTime();

// ── Types ──

export interface KeepaProductRaw {
  asin: string;
  title?: string;
  csv?: (number[] | null)[];
  stats?: {
    current?: number[];
    avg?: number[];       // 180-day averages
    avg30?: number[];
    avg90?: number[];
    salesRankDrops90?: number;
    salesRankDrops30?: number;
    buyBoxPrice?: number;
    offerCountNew?: number;
    offerCountUsed?: number;
    offerCountFBA?: number;
    outOfStockPercentage90?: number;
  };
  imagesCSV?: string;
  categoryTree?: Array<{ catId: number; name: string }>;
  lastUpdate?: number;
  binding?: string;
  packageWeight?: number;
  itemWeight?: number;
}

interface KeepaApiResponse {
  tokensLeft: number;
  tokensConsumed: number;
  products?: KeepaProductRaw[];
  error?: { message: string };
}

export interface AmazonPrices {
  current: {
    fba: number | null;     // Current FBA price (dollars)
    newFBM: number | null;  // Current new 3rd party price (dollars)
    used: number | null;    // Current used price (dollars)
  };
  avg180: {
    fba: number | null;
    newFBM: number | null;
    used: number | null;
  };
}

export interface AmazonPresence {
  stockoutPercent: number | null;   // % of last 90 days Amazon was out of stock
  realisticPrice: number | null;    // Best price to use for profit calc (dollars)
  amazonFlag: 'green' | 'yellow' | 'red' | null;  // green=good, red=bad
}

export interface EvaluationResult {
  decision: 'BUY' | 'REVIEW' | 'REJECT';
  reason: string;
  amazonPrice: number | null;       // Realistic sell price in dollars
  fbaProfit: number | null;
  fbmProfit: number | null;
  salesRank: number | null;         // 180-day avg
  salesRankDrops90: number;
  asin: string;
  amazonFlag: 'green' | 'yellow' | 'red' | null;
  weightLbs: number | null;
  binding: string | null;
  multiplier: number | null;
}

// ── ISBN utilities ──

export function isbn10to13(isbn10: string): string | null {
  const clean = isbn10.replace(/[-\s]/g, '');
  if (clean.length !== 10) return null;
  const base = '978' + clean.substring(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(base[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return base + checkDigit;
}

export function isbn13to10(isbn13: string): string | null {
  const clean = isbn13.replace(/[-\s]/g, '');
  if (clean.length !== 13 || !clean.startsWith('978')) return null;
  const base = clean.substring(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(base[i], 10) * (10 - i);
  }
  const remainder = sum % 11;
  const checkDigit = remainder === 0 ? '0' : remainder === 1 ? 'X' : (11 - remainder).toString();
  return base + checkDigit;
}

export function validateIsbn(isbn: string): { valid: boolean; error?: string } {
  const clean = isbn.replace(/[-\s]/g, '');
  if (!clean) return { valid: false, error: 'ISBN is empty' };
  if (!/^\d+X?$/i.test(clean)) return { valid: false, error: 'ISBN must contain only digits (and X for ISBN-10)' };

  if (clean.length === 10) {
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += parseInt(clean[i], 10) * (10 - i);
    }
    const lastChar = clean[9].toUpperCase();
    sum += lastChar === 'X' ? 10 : parseInt(lastChar, 10);
    if (sum % 11 !== 0) return { valid: false, error: 'Invalid ISBN-10 checksum' };
    return { valid: true };
  }

  if (clean.length === 13) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(clean[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    if (checkDigit !== parseInt(clean[12], 10)) return { valid: false, error: 'Invalid ISBN-13 checksum' };
    return { valid: true };
  }

  return { valid: false, error: `ISBN must be 10 or 13 digits (got ${clean.length})` };
}

// ── Keepa API ──

export async function getProductByIsbn(isbn: string): Promise<KeepaProductRaw | null> {
  if (!KEEPA_API_KEY) {
    console.error('Keepa API key not configured');
    return null;
  }

  const cleanIsbn = isbn.replace(/[-\s]/g, '');
  const validation = validateIsbn(cleanIsbn);
  if (!validation.valid) {
    console.error('Invalid ISBN:', validation.error);
    return null;
  }

  // history=1 is critical for Amazon 1P stockout analysis
  const url = `${KEEPA_API_BASE}/product?key=${KEEPA_API_KEY}&domain=1&code=${cleanIsbn}&stats=180&history=1&offers=20`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error('Keepa API error:', response.status);
      return null;
    }

    const data: KeepaApiResponse = await response.json();
    if (data.error) {
      console.error('Keepa API error:', data.error.message);
      return null;
    }

    console.log(`  Keepa tokens left: ${data.tokensLeft}`);

    if (!data.products || data.products.length === 0) return null;
    return data.products[0];
  } catch (error) {
    console.error('Keepa API fetch error:', error);
    return null;
  }
}

// ── Price extraction (matching ScanFlow-ScapBooksRun getAmazonPrice) ──

function getLastPrice(csv: number[] | null | undefined): number | null {
  if (!csv || csv.length < 2) return null;
  const price = csv[csv.length - 1];
  return price > 0 ? price / 100 : null;  // Keepa cents → dollars
}

export function getAmazonPrices(raw: KeepaProductRaw): AmazonPrices {
  const csv = raw.csv || [];
  const stats = raw.stats;

  const prices: AmazonPrices = {
    current: { fba: null, newFBM: null, used: null },
    avg180: { fba: null, newFBM: null, used: null },
  };

  // Current prices from CSV history (last value)
  prices.current.fba = getLastPrice(csv[CSV.NEW_FBA]);
  prices.current.newFBM = getLastPrice(csv[CSV.NEW]);
  prices.current.used = getLastPrice(csv[CSV.USED]);

  // 180-day averages from stats.avg
  if (stats?.avg) {
    const avg = stats.avg;
    if (avg[STATS.NEW_FBA] > 0) prices.avg180.fba = avg[STATS.NEW_FBA] / 100;
    if (avg[STATS.NEW] > 0) prices.avg180.newFBM = avg[STATS.NEW] / 100;
    if (avg[STATS.USED] > 0) prices.avg180.used = avg[STATS.USED] / 100;
  }

  return prices;
}

// ── Amazon 1P stockout analysis (the complex price logic) ──

export function analyzeAmazonPresence(raw: KeepaProductRaw): AmazonPresence {
  const result: AmazonPresence = {
    stockoutPercent: null,
    realisticPrice: null,
    amazonFlag: null,
  };

  const csv = raw.csv || [];
  const amazon1P = csv[CSV.AMAZON];
  const buyBox = csv[CSV.BUY_BOX];
  const newThirdParty = csv[CSV.NEW];

  if (!amazon1P || amazon1P.length < 2) return result;

  const now = Date.now();
  const cutoff90Days = now - (90 * 24 * 60 * 60 * 1000);

  let totalPeriods = 0;
  let stockoutPeriods = 0;
  const buyBoxWhenAmazonOut: number[] = [];

  // Walk through Amazon 1P history pairs [time, price, time, price, ...]
  for (let i = 0; i < amazon1P.length - 2; i += 2) {
    const time = KEEPA_BASE_TIME + (amazon1P[i] * 60 * 1000);
    const nextTime = KEEPA_BASE_TIME + (amazon1P[i + 2] * 60 * 1000);
    const price = amazon1P[i + 1];

    if (nextTime < cutoff90Days) continue; // Skip data older than 90 days

    const periodStart = Math.max(time, cutoff90Days);
    const periodEnd = Math.min(nextTime, now);
    const periodDuration = (periodEnd - periodStart) / (60 * 1000);

    if (periodDuration <= 0) continue;
    totalPeriods += periodDuration;

    // price === -1 means Amazon is out of stock
    if (price === -1) {
      stockoutPeriods += periodDuration;

      // Record buy box prices during this stockout period
      if (buyBox && buyBox.length >= 2) {
        for (let j = 0; j < buyBox.length - 2; j += 2) {
          const bbTime = KEEPA_BASE_TIME + (buyBox[j] * 60 * 1000);
          const bbPrice = buyBox[j + 1];
          if (bbTime >= periodStart && bbTime <= periodEnd && bbPrice > 0) {
            buyBoxWhenAmazonOut.push(bbPrice / 100);
          }
        }
      }
    }
  }

  // Handle last period (from last data point to now)
  if (amazon1P.length >= 2) {
    const lastTime = KEEPA_BASE_TIME + (amazon1P[amazon1P.length - 2] * 60 * 1000);
    const lastPrice = amazon1P[amazon1P.length - 1];

    if (lastTime < now) {
      const periodStart = Math.max(lastTime, cutoff90Days);
      const periodDuration = (now - periodStart) / (60 * 1000);

      if (periodDuration > 0) {
        totalPeriods += periodDuration;
        if (lastPrice === -1) {
          stockoutPeriods += periodDuration;
          if (buyBox && buyBox.length >= 2) {
            const lastBBPrice = buyBox[buyBox.length - 1];
            if (lastBBPrice > 0) buyBoxWhenAmazonOut.push(lastBBPrice / 100);
          }
        }
      }
    }
  }

  // Calculate stockout percentage and flag
  if (totalPeriods > 0) {
    result.stockoutPercent = Math.round((stockoutPeriods / totalPeriods) * 100);

    if (result.stockoutPercent > 50) {
      result.amazonFlag = 'green';   // Amazon out >50% of time — good for us
    } else if (result.stockoutPercent >= 20) {
      result.amazonFlag = 'yellow';  // Amazon out 20-50%
    } else {
      result.amazonFlag = 'red';     // Amazon in stock >80% — tough competition
    }
  }

  // Calculate realistic price
  if (buyBoxWhenAmazonOut.length > 0) {
    // Median of buy box prices when Amazon was out of stock
    buyBoxWhenAmazonOut.sort((a, b) => a - b);
    const mid = Math.floor(buyBoxWhenAmazonOut.length / 2);
    result.realisticPrice = buyBoxWhenAmazonOut.length % 2 === 0
      ? (buyBoxWhenAmazonOut[mid - 1] + buyBoxWhenAmazonOut[mid]) / 2
      : buyBoxWhenAmazonOut[mid];
  } else if (result.stockoutPercent === 0) {
    // Amazon always in stock — use current 3rd party new price
    if (newThirdParty && newThirdParty.length >= 2) {
      const lastNewPrice = newThirdParty[newThirdParty.length - 1];
      if (lastNewPrice > 0) {
        result.realisticPrice = lastNewPrice / 100;
        result.amazonFlag = 'red';
      }
    }
  }

  return result;
}

// ── Sales rank metrics (180-day avg, drops) ──

export function getSalesRankMetrics(raw: KeepaProductRaw): {
  avgSalesRank: number | null;
  salesRankDrops90: number;
} {
  const stats = raw.stats;
  if (!stats) return { avgSalesRank: null, salesRankDrops90: 0 };

  const salesRankDrops90 = stats.salesRankDrops90 || 0;

  // Priority: 180-day average first, then 90-day average
  let avgSalesRank: number | null = null;
  if (stats.avg && stats.avg[STATS.SALES_RANK] > 0) {
    avgSalesRank = stats.avg[STATS.SALES_RANK];
  } else if (stats.avg90 && stats.avg90[STATS.SALES_RANK] > 0) {
    avgSalesRank = stats.avg90[STATS.SALES_RANK];
  }

  return { avgSalesRank, salesRankDrops90 };
}

// ── Weight extraction ──

export function getWeightInPounds(raw: KeepaProductRaw): number | null {
  if (raw.itemWeight && raw.itemWeight > 0) {
    return raw.itemWeight / 453.592;
  }
  if (raw.packageWeight && raw.packageWeight > 0) {
    return raw.packageWeight / 453.592;
  }
  return null;
}

// ── Fee calculation (matching ScanFlow-ScapBooksRun) ──
// sellPrice and buyPrice are in DOLLARS

export function calculateFBAProfit(buyPrice: number, sellPrice: number): number {
  const referralFee = sellPrice * FEES.REFERRAL_FEE_PERCENT;
  const totalFees = referralFee + FEES.CLOSING_FEE + FEES.FBA_FULFILLMENT_FEE;
  return sellPrice - buyPrice - totalFees;
}

export function calculateFBMProfit(buyPrice: number, sellPrice: number): number {
  const referralFee = sellPrice * FEES.REFERRAL_FEE_PERCENT;
  const totalFees = referralFee + FEES.CLOSING_FEE + FEES.FBM_SHIPPING_COST;
  return sellPrice - buyPrice - totalFees;
}

// ── Decision logic (multiplier-based, matching ScanFlow-ScapBooksRun) ──

export function evaluateBook(
  raw: KeepaProductRaw,
  buyPriceDollars: number,
): EvaluationResult {
  const result: EvaluationResult = {
    decision: 'REJECT',
    reason: '',
    amazonPrice: null,
    fbaProfit: null,
    fbmProfit: null,
    salesRank: null,
    salesRankDrops90: 0,
    asin: raw.asin,
    amazonFlag: null,
    weightLbs: getWeightInPounds(raw),
    binding: raw.binding || null,
    multiplier: null,
  };

  // Step 1: Get sales rank metrics (180-day avg)
  const metrics = getSalesRankMetrics(raw);
  result.salesRank = metrics.avgSalesRank;
  result.salesRankDrops90 = metrics.salesRankDrops90;

  if (!metrics.avgSalesRank) {
    result.reason = 'Unknown sales rank';
    return result;
  }

  // Knockout: Rank > 3M
  if (metrics.avgSalesRank > DECISION.KNOCKOUT.MAX_SALES_RANK) {
    result.reason = `Rank ${metrics.avgSalesRank.toLocaleString()} > 3M`;
    return result;
  }

  // Step 2: Get Amazon prices (complex analysis)
  const prices = getAmazonPrices(raw);
  const amazonAnalysis = analyzeAmazonPresence(raw);
  result.amazonFlag = amazonAnalysis.amazonFlag;

  // Determine the sell price to use
  let amazonPrice: number | null;
  if (amazonAnalysis.realisticPrice) {
    // Primary: realistic price from Amazon 1P stockout analysis
    amazonPrice = amazonAnalysis.realisticPrice;
  } else {
    // Fallback: min of 180-day avg or current price
    const avgPrice = prices.avg180.fba || prices.avg180.newFBM || prices.avg180.used;
    const currentPrice = prices.current.fba || prices.current.newFBM || prices.current.used;
    amazonPrice = (avgPrice && currentPrice) ? Math.min(avgPrice, currentPrice) : (avgPrice || currentPrice);
  }

  if (!amazonPrice) {
    result.reason = 'No Amazon price data';
    return result;
  }

  result.amazonPrice = amazonPrice;

  // Step 3: Calculate multiplier
  const multiplier = amazonPrice / buyPriceDollars;
  result.multiplier = multiplier;

  // Knockout: Multiplier < 4x (not enough margin even for REVIEW)
  if (multiplier < DECISION.REVIEW.MULTIPLIER) {
    result.reason = `Multiplier ${multiplier.toFixed(1)}x < ${DECISION.REVIEW.MULTIPLIER}x`;
    return result;
  }

  // Step 4: Calculate profits
  result.fbaProfit = calculateFBAProfit(buyPriceDollars, amazonPrice);
  result.fbmProfit = calculateFBMProfit(buyPriceDollars, amazonPrice);

  // Knockout: No sales in 90 days
  if (metrics.salesRankDrops90 === 0) {
    result.reason = 'No sales in 90 days (drops90 = 0)';
    return result;
  }

  // Step 5: Determine max rank threshold (cheaper books get relaxed rank)
  const buyMaxRank = buyPriceDollars < DECISION.BUY.CHEAP_PRICE_THRESHOLD
    ? DECISION.BUY.MAX_SALES_RANK_CHEAP
    : DECISION.BUY.MAX_SALES_RANK;

  // Step 6: Apply decision thresholds
  const meetsBuy = multiplier >= DECISION.BUY.MULTIPLIER &&
                   metrics.avgSalesRank < buyMaxRank &&
                   metrics.salesRankDrops90 >= DECISION.BUY.MIN_DROPS_90;

  const meetsReview = multiplier >= DECISION.REVIEW.MULTIPLIER &&
                      metrics.avgSalesRank < DECISION.REVIEW.MAX_SALES_RANK &&
                      metrics.salesRankDrops90 >= DECISION.REVIEW.MIN_DROPS_90;

  // High-profit exception: FBM profit >= $60, rank < 1M, drops >= 10
  const isHighProfit = result.fbmProfit !== null &&
                       result.fbmProfit >= DECISION.BUY.HIGH_PROFIT_MIN_FBM &&
                       metrics.avgSalesRank < DECISION.BUY.HIGH_PROFIT_MAX_RANK &&
                       metrics.salesRankDrops90 >= DECISION.BUY.HIGH_PROFIT_MIN_DROPS;

  const metricsStr = `${multiplier.toFixed(1)}x | Rank: ${metrics.avgSalesRank.toLocaleString()} | Drops: ${metrics.salesRankDrops90}`;

  if (meetsBuy || isHighProfit) {
    result.decision = 'BUY';
    result.reason = isHighProfit
      ? `${metricsStr} | HIGH_PROFIT FBM $${result.fbmProfit!.toFixed(0)}`
      : metricsStr;
  } else if (meetsReview) {
    result.decision = 'REVIEW';
    result.reason = metricsStr;
  } else {
    result.decision = 'REJECT';
    const failedCriteria: string[] = [];
    if (multiplier < DECISION.REVIEW.MULTIPLIER)
      failedCriteria.push(`${multiplier.toFixed(1)}x < ${DECISION.REVIEW.MULTIPLIER}x`);
    if (metrics.avgSalesRank >= DECISION.REVIEW.MAX_SALES_RANK)
      failedCriteria.push(`rank ${metrics.avgSalesRank.toLocaleString()} > 2.5M`);
    if (metrics.salesRankDrops90 < DECISION.REVIEW.MIN_DROPS_90)
      failedCriteria.push(`drops ${metrics.salesRankDrops90} < ${DECISION.REVIEW.MIN_DROPS_90}`);
    result.reason = failedCriteria.join(', ') || metricsStr;
  }

  return result;
}
