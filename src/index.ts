import 'dotenv/config';
import { SELLER, CONDITION_ID, EVAL_BATCH_SIZE, SEARCHES } from './config.js';
import { scrapeAllListings } from './ebayApi.js';
import { getExistingISBNs, insertBooks, getCheckpoint, saveCheckpoint } from './supabase.js';
import { evaluatePendingBooks } from './evaluate.js';

async function main() {
  console.log('=== ScanFlow Fetcher ===\n');

  const existingISBNs = await getExistingISBNs();
  let totalNew = 0;
  let totalSkipped = 0;
  let totalEval = { evaluated: 0, buy: 0, review: 0, reject: 0, noData: 0 };

  console.log(`\nSeller: ${SELLER} (condition: ${CONDITION_ID}, eval every ${EVAL_BATCH_SIZE} new books)`);

  for (const search of SEARCHES) {
    console.log(`\n  Search: ${search.name} [cat:${search.categoryId}]`);

    let searchDone = false;

    while (!searchDone) {
      const startOffset = await getCheckpoint(SELLER, search.key);
      if (startOffset > 0) {
        console.log(`    Resuming from offset ${startOffset}`);
      }

      try {
        let batchNew = 0;

        const result = await scrapeAllListings(
          SELLER,
          search.query,
          existingISBNs,
          async (books) => {
            const insertResult = await insertBooks(books);
            console.log(`      → Inserted ${insertResult.saved}, ${insertResult.duplicates} dups, ${insertResult.errors} errors`);
            totalNew += insertResult.saved;
            batchNew += insertResult.saved;
            totalSkipped += insertResult.duplicates;
          },
          startOffset,
          async (nextOffset) => {
            await saveCheckpoint(SELLER, search.key, nextOffset);
          },
          search.categoryId,
          CONDITION_ID,
          EVAL_BATCH_SIZE,
        );

        console.log(`    Batch: ${result.totalScraped} scraped, ${result.totalNew} new`);

        if (result.completed) {
          console.log(`    ${search.name} — reached end of results`);
          searchDone = true;
        }

        // Evaluate pending books after each batch
        if (batchNew > 0) {
          console.log(`\n    --- Evaluating pending books ---`);
          const evalResult = await evaluatePendingBooks(SELLER);
          totalEval.evaluated += evalResult.evaluated;
          totalEval.buy += evalResult.buy;
          totalEval.review += evalResult.review;
          totalEval.reject += evalResult.reject;
          totalEval.noData += evalResult.noData;
          console.log(`    --- Eval done: ${evalResult.buy} BUY, ${evalResult.review} REVIEW, ${evalResult.reject} REJECT ---\n`);
        } else {
          searchDone = true;
        }
      } catch (error) {
        console.error(`  ${search.name}: ERROR -`, error instanceof Error ? error.message : error);
        searchDone = true;
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Scraped: ${totalNew} new, ${totalSkipped} skipped`);
  console.log(`Evaluated: ${totalEval.evaluated} total`);
  console.log(`  BUY: ${totalEval.buy}`);
  console.log(`  REVIEW: ${totalEval.review}`);
  console.log(`  REJECT: ${totalEval.reject}`);
  console.log(`  No Keepa data: ${totalEval.noData}`);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
