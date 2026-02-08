import 'dotenv/config';
import { SELLERS, CATEGORIES } from './config.js';
import { scrapeAllListings } from './ebayApi.js';
import { getExistingISBNs, insertBooks } from './supabase.js';
import { evaluatePendingBooks } from './evaluate.js';

async function main() {
  console.log('=== ScanFlow Fetcher ===\n');

  // Step 1: Load existing ISBNs for dedup
  const existingISBNs = await getExistingISBNs();
  let totalNew = 0;
  let totalSkipped = 0;

  // Step 2: Scrape all sellers × categories
  for (const seller of SELLERS) {
    console.log(`\nSeller: ${seller}`);

    for (const cat of CATEGORIES) {
      console.log(`  Category: ${cat.name} (${cat.id})`);

      try {
        const result = await scrapeAllListings(
          seller,
          cat.id,
          existingISBNs,
          async (books, pageNum) => {
            // Insert this page's books to DB immediately
            const insertResult = await insertBooks(books);
            console.log(`      → Inserted ${insertResult.saved}, ${insertResult.duplicates} dups, ${insertResult.errors} errors`);
            totalNew += insertResult.saved;
            totalSkipped += insertResult.duplicates;
          },
        );

        console.log(`  ${cat.name} done: ${result.totalScraped} scraped, ${result.totalWithISBN} with ISBN, ${result.totalNew} new`);
      } catch (error) {
        console.error(`  ${cat.name}: ERROR -`, error instanceof Error ? error.message : error);
      }
    }
  }

  console.log(`\nScraping complete: ${totalNew} new books inserted, ${totalSkipped} skipped`);

  // Step 3: Evaluate pending books via Keepa
  const evalResult = await evaluatePendingBooks();

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
