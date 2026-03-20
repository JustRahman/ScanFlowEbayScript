import 'dotenv/config';
import { supabase } from '../src/supabase.js';
import { getProductsByIsbns, evaluateBook, waitForKeepaTokens, type KeepaProductRaw } from '../src/keepaApi.js';
import { updateBookEvaluation } from '../src/supabase.js';
import type { EbayBook } from '../src/supabase.js';

const BATCH_SIZE = 100;
const seller = process.argv[2]; // optional: pass seller name as argument

async function main() {
  console.log('=== Evaluate Pending Books (decision = NULL) ===\n');
  if (seller) console.log(`Filtering by seller: ${seller}\n`);

  const books: EbayBook[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    let query = supabase
      .from('ebay_books')
      .select('*')
      .is('decision', null)
      .neq('seller', 'second.sale')
      .order('scraped_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (seller) query = query.eq('seller', seller);
    const { data, error } = await query;

    if (error) {
      console.error('Error fetching pending books:', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    books.push(...(data as EbayBook[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`Found ${books.length} pending books to evaluate\n`);
  if (books.length === 0) return;

  let evaluated = 0;
  let buy = 0;
  let review = 0;
  let reject = 0;
  let notFound = 0;

  const safeInt = (v: number | null | undefined): number | undefined => {
    if (v == null || !Number.isFinite(v)) return undefined;
    const rounded = Math.round(v);
    if (rounded > 2_000_000_000 || rounded < -2_000_000_000) return undefined;
    return rounded;
  };

  for (let i = 0; i < books.length; i += BATCH_SIZE) {
    const batch = books.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(books.length / BATCH_SIZE);

    await waitForKeepaTokens();

    const isbns = batch.map(b => b.isbn);
    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} books)...`);

    const { byAsin, byIsbn } = await getProductsByIsbns(isbns);

    for (const book of batch) {
      evaluated++;

      const product: KeepaProductRaw | undefined =
        (book.asin ? byAsin.get(book.asin) : undefined) || byIsbn.get(book.isbn);

      if (!product) {
        await updateBookEvaluation(book.isbn, { decision: 'NOT FOUND' });
        notFound++;
        console.log(`  [${evaluated}/${books.length}] ${book.isbn} — no Keepa data → NOT FOUND`);
        continue;
      }

      const buyPriceDollars = (book.price + book.shipping) / 100;
      const result = evaluateBook(product, buyPriceDollars);

      const amazonPriceCents = result.amazonPrice != null ? Math.round(result.amazonPrice * 100) : undefined;
      const fbaProfitCents = result.fbaProfit != null ? Math.round(result.fbaProfit * 100) : undefined;
      const fbmProfitCents = result.fbmProfit != null ? Math.round(result.fbmProfit * 100) : undefined;
      const weightOz = result.weightLbs != null ? Math.round(result.weightLbs * 16 * 10) / 10 : undefined;

      await updateBookEvaluation(book.isbn, {
        decision: result.decision as any,
        asin: result.asin,
        amazon_price: safeInt(amazonPriceCents),
        sales_rank: safeInt(result.salesRank),
        sales_rank_drops_90: safeInt(result.salesRankDrops90),
        fba_profit: safeInt(fbaProfitCents),
        fbm_profit: safeInt(fbmProfitCents),
        amazon_flag: result.amazonFlag ?? undefined,
        book_type: result.binding ?? undefined,
        weight_oz: weightOz != null && Number.isFinite(weightOz) ? weightOz : undefined,
      });

      if (result.decision === 'BUY') buy++;
      else if (result.decision === 'REVIEW') review++;
      else reject++;

      console.log(`  [${evaluated}/${books.length}] ${book.isbn} → ${result.decision} (${result.reason})`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Evaluated: ${evaluated}`);
  console.log(`  BUY: ${buy}`);
  console.log(`  REVIEW: ${review}`);
  console.log(`  REJECT: ${reject}`);
  console.log(`  NOT FOUND: ${notFound}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
