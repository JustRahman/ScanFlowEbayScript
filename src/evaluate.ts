import { KEEPA_DELAY_MS } from './config.js';
import { getProductByIsbn, evaluateBook } from './keepaApi.js';
import { getPendingBooks, updateBookEvaluation } from './supabase.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function evaluatePendingBooks(): Promise<{
  evaluated: number;
  buy: number;
  review: number;
  reject: number;
  noData: number;
}> {
  const pending = await getPendingBooks();
  console.log(`\nEvaluating ${pending.length} pending books...`);

  let evaluated = 0;
  let buy = 0;
  let review = 0;
  let reject = 0;
  let noData = 0;

  for (const book of pending) {
    const raw = await getProductByIsbn(book.isbn);

    if (!raw) {
      await updateBookEvaluation(book.isbn, {
        decision: 'REJECT',
      });
      noData++;
      evaluated++;
      console.log(`  [${evaluated}/${pending.length}] ${book.isbn} — no Keepa data → REJECT`);
      await sleep(KEEPA_DELAY_MS);
      continue;
    }

    // Buy price in dollars (price + shipping are stored in cents)
    const buyPriceDollars = (book.price + book.shipping) / 100;

    // Run full evaluation (Amazon 1P stockout analysis, multiplier, fees, decision)
    const result = evaluateBook(raw, buyPriceDollars);

    // Convert dollars to cents for DB storage
    const amazonPriceCents = result.amazonPrice != null ? Math.round(result.amazonPrice * 100) : undefined;
    const fbaProfitCents = result.fbaProfit != null ? Math.round(result.fbaProfit * 100) : undefined;
    const fbmProfitCents = result.fbmProfit != null ? Math.round(result.fbmProfit * 100) : undefined;
    const weightOz = result.weightLbs != null ? Math.round(result.weightLbs * 16 * 10) / 10 : undefined;

    await updateBookEvaluation(book.isbn, {
      decision: result.decision,
      asin: result.asin,
      amazon_price: amazonPriceCents,
      sales_rank: result.salesRank != null ? Math.round(result.salesRank) : undefined,
      sales_rank_drops_90: result.salesRankDrops90,
      fba_profit: fbaProfitCents,
      fbm_profit: fbmProfitCents,
      amazon_flag: result.amazonFlag ?? undefined,
      book_type: result.binding ?? undefined,
      weight_oz: weightOz,
    });

    if (result.decision === 'BUY') buy++;
    else if (result.decision === 'REVIEW') review++;
    else reject++;

    evaluated++;
    console.log(`  [${evaluated}/${pending.length}] ${book.isbn} → ${result.decision} (${result.reason})`);

    await sleep(KEEPA_DELAY_MS);
  }

  return { evaluated, buy, review, reject, noData };
}
