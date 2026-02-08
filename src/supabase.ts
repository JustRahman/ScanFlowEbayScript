import { createClient } from '@supabase/supabase-js';
import type { ScrapedBook } from './ebayApi.js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey);

const TABLE = 'ebay_books';

export interface EbayBook {
  id?: number;
  isbn: string;
  title: string;
  price: number;
  condition: string;
  seller: string;
  category: string;
  ebay_item_id: string;
  ebay_url: string;
  image_url: string | null;
  shipping: number;
  scraped_at: string;
  decision: 'BUY' | 'REVIEW' | 'REJECT' | 'BOUGHT' | null;
  asin: string | null;
  amazon_price: number | null;
  sales_rank: number | null;
  sales_rank_drops_90: number | null;
  fba_profit: number | null;
  fbm_profit: number | null;
  amazon_flag: string | null;
  book_type: string | null;
  weight_oz: number | null;
  evaluated_at: string | null;
  bought_at: string | null;
}

/**
 * Load all existing ISBNs from DB (paginated) into a Set for dedup.
 */
export async function getExistingISBNs(): Promise<Set<string>> {
  const isbns = new Set<string>();
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('isbn')
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('Error loading existing ISBNs:', error.message);
      break;
    }

    if (!data || data.length === 0) break;
    data.forEach((row: { isbn: string }) => isbns.add(row.isbn));
    from += pageSize;
    if (data.length < pageSize) break;
  }

  console.log(`Loaded ${isbns.size} existing ISBNs from DB`);
  return isbns;
}

/**
 * Insert books one by one, skipping duplicates (23505).
 */
export async function insertBooks(books: ScrapedBook[]): Promise<{ saved: number; duplicates: number; errors: number }> {
  let saved = 0;
  let duplicates = 0;
  let errors = 0;

  for (const book of books) {
    const { error } = await supabase.from(TABLE).insert(book);

    if (error) {
      if (error.code === '23505') {
        duplicates++;
      } else {
        console.error(`  Insert error for ${book.isbn}: ${error.message}`);
        errors++;
      }
    } else {
      saved++;
    }
  }

  return { saved, duplicates, errors };
}

/**
 * Get books that haven't been evaluated yet.
 */
export async function getPendingBooks(limit: number = 500): Promise<EbayBook[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .is('decision', null)
    .order('scraped_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('Error fetching pending books:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Update a book with evaluation results.
 */
export async function updateBookEvaluation(isbn: string, evaluation: {
  decision: 'BUY' | 'REVIEW' | 'REJECT';
  asin?: string;
  amazon_price?: number;
  sales_rank?: number;
  sales_rank_drops_90?: number;
  fba_profit?: number;
  fbm_profit?: number;
  amazon_flag?: string;
  book_type?: string;
  weight_oz?: number;
}): Promise<boolean> {
  const { error } = await supabase
    .from(TABLE)
    .update({
      ...evaluation,
      evaluated_at: new Date().toISOString(),
    })
    .eq('isbn', isbn);

  if (error) {
    console.error(`  Update error for ${isbn}: ${error.message}`);
    return false;
  }

  return true;
}
