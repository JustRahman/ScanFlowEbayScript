# ScanFlowFetcher — System Documentation

## Overview

ScanFlowFetcher is a book arbitrage pipeline. It scrapes used/like-new book listings from eBay sellers, evaluates them against Amazon data via Keepa API, and makes BUY/REVIEW/REJECT decisions. The goal: find books listed cheaply on eBay that sell for significantly more on Amazon.

**Tech stack:** TypeScript, eBay Browse API, Keepa API, Supabase (PostgreSQL).

**Deployment:** Railway (one service per seller, controlled by `SELLER` env var).

---

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  eBay Browse  │────>│   Scraper    │────>│   Supabase   │────>│  Evaluator   │
│     API       │     │ (ebayApi.ts) │     │ (ebay_books) │     │(evaluate.ts) │
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                      │
                                          ┌──────────────┐            │
                                          │  Keepa API   │<───────────┘
                                          │ (keepaApi.ts) │
                                          └──────┬───────┘
                                                 │
                                          ┌──────▼───────┐
                                          │   Decision   │
                                          │ BUY/REVIEW/  │
                                          │ REJECT/NOTFND│
                                          └──────────────┘
```

---

## File Structure

```
src/
  config.ts     — Seller configs, search definitions, decision thresholds, fee structure
  index.ts      — Main entry point: startup, scrape loop, evaluation loop
  ebayApi.ts    — eBay OAuth, Browse API search, item detail fetch, ISBN extraction
  keepaApi.ts   — Keepa product lookup (batch + single), price analysis, decision logic
  evaluate.ts   — Evaluation orchestrator: Keepa calls, offer search, seller URLs
  supabase.ts   — Database operations: insert, update, dedup, checkpoints, seller cache
scripts/
  export-rejected.ts         — Export REJECT/NOT FOUND ISBNs to local file
  recheck-not-found.ts       — Re-evaluate NOT FOUND books
  update-buy-review-offers.ts — Backfill BUY/REVIEW with offer data
  update-specific-isbns.ts   — Update specific ISBNs with offer data
```

---

## Step-by-Step Flow (Full Catalog Scrape)

### Phase 1: Startup & Dedup Loading

1. Load `SELLER` from env var (e.g., `booksrun`, `thriftbooks`, `bwb`)
2. Fetch all existing ISBNs from `ebay_books` Supabase table → `existingISBNs` Set
3. Fetch rejected ISBNs from remote file via ngrok (`REJECT_FILE_URL`) → merge into `existingISBNs`
4. Total dedup set = DB ISBNs + rejected file ISBNs (typically 130K+)

### Phase 2: eBay Scraping

For each **search** defined in the seller config (sequentially):

1. **Resume from checkpoint** — reads `fetcher_checkpoints` table for last saved offset
2. **eBay Browse API call** — `GET /buy/browse/v1/item_summary/search`
   - Sorted by `newlyListed` (newest first)
   - Page size: 200 items
   - Filters: seller, price range ($4-$30), condition, fixed price only
   - Optional keyword query (e.g., `medicine textbook`)
3. **ISBN extraction** for each item:
   - Try `isbn` field from search summary
   - Try `gtin` field from search summary
   - If neither has valid data → fetch individual item detail (`/item/{id}`) and check `localizedAspects`
   - Validate ISBN checksum (ISBN-10 and ISBN-13)
4. **Dedup check** — skip if ISBN already in `existingISBNs`
5. **Insert to Supabase** — save new books with `decision: null` (pending)
6. **Save checkpoint** — after each page, save offset to `fetcher_checkpoints` for resume
7. **Batch limit** — after `evalBatchSize` new books found, pause scraping for evaluation
8. **Loop** — after evaluation, resume scraping from checkpoint until all pages exhausted

### Phase 3: Keepa Evaluation

After each scrape batch:

1. **Fetch pending books** — query `ebay_books WHERE decision IS NULL`
2. **Batch Keepa lookup** — up to 100 ISBNs per API call (1 token/book)
   - `GET /product?code={isbn1,isbn2,...}&stats=180&history=1`
   - Maps results by both ASIN (ISBN-10 for books) and ISBN-13 (`eanList`)
   - Invalid ISBNs pre-filtered; batch failures trigger one-by-one retry
3. **For each book**, run decision logic (see Decision Logic below)
4. **For BUY/REVIEW books only**, additionally:
   - Generate seller URL (booksrun/bwb website link)
   - Generate Amazon URL (`amazon.com/dp/{ASIN}`)
   - Fetch Amazon offers (20 tokens/book) → find cheapest trusted seller
5. **Update Supabase** with decision + all metrics

---

## Sellers

| Key              | eBay Username       | Condition  | Condition ID | Searches                    |
|------------------|---------------------|------------|--------------|-----------------------------|
| booksrun         | booksrun            | Very Good  | 4000         | edu, all + 6 keyword        |
| secondsale       | second.sale         | Very Good  | 4000         | edu, all                    |
| thriftbooks      | thriftbooks.store   | Like New   | 2750         | all                         |
| oneplanetbook    | oneplanetbooks      | Like New   | 2750         | edu, all + 6 keyword        |
| bwb              | betterworldbooks    | Like New   | 2750         | edu, all                    |
| baystatebooks    | baystatebooks       | Like New   | 2750         | edu                         |
| awesomebooksusa  | Awesomebooksusa     | Like New   | 2750         | edu                         |

### Search Categories

| Key  | Category ID | Query                  | Description                        |
|------|-------------|------------------------|------------------------------------|
| edu  | 2228        | (empty)                | Textbooks, Education & Reference   |
| all  | 267         | (empty)                | All Books                          |
| med  | 267         | medicine textbook      | Medicine Textbooks (keyword)       |
| biz  | 267         | business textbook      | Business Textbooks (keyword)       |
| eng  | 267         | engineering textbook   | Engineering Textbooks (keyword)    |
| cs   | 267         | computer science       | CS Textbooks (keyword)             |
| math | 267         | mathematics textbook   | Math Textbooks (keyword)           |
| law  | 267         | law textbook           | Law Textbooks (keyword)            |

---

## Decision Logic

### Input Data (from Keepa)

| Metric               | Source                              | Description                                       |
|----------------------|-------------------------------------|---------------------------------------------------|
| Amazon Price         | `analyzeAmazonPresence()`           | Realistic sell price (see Price Calculation below) |
| Sales Rank (avg)     | `stats.avg[3]` (180-day average)    | How popular the book is (lower = better)           |
| Sales Rank Drops 90  | `stats.salesRankDrops90`            | Number of sales in last 90 days                    |
| Amazon Flag          | `analyzeAmazonPresence()`           | green/yellow/red (Amazon 1P competition)           |
| Weight               | `itemWeight` or `packageWeight`     | In ounces (for shipping calc)                      |
| Binding              | `binding`                           | Hardcover, Paperback, etc.                         |

### Amazon Sell Price Calculation (analyzeAmazonPresence)

This is the most complex part. It determines what price you can realistically sell at:

1. **Walk Amazon 1P price history** (last 90 days) — `csv[0]` (Amazon price time series)
2. **Calculate stockout percentage** — how often Amazon 1P was out of stock (price = -1)
3. **During Amazon stockout periods**, collect buy box prices — `csv[18]` (buy box history)
4. **Realistic price = median of buy box prices during Amazon stockout**
   - This is the price 3rd party sellers actually get when Amazon isn't competing
5. **Amazon flag:**
   - `green` = Amazon out of stock >50% of time (good — less competition)
   - `yellow` = Amazon out 20-50%
   - `red` = Amazon in stock >80% (bad — Amazon undercuts you)
6. **Fallbacks:**
   - If stockout = 0% (Amazon always in stock) → use current 3rd party new price, flag = red
   - If no realistic price available → use min(180-day avg, current) from FBA/FBM/Used prices

### Multiplier

```
multiplier = amazonPrice / buyPrice
```

Where `buyPrice = (eBay price + eBay shipping) / 100` in dollars.

### Fee Calculation

```
FBA Profit = amazonPrice - buyPrice - (amazonPrice * 15%) - $1.80 closing - $3.50 FBA fee
FBM Profit = amazonPrice - buyPrice - (amazonPrice * 15%) - $1.80 closing - $4.00 shipping
```

### Decision Thresholds

#### Knockout (immediate REJECT):
- Sales rank > 3,000,000
- Multiplier < 4x
- Zero sales in 90 days (salesRankDrops90 = 0)
- No Amazon price data
- Unknown sales rank

#### BUY (all must be true):
- Multiplier >= 6x
- Sales rank < 1,700,000 (or < 2,000,000 if buy price < $6)
- Sales rank drops 90 >= 3

#### BUY — High Profit Exception:
- Gross profit (amazonPrice - buyPrice) >= $60
- Sales rank < 1,700,000
- Sales rank drops 90 >= 5

#### REVIEW (all must be true):
- Multiplier >= 4x
- Sales rank < 2,500,000
- Sales rank drops 90 >= 2

#### REJECT:
- Everything else that passes knockout but fails BUY and REVIEW

#### NOT FOUND:
- No Keepa data returned for the ISBN (book doesn't exist on Amazon)

### Price Range Filter (eBay)

Only books priced $4.00 - $30.00 on eBay are scraped.

---

## Amazon Offer Search (for BUY/REVIEW only)

After a book is marked BUY or REVIEW, the system searches for the cheapest offer from a trusted seller on Amazon:

1. **Keepa API call** — `GET /product?code={isbn}&offers=20` (costs 20 tokens)
2. **Filter offers by condition** — matches the eBay seller's condition:
   - booksrun, second.sale → condition 3 (Very Good)
   - All others → condition 2 (Like New)
3. **Freshness filter** — only offers seen within the last 7 days (`lastSeen` in Keepa minutes)
4. **Parse offerCSV** — flat triplets `[time, price, shipping, time, price, shipping, ...]`
   - Current price = `csv[csv.length - 2]`
   - Current shipping = `csv[csv.length - 1]`
   - Total = price + shipping (if shipping > 0)
5. **Resolve seller names** — Keepa `/seller` API (1 token/seller), cached in `keepa_sellers` Supabase table
6. **Find cheapest trusted seller** — match seller name against 23 trusted patterns (case-insensitive contains)
7. **If no trusted seller found → skip** (no offer saved, no amazon link)

### Trusted Seller Patterns

```
thrift, goodwill, greatbookprices, zuber, rockymtntext, betterworldbooks,
textbook, booksrun, zoombookscompany, greenworldbooks, baystatebooks,
ontimebooks, awesomebooksusa, goodbooksco, zebrasbooks, zbkbooks,
bluevasemarketplace, oneplanetbooks, a plus books, aplusbooks
```

### Seller URLs (generated for BUY/REVIEW)

| eBay Seller        | URL Pattern                                           |
|--------------------|-------------------------------------------------------|
| booksrun           | `https://booksrun.com/categories?sr={ISBN}`            |
| second.sale        | `https://booksrun.com/categories?sr={ISBN}`            |
| betterworldbooks   | `https://www.betterworldbooks.com/product/detail/{ISBN}`|
| Others             | No seller URL generated                                |

---

## Supabase Schema

### Table: `ebay_books`

| Column              | Type      | Description                                      |
|---------------------|-----------|--------------------------------------------------|
| isbn                | text PK   | ISBN-10 or ISBN-13                               |
| title               | text      | Book title from eBay                             |
| price               | integer   | eBay price in cents                              |
| shipping            | integer   | eBay shipping cost in cents                      |
| condition           | text      | eBay condition (Very Good, Like New)             |
| seller              | text      | eBay seller username                             |
| category            | text      | Search query used (empty for category-only)      |
| ebay_item_id        | text      | eBay item ID                                     |
| ebay_url            | text      | eBay listing URL                                 |
| image_url           | text      | Book cover image URL                             |
| scraped_at          | timestamp | When the book was scraped                        |
| decision            | text      | BUY / REVIEW / REJECT / NOT FOUND / BOUGHT / SOLD_OUT |
| asin                | text      | Amazon ASIN                                      |
| amazon_price        | integer   | Realistic Amazon sell price (cents)              |
| sales_rank          | integer   | 180-day average sales rank                       |
| sales_rank_drops_90 | integer   | Number of sales in 90 days                       |
| fba_profit          | integer   | FBA profit (cents)                               |
| fbm_profit          | integer   | FBM profit (cents)                               |
| amazon_flag         | text      | green / yellow / red                             |
| book_type           | text      | Binding (Hardcover, Paperback, etc.)             |
| weight_oz           | real      | Weight in ounces                                 |
| seller_url          | text      | BooksRun/BWB website link                        |
| amazon_url          | text      | Amazon product page link                         |
| best_offer_price    | integer   | Cheapest trusted seller offer price (cents)      |
| best_offer_seller   | text      | Cheapest trusted seller name                     |
| evaluated_at        | timestamp | When evaluation happened                         |
| bought_at           | timestamp | When marked as bought                            |

### Table: `fetcher_checkpoints`

| Column      | Type      | Description                        |
|-------------|-----------|-------------------------------------|
| seller      | text      | eBay seller username (PK)          |
| category_id | text      | Search key (PK)                    |
| last_offset | integer   | Last scraped offset                |
| updated_at  | timestamp | Last checkpoint update             |

### Table: `keepa_sellers`

| Column      | Type | Description             |
|-------------|------|--------------------------|
| seller_id   | text PK | Keepa seller ID       |
| seller_name | text | Resolved seller name     |

---

## Checkpoint System (Full Catalog Scrape)

The current system uses **checkpoints** to handle the full catalog scrape:

1. Each seller+search combo has a checkpoint in `fetcher_checkpoints`
2. The scraper pages through eBay results sorted by `newlyListed`
3. After each page, the offset is saved to the checkpoint
4. If the process crashes or stops, it resumes from the last offset
5. After `evalBatchSize` new books → pause scraping → evaluate → resume from checkpoint
6. When all pages are exhausted → search is complete → move to next search

**Problem:** Checkpoints track offset position in a `newlyListed` sort. If the seller adds new books between runs, those new books appear at offset 0 but the checkpoint resumes from a later offset — so new books get skipped until the full catalog scrape wraps around.

**This is by design for the full catalog scrape** — it processes the entire inventory once. But it means daily new listings are NOT caught until the next full run from offset 0.

---

## Rejected ISBNs Dedup (ngrok)

To keep the Supabase row count manageable:

1. REJECT and NOT FOUND books are periodically exported to `data/rejected_isbns.txt` via `scripts/export-rejected.ts`
2. The file is served from the local Mac via ngrok (`REJECT_FILE_URL` env var)
3. At startup, Railway fetches this file and merges ISBNs into the dedup set
4. This allows deleting REJECT/NOT FOUND rows from Supabase while still skipping those ISBNs

---

## Keepa API Token Usage

| Operation                | Tokens/book | When used                     |
|--------------------------|-------------|-------------------------------|
| Batch product lookup     | 1           | Every book (evaluation)       |
| Product + offers (20)    | 20          | BUY and REVIEW books only     |
| Seller name lookup       | 1/seller    | New sellers (cached after)    |
| Token check              | 0           | Before each batch             |

The system waits if tokens drop below 100 (checks every 60s).

---

## Environment Variables

| Variable           | Description                          |
|-------------------|--------------------------------------|
| SELLER            | Seller key (booksrun, thriftbooks, etc.) |
| EBAY_CLIENT_ID    | eBay API app ID                      |
| EBAY_CLIENT_SECRET| eBay API secret                      |
| EBAY_REFRESH_TOKEN| eBay OAuth refresh token             |
| KEEPA_API_KEY     | Keepa API key                        |
| SUPABASE_URL      | Supabase project URL                 |
| SUPABASE_KEY      | Supabase anon/service key            |
| REJECT_FILE_URL   | ngrok URL for rejected ISBNs file    |

---

---

# New Listed Books Fetcher (Planned)

## Problem

The full catalog scraper uses checkpoints + `newlyListed` sorting. It is designed to process the **entire seller inventory** from beginning to end. This works great for initial catalog scraping, but has a fundamental flaw for ongoing monitoring:

- Sellers like booksrun and bwb add **100-200 new books every day**
- Of those, maybe **20-30 are in our target condition** (Like New / Very Good)
- The checkpoint system resumes from where it left off (e.g., offset 5000), so it **misses new books at offset 0**
- To catch new books, you'd need to wait for the full catalog scrape to finish and start over — which is wasteful

## Solution: Separate "New Books" Fetcher

A lightweight, separate fetcher that runs on a **schedule** (e.g., every few hours or once/twice daily). Its only job is to catch newly listed books.

## How It Works

### Key Differences from Full Catalog Scraper

| Aspect              | Full Catalog Scraper         | New Books Fetcher              |
|---------------------|------------------------------|--------------------------------|
| **Purpose**         | Process entire inventory     | Catch daily new listings       |
| **Start offset**    | From checkpoint (resumable)  | Always from offset 0           |
| **Checkpoints**     | Yes (saves progress)         | No (always starts fresh)       |
| **Stop condition**  | End of all results           | When it hits known books       |
| **Batch limit**     | evalBatchSize                | None — process all new in one pass |
| **Run frequency**   | Once (full crawl)            | Scheduled (every 4-6 hours)    |
| **Sellers**         | One per Railway service      | All sellers in one run         |

### Flow

1. **Startup**
   - Load existing ISBNs from Supabase
   - Load rejected ISBNs from ngrok file
   - Merge into dedup set

2. **For each seller** (all sellers, not just one):
   - For each search (edu, all, keyword searches):
     - Start from **offset 0** (newest listings first)
     - Page through results
     - Skip ISBNs already in dedup set
     - Insert new books to Supabase
     - **Stop early** when a full page has zero new books (we've reached books already scraped)
     - No checkpoint saving

3. **Evaluate all new books**
   - Same evaluation logic (Keepa batch lookup → decision → offer search for BUY/REVIEW)
   - Same trusted seller matching, same freshness filter, same price logic
   - Runs once after all sellers scraped (not batched)

4. **Print summary and exit**

### Early Stop Logic

The key optimization: since results are sorted by `newlyListed`, once the fetcher hits a page where **every ISBN is already known**, all subsequent pages will also be known books. So it stops immediately instead of paging through thousands of old listings.

```
Page 1: 200 items → 15 new, 185 known  (continue)
Page 2: 200 items → 3 new, 197 known   (continue)
Page 3: 200 items → 0 new, 200 known   (STOP — reached old inventory)
```

### Configuration

Same sellers, same searches, same decision thresholds, same fees. The only differences:
- No `evalBatchSize` (process everything in one pass)
- No checkpoints
- Runs all sellers in a single execution
- Early stop on zero-new-books page

### Deployment

- **Separate Railway service** or **cron job** on the Mac
- Uses the same `.env` variables
- Can run alongside the full catalog scraper without conflicts (both use the same Supabase dedup)
- Recommended schedule: every 4-6 hours, or twice daily (morning + evening)

### Expected Volume (Per Run)

| Seller          | Daily New Books | In Target Condition | Per 6-Hour Run |
|-----------------|-----------------|---------------------|----------------|
| booksrun        | ~150-200        | ~30-40 (VG)         | ~8-10          |
| betterworldbooks| ~100-150        | ~20-30 (LN)         | ~5-8           |
| thriftbooks     | ~200-300        | ~10-20 (LN)         | ~3-5           |
| oneplanetbooks  | ~50-100         | ~10-20 (LN)         | ~3-5           |
| secondsale      | ~50-80          | ~10-15 (VG)         | ~3-4           |
| baystatebooks   | ~20-40          | ~5-10 (LN)          | ~1-3           |
| awesomebooksusa | ~20-40          | ~5-10 (LN)          | ~1-3           |

**Total per run: ~25-45 new books across all sellers**

### Keepa Token Budget (Per Run)

- ~40 new books * 1 token (batch lookup) = ~40 tokens
- ~5 BUY/REVIEW books * 20 tokens (offer search) = ~100 tokens
- ~10 new sellers * 1 token (seller lookup) = ~10 tokens
- **Total: ~150 tokens per run** (very lightweight)

### File Structure (Planned)

```
new-books-fetcher/       (separate project folder)
  src/
    index.ts             — Main: loop all sellers, scrape new, evaluate, exit
    config.ts            — Same seller configs (shared or copied)
    ebayApi.ts           — Same eBay API code (shared or copied)
    keepaApi.ts          — Same Keepa code (shared or copied)
    evaluate.ts          — Same evaluation logic (shared or copied)
    supabase.ts          — Same DB code minus checkpoints
  .env                   — Same env variables
  package.json
  tsconfig.json
```

The code is identical to the full catalog scraper except:
- `index.ts` loops all sellers, starts from offset 0, no checkpoints, early stop logic
- No `evalBatchSize` or `maxNewBooks` — scrapes all new, evaluates once
- Can optionally be a monorepo with shared `src/` to avoid code duplication
