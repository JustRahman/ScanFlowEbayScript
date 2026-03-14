import { getProductsByIsbns, evaluateBook, waitForKeepaTokens, type KeepaProductRaw } from './keepaApi.js';
import { getPendingBooks, updateBookEvaluation, getCachedSellerNames, cacheSellerNames } from './supabase.js';

const KEEPA_API_KEY = process.env.KEEPA_API_KEY || '';
const KEEPA_API_BASE = 'https://api.keepa.com';
const KEEPA_BATCH_SIZE = 100;

// ── Seller URL generation ──

const SELLER_URL_MAP: Record<string, (isbn: string) => string> = {
  'booksrun': (isbn) => `https://booksrun.com/search/results?q=${isbn}`,
  'second.sale': (isbn) => `https://booksrun.com/search/results?q=${isbn}`,
  'betterworldbooks': (isbn) => `https://www.betterworldbooks.com/product/detail/${isbn}`,
};

function getSellerUrl(seller: string, isbn: string): string | undefined {
  const fn = SELLER_URL_MAP[seller];
  return fn ? fn(isbn) : undefined;
}

// ── Trusted seller patterns (case-insensitive contains) ──

const TRUSTED_SELLER_PATTERNS = [
  'thrift',
  'goodwill',
  'greatbookprices',
  'zuber',
  'rockymtntext',
  'betterworldbooks',
  'textbook',
  'booksrun',
  'zoombookscompany',
  'greenworldbooks',
  'baystatebooks',
  'ontimebooks',
  'awesomebooksusa',
  'goodbooksco',
  'zebrasbooks',
  'zbkbooks',
  'bluevasemarketplace',
  'oneplanetbooks',
  'a plus books',
  'aplusbooks',
];

function isTrustedSeller(sellerName: string): boolean {
  const lower = sellerName.toLowerCase();
  return TRUSTED_SELLER_PATTERNS.some(pattern => lower.includes(pattern));
}

// ── Keepa seller name resolution ──

async function resolveSellerNames(sellerIds: string[]): Promise<Record<string, string>> {
  if (sellerIds.length === 0) return {};

  // Check cache first
  const cached = await getCachedSellerNames(sellerIds);
  const unknown = sellerIds.filter(id => !cached[id]);

  if (unknown.length === 0) return cached;

  // Fetch unknown sellers from Keepa API
  const ids = unknown.join(',');
  try {
    const resp = await fetch(`${KEEPA_API_BASE}/seller?key=${KEEPA_API_KEY}&domain=1&seller=${ids}`);
    const data = await resp.json();

    if (data.sellers) {
      const newNames: Record<string, string> = {};
      for (const [id, info] of Object.entries(data.sellers)) {
        const name = (info as any).sellerName || id;
        cached[id] = name;
        newNames[id] = name;
      }
      // Cache new names
      if (Object.keys(newNames).length > 0) {
        await cacheSellerNames(newNames);
      }
    }
  } catch (err) {
    console.error('    Seller lookup error:', err instanceof Error ? err.message : err);
  }

  // Fill any still-unknown with their ID
  for (const id of unknown) {
    if (!cached[id]) cached[id] = id;
  }

  return cached;
}

// ── Keepa condition codes matching eBay conditions ──
// Keepa: 1=New, 2=Used-Like New, 3=Used-Very Good, 4=Used-Good, 5=Used-Acceptable

const SELLER_KEEPA_CONDITION: Record<string, number> = {
  'booksrun': 3,          // Very Good
  'second.sale': 3,       // Very Good
  'thriftbooks.store': 2, // Like New
  'oneplanetbooks': 2,    // Like New
  'betterworldbooks': 2,  // Like New
};

function getKeepaCondition(seller: string): number {
  return SELLER_KEEPA_CONDITION[seller] ?? 2; // default Like New
}

// ── Find cheapest matching offer from trusted seller ──

interface BestOffer {
  price: number;       // cents
  sellerName: string;
}

async function findBestOffer(isbn: string, keepaCondition: number): Promise<BestOffer | null> {
  const url = `${KEEPA_API_BASE}/product?key=${KEEPA_API_KEY}&domain=1&code=${isbn}&stats=180&history=1&offers=20`;
  const condName = keepaCondition === 2 ? 'Like New' : keepaCondition === 3 ? 'Very Good' : `cond=${keepaCondition}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.error) {
      console.log(`    Offers fetch error: ${data.error.message}`);
      return null;
    }

    const product = data.products?.[0];
    if (!product || !product.offers) return null;

    // Filter by matching condition
    const matching = product.offers.filter((o: any) => o.condition === keepaCondition);
    if (matching.length === 0) {
      console.log(`    No ${condName} offers found`);
      return null;
    }

    // Get unique seller IDs and resolve names
    const sellerIds = [...new Set(matching.map((o: any) => o.sellerId))] as string[];
    const sellerNames = await resolveSellerNames(sellerIds);

    // Build offers with resolved names and prices
    const parsedOffers: { name: string; totalCents: number }[] = [];
    for (const offer of matching) {
      const price = offer.offerCSV?.[1] ?? -1;
      const shipping = offer.offerCSV?.[2] ?? 0;
      if (price <= 0) continue;

      const totalCents = price + (shipping > 0 ? shipping : 0);
      const name = sellerNames[offer.sellerId] || offer.sellerId;
      parsedOffers.push({ name, totalCents });
    }

    if (parsedOffers.length === 0) return null;

    // Sort by price ascending
    parsedOffers.sort((a, b) => a.totalCents - b.totalCents);

    // Find cheapest trusted seller only
    const trustedOffer = parsedOffers.find(o => isTrustedSeller(o.name));
    if (trustedOffer) {
      return { price: trustedOffer.totalCents, sellerName: trustedOffer.name };
    }

    // No trusted seller found — skip
    return null;
  } catch (err) {
    console.error('    Offers fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Main evaluation ──

export async function evaluatePendingBooks(seller?: string): Promise<{
  evaluated: number;
  buy: number;
  review: number;
  reject: number;
  noData: number;
}> {
  const pending = await getPendingBooks(seller);
  console.log(`\nEvaluating ${pending.length} pending books...`);

  let evaluated = 0;
  let buy = 0;
  let review = 0;
  let reject = 0;
  let noData = 0;

  const safeInt = (v: number | null | undefined): number | undefined => {
    if (v == null || !Number.isFinite(v)) return undefined;
    const rounded = Math.round(v);
    if (rounded > 2_000_000_000 || rounded < -2_000_000_000) return undefined;
    return rounded;
  };

  for (let i = 0; i < pending.length; i += KEEPA_BATCH_SIZE) {
    const batch = pending.slice(i, i + KEEPA_BATCH_SIZE);
    const batchNum = Math.floor(i / KEEPA_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(pending.length / KEEPA_BATCH_SIZE);

    await waitForKeepaTokens();

    const isbns = batch.map(b => b.isbn);
    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} books)...`);

    const { byAsin, byIsbn, tokensConsumed } = await getProductsByIsbns(isbns);
    console.log(`    ${tokensConsumed} tokens consumed`);

    for (const book of batch) {
      evaluated++;

      const product: KeepaProductRaw | undefined =
        (book.asin ? byAsin.get(book.asin) : undefined) || byIsbn.get(book.isbn);

      if (!product) {
        await updateBookEvaluation(book.isbn, { decision: 'NOT FOUND' });
        noData++;
        console.log(`  [${evaluated}/${pending.length}] ${book.isbn} — no Keepa data → NOT FOUND`);
        continue;
      }

      const buyPriceDollars = (book.price + book.shipping) / 100;
      const result = evaluateBook(product, buyPriceDollars);

      const amazonPriceCents = result.amazonPrice != null ? Math.round(result.amazonPrice * 100) : undefined;
      const fbaProfitCents = result.fbaProfit != null ? Math.round(result.fbaProfit * 100) : undefined;
      const fbmProfitCents = result.fbmProfit != null ? Math.round(result.fbmProfit * 100) : undefined;
      const weightOz = result.weightLbs != null ? Math.round(result.weightLbs * 16 * 10) / 10 : undefined;

      const isBuyOrReview = result.decision === 'BUY' || result.decision === 'REVIEW';

      // Generate seller URL for BUY/REVIEW
      const sellerUrl = isBuyOrReview ? getSellerUrl(book.seller, book.isbn) : undefined;

      // Amazon URL for BUY/REVIEW
      const amazonUrl = isBuyOrReview && result.asin
        ? `https://www.amazon.com/dp/${result.asin}`
        : undefined;

      // Find best Like New offer for BUY/REVIEW
      let bestOfferPrice: number | undefined;
      let bestOfferSeller: string | undefined;

      if (isBuyOrReview) {
        const keepaCondition = getKeepaCondition(book.seller);
        const condLabel = keepaCondition === 2 ? 'Like New' : 'Very Good';
        console.log(`    Fetching ${condLabel} offers for ${book.isbn}...`);
        const bestOffer = await findBestOffer(book.isbn, keepaCondition);
        if (bestOffer) {
          bestOfferPrice = bestOffer.price;
          bestOfferSeller = bestOffer.sellerName;
          const trusted = isTrustedSeller(bestOffer.sellerName) ? '✓' : '?';
          console.log(`    → Best: $${(bestOffer.price / 100).toFixed(2)} from ${bestOffer.sellerName} [${trusted}]`);
        } else {
          console.log(`    → No Like New offers found`);
        }
      }

      await updateBookEvaluation(book.isbn, {
        decision: result.decision,
        asin: result.asin,
        amazon_price: safeInt(amazonPriceCents),
        sales_rank: safeInt(result.salesRank),
        sales_rank_drops_90: safeInt(result.salesRankDrops90),
        fba_profit: safeInt(fbaProfitCents),
        fbm_profit: safeInt(fbmProfitCents),
        amazon_flag: result.amazonFlag ?? undefined,
        book_type: result.binding ?? undefined,
        weight_oz: weightOz != null && Number.isFinite(weightOz) ? weightOz : undefined,
        seller_url: sellerUrl,
        amazon_url: amazonUrl,
        best_offer_price: bestOfferPrice,
        best_offer_seller: bestOfferSeller,
      });

      if (result.decision === 'BUY') buy++;
      else if (result.decision === 'REVIEW') review++;
      else reject++;

      console.log(`  [${evaluated}/${pending.length}] ${book.isbn} → ${result.decision} (${result.reason})`);
    }
  }

  return { evaluated, buy, review, reject, noData };
}
