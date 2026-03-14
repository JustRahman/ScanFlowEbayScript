import 'dotenv/config';
import { supabase } from '../src/supabase.js';
import { getCachedSellerNames, cacheSellerNames, updateBookEvaluation } from '../src/supabase.js';
import type { EbayBook } from '../src/supabase.js';

const KEEPA_API_KEY = process.env.KEEPA_API_KEY || '';
const KEEPA_API_BASE = 'https://api.keepa.com';

const seller = process.argv[2]; // optional: pass seller name as argument

// ── Seller URL generation ──

const SELLER_URL_MAP: Record<string, (isbn: string) => string> = {
  'booksrun': (isbn) => `https://booksrun.com/categories?sr=${isbn}`,
  'second.sale': (isbn) => `https://booksrun.com/categories?sr=${isbn}`,
  'betterworldbooks': (isbn) => `https://www.betterworldbooks.com/product/detail/${isbn}`,
};

function getSellerUrl(sellerName: string, isbn: string): string | undefined {
  const fn = SELLER_URL_MAP[sellerName];
  return fn ? fn(isbn) : undefined;
}

// ── Keepa condition per seller ──

const SELLER_KEEPA_CONDITION: Record<string, number> = {
  'booksrun': 3,
  'second.sale': 3,
  'thriftbooks.store': 2,
  'oneplanetbooks': 2,
  'betterworldbooks': 2,
};

function getKeepaCondition(sellerName: string): number {
  return SELLER_KEEPA_CONDITION[sellerName] ?? 2;
}

// ── Trusted seller patterns ──

const TRUSTED_SELLER_PATTERNS = [
  'thrift', 'goodwill', 'greatbookprices', 'zuber', 'rockymtntext',
  'betterworldbooks', 'textbook', 'booksrun', 'zoombookscompany',
  'greenworldbooks', 'baystatebooks', 'ontimebooks', 'awesomebooksusa',
  'goodbooksco', 'zebrasbooks', 'zbkbooks', 'bluevasemarketplace',
  'oneplanetbooks', 'a plus books', 'aplusbooks',
];

function isTrustedSeller(name: string): boolean {
  const lower = name.toLowerCase();
  return TRUSTED_SELLER_PATTERNS.some(p => lower.includes(p));
}

// ── Seller name resolution ──

async function resolveSellerNames(sellerIds: string[]): Promise<Record<string, string>> {
  if (sellerIds.length === 0) return {};

  const cached = await getCachedSellerNames(sellerIds);
  const unknown = sellerIds.filter(id => !cached[id]);

  if (unknown.length === 0) return cached;

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
      if (Object.keys(newNames).length > 0) {
        await cacheSellerNames(newNames);
      }
    }
  } catch (err) {
    console.error('  Seller lookup error:', err instanceof Error ? err.message : err);
  }

  for (const id of unknown) {
    if (!cached[id]) cached[id] = id;
  }

  return cached;
}

// ── Find best offer ──

async function findBestOffer(isbn: string, keepaCondition: number): Promise<{ price: number; sellerName: string } | null> {
  const url = `${KEEPA_API_BASE}/product?key=${KEEPA_API_KEY}&domain=1&code=${isbn}&stats=180&history=1&offers=20`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.error) return null;

    const product = data.products?.[0];
    if (!product?.offers) return null;

    const KEEPA_BASE = new Date('2011-01-01').getTime();
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    const matching = product.offers.filter((o: any) => {
      if (o.condition !== keepaCondition) return false;
      const lastSeenMs = KEEPA_BASE + (o.lastSeen * 60 * 1000);
      return lastSeenMs >= sevenDaysAgo;
    });
    if (matching.length === 0) return null;

    const sellerIds = [...new Set(matching.map((o: any) => o.sellerId))] as string[];
    const sellerNames = await resolveSellerNames(sellerIds);

    // offerCSV is flat triplets: [time, price, shipping, time, price, shipping, ...]
    const parsedOffers: { name: string; totalCents: number }[] = [];
    for (const offer of matching) {
      const csv = offer.offerCSV;
      if (!csv || csv.length < 3) continue;
      const price = csv[csv.length - 2];    // last price
      const shipping = csv[csv.length - 1]; // last shipping
      if (price <= 0) continue;
      parsedOffers.push({
        name: sellerNames[offer.sellerId] || offer.sellerId,
        totalCents: price + (shipping > 0 ? shipping : 0),
      });
    }

    if (parsedOffers.length === 0) return null;
    parsedOffers.sort((a, b) => a.totalCents - b.totalCents);

    const trusted = parsedOffers.find(o => isTrustedSeller(o.name));
    return trusted ? { price: trusted.totalCents, sellerName: trusted.name } : null;
  } catch {
    return null;
  }
}

// ── Main ──

async function main() {
  console.log('=== Update BUY/REVIEW books with offers & URLs ===\n');
  if (seller) console.log(`Filtering by seller: ${seller}\n`);

  // Fetch BUY + REVIEW books
  const books: EbayBook[] = [];
  for (const decision of ['BUY', 'REVIEW']) {
    let from = 0;
    const pageSize = 500;
    let count = 0;

    while (true) {
      let query = supabase
        .from('ebay_books')
        .select('*')
        .eq('decision', decision)
        .range(from, from + pageSize - 1);
      if (seller) query = query.eq('seller', seller);
      const { data, error } = await query;

      if (error) { console.error(`Error fetching ${decision}:`, error.message); break; }
      if (!data || data.length === 0) break;
      books.push(...(data as EbayBook[]));
      count += data.length;
      if (data.length < pageSize) break;
      from += pageSize;
    }
    if (count > 0) console.log(`  ${decision}: ${count} books`);
  }

  console.log(`\nTotal: ${books.length} books to update\n`);
  if (books.length === 0) return;

  let updated = 0;
  let withOffer = 0;

  for (const book of books) {
    updated++;

    const sellerUrl = getSellerUrl(book.seller, book.isbn);
    const amazonUrl = book.asin ? `https://www.amazon.com/dp/${book.asin}` : undefined;

    const keepaCondition = getKeepaCondition(book.seller);
    const condLabel = keepaCondition === 2 ? 'Like New' : 'Very Good';

    const bestOffer = await findBestOffer(book.isbn, keepaCondition);

    const updateData: Record<string, any> = {
      decision: book.decision as any,
    };
    if (sellerUrl) updateData.seller_url = sellerUrl;
    if (amazonUrl) updateData.amazon_url = amazonUrl;
    if (bestOffer) {
      updateData.best_offer_price = bestOffer.price;
      updateData.best_offer_seller = bestOffer.sellerName;
      withOffer++;
    }

    await updateBookEvaluation(book.isbn, updateData);

    if (bestOffer) {
      const trusted = isTrustedSeller(bestOffer.sellerName) ? '✓' : '?';
      console.log(`  [${updated}/${books.length}] ${book.isbn} → $${(bestOffer.price / 100).toFixed(2)} from ${bestOffer.sellerName} [${trusted}]`);
    } else {
      console.log(`  [${updated}/${books.length}] ${book.isbn} → no ${condLabel} trusted offer`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Updated: ${updated}`);
  console.log(`With trusted offer: ${withOffer}`);
  console.log(`Without: ${updated - withOffer}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
