---
title: 'ScyllaDB and Elasticsearch for E-commerce: Specialized Databases (Part 2/3)'
description: 'Deep dive into ScyllaDB for extreme write throughput and Elasticsearch for lightning-fast product search - when to use specialized databases.'
date: 2026-01-18
tags: ['databases', 'scalability', 'e-commerce', 'scylladb', 'elasticsearch', 'series']
---

In [Part 1](/blog/database-comparison-part-1-mongodb-vs-postgresql), we compared MongoDB and PostgreSQL for general-purpose e-commerce product storage. Both are excellent choices, but sometimes you need specialized databases for specific workloads.

In this post, we'll explore two specialized databases:
- **ScyllaDB**: For extreme write throughput (inventory updates at massive scale)
- **Elasticsearch**: For lightning-fast product search and faceted filtering

**Series Overview:**
- Part 1: MongoDB vs PostgreSQL ✅
- **Part 2** (this post): ScyllaDB and Elasticsearch
- Part 3: Hybrid architectures and decision framework

---

## ScyllaDB: The High-Throughput Beast

ScyllaDB is a Cassandra-compatible wide-column store written in C++. It's designed for **extreme write throughput** and **predictable low latency**—perfect for real-time inventory tracking at massive scale.

### Why ScyllaDB Exists

Traditional databases struggle with write-heavy workloads:
- **PostgreSQL**: 2,000-5,000 writes/sec (lock contention on hot rows)
- **MongoDB**: 5,000-10,000 writes/sec per shard (write conflicts under extreme load)

**ScyllaDB**: 50,000-100,000+ writes/sec with sub-millisecond latency, even during Black Friday traffic spikes.

### Architecture Highlights

- **Written in C++**: No garbage collection pauses (unlike Cassandra's Java)
- **Shard-per-core model**: Maximizes CPU utilization
- **Async I/O**: Non-blocking operations for maximum throughput
- **Auto-tuning**: Automatically optimizes for your hardware

### Schema Design

```cql
CREATE KEYSPACE ecommerce WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'datacenter1': 3  -- Replication factor of 3
};

USE ecommerce;

-- Main products table
CREATE TABLE products (
  product_id TEXT PRIMARY KEY,
  name TEXT,
  category TEXT,
  price DECIMAL,
  brand TEXT,
  in_stock BOOLEAN,
  attributes MAP<TEXT, TEXT>, -- Key-value pairs for flexible attributes
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Separate table optimized for inventory (high-write workload)
-- Note: Counter tables can ONLY have counter columns + primary key columns
CREATE TABLE inventory (
  product_id TEXT PRIMARY KEY,
  quantity COUNTER  -- Special counter type for atomic increments
);

-- Materialized view for category queries
CREATE MATERIALIZED VIEW products_by_category AS
  SELECT * FROM products
  WHERE category IS NOT NULL AND product_id IS NOT NULL
  PRIMARY KEY (category, product_id);
```

**Key concepts**:
- **Partition key**: Determines data distribution (e.g., `product_id`)
- **Counter columns**: Atomic increment/decrement without read-modify-write
- **Materialized views**: Precomputed query results for specific access patterns

### Query Performance

#### Product ID Lookup (Exceptional)

```cql
SELECT * FROM products WHERE product_id = 'prod_12345';

-- Performance: Sub-millisecond (< 1ms)
-- Direct partition key lookup, no index needed
```

ScyllaDB's partition key lookups are **the fastest** of any database—data is stored by partition key, so it's a direct memory/disk access.

#### Multi-Column Filtering (Challenge)

```cql
-- This query is SLOW in ScyllaDB
SELECT * FROM products
WHERE category = 'Electronics'
  AND price < 500
  AND brand = 'Sony'
ALLOW FILTERING;

-- ALLOW FILTERING scans all partitions - avoid in production!
```

**Problem**: ScyllaDB is NOT optimized for arbitrary multi-column queries. It's designed for known access patterns.

**Solution 1**: Materialized Views
```cql
CREATE MATERIALIZED VIEW products_by_category_brand AS
  SELECT * FROM products
  WHERE category IS NOT NULL
    AND brand IS NOT NULL
    AND product_id IS NOT NULL
  PRIMARY KEY ((category, brand), product_id);

-- Now this is fast:
SELECT * FROM products_by_category_brand
WHERE category = 'Electronics' AND brand = 'Sony';
```

**Trade-off**: Each materialized view duplicates data and adds write overhead. For 100M products, a materialized view adds ~200GB storage and increases write latency.

**Solution 2**: Secondary Indexes (use sparingly)
```cql
CREATE INDEX ON products (brand);

SELECT * FROM products WHERE brand = 'Sony';
-- Works, but not as efficient as partition key queries
```

**Recommendation**: Use ScyllaDB for known access patterns (product ID lookup, inventory updates), not for ad-hoc filtering.

### Write Performance (Where ScyllaDB Shines)

#### Atomic Inventory Increment (Best-in-Class)

```cql
UPDATE inventory
SET quantity = quantity + 1
WHERE product_id = 'prod_12345';

-- Performance: 50,000-100,000+ writes/sec
-- Sub-millisecond P99 latency even under load
-- No lock contention - uses Last-Write-Wins (LWW)
```

**Why so fast?**
- No row-level locking (unlike PostgreSQL)
- No write conflicts (unlike MongoDB under extreme load)
- Writes are append-only (LSM tree structure)
- C++ implementation avoids GC pauses

**Real-world example**: During a flash sale, 10,000 customers try to buy the same product simultaneously:
- **PostgreSQL**: Lock contention, some requests timeout
- **MongoDB**: Write conflicts, retries needed
- **ScyllaDB**: All 10,000 writes complete in < 10ms

#### Counter Columns for Inventory

```cql
-- Counter columns are special - they handle concurrency automatically
CREATE TABLE inventory (
  product_id TEXT PRIMARY KEY,
  quantity COUNTER
);

-- Decrement inventory (atomic, no race conditions)
UPDATE inventory
SET quantity = quantity - 1
WHERE product_id = 'prod_12345';

-- Increment inventory (e.g., restocking)
UPDATE inventory
SET quantity = quantity + 100
WHERE product_id = 'prod_12345';
```

**Note**: Counter columns have limitations:
- All non-primary-key columns in a counter table must be counters (no mixing with regular columns)
- Can't be set to a specific value — only increment/decrement from an implicit starting value of 0
- Updates are **not idempotent** — if a write fails and the client retries, the counter may be incremented twice
- Once deleted, counter values should not be reused (behavior is undefined)

For e-commerce, these trade-offs are usually acceptable — the extreme throughput outweighs the edge cases, and you can mitigate double-counting with application-level deduplication.

#### Stock Status Toggle

```cql
UPDATE products
SET in_stock = false,
    updated_at = toTimestamp(now())
WHERE product_id = 'prod_12345';

-- Lightweight column update, extremely fast
```

#### Bulk Updates

```cql
-- Batch updates (use sparingly - batches should be small)
BEGIN BATCH
  UPDATE products SET price = 359.99 WHERE product_id = 'prod_1';
  UPDATE products SET price = 449.99 WHERE product_id = 'prod_2';
  UPDATE products SET price = 299.99 WHERE product_id = 'prod_3';
APPLY BATCH;

-- Note: Batches in ScyllaDB are for atomicity, not performance
-- For bulk updates, use async parallel writes instead
```

### Scaling Strategy

ScyllaDB scales **linearly** by adding nodes. This is its superpower.

**Starting cluster** (100M products):
```
6 nodes with RF=3 (each piece of data stored on 3 of the 6 nodes)
- Each node: i3.2xlarge (8 vCPUs, 61GB RAM, 1.9TB NVMe SSD)
- Effective capacity: ~3.8TB (6 × 1.9TB / RF 3)
- Write throughput: ~150,000 writes/sec
```

> **Note**: Replication factor (RF) doesn't multiply the node count — it determines how many of the existing nodes hold a copy of each piece of data. RF=3 with 6 nodes means each row is stored on 3 out of 6 nodes.

**Scaling up** (500M products, 10x traffic):
```
12 nodes with RF=3
- Write throughput: ~300,000 writes/sec
- Linear scaling - double nodes, double throughput
```

**No single point of failure**: All nodes are equal (no primary/replica distinction).

### Cost Analysis (ScyllaDB Cloud)

For 100M products with high write volume:

**Cluster Configuration**:
- 6 nodes (i3.2xlarge equivalent) with RF=3
- Multi-AZ deployment

**Monthly Cost Breakdown**:
- **Compute**: $3,000 (6 nodes × $500/month)
- **Storage**: Included in instance cost (NVMe SSDs)
- **Data transfer**: $100-$300 (variable)
- **Total**: **$3,100-$3,300/month**

**3-year TCO**: ~$111,600-$118,800

**Cost per write**: $0.10-$0.20 per million writes (most efficient)

**Key insight**: ScyllaDB costs more than PostgreSQL/MongoDB in absolute terms, but handles **10-20x more load per node**. If you need extreme write throughput, it's actually more cost-effective.

### Maintenance

**Daily operations**:
- ✅ **Compaction**: Automatic with Incremental Compaction Strategy (ICS)
- ✅ **Repairs**: Automatic repair for data consistency
- ✅ **No garbage collection tuning**: C++ implementation
- ✅ **Auto-scaling**: Add/remove nodes without downtime

**Operational complexity**: Medium to High
- Requires understanding of partition keys and data modeling
- Monitoring is critical (use ScyllaDB Monitoring Stack)
- Repair operations need monitoring

### ScyllaDB Verdict

**Strengths**:
- ✅ **Exceptional write throughput** (50K-100K+ writes/sec)
- ✅ **Sub-millisecond latency** even under extreme load
- ✅ **Linear scalability** - add nodes for more capacity
- ✅ **No GC pauses** - predictable performance
- ✅ **Cost-efficient per operation** for high-volume workloads

**Weaknesses**:
- ❌ **Limited query flexibility** - not for ad-hoc multi-column filtering
- ❌ **Eventual consistency** by default (tunable, but not ACID)
- ❌ **Higher base cost** than PostgreSQL/MongoDB
- ❌ **Steeper learning curve** - requires understanding of distributed systems

**Best for**: Extreme write throughput scenarios (real-time inventory during flash sales, high-frequency stock updates, time-series data).

**Not for**: Primary product catalog storage (use PostgreSQL/MongoDB), complex queries, strong ACID requirements.

---

## Elasticsearch: The Search Specialist

Elasticsearch is a **search engine**, not a primary database. It excels at full-text search, faceted filtering, and aggregations—but it's not designed for transactional updates.

### Why Elasticsearch Exists

Traditional databases struggle with search:
- **PostgreSQL**: Full-text search is slow for millions of rows
- **MongoDB**: Text search exists but not as powerful as Elasticsearch
- **ScyllaDB**: Not designed for search at all

**Elasticsearch**: Inverted indexes make search blazing fast, even across billions of documents.

### Architecture Highlights

- **Inverted indexes**: Map terms to documents (opposite of traditional indexes)
- **Distributed search**: Queries run in parallel across shards
- **Near real-time**: Documents searchable within 1 second of indexing
- **Built on Apache Lucene**: Battle-tested search library

### Schema Design

```json
PUT /products
{
  "settings": {
    "number_of_shards": 5,
    "number_of_replicas": 1,
    "refresh_interval": "1s"
  },
  "mappings": {
    "properties": {
      "product_id": { "type": "keyword" },
      "name": {
        "type": "text",
        "fields": {
          "keyword": { "type": "keyword" }
        }
      },
      "category": { "type": "keyword" },
      "price": { "type": "float" },
      "quantity": { "type": "integer" },
      "in_stock": { "type": "boolean" },
      "brand": { "type": "keyword" },
      "description": { "type": "text" },
      "attributes": {
        "type": "object",
        "dynamic": true
      },
      "created_at": { "type": "date" }
    }
  }
}
```

**Field types**:
- **keyword**: Exact match (categories, brands, IDs)
- **text**: Full-text search (product names, descriptions)
- **object**: Nested JSON (flexible attributes)

### Query Performance

#### Product ID Lookup

```json
GET /products/_doc/prod_12345

// Performance: 10-50ms
// Fast but not optimal for primary data retrieval
```

Elasticsearch can do ID lookups, but it's not as fast as ScyllaDB (sub-ms) or PostgreSQL (5ms). **Don't use Elasticsearch as your primary database.**

#### Multi-Column Filtering (Where Elasticsearch Excels)

```json
POST /products/_search
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "category": "Electronics" } },
        { "range": { "price": { "lt": 500 } } },
        { "term": { "brand": "Sony" } },
        { "term": { "in_stock": true } }
      ]
    }
  },
  "size": 20,
  "from": 0
}

// Performance: 50-200ms for millions of documents
// Inverted indexes make complex filters extremely fast
```

**Why so fast?**
- Inverted indexes: Each term points to matching documents
- Boolean queries combine filters efficiently
- Shard-level parallelism: Query runs on all shards simultaneously

#### Full-Text Search

```json
POST /products/_search
{
  "query": {
    "multi_match": {
      "query": "wireless noise cancelling headphones",
      "fields": ["name^2", "description"],
      "fuzziness": "AUTO"
    }
  }
}

// Returns relevant products even with typos
// Relevance scoring ranks results by match quality
```

**Features**:
- **Fuzzy matching**: Handles typos ("headphnes" → "headphones")
- **Synonyms**: "laptop" matches "notebook"
- **Boosting**: Name matches rank higher than description matches
- **Autocomplete**: Suggest products as users type

#### Faceted Search (Killer Feature)

```json
POST /products/_search
{
  "size": 0,
  "query": {
    "bool": {
      "filter": [
        { "term": { "category": "Electronics" } },
        { "range": { "price": { "lt": 500 } } }
      ]
    }
  },
  "aggs": {
    "brands": {
      "terms": {
        "field": "brand",
        "size": 50
      }
    },
    "price_ranges": {
      "range": {
        "field": "price",
        "ranges": [
          { "key": "Under $100", "to": 100 },
          { "key": "$100-$250", "from": 100, "to": 250 },
          { "key": "$250-$500", "from": 250, "to": 500 },
          { "key": "$500+", "from": 500 }
        ]
      }
    },
    "avg_price": {
      "avg": { "field": "price" }
    }
  }
}

// Returns:
// {
//   "aggregations": {
//     "brands": {
//       "buckets": [
//         { "key": "Sony", "doc_count": 1234 },
//         { "key": "Samsung", "doc_count": 987 },
//         { "key": "LG", "doc_count": 654 }
//       ]
//     },
//     "price_ranges": {
//       "buckets": [
//         { "key": "Under $100", "doc_count": 543 },
//         { "key": "$100-$250", "doc_count": 2341 },
//         { "key": "$250-$500", "doc_count": 1876 }
//       ]
//     },
//     "avg_price": { "value": 287.45 }
//   }
// }
```

This is **impossible to do efficiently** in traditional databases at scale. Elasticsearch aggregations are optimized for this exact use case.

### Write Performance (Major Limitation)

#### Inventory Updates (Not Recommended)

```json
POST /products/_update/prod_12345
{
  "script": {
    "source": "ctx._source.quantity -= params.amount",
    "params": { "amount": 1 }
  }
}

// Problems:
// 1. No atomic increment (uses versioning for optimistic locking)
// 2. Refresh interval (default 1s) means writes aren't immediately searchable
// 3. Not designed for high-frequency transactional updates
```

**Consistency**: Elasticsearch is **eventually consistent**. A product updated to "out of stock" might still appear in search results for up to 1 second.

**For e-commerce inventory, this is unacceptable.** Never use Elasticsearch as your source of truth for inventory.

#### Bulk Indexing (For Initial Load)

```json
POST /_bulk
{ "index": { "_index": "products", "_id": "prod_1" } }
{ "name": "Product 1", "price": 99.99, "category": "Electronics" }
{ "index": { "_index": "products", "_id": "prod_2" } }
{ "name": "Product 2", "price": 149.99, "category": "Clothing" }

// Efficient for bulk loading data
// Can index 10,000-50,000 docs/sec
```

### Scaling Strategy

Elasticsearch scales horizontally via **sharding**.

**Shard calculation** for 100M products:
```
Total data: 200GB
Shard size: 30-50GB (recommended)
Number of shards: 5-7

Recommended: 5 shards, 1 replica
Total shards: 10 (5 primary + 5 replica)
Nodes: 3-6 (distribute shards across nodes)
```

**Cluster setup**:
```json
PUT /products
{
  "settings": {
    "number_of_shards": 5,
    "number_of_replicas": 1
  }
}
```

### Cost Analysis (Elastic Cloud)

For 100M products (search workload):

**Cluster Configuration**:
- 3 hot nodes (data + search)
- 64GB RAM, 8 vCPUs per node
- 200GB storage per node

**Monthly Cost Breakdown**:
- **Compute**: $1,200 (hot tier)
- **Storage**: $300 (600GB total with replication)
- **Data transfer**: $100-$200
- **Total**: **$1,600-$1,700/month**

**3-year TCO**: ~$57,600-$61,200

**Cost optimization**:
- Use warm/cold tiers for older products ($0.05/GB vs $0.15/GB)
- Optimize shard count (too many shards = overhead)
- Use index lifecycle management (ILM) to move old data to cheaper tiers

### Maintenance

**Daily operations**:
- ⚠️ **Index management**: Reindex for schema changes (no ALTER TABLE)
- ⚠️ **Cluster health**: Monitor shard allocation, heap usage
- ⚠️ **Refresh interval tuning**: Balance write performance vs search latency
- ✅ **Snapshots**: Automated backups to S3

**Operational complexity**: Medium
- Requires understanding of shards, replicas, and cluster health
- Index management is manual (unlike database schema migrations)
- Heap tuning critical for performance

### Elasticsearch Verdict

**Strengths**:
- ✅ **Exceptional search performance** (full-text, fuzzy, autocomplete)
- ✅ **Faceted filtering** - best-in-class aggregations
- ✅ **Flexible schema** - dynamic mapping for new fields
- ✅ **Horizontal scaling** - add nodes for more capacity
- ✅ **Rich ecosystem** - Kibana for visualization, Logstash for data pipelines

**Weaknesses**:
- ❌ **Not a primary database** - eventual consistency, no ACID
- ❌ **Poor for transactional updates** (inventory, stock status)
- ❌ **Index management overhead** - reindexing for schema changes
- ❌ **Memory-intensive** - requires significant heap for large datasets

**Best for**: Search and filtering layer in a hybrid architecture. Essential for e-commerce UX.

**Not for**: Primary data storage, inventory management, transactional updates.

---

## ScyllaDB vs Elasticsearch: Comparison

| Feature | ScyllaDB | Elasticsearch |
|---------|----------|---------------|
| **Primary Use Case** | High-volume writes | Search and filtering |
| **Write Throughput** | ⭐⭐⭐⭐⭐ (50K-100K+/sec) | ⭐⭐ (not designed for writes) |
| **Product ID Lookup** | ⭐⭐⭐⭐⭐ (sub-ms) | ⭐⭐⭐ (10-50ms) |
| **Multi-Column Filtering** | ⭐ (limited) | ⭐⭐⭐⭐⭐ (exceptional) |
| **Full-Text Search** | ❌ (not supported) | ⭐⭐⭐⭐⭐ (best-in-class) |
| **Faceted Search** | ❌ (not supported) | ⭐⭐⭐⭐⭐ (killer feature) |
| **Consistency** | ⭐⭐⭐ (tunable) | ⭐⭐ (eventual) |
| **Cost (3-year TCO)** | $111K-$118K | $57K-$61K |
| **Operational Complexity** | ⭐⭐⭐ (medium-high) | ⭐⭐⭐ (medium) |

### When to Use ScyllaDB
- ✅ Extreme write volume (> 50K writes/sec)
- ✅ Real-time inventory tracking during flash sales
- ✅ Time-series data (clickstreams, events)
- ✅ Known access patterns (product ID lookups)

### When to Use Elasticsearch
- ✅ Product search is a core UX requirement
- ✅ Faceted filtering (show counts per brand, price range, etc.)
- ✅ Full-text search with typo tolerance
- ✅ You're using it **alongside** a primary database

---

## What's Next

In **Part 3**, we'll bring it all together:
- **Hybrid architectures**: Using multiple databases together
- **Cost comparison**: All four databases side-by-side
- **Decision framework**: How to choose the right database(s) for your use case
- **Real-world examples**: Architecture patterns from successful e-commerce platforms

**Coming soon!** Subscribe or follow for updates.

---

*Have you used ScyllaDB or Elasticsearch in production? What challenges did you face? Share your experiences in the comments!*
