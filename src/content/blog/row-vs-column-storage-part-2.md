---
title: 'The Best of Both Worlds: Hybrid Storage Formats Explained (Part 2/2)'
description: 'How modern databases combine row and column storage using row groups, predicate pushdown, and HTAP architectures to handle both transactional and analytical workloads.'
date: 2026-01-25
tags: ['databases', 'storage', 'parquet', 'architecture', 'series']
---

In [Part 1](/blog/row-vs-column-storage-part-1), we explored the fundamental trade-off: row-oriented storage excels at point queries but struggles with analytics, while column-oriented storage is the opposite. Most real applications need both.

The solution? **Hybrid storage formats** that combine the strengths of both approaches. In this post, we'll explore how modern systems achieve this, with a focus on the row group pattern used by Apache Parquet, ORC, and Delta Lake.

**Series Overview:**
- **Part 1**: Row vs Column-oriented storage fundamentals
- **Part 2** (this post): Hybrid formats that give you the best of both worlds

---

## The Problem with Pure Approaches

Real applications don't fit neatly into OLTP or OLAP boxes:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    REAL-WORLD QUERY PATTERNS                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  E-commerce Application:                                            │
│                                                                     │
│  OLTP (need row storage):                                          │
│    • Get product details by ID                                     │
│    • Update inventory on purchase                                  │
│    • Fetch user's cart                                             │
│                                                                     │
│  OLAP (need column storage):                                       │
│    • Dashboard: revenue by category this month                     │
│    • Report: top 100 products by sales                             │
│    • Analytics: average order value trends                         │
│                                                                     │
│  Problem: Can't efficiently serve both with one storage format     │
└─────────────────────────────────────────────────────────────────────┘
```

**Traditional solutions:**
1. Run analytics on production DB → Slow queries, impacts OLTP performance
2. ETL to separate analytics DB → Data latency, operational complexity
3. Maintain two systems → Double the cost, sync challenges

Modern hybrid formats offer a better path.

---

## Row Groups: The Key Insight

The breakthrough idea: **group rows together, but store columns within each group**.

Instead of choosing between:
- **Pure row**: All columns of all rows together
- **Pure column**: Each column entirely separate

We get:
- **Hybrid**: Chunks of rows (row groups), with columnar layout inside each chunk

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ROW GROUP ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────────── Row Group 1 ──────────────────────┐       │
│  │  Rows 1-50,000                                          │       │
│  │                                                          │       │
│  │  Column Chunk: id      [1, 2, 3, ... 50000]             │       │
│  │  Column Chunk: name    [iPhone, Galaxy, Pixel, ...]     │       │
│  │  Column Chunk: price   [999, 899, 699, ...]             │       │
│  │  Column Chunk: stock   [50, 120, 85, ...]               │       │
│  │  Column Chunk: category [E, E, C, E, ...]               │       │
│  │                                                          │       │
│  │  Footer: statistics, offsets, encoding info              │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌────────────────────── Row Group 2 ──────────────────────┐       │
│  │  Rows 50,001-100,000                                    │       │
│  │                                                          │       │
│  │  Column Chunk: id      [50001, 50002, ...]              │       │
│  │  Column Chunk: name    [AirPods, Watch, ...]            │       │
│  │  Column Chunk: price   [249, 399, ...]                  │       │
│  │  ...                                                     │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌────────────────────── Row Group 3 ──────────────────────┐       │
│  │  Rows 100,001-150,000                                   │       │
│  │  ...                                                     │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Why this works:**

| Benefit | How Row Groups Help |
|---------|---------------------|
| Column projection | Read only needed columns within each row group |
| Compression | Same-type values together enable great compression |
| Row locality | Related rows are in the same row group |
| Parallelism | Different row groups can be processed independently |

---

## Apache Parquet: Anatomy of a Hybrid Format

Parquet is the most widely-used hybrid format, powering data lakes at companies like Netflix, Uber, and Airbnb. Let's look inside:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PARQUET FILE STRUCTURE                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     Magic Number: PAR1                       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     ROW GROUP 1                              │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ Column Chunk: id                                     │    │   │
│  │  │   Page 1: [1-1000]  Page 2: [1001-2000] ...         │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ Column Chunk: name                                   │    │   │
│  │  │   Page 1: [iPhone, Galaxy, ...]  Page 2: [...]      │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ Column Chunk: price                                  │    │   │
│  │  │   Page 1: [999, 899, ...]  Page 2: [...]            │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     ROW GROUP 2                              │   │
│  │  ...                                                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     FILE FOOTER                              │   │
│  │  • Schema definition                                         │   │
│  │  • Row group metadata (offsets, sizes)                       │   │
│  │  • Column statistics (min, max, null count)                  │   │
│  │  • Encoding and compression info                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     Footer Length + Magic: PAR1              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Key components:**

| Component | Purpose | Typical Size |
|-----------|---------|--------------|
| Row Group | Logical grouping of rows | 128MB - 1GB |
| Column Chunk | All values of one column in a row group | Varies |
| Page | Unit of compression/encoding | 1MB |
| Footer | Metadata for efficient access | Few KB |

### How Analytical Queries Execute

```sql
SELECT AVG(price) FROM products WHERE category = 'Electronics';
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                    QUERY EXECUTION                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Step 1: Read footer (few KB)                                       │
│          → Get schema, row group locations, column stats            │
│                                                                     │
│  Step 2: For each row group, check statistics                       │
│                                                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │   Row Group 1   │  │   Row Group 2   │  │   Row Group 3   │     │
│  │                 │  │                 │  │                 │     │
│  │  category:      │  │  category:      │  │  category:      │     │
│  │   min: Clothing │  │   min: Electr.  │  │   min: Garden   │     │
│  │   max: Clothing │  │   max: Electr.  │  │   max: Kitchen  │     │
│  │                 │  │                 │  │                 │     │
│  │   SKIP ✗        │  │   READ ✓        │  │   SKIP ✗        │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│                                                                     │
│  Step 3: In Row Group 2, read only needed columns                   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Row Group 2:                                                │   │
│  │                                                              │   │
│  │    id column      → SKIP (not in SELECT or WHERE)           │   │
│  │    name column    → SKIP                                    │   │
│  │    price column   → READ ✓ (needed for AVG)                 │   │
│  │    stock column   → SKIP                                    │   │
│  │    category column → READ ✓ (needed for WHERE filter)       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Step 4: Filter rows where category = 'Electronics'                 │
│          Compute AVG(price) on matching rows                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Two levels of optimization:**
1. **Row group pruning**: Skip entire row groups using min/max statistics
2. **Column projection**: Read only the columns needed for the query

---

## Predicate Pushdown: Skipping Data Before Reading

The footer statistics enable **predicate pushdown**—evaluating WHERE clauses before reading data:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PREDICATE PUSHDOWN                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Query: SELECT * FROM orders WHERE order_date = '2026-01-15'        │
│                                                                     │
│  Footer Statistics:                                                 │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  Row Group    │  order_date min   │  order_date max   │ Skip? │ │
│  │───────────────┼───────────────────┼───────────────────┼───────│ │
│  │  RG 1         │  2026-01-01       │  2026-01-07       │  YES  │ │
│  │  RG 2         │  2026-01-08       │  2026-01-14       │  YES  │ │
│  │  RG 3         │  2026-01-15       │  2026-01-21       │  NO   │ │
│  │  RG 4         │  2026-01-22       │  2026-01-28       │  YES  │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Result: Read only Row Group 3 (25% of data)                        │
│          Skip 75% of I/O without reading actual data!               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Statistics stored per column chunk:**
- `min`: Minimum value in the chunk
- `max`: Maximum value in the chunk
- `null_count`: Number of null values
- `distinct_count`: Approximate unique values (optional)

### When Predicate Pushdown Works Best

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SORTED vs UNSORTED DATA                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  SORTED BY order_date (ideal):                                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                   │
│  │ Jan 1-7 │ │ Jan 8-14│ │Jan 15-21│ │Jan 22-28│                   │
│  │   RG1   │ │   RG2   │ │   RG3   │ │   RG4   │                   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘                   │
│                              ↑                                      │
│              Query for Jan 15 → Read only RG3                       │
│              Skip 75% of data ✓                                     │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  UNSORTED (random order):                                           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                   │
│  │Jan 1-28 │ │Jan 1-28 │ │Jan 1-28 │ │Jan 1-28 │                   │
│  │ (mixed) │ │ (mixed) │ │ (mixed) │ │ (mixed) │                   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘                   │
│      ↑           ↑           ↑           ↑                          │
│   All row groups have min=Jan1, max=Jan28                           │
│   Cannot skip any row group ✗                                       │
│                                                                     │
│  Lesson: Sort or cluster data by frequently filtered columns        │
└─────────────────────────────────────────────────────────────────────┘
```

**Best practices for predicate pushdown:**
1. Sort data by commonly filtered columns (date, region, category)
2. Partition data into separate files by high-cardinality filters
3. Keep row groups reasonably sized (128MB-256MB typical)

---

## Point Queries in Hybrid Formats

What about fetching a single row? Hybrid formats aren't as fast as pure row storage, but they're not terrible either:

```sql
SELECT * FROM products WHERE id = 12345;
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                    POINT QUERY EXECUTION                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Step 1: Use statistics to find the right row group                 │
│                                                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │   Row Group 1   │  │   Row Group 2   │  │   Row Group 3   │     │
│  │   id: 1-50000   │  │  id: 50001-100k │  │   id: 100k+     │     │
│  │                 │  │                 │  │                 │     │
│  │   SKIP ✗        │  │   SKIP ✗        │  │   SKIP ✗        │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│          │                                                          │
│          ↓                                                          │
│   id=12345 is in RG1                                               │
│                                                                     │
│  Step 2: Read all column chunks from Row Group 1                    │
│          (Must read ~128MB even for 1 row)                          │
│                                                                     │
│  Step 3: Scan id column to find position of id=12345               │
│          (Position 12345 in the row group)                          │
│                                                                     │
│  Step 4: Extract values at position 12345 from all columns          │
│                                                                     │
│  Total I/O: ~128MB (entire row group)                               │
│  vs Row-oriented: ~1KB (just the row)                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Point query performance in hybrid formats:**
- Much better than pure columnar (skip most row groups)
- Much worse than pure row storage (read entire row group)
- Acceptable for occasional lookups, not for high-frequency OLTP

---

## Delta Lake / Apache Iceberg: Versioned Hybrid Storage

Parquet is a file format. **Delta Lake** and **Apache Iceberg** are table formats built on top of Parquet that add:
- ACID transactions
- Schema evolution
- Time travel (query historical versions)
- Efficient upserts and deletes

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DELTA LAKE ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                       ┌─────────────────┐                           │
│                       │  Delta Log      │                           │
│                       │  (Transaction   │                           │
│                       │   Log - JSON)   │                           │
│                       └────────┬────────┘                           │
│                                │                                    │
│            Tracks which Parquet files are "current"                 │
│                                │                                    │
│     ┌──────────────────────────┼──────────────────────────┐        │
│     ▼                          ▼                          ▼        │
│  ┌──────────┐            ┌──────────┐            ┌──────────┐      │
│  │ part-001 │            │ part-002 │            │ part-003 │      │
│  │ .parquet │            │ .parquet │            │ .parquet │      │
│  └──────────┘            └──────────┘            └──────────┘      │
│                                                                     │
│  How Updates Work:                                                  │
│  ─────────────────                                                  │
│  1. Write new Parquet file with updated rows                        │
│  2. Add entry to Delta Log: "part-004.parquet replaces part-002"   │
│  3. Old file kept for time travel, eventually cleaned up            │
│                                                                     │
│  Benefits:                                                          │
│  • ACID: Atomic commits via log                                     │
│  • Isolation: Readers see consistent snapshot                       │
│  • Time travel: Query any historical version                        │
│  • Efficient deletes: Mark files as removed in log                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Delta Lake vs raw Parquet:**

| Feature | Raw Parquet | Delta Lake |
|---------|-------------|------------|
| ACID transactions | No | Yes |
| Schema enforcement | No | Yes |
| Update/Delete | Rewrite entire file | Efficient merge |
| Concurrent writes | Corrupted files | Safe |
| Time travel | No | Yes |

---

## PAX: Page-Level Hybrid

While Parquet uses large row groups (128MB+), **PAX (Partition Attributes Across)** applies the same principle at the page level (8-16KB):

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PAX PAGE LAYOUT                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Traditional Row Page (8KB):                                        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ [id:1][name:iPhone][price:999] [id:2][name:Galaxy][price:899]│   │
│  │ [id:3][name:Pixel][price:699] ...                           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  PAX Page (8KB):                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ ┌─────────────┐ ┌─────────────────────┐ ┌─────────────────┐ │   │
│  │ │ Mini-column │ │    Mini-column      │ │   Mini-column   │ │   │
│  │ │     id      │ │       name          │ │     price       │ │   │
│  │ │             │ │                     │ │                 │ │   │
│  │ │ [1]         │ │ [iPhone]            │ │ [999]           │ │   │
│  │ │ [2]         │ │ [Galaxy]            │ │ [899]           │ │   │
│  │ │ [3]         │ │ [Pixel]             │ │ [699]           │ │   │
│  │ │ [4]         │ │ [Levi's]            │ │ [89]            │ │   │
│  │ └─────────────┘ └─────────────────────┘ └─────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Advantages:                                                        │
│  • Cache-friendly: Scan one mini-column without polluting cache    │
│  • Row reconstruction: All columns in same page (no extra I/O)     │
│  • Works with existing B-tree indexes                               │
│                                                                     │
│  Used by: SQL Server Columnstore, some research databases           │
└─────────────────────────────────────────────────────────────────────┘
```

**PAX vs Row Groups:**

| Aspect | PAX (Page-Level) | Row Groups (Parquet) |
|--------|------------------|----------------------|
| Granularity | 8-16KB pages | 128MB+ groups |
| Point queries | Fast (one page) | Slow (read whole group) |
| Compression | Limited (small chunks) | Excellent (large chunks) |
| Use case | Mixed workloads in RDBMS | Data lakes, analytics |

---

## HTAP: Dual Storage Engines

**HTAP (Hybrid Transactional/Analytical Processing)** databases take a different approach: maintain two copies of data, each optimized for its workload.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    HTAP ARCHITECTURE (e.g., TiDB)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                        ┌───────────────┐                            │
│                        │    TiDB       │                            │
│                        │  (SQL Layer)  │                            │
│                        └───────┬───────┘                            │
│                                │                                    │
│                    Query Router / Optimizer                         │
│                                │                                    │
│              ┌─────────────────┴─────────────────┐                  │
│              │                                   │                  │
│              ▼                                   ▼                  │
│     ┌─────────────────┐                 ┌─────────────────┐        │
│     │      TiKV       │   Raft Sync     │    TiFlash      │        │
│     │  (Row Storage)  │ ───────────────►│ (Column Storage)│        │
│     │                 │   Real-time     │                 │        │
│     │  • B-tree index │   Replication   │  • Columnar     │        │
│     │  • Row format   │                 │  • Compressed   │        │
│     │  • ACID txns    │                 │  • Vectorized   │        │
│     └─────────────────┘                 └─────────────────┘        │
│              │                                   │                  │
│              ▼                                   ▼                  │
│     ┌─────────────────┐                 ┌─────────────────┐        │
│     │ Point queries   │                 │ Analytical      │        │
│     │ Transactions    │                 │ Aggregations    │        │
│     │ OLTP workloads  │                 │ OLAP workloads  │        │
│     └─────────────────┘                 └─────────────────┘        │
│                                                                     │
│  Key Features:                                                      │
│  • Automatic routing: Optimizer picks best engine per query        │
│  • Real-time sync: Changes in TiKV replicated to TiFlash          │
│  • Strong consistency: Both engines see same data                   │
│  • No ETL needed: Single system for both workloads                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**HTAP databases:**
- **TiDB**: TiKV (row) + TiFlash (column)
- **SingleStore**: Rowstore + Columnstore
- **AlloyDB**: PostgreSQL + Columnar engine
- **SQL Server**: Rowstore + Columnstore indexes

**When HTAP makes sense:**
- Need real-time analytics on transactional data
- Can't tolerate ETL latency
- Want operational simplicity (one system vs two)

**Trade-offs:**
- Higher storage cost (two copies)
- More complex operations
- Sync lag (usually seconds)

---

## Decision Framework

Choose based on your **primary** workload:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    STORAGE FORMAT DECISION TREE                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                    What's your primary workload?                    │
│                              │                                      │
│         ┌────────────────────┼────────────────────┐                │
│         │                    │                    │                │
│         ▼                    ▼                    ▼                │
│    Transactions         Analytics            Both (HTAP)           │
│    (OLTP)               (OLAP)                                     │
│         │                    │                    │                │
│         ▼                    ▼                    ▼                │
│  ┌────────────┐      ┌─────────────┐      ┌─────────────┐         │
│  │    ROW     │      │   COLUMN    │      │   HYBRID    │         │
│  │            │      │             │      │             │         │
│  │ PostgreSQL │      │ ClickHouse  │      │ TiDB        │         │
│  │ MySQL      │      │ BigQuery    │      │ SingleStore │         │
│  │ MongoDB    │      │ Redshift    │      │ AlloyDB     │         │
│  │ SQL Server │      │ Snowflake   │      │             │         │
│  │            │      │ DuckDB      │      │    OR       │         │
│  │            │      │             │      │             │         │
│  │            │      │ File formats│      │ Row DB +    │         │
│  │            │      │ Parquet/ORC │      │ Parquet     │         │
│  │            │      │ Delta Lake  │      │ (with ETL)  │         │
│  └────────────┘      └─────────────┘      └─────────────┘         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Summary Comparison

| Format | Point Queries | Analytics | Writes | Compression | Use Case |
|--------|---------------|-----------|--------|-------------|----------|
| **Pure Row** | Excellent | Poor | Excellent | Poor | OLTP |
| **Pure Column** | Poor | Excellent | Batch only | Excellent | OLAP |
| **Row Groups (Parquet)** | Moderate | Excellent | Batch | Excellent | Data lakes |
| **PAX** | Good | Good | Good | Moderate | Mixed RDBMS |
| **HTAP** | Excellent | Excellent | Excellent | N/A | Real-time analytics |

### Common Architecture Patterns

**Pattern 1: OLTP + Data Lake**
```
PostgreSQL (OLTP) → ETL/CDC → Parquet in S3 → Query with DuckDB/Spark
                              └─ Delta Lake for ACID
```

**Pattern 2: HTAP Database**
```
TiDB/SingleStore handles both workloads in one system
```

**Pattern 3: Operational + Analytical DBs**
```
PostgreSQL (OLTP) → Real-time sync → ClickHouse (OLAP)
                    (Debezium/Kafka)
```

---

## Key Takeaways

1. **Storage layout is fundamental**: The choice between row and column orientation determines query performance by orders of magnitude.

2. **Row groups are the breakthrough**: Grouping rows together while storing columns within each group gives you analytical performance with reasonable point query capability.

3. **Predicate pushdown is powerful**: Statistics in file footers let you skip entire row groups without reading data—but only if your data is sorted or partitioned wisely.

4. **No single format is best**: OLTP needs rows, OLAP needs columns, and real-world apps often need both. Choose based on your primary workload, then architect for the secondary.

5. **Hybrid is the future**: Whether through row-group formats like Parquet, HTAP databases like TiDB, or multi-engine architectures, the industry is converging on solutions that handle both patterns.

---

*Working with large datasets? I'd love to hear how you're handling the OLTP/OLAP divide. Are you running separate systems, using HTAP, or something else entirely?*
