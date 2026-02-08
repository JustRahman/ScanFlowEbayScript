import { MIN_PRICE, MAX_PRICE } from './config.js';

const EBAY_API_BASE = 'https://api.ebay.com';
const EBAY_OAUTH_URL = `${EBAY_API_BASE}/identity/v1/oauth2/token`;
const EBAY_BROWSE_URL = `${EBAY_API_BASE}/buy/browse/v1`;
const OAUTH_SCOPES = 'https://api.ebay.com/oauth/api_scope';

const CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const EPN_CAMPAIGN_ID = process.env.EPN_CAMPAIGN_ID || '5339135996';

// OAuth token cache
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  context: string,
): Promise<Response> {
  const maxRetries = 4;
  let delay = 2000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // 401 Unauthorized — token expired, refresh and retry
      if (response.status === 401 && attempt < maxRetries) {
        console.log(`  ${context}: Token expired, refreshing...`);
        cachedToken = null;
        tokenExpiresAt = 0;
        const newToken = await getOAuthToken();
        const headers = new Headers(options.headers);
        headers.set('Authorization', `Bearer ${newToken}`);
        options = { ...options, headers };
        continue;
      }

      // 429 Rate limit
      if (response.status === 429) {
        if (attempt === maxRetries) throw new RateLimitError(`${context}: Rate limit exceeded after ${maxRetries} retries`);
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
        console.log(`  ${context}: Rate limited (429), waiting ${Math.round(waitTime / 1000)}s...`);
        await sleep(waitTime);
        delay *= 2;
        continue;
      }

      // 5xx Server errors
      if (response.status >= 500) {
        if (attempt === maxRetries) throw new Error(`${context}: Server error ${response.status} after ${maxRetries} retries`);
        console.log(`  ${context}: Server error ${response.status}, retrying in ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
        delay *= 2;
        continue;
      }

      // 400-level errors (except 401/429)
      if (response.status >= 400) {
        const body = await response.text();
        throw new Error(`${context}: HTTP ${response.status} — ${body.substring(0, 200)}`);
      }

      return response;
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && error.message.includes('fetch'))) {
        if (attempt === maxRetries) throw new Error(`${context}: Network error after ${maxRetries} retries — ${error}`);
        console.log(`  ${context}: Network error, retrying in ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw error;
    }
  }

  throw new Error(`${context}: Failed after ${maxRetries} retries`);
}

export async function getOAuthToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 300_000) {
    return cachedToken;
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('eBay API credentials not configured (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET)');
  }

  console.log('Fetching eBay OAuth token...');
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const response = await fetchWithRetry(
    EBAY_OAUTH_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(OAUTH_SCOPES)}`,
    },
    'eBay OAuth'
  );

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  console.log(`OAuth token obtained, expires in ${data.expires_in}s`);

  return cachedToken!;
}

export interface ScrapedBook {
  isbn: string;
  title: string;
  price: number;        // cents
  condition: string;
  seller: string;
  category: string;
  ebay_item_id: string;
  ebay_url: string;
  image_url: string | null;
  shipping: number;     // cents
  scraped_at: string;
}

// ── eBay item types ──

interface EbayItem {
  itemId: string;
  title: string;
  price: { value: string; currency: string };
  image?: { imageUrl: string };
  condition?: string;
  seller?: { username: string };
  itemWebUrl: string;
  itemAffiliateWebUrl?: string;
  shippingOptions?: Array<{
    shippingCost?: { value: string; currency: string };
  }>;
  localizedAspects?: Array<{
    type: string;
    name: string;
    value: string;
  }>;
  isbn?: string[];
  gtin?: string;
}

// ── ISBN validation (checksum) ──

function isValidIsbn10(isbn: string): boolean {
  if (isbn.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    if (!/\d/.test(isbn[i])) return false;
    sum += parseInt(isbn[i], 10) * (10 - i);
  }
  const last = isbn[9].toUpperCase();
  sum += last === 'X' ? 10 : parseInt(last, 10);
  return sum % 11 === 0;
}

function isValidIsbn13(isbn: string): boolean {
  if (isbn.length !== 13 || !/^\d{13}$/.test(isbn)) return false;
  if (!isbn.startsWith('978') && !isbn.startsWith('979')) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(isbn[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(isbn[12], 10);
}

function isValidIsbn(isbn: string): boolean {
  return isValidIsbn10(isbn) || isValidIsbn13(isbn);
}

// ── ISBN extraction (validated) ──

function extractISBN(item: EbayItem): string | null {
  // Strategy 1: Direct ISBN field
  if (item.isbn && item.isbn.length > 0) {
    const clean = item.isbn[0].replace(/[-\s]/g, '');
    if (isValidIsbn(clean)) return clean;
  }

  // Strategy 2: GTIN field
  if (item.gtin) {
    const clean = item.gtin.replace(/[-\s]/g, '');
    if (isValidIsbn(clean)) return clean;
  }

  // Strategy 3: localizedAspects (only available in item detail)
  if (item.localizedAspects) {
    const isbnAspect = item.localizedAspects.find(a =>
      a.name.toLowerCase().includes('isbn')
    );
    if (isbnAspect) {
      const clean = isbnAspect.value.replace(/[-\s]/g, '');
      if (isValidIsbn(clean)) return clean;
    }
  }

  return null;
}

// ── Fetch single item detail (for ISBN extraction when summary doesn't have it) ──

async function fetchItemDetail(itemId: string): Promise<EbayItem | null> {
  const token = await getOAuthToken();
  const url = `${EBAY_BROWSE_URL}/item/${itemId}`;

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'X-EBAY-C-ENDUSERCTX': `affiliateCampaignId=${EPN_CAMPAIGN_ID},affiliateReferenceId=scanflow`,
        },
      },
      'eBay Item Detail',
    );

    return await response.json();
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    return null;
  }
}

// ── Main scrape function: page by page, extract ISBNs, fetch details if needed ──

export async function scrapeAllListings(
  seller: string,
  categoryId: string,
  existingISBNs: Set<string>,
  onPageDone: (books: ScrapedBook[], pageNum: number) => Promise<void>,
): Promise<{ totalScraped: number; totalWithISBN: number; totalNew: number; detailFetches: number }> {
  const PAGE_SIZE = 200;
  let offset = 0;
  let pageNum = 0;
  let totalScraped = 0;
  let totalWithISBN = 0;
  let totalNew = 0;
  let detailFetches = 0;
  let consecutiveErrors = 0;

  const token = await getOAuthToken();

  const minPriceDollars = (MIN_PRICE / 100).toFixed(2);
  const maxPriceDollars = (MAX_PRICE / 100).toFixed(2);

  const filters = [
    `sellers:{${seller}}`,
    `price:[${minPriceDollars}..${maxPriceDollars}]`,
    'priceCurrency:USD',
    'conditionIds:{4000}', // Very Good only
    'buyingOptions:{FIXED_PRICE}',
  ].join(',');

  while (true) {
    pageNum++;

    // Step 1: Search page
    const params = new URLSearchParams({
      q: '',
      category_ids: categoryId,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      filter: filters,
      sort: 'newlyListed',
      fieldgroups: 'EXTENDED',
    });

    const searchUrl = `${EBAY_BROWSE_URL}/item_summary/search?${params.toString()}`;

    let searchData: { itemSummaries?: EbayItem[]; total?: number };
    try {
      const response = await fetchWithRetry(
        searchUrl,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            'X-EBAY-C-ENDUSERCTX': `affiliateCampaignId=${EPN_CAMPAIGN_ID},affiliateReferenceId=scanflow`,
          },
        },
        `eBay Search (page ${pageNum})`,
      );
      searchData = await response.json();
    } catch (error) {
      if (error instanceof RateLimitError) {
        console.log(`\n    eBay rate limit hit on search — stopping scrape...`);
        break;
      }
      consecutiveErrors++;
      console.error(`  Page ${pageNum} search failed: ${error}`);
      if (consecutiveErrors >= 3) {
        console.error(`  Stopping: ${consecutiveErrors} consecutive errors`);
        break;
      }
      offset += PAGE_SIZE;
      await sleep(2000);
      continue;
    }
    consecutiveErrors = 0;

    const items: EbayItem[] = searchData.itemSummaries || [];
    if (items.length === 0) break;

    totalScraped += items.length;

    if (pageNum === 1) {
      console.log(`    Total results: ~${searchData.total || 'unknown'}`);
    }

    // Step 2: For each item, try to extract ISBN from summary first,
    // then fetch individual item detail if needed
    const now = new Date().toISOString();
    const booksFromPage: ScrapedBook[] = [];

    let itemIndex = 0;
    let skippedNoIsbn = 0;
    let rateLimited = false;
    for (const item of items) {
      itemIndex++;
      // Try ISBN from search summary
      let isbn = extractISBN(item);

      // If summary had ISBN/GTIN fields but they failed validation, skip detail fetch
      // (detail will have the same bad data)
      const summaryHadData = !!(item.isbn?.length || item.gtin);

      // Only fetch detail if summary had NO ISBN-like fields at all
      if (!isbn && !summaryHadData) {
        detailFetches++;
        try {
          const detail = await fetchItemDetail(item.itemId);
          if (detail) {
            isbn = extractISBN(detail);
            if (detail.itemAffiliateWebUrl) {
              item.itemAffiliateWebUrl = detail.itemAffiliateWebUrl;
            }
          }
        } catch (error) {
          if (error instanceof RateLimitError) {
            console.log(`\n    eBay rate limit hit — stopping scrape, saving collected books...`);
            rateLimited = true;
            break;
          }
          throw error;
        }
        await sleep(150);
      }

      // Progress log every 20 items
      if (itemIndex % 20 === 0) {
        process.stdout.write(`\r    Page ${pageNum}: ${itemIndex}/${items.length} items processed, ${booksFromPage.length} new...`);
      }

      if (!isbn) {
        skippedNoIsbn++;
        continue;
      }

      // Skip if already in DB
      if (existingISBNs.has(isbn)) continue;

      const priceCents = Math.round(parseFloat(item.price.value) * 100);
      const shippingCents = item.shippingOptions?.[0]?.shippingCost
        ? Math.round(parseFloat(item.shippingOptions[0].shippingCost.value) * 100)
        : 0;

      booksFromPage.push({
        isbn,
        title: item.title,
        price: priceCents,
        condition: item.condition || 'Very Good',
        seller,
        category: categoryId,
        ebay_item_id: item.itemId,
        ebay_url: item.itemAffiliateWebUrl || item.itemWebUrl,
        image_url: item.image?.imageUrl || null,
        shipping: shippingCents,
        scraped_at: now,
      });
    }

    const isbnCount = booksFromPage.length + items.filter(i => existingISBNs.has(extractISBN(i) || '')).length;
    totalWithISBN += isbnCount;
    totalNew += booksFromPage.length;

    process.stdout.write(`\r`);
    console.log(`    Page ${pageNum}: ${items.length} listings, ${detailFetches} detail fetches, ${booksFromPage.length} new books`);

    // Step 3: Insert this page's books immediately
    if (booksFromPage.length > 0) {
      await onPageDone(booksFromPage, pageNum);
      for (const book of booksFromPage) {
        existingISBNs.add(book.isbn);
      }
    }

    // Stop entirely if rate limited
    if (rateLimited) break;

    // Stop if we got fewer than a full page
    if (items.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    await sleep(300);
  }

  return { totalScraped, totalWithISBN, totalNew, detailFetches };
}
