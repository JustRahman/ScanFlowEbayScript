import { getProductsByIsbns, evaluateBook, waitForKeepaTokens, type KeepaProductRaw } from './keepaApi.js';
import { getPendingBooks, updateBookEvaluation } from './supabase.js';

const KEEPA_BATCH_SIZE = 100;

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

      // Match by ASIN (if book has one) or by ISBN
      const product: KeepaProductRaw | undefined =
        (book.asin ? byAsin.get(book.asin) : undefined) || byIsbn.get(book.isbn);

      if (!product) {
        await updateBookEvaluation(book.isbn, { decision: 'REJECT' });
        noData++;
        console.log(`  [${evaluated}/${pending.length}] ${book.isbn} — no Keepa data → REJECT`);
        continue;
      }

      const buyPriceDollars = (book.price + book.shipping) / 100;
      const result = evaluateBook(product, buyPriceDollars);

      const amazonPriceCents = result.amazonPrice != null ? Math.round(result.amazonPrice * 100) : undefined;
      const fbaProfitCents = result.fbaProfit != null ? Math.round(result.fbaProfit * 100) : undefined;
      const fbmProfitCents = result.fbmProfit != null ? Math.round(result.fbmProfit * 100) : undefined;
      const weightOz = result.weightLbs != null ? Math.round(result.weightLbs * 16 * 10) / 10 : undefined;

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
      });

      if (result.decision === 'BUY') buy++;
      else if (result.decision === 'REVIEW') review++;
      else reject++;

      console.log(`  [${evaluated}/${pending.length}] ${book.isbn} → ${result.decision} (${result.reason})`);
    }
  }

  return { evaluated, buy, review, reject, noData };
}
