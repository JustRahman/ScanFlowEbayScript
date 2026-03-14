import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = join(__dirname, '..', 'data', 'rejected_isbns.txt');

async function main() {
  console.log('=== Export REJECT + NOT FOUND ISBNs ===\n');

  const isbns: string[] = [];

  for (const decision of ['REJECT', 'NOT FOUND']) {
    let from = 0;
    const pageSize = 1000;
    let count = 0;

    while (true) {
      const { data, error } = await supabase
        .from('ebay_books')
        .select('isbn')
        .eq('decision', decision)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error(`Error fetching ${decision}:`, error.message);
        break;
      }
      if (!data || data.length === 0) break;

      for (const row of data) {
        isbns.push(row.isbn);
      }
      count += data.length;
      process.stdout.write(`\r  Loading ${decision}: ${count}...`);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    if (count > 0) console.log(`\r  ${decision}: ${count} ISBNs`);
  }

  console.log(`\nTotal: ${isbns.length} ISBNs`);

  writeFileSync(OUTPUT_FILE, isbns.join('\n') + '\n');
  console.log(`Saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
