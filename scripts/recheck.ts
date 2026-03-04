/**
 * Recheck script — verify eBay availability and re-evaluate BUY/REVIEW books.
 *
 * Usage: npm run recheck
 *        SELLER=booksrun npx tsx scripts/recheck.ts
 */

import 'dotenv/config';
import { getBooksForRecheck, updateBookEvaluation, type EbayBook } from '../src/supabase.js';
import { fetchItemDetail } from '../src/ebayApi.js';
import { getProductsByIsbns, evaluateBook, waitForKeepaTokens } from '../src/keepaApi.js';

const CONCURRENCY = 8;
const KEEPA_BATCH_SIZE = 100;

const seller = process.env.SELLER || undefined;
const skipEbay = process.env.SKIP_EBAY === '1';
const includeReject = process.env.INCLUDE_REJECT === '1';

async function checkEbayAvailability(books: EbayBook[]): Promise<{ available: EbayBook[]; soldOut: EbayBook[] }> {
  const available: EbayBook[] = [];
  const soldOut: EbayBook[] = [];
  let done = 0;

  // Process in parallel with concurrency limit
  const queue = [...books];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const book = queue.shift()!;
      const idx = ++done;
      try {
        const detail = await fetchItemDetail(book.ebay_item_id);
        if (detail) {
          available.push(book);
          console.log(`  [${idx}/${books.length}] ${book.isbn} — still available`);
        } else {
          soldOut.push(book);
          console.log(`  [${idx}/${books.length}] ${book.isbn} — SOLD OUT`);
        }
      } catch {
        // Network/API error — assume still available to avoid false sold-out
        available.push(book);
        console.log(`  [${idx}/${books.length}] ${book.isbn} — check failed, keeping`);
      }
    }
  });

  await Promise.all(workers);
  return { available, soldOut };
}

async function recheckWithKeepa(books: EbayBook[]): Promise<{
  changes: { isbn: string; oldDecision: string; newDecision: string }[];
  tokensUsed: number;
}> {
  const changes: { isbn: string; oldDecision: string; newDecision: string }[] = [];
  let tokensUsed = 0;
  const totalBatches = Math.ceil(books.length / KEEPA_BATCH_SIZE);

  for (let i = 0; i < books.length; i += KEEPA_BATCH_SIZE) {
    const batch = books.slice(i, i + KEEPA_BATCH_SIZE);
    const batchNum = Math.floor(i / KEEPA_BATCH_SIZE) + 1;

    await waitForKeepaTokens();

    const isbns = batch.map(b => b.isbn);
    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} books)...`);

    const { byAsin, byIsbn, tokensConsumed } = await getProductsByIsbns(isbns);
    tokensUsed += tokensConsumed;
    console.log(`    1 API call, ${tokensConsumed} tokens consumed`);

    for (const book of batch) {
      // Match by ASIN or ISBN
      const product = (book.asin ? byAsin.get(book.asin) : undefined) || byIsbn.get(book.isbn);
      if (!product) {
        if (book.asin) {
          console.log(`    ${book.isbn}: no Keepa data returned`);
        }
        continue;
      }

      const buyPrice = (book.price + book.shipping) / 100;
      const evalResult = evaluateBook(product, buyPrice);
      const oldDecision = book.decision!;
      const newDecision = evalResult.decision;

      let marker = '';
      if (oldDecision !== newDecision) {
        changes.push({ isbn: book.isbn, oldDecision, newDecision });
        if (oldDecision === 'REVIEW' && newDecision === 'BUY') {
          marker = ' ★ UPGRADE';
        } else if (oldDecision === 'REJECT' && (newDecision === 'BUY' || newDecision === 'REVIEW')) {
          marker = ' ★ UPGRADE';
        } else if (
          (oldDecision === 'BUY' && (newDecision === 'REJECT' || newDecision === 'REVIEW')) ||
          (oldDecision === 'REVIEW' && newDecision === 'REJECT')
        ) {
          marker = ' ✗ DOWNGRADE';
        }
        console.log(`    ${book.isbn}: ${oldDecision} → ${newDecision}${marker} (${evalResult.reason})`);
      } else {
        console.log(`    ${book.isbn}: ${oldDecision} → ${newDecision} (no change)`);
      }

      await updateBookEvaluation(book.isbn, {
        decision: evalResult.decision,
        asin: evalResult.asin,
        amazon_price: evalResult.amazonPrice != null ? Math.round(evalResult.amazonPrice * 100) : undefined,
        sales_rank: evalResult.salesRank ?? undefined,
        sales_rank_drops_90: evalResult.salesRankDrops90,
        fba_profit: evalResult.fbaProfit != null ? Math.round(evalResult.fbaProfit * 100) : undefined,
        fbm_profit: evalResult.fbmProfit != null ? Math.round(evalResult.fbmProfit * 100) : undefined,
        amazon_flag: evalResult.amazonFlag ?? undefined,
        book_type: evalResult.binding ?? undefined,
        weight_oz: evalResult.weightLbs ? Math.round(evalResult.weightLbs * 16) : undefined,
      });
    }
  }

  return { changes, tokensUsed };
}

async function main() {
  console.log('=== ScanFlow Recheck ===\n');

  if (seller) {
    console.log(`Seller: ${seller}`);
  } else {
    console.log('Seller: all');
  }

  // 1. Load books
  const books = await getBooksForRecheck(seller, includeReject);
  const buyCount = books.filter(b => b.decision === 'BUY').length;
  const reviewCount = books.filter(b => b.decision === 'REVIEW').length;
  const rejectCount = books.filter(b => b.decision === 'REJECT').length;
  console.log(`Loaded ${buyCount} BUY + ${reviewCount} REVIEW + ${rejectCount} REJECT books (${books.length} total)\n`);

  if (books.length === 0) {
    console.log('Nothing to recheck.');
    return;
  }

  let available: EbayBook[];
  let soldOut: EbayBook[] = [];

  if (skipEbay) {
    console.log('--- Skipping eBay availability check (SKIP_EBAY=1) ---\n');
    available = books;
  } else {
    // 2. Check eBay availability
    console.log('--- Checking eBay availability ---');
    const result = await checkEbayAvailability(books);
    available = result.available;
    soldOut = result.soldOut;
    console.log(`  eBay check done: ${available.length} available, ${soldOut.length} sold out\n`);

    // Mark sold out books
    for (const book of soldOut) {
      await updateBookEvaluation(book.isbn, { decision: 'SOLD_OUT' });
    }
  }

  // 3. Re-evaluate available books with Keepa
  const booksWithAsin = available.filter(b => b.asin);
  const booksWithoutAsin = available.filter(b => !b.asin);
  if (booksWithoutAsin.length > 0) {
    console.log(`Skipping ${booksWithoutAsin.length} books without ASIN for Keepa re-eval`);
  }

  let changes: { isbn: string; oldDecision: string; newDecision: string }[] = [];
  let tokensUsed = 0;

  if (booksWithAsin.length > 0) {
    console.log(`--- Re-evaluating with Keepa (batch mode) ---`);
    const result = await recheckWithKeepa(booksWithAsin);
    changes = result.changes;
    tokensUsed = result.tokensUsed;
  }

  // 4. Summary
  console.log('\n=== Summary ===');
  console.log(`  Total checked:    ${books.length}`);
  console.log(`  Still available:  ${available.length}`);
  console.log(`  Sold out:         ${soldOut.length}`);
  console.log(`  Decision changes: ${changes.length}`);

  if (changes.length > 0) {
    const changeCounts: Record<string, number> = {};
    for (const c of changes) {
      const key = `${c.oldDecision} → ${c.newDecision}`;
      changeCounts[key] = (changeCounts[key] || 0) + 1;
    }
    for (const [key, count] of Object.entries(changeCounts)) {
      console.log(`    ${key}: ${count}`);
    }
  }

  console.log(`  Keepa tokens used: ${tokensUsed}`);
}

main().catch(err => {
  console.error('Recheck failed:', err);
  process.exit(1);
});
