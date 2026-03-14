import 'dotenv/config';
import { supabase } from '../src/supabase.js';
import { getCachedSellerNames, cacheSellerNames, updateBookEvaluation } from '../src/supabase.js';
import type { EbayBook } from '../src/supabase.js';

const KEEPA_API_KEY = process.env.KEEPA_API_KEY || '';
const KEEPA_API_BASE = 'https://api.keepa.com';

const ISBNS = [
  '9780321909077','9780199329960','9780914901129','9780323414142','9780073380322',
  '9781452276403','9780134444321','9781684671502','9781556203541','9781732199323',
  '9781605355559','9780323655538','9781591663997','9781531936983','9780132850643',
  '9780321934925','9780134801148','9781495189050','9780195130454','9780803924314',
  '9781119492986','9781558532779','9780132279383','9781284108323','9780545128889',
  '9781636598963','9781644970812','9780913087015','9783030457914','9780323532044',
  '9781547604241','9780787984960','9780997787603','9780323875110','9781573441971',
  '9781250016980','9780062853370','9780133110494','9780135974445','9780986436338',
  '9781335526526','9780738582375','9781506336244','9781285444550','9781606418130',
  '9781581809541','9781564849281','9781586447281','9780809139316','9781483319889',
];

const SELLER_URL_MAP: Record<string, (isbn: string) => string> = {
  'booksrun': (isbn) => `https://booksrun.com/categories?sr=${isbn}`,
  'second.sale': (isbn) => `https://booksrun.com/categories?sr=${isbn}`,
  'betterworldbooks': (isbn) => `https://www.betterworldbooks.com/product/detail/${isbn}`,
};

function getSellerUrl(sellerName: string, isbn: string): string | undefined {
  const fn = SELLER_URL_MAP[sellerName];
  return fn ? fn(isbn) : undefined;
}

const SELLER_KEEPA_CONDITION: Record<string, number> = {
  'booksrun': 3, 'second.sale': 3,
  'thriftbooks.store': 2, 'oneplanetbooks': 2, 'betterworldbooks': 2,
  'baystatebooks': 2, 'Awesomebooksusa': 2,
};

function getKeepaCondition(sellerName: string): number {
  return SELLER_KEEPA_CONDITION[sellerName] ?? 2;
}

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

async function resolveSellerNames(sellerIds: string[]): Promise<Record<string, string>> {
  if (sellerIds.length === 0) return {};
  const cached = await getCachedSellerNames(sellerIds);
  const unknown = sellerIds.filter(id => !cached[id]);
  if (unknown.length === 0) return cached;

  try {
    const resp = await fetch(`${KEEPA_API_BASE}/seller?key=${KEEPA_API_KEY}&domain=1&seller=${unknown.join(',')}`);
    const data = await resp.json();
    if (data.sellers) {
      const newNames: Record<string, string> = {};
      for (const [id, info] of Object.entries(data.sellers)) {
        const name = (info as any).sellerName || id;
        cached[id] = name;
        newNames[id] = name;
      }
      if (Object.keys(newNames).length > 0) await cacheSellerNames(newNames);
    }
  } catch (err) {
    console.error('  Seller lookup error:', err instanceof Error ? err.message : err);
  }
  for (const id of unknown) { if (!cached[id]) cached[id] = id; }
  return cached;
}

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

    const parsedOffers: { name: string; totalCents: number }[] = [];
    for (const offer of matching) {
      const csv = offer.offerCSV;
      if (!csv || csv.length < 3) continue;
      const price = csv[csv.length - 2];
      const shipping = csv[csv.length - 1];
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
  } catch { return null; }
}

async function main() {
  console.log(`=== Update ${ISBNS.length} specific ISBNs ===\n`);

  // Fetch these books from Supabase
  const { data, error } = await supabase
    .from('ebay_books')
    .select('*')
    .in('isbn', ISBNS);

  if (error) { console.error('Error:', error.message); return; }

  const books = (data || []) as EbayBook[];
  console.log(`Found ${books.length}/${ISBNS.length} books in DB\n`);

  let updated = 0;
  let withOffer = 0;

  for (const book of books) {
    updated++;
    const sellerUrl = getSellerUrl(book.seller, book.isbn);
    const amazonUrl = book.asin ? `https://www.amazon.com/dp/${book.asin}` : undefined;
    const keepaCondition = getKeepaCondition(book.seller);
    const condLabel = keepaCondition === 2 ? 'Like New' : 'Very Good';

    const bestOffer = await findBestOffer(book.isbn, keepaCondition);

    const updateData: Record<string, any> = { decision: book.decision as any };
    if (sellerUrl) updateData.seller_url = sellerUrl;
    if (amazonUrl) updateData.amazon_url = amazonUrl;
    if (bestOffer) {
      updateData.best_offer_price = bestOffer.price;
      updateData.best_offer_seller = bestOffer.sellerName;
      withOffer++;
    }

    await updateBookEvaluation(book.isbn, updateData);

    if (bestOffer) {
      const t = isTrustedSeller(bestOffer.sellerName) ? '✓' : '?';
      console.log(`  [${updated}/${books.length}] ${book.isbn} → $${(bestOffer.price / 100).toFixed(2)} from ${bestOffer.sellerName} [${t}]`);
    } else {
      console.log(`  [${updated}/${books.length}] ${book.isbn} → no ${condLabel} trusted offer`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`With trusted offer: ${withOffer}`);
  console.log(`Without: ${updated - withOffer}`);
}

main().catch(err => { console.error(err); process.exit(1); });
