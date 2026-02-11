import 'dotenv/config';
import { SELLERS, SEARCHES } from './config.js';
import { scrapeAllListings } from './ebayApi.js';
import { getExistingISBNs, insertBooks, getCheckpoint, saveCheckpoint, resetCheckpoint } from './supabase.js';
import { evaluatePendingBooks } from './evaluate.js';

async function main() {
  console.log('=== ScanFlow Fetcher ===\n');

  // Step 1: Evaluate pending books (decision = NULL) via Keepa
  const evalResult = await evaluatePendingBooks();

  // Step 2: Load existing ISBNs for dedup
  const existingISBNs = await getExistingISBNs();
  let totalNew = 0;
  let totalSkipped = 0;

  // Step 3: Scrape all sellers × categories
  for (const seller of SELLERS) {
    console.log(`\nSeller: ${seller}`);

    for (const search of SEARCHES) {
      console.log(`  Search: ${search.name} ("${search.query}")`);

      try {
        const startOffset = await getCheckpoint(seller, search.query);
        if (startOffset > 0) {
          console.log(`    Resuming from page ${startOffset / 200 + 1} (offset ${startOffset})`);
        }

        const result = await scrapeAllListings(
          seller,
          search.query,
          existingISBNs,
          async (books, pageNum) => {
            const insertResult = await insertBooks(books);
            console.log(`      → Inserted ${insertResult.saved}, ${insertResult.duplicates} dups, ${insertResult.errors} errors`);
            totalNew += insertResult.saved;
            totalSkipped += insertResult.duplicates;
          },
          startOffset,
          async (nextOffset) => {
            await saveCheckpoint(seller, search.query, nextOffset);
          },
        );

        if (result.completed) {
          await resetCheckpoint(seller, search.query);
          console.log(`    Checkpoint reset — full results scraped`);
        }

        console.log(`  ${search.name} done: ${result.totalScraped} scraped, ${result.totalWithISBN} with ISBN, ${result.totalNew} new`);
      } catch (error) {
        console.error(`  ${search.name}: ERROR -`, error instanceof Error ? error.message : error);
      }
    }
  }

  console.log(`\nScraping complete: ${totalNew} new books inserted, ${totalSkipped} skipped`);

  // Step 4: Summary
  console.log('\n=== Summary ===');
  console.log(`Scraped: ${totalNew} new, ${totalSkipped} skipped`);
  console.log(`Evaluated: ${evalResult.evaluated} total`);
  console.log(`  BUY: ${evalResult.buy}`);
  console.log(`  REVIEW: ${evalResult.review}`);
  console.log(`  REJECT: ${evalResult.reject}`);
  console.log(`  No Keepa data: ${evalResult.noData}`);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
