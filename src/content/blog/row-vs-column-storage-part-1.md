---
title: 'How Databases Store Your Data: Row vs Column-Oriented Storage (Part 1/2)'
description: 'A deep dive into how databases physically store data on disk, why it matters for performance, and when to choose row-oriented vs column-oriented storage.'
date: 2026-01-25
tags: ['databases', 'storage', 'performance', 'architecture', 'series']
---

Every database makes a fundamental choice: how should data be physically arranged on disk? This decision, invisible to most developers, determines whether your queries run in milliseconds or minutes.

In this 2-part series, I'll explain the two dominant storage layouts—row-oriented and column-oriented—with diagrams showing exactly how data lives on disk and how queries execute against each format.

**Series Overview:**
- **Part 1** (this post): Row vs Column-oriented storage fundamentals
- **Part 2**: Hybrid formats that give you the best of both worlds

---

## Why Storage Layout Matters

Consider a simple products table:

```
| id | name       | price | stock | category    |
|----|------------|-------|-------|-------------|
| 1  | iPhone 15  | 999   | 50    | Electronics |
| 2  | Galaxy S24 | 899   | 120   | Electronics |
| 3  | Levi's 501 | 89    | 200   | Clothing    |
| 4  | Pixel 8    | 699   | 85    | Electronics |
```

This looks like a grid, but on disk, data must be stored as a sequential stream of bytes. The question is: **in what order?**

The two fundamental approaches:

```
ROW-ORIENTED (store by rows):
→ [1, iPhone 15, 999, 50, Electronics] [2, Galaxy S24, 899, 120, Electronics] ...

COLUMN-ORIENTED (store by columns):
→ [1, 2, 3, 4] [iPhone 15, Galaxy S24, Levi's 501, Pixel 8] [999, 899, 89, 699] ...
```

This simple difference has profound implications for performance.

---

## Row-Oriented Storage

Row-oriented databases store all columns of a row together, one row after another. This is the traditional approach used by most transactional databases.

**Examples:** PostgreSQL, MySQL, SQLite, Oracle, SQL Server (default), MongoDB

### How Data Lives on Disk

Databases organize data into fixed-size **pages** (typically 4KB-16KB). In row-oriented storage, each page contains complete rows:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DISK PAGE (8KB)                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Row 1: [id:1] [name:"iPhone 15"]  [price:999] [stock:50]  [cat:E] │
│  Row 2: [id:2] [name:"Galaxy S24"] [price:899] [stock:120] [cat:E] │
│  Row 3: [id:3] [name:"Levi's 501"] [price:89]  [stock:200] [cat:C] │
│  Row 4: [id:4] [name:"Pixel 8"]    [price:699] [stock:85]  [cat:E] │
│                                                                     │
│  [Page Header] [Free Space Pointer] [Row Directory]                 │
└─────────────────────────────────────────────────────────────────────┘
                    ↑
        All columns of each row stored together
```

Each row is stored contiguously. To read row 2, the database loads the page and jumps to the row's offset—all columns come along for the ride.

### Point Queries: Where Row Storage Shines

When you fetch a single row by ID, row-oriented storage is optimal:

```sql
SELECT * FROM products WHERE id = 2;
```

```
Step 1: Index Lookup
┌──────────────────┐
│   B-Tree Index   │
│                  │
│  id=2 → Page 1,  │────→ Points directly to row location
│         Offset 2 │
└──────────────────┘

Step 2: Single Page Read
┌─────────────────────────────────────────────────────────────────────┐
│                           Page 1                                    │
├─────────────────────────────────────────────────────────────────────┤
│  Row 1: [1] [iPhone 15] [999] [50] [E]                             │
│  Row 2: [2] [Galaxy S24] [899] [120] [E]  ◄── Read this row        │
│  Row 3: [3] [Levi's 501] [89] [200] [C]                            │
└─────────────────────────────────────────────────────────────────────┘

Result: 1 disk I/O, all columns retrieved together ✓
```

**Why it's fast:**
- Single disk seek locates the entire row
- All columns are adjacent in memory
- No need to stitch data from multiple locations

This is why row-oriented databases dominate **OLTP (Online Transaction Processing)** workloads—applications that read/write individual records like user profiles, orders, or inventory updates.

### Writes: Also Excellent

Inserting or updating a row is straightforward:

```sql
INSERT INTO products VALUES (5, 'AirPods Pro', 249, 500, 'Electronics');
```

```
Before Insert:
┌─────────────────────────────────────────────────────────────────────┐
│  Row 1: [1] [iPhone 15] [999] [50] [E]                             │
│  Row 2: [2] [Galaxy S24] [899] [120] [E]                           │
│  [Free Space...]                                                    │
└─────────────────────────────────────────────────────────────────────┘

After Insert:
┌─────────────────────────────────────────────────────────────────────┐
│  Row 1: [1] [iPhone 15] [999] [50] [E]                             │
│  Row 2: [2] [Galaxy S24] [899] [120] [E]                           │
│  Row 3: [5] [AirPods Pro] [249] [500] [E]  ◄── Appended            │
└─────────────────────────────────────────────────────────────────────┘

Result: 1 disk I/O to append the new row ✓
```

**Why it's fast:**
- New row is written sequentially
- Single write operation for all columns
- Updates modify only one location

### The Problem: Analytical Queries

Now consider a different query—calculating average price across 10 million products:

```sql
SELECT AVG(price) FROM products;
```

```
What we need:    Just the price column (4 bytes per row)
What we read:    Entire rows (200+ bytes per row)

┌─────────────────────────────────────────────────────────────────────┐
│                           Page 1                                    │
├─────────────────────────────────────────────────────────────────────┤
│  [1] [iPhone 15] [999] [50] [E]      ← Read 200 bytes, need 4      │
│  [2] [Galaxy S24] [899] [120] [E]    ← Read 200 bytes, need 4      │
│  [3] [Levi's 501] [89] [200] [C]     ← Read 200 bytes, need 4      │
│  [4] [Pixel 8] [699] [85] [E]        ← Read 200 bytes, need 4      │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
                    I/O Amplification: 50x

For 10 million rows:
  Useful data:     40 MB  (10M × 4 bytes)
  Actually read:   2 GB   (10M × 200 bytes)
```

**The fundamental problem:** Row storage forces you to read every column even when you only need one. For analytical queries that scan millions of rows but touch few columns, this wastes enormous I/O bandwidth.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    I/O WASTE VISUALIZATION                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Row 1:  [id] [name] [price] [stock] [category]                    │
│           ░░   ░░░░   ████    ░░░░    ░░░░░░░░                     │
│                                                                     │
│  Row 2:  [id] [name] [price] [stock] [category]                    │
│           ░░   ░░░░   ████    ░░░░    ░░░░░░░░                     │
│                                                                     │
│  Row 3:  [id] [name] [price] [stock] [category]                    │
│           ░░   ░░░░   ████    ░░░░    ░░░░░░░░                     │
│                                                                     │
│  ████ = Data we need    ░░░░ = Data we're forced to read           │
│                                                                     │
│  Efficiency: ~2%                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

This is why running analytics on your production PostgreSQL database feels slow—it's not designed for that access pattern.

---

## Column-Oriented Storage

Column-oriented databases flip the model: instead of storing rows together, they store each column separately.

**Examples:** ClickHouse, Apache Parquet, Amazon Redshift, Google BigQuery, DuckDB, Apache Druid

### How Data Lives on Disk

Each column is stored in its own contiguous block:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    COLUMNAR STORAGE LAYOUT                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  id.col:       [1] [2] [3] [4] [5] [6] [7] [8] [9] [10] ...        │
│                └────────────────────────────────────────┘           │
│                              ↓                                      │
│                    Contiguous on disk                               │
│                                                                     │
│  name.col:     [iPhone 15] [Galaxy S24] [Levi's 501] [Pixel 8] ... │
│                └────────────────────────────────────────────────┘   │
│                                                                     │
│  price.col:    [999] [899] [89] [699] [249] [1099] [79] ...        │
│                └────────────────────────────────────────────┘       │
│                                                                     │
│  stock.col:    [50] [120] [200] [85] [500] [25] [1000] ...         │
│                └───────────────────────────────────────────┘        │
│                                                                     │
│  category.col: [E] [E] [C] [E] [E] [E] [C] [C] [E] [E] ...         │
│                └───────────────────────────────────────────┘        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
          ↑
    Each column stored independently, values of same type together
```

The same data, but organized for a completely different access pattern.

### Analytical Queries: Where Column Storage Shines

That same average price query now becomes highly efficient:

```sql
SELECT AVG(price) FROM products;  -- 10 million rows
```

```
Step 1: Read ONLY the price column
┌─────────────────────────────────────────────────────────────────────┐
│  price.col: [999] [899] [89] [699] [249] [1099] [79] [599] ...     │
│             └────────────────────────────────────────────────┘      │
│                                    ↓                                │
│                    Sequential read, no wasted bytes                 │
└─────────────────────────────────────────────────────────────────────┘

Step 2: Compute average in memory
         SUM(prices) / COUNT(prices) = result

Data read:   40 MB  (10M × 4 bytes)  ✓
vs Row:      2 GB   (10M × 200 bytes)

Speedup: 50x less I/O
```

**Why it's fast:**
- Read only the columns you need
- Sequential disk access (no seeking between rows)
- Data fits in CPU cache more efficiently

### Compression: The Hidden Superpower

Column storage enables dramatically better compression. When values of the same type are stored together, patterns emerge:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    COMPRESSION TECHNIQUES                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  RUN-LENGTH ENCODING (RLE)                                          │
│  ─────────────────────────                                          │
│  category.col before:                                               │
│    [Electronics] [Electronics] [Electronics] [Clothing] [Clothing] │
│                                                                     │
│  category.col after:                                                │
│    [(Electronics, 3), (Clothing, 2)]                                │
│                                                                     │
│  Compression ratio: 60% smaller                                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  DICTIONARY ENCODING                                                │
│  ───────────────────                                                │
│  brand.col before:                                                  │
│    [Apple] [Samsung] [Apple] [Google] [Apple] [Samsung]            │
│                                                                     │
│  Dictionary: {0: Apple, 1: Samsung, 2: Google}                      │
│  brand.col after:                                                   │
│    [0] [1] [0] [2] [0] [1]                                         │
│                                                                     │
│  Compression ratio: 75% smaller                                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  DELTA ENCODING                                                     │
│  ──────────────                                                     │
│  timestamp.col before:                                              │
│    [1706140800] [1706140801] [1706140802] [1706140805]             │
│                                                                     │
│  timestamp.col after:                                               │
│    Base: 1706140800                                                 │
│    Deltas: [0] [1] [1] [3]                                         │
│                                                                     │
│  Compression ratio: 80% smaller                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Why columnar compresses better:**
- Similar values cluster together (all prices, all dates, all categories)
- Patterns are exploitable (sorted data, repeated values, sequential IDs)
- Type-specific encodings (integers compress differently than strings)

Real-world columnar databases often achieve **5-10x compression** compared to row-oriented storage. This means:
- Less disk space
- Less I/O (compressed data stays compressed during reads)
- Better cache utilization

### The Problem: Point Queries

Now let's fetch a single product:

```sql
SELECT * FROM products WHERE id = 2;
```

```
Step 1: Find position of id=2 in id.col
┌─────────────────────────────────────┐
│  id.col: [1] [2] [3] [4] [5] ...   │
│               ↑                     │
│          Position 2                 │
└─────────────────────────────────────┘

Step 2: Read position 2 from EVERY column file
┌─────────────────────────────────────┐
│  id.col:       [2]       ─┐        │
│  name.col:     [Galaxy]   │        │
│  price.col:    [899]      ├──→ 5 separate reads!
│  stock.col:    [120]      │        │
│  category.col: [E]       ─┘        │
└─────────────────────────────────────┘

Step 3: Reassemble the row
         [2, Galaxy S24, 899, 120, Electronics]

Result: 5 disk I/O operations instead of 1 ✗
```

**Why it's slow:**
- Each column requires a separate seek
- More columns = more I/O operations
- Row must be reconstructed from scattered pieces

```
┌─────────────────────────────────────────────────────────────────────┐
│                    POINT QUERY: ROW vs COLUMN                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ROW-ORIENTED:                                                      │
│  ┌─────────────────────────────────────────┐                       │
│  │ Page 1: [...] [id:2, Galaxy, 899, ...] │ ← 1 read, done         │
│  └─────────────────────────────────────────┘                       │
│                                                                     │
│  COLUMN-ORIENTED:                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ id.col   │  │ name.col │  │price.col │  │ stock... │            │
│  │   ↓      │  │    ↓     │  │    ↓     │  │    ↓     │            │
│  │  [2]     │  │ [Galaxy] │  │  [899]   │  │  [120]   │            │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘            │
│      read 1       read 2       read 3        read 4                 │
│                                                                     │
│  4 reads + reconstruction overhead                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Writes: Also Challenging

Inserting a new row requires appending to every column file:

```sql
INSERT INTO products VALUES (5, 'AirPods Pro', 249, 500, 'Electronics');
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                    INSERT: COLUMN-ORIENTED                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  id.col:       [1][2][3][4] → append [5]        Write 1            │
│  name.col:     [...][...] → append [AirPods]    Write 2            │
│  price.col:    [999][899][89][699] → append [249]  Write 3         │
│  stock.col:    [50][120][200][85] → append [500]   Write 4         │
│  category.col: [E][E][C][E] → append [E]           Write 5         │
│                                                                     │
│  Result: 5 write operations instead of 1                           │
│                                                                     │
│  Also: May need to update compression blocks, recompute stats      │
└─────────────────────────────────────────────────────────────────────┘
```

**Why writes are harder:**
- Single row insert touches multiple files
- Compression must be maintained or recomputed
- Random writes break sequential layout

This is why columnar databases often use **batch inserts** and **append-only patterns** rather than single-row writes.

---

## The Fundamental Trade-off

Row and column storage optimize for opposite access patterns:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    THE STORAGE TRADE-OFF                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│           │  Few Rows, All Columns  │  Many Rows, Few Columns      │
│           │  (Point Queries)        │  (Analytical Queries)        │
│  ─────────┼─────────────────────────┼─────────────────────────────  │
│           │                         │                               │
│  ROW      │    ████ FAST ████       │    ░░░░ SLOW ░░░░            │
│           │    1 I/O per row        │    Reads unused columns      │
│           │                         │                               │
│  ─────────┼─────────────────────────┼─────────────────────────────  │
│           │                         │                               │
│  COLUMN   │    ░░░░ SLOW ░░░░       │    ████ FAST ████            │
│           │    N I/Os per row       │    Reads only needed cols    │
│           │                         │                               │
└─────────────────────────────────────────────────────────────────────┘
```

### OLTP vs OLAP

These storage layouts align with two fundamental database workloads:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    WORKLOAD CHARACTERISTICS                         │
├────────────────────────────────┬────────────────────────────────────┤
│           OLTP                 │              OLAP                  │
│   (Online Transaction          │     (Online Analytical             │
│    Processing)                 │      Processing)                   │
├────────────────────────────────┼────────────────────────────────────┤
│                                │                                    │
│  "Get user #12345"             │  "Total revenue last quarter"     │
│  "Update cart item"            │  "Avg order value by region"      │
│  "Insert new order"            │  "Top 100 products by sales"      │
│  "Check inventory"             │  "Year-over-year growth"          │
│                                │                                    │
├────────────────────────────────┼────────────────────────────────────┤
│                                │                                    │
│  • Few rows per query          │  • Millions of rows per query     │
│  • All columns needed          │  • Few columns needed             │
│  • High concurrency            │  • Complex aggregations           │
│  • Millisecond latency         │  • Seconds acceptable             │
│  • Many small writes           │  • Batch inserts                  │
│                                │                                    │
├────────────────────────────────┼────────────────────────────────────┤
│                                │                                    │
│  → ROW-ORIENTED ✓              │  → COLUMN-ORIENTED ✓              │
│                                │                                    │
│  PostgreSQL, MySQL             │  ClickHouse, BigQuery             │
│  MongoDB, Oracle               │  Redshift, Snowflake              │
│                                │                                    │
└────────────────────────────────┴────────────────────────────────────┘
```

### Summary Comparison

| Aspect | Row-Oriented | Column-Oriented |
|--------|--------------|-----------------|
| **Point queries** | Excellent (1 I/O) | Poor (N I/Os) |
| **Analytical scans** | Poor (reads all columns) | Excellent (reads needed columns) |
| **Compression** | Limited (mixed types) | Excellent (same types together) |
| **Single-row writes** | Fast (1 write) | Slow (N writes) |
| **Batch writes** | Good | Excellent |
| **Concurrency** | High (row-level locks) | Limited (batch-oriented) |
| **Use case** | OLTP, transactions | OLAP, analytics |

---

## What's Next: The Best of Both Worlds

The reality is that most applications need both patterns:
- Your e-commerce app needs fast product lookups (OLTP)
- Your analytics dashboard needs to aggregate millions of orders (OLAP)

Running analytics on your production PostgreSQL is slow. Syncing data to a separate ClickHouse cluster is complex. Is there a better way?

**Yes.** Modern storage formats have found a middle ground: **store data in row groups, but organize columns within each group**. This hybrid approach—used by Apache Parquet, ORC, and Delta Lake—enables efficient analytical queries while maintaining reasonable point query performance.

In **Part 2**, we'll explore:
- **Row Group + Columnar hybrids**: How Parquet and ORC achieve the best of both worlds
- **Predicate pushdown**: Skipping entire row groups using statistics
- **HTAP databases**: Systems like TiDB that maintain both storage formats
- **Decision framework**: Choosing the right storage for your workload

---

*Have you experienced the row vs column trade-off in production? Running slow analytics on PostgreSQL? I'd love to hear your experiences!*
