---
title: 'Database Showdown for 100M Products: MongoDB vs PostgreSQL (Part 1/3)'
description: 'Comparing MongoDB and PostgreSQL for e-commerce product catalogs at scale - schema flexibility, query performance, write throughput, and cost analysis.'
date: 2026-01-18
tags: ['databases', 'scalability', 'e-commerce', 'mongodb', 'postgresql', 'series']
---

When building an e-commerce platform that needs to handle 100 million products, choosing the right database is critical. In this 3-part series, I'll compare four databases—MongoDB, PostgreSQL, ScyllaDB, and Elasticsearch—based on my analysis of their performance, cost, and scalability for this specific use case.

**Series Overview:**
- **Part 1** (this post): MongoDB vs PostgreSQL
- **Part 2**: ScyllaDB and Elasticsearch deep dives
- **Part 3**: Hybrid architectures and decision framework

## The Challenge

Let's establish the requirements for our 100 million product catalog:

### Data Scale
- **100 million product rows** with variable attributes
- Products have common fields (id, name, price, stock status) and category-specific attributes
- Average document size: ~2KB per product
- Total data: ~200GB

### Query Patterns
1. **Point lookups**: Fetch product by ID (most common operation)
2. **Multi-column filtering**: `category = "Electronics" AND price < 500 AND brand = "Sony" AND in_stock = true`
3. **Faceted search**: Show filter counts (e.g., "Sony (1,234 products), Samsung (987 products)")

### Write Operations (High Volume)
1. **Inventory updates**: Atomic increment/decrement of quantity (1,000-10,000 writes/sec during peak)
2. **Stock status changes**: Toggle in_stock/out_of_stock flags
3. **Bulk updates**: Periodic price changes across product sets

### Performance Requirements
- Read latency: < 100ms for ID lookup, < 500ms for filtered queries
- Write latency: < 50ms for inventory updates (critical for checkout)
- Strong consistency for inventory, eventual consistency acceptable for product attributes

Now let's see how MongoDB and PostgreSQL handle these requirements.

---

## MongoDB: The Flexible Document Store

MongoDB's document model is a natural fit for products with variable attributes. Each product is a JSON document that can have different fields without schema migrations.

### Schema Design

```javascript
{
  "_id": "prod_12345",
  "name": "Sony WH-1000XM5 Headphones",
  "category": "Electronics",
  "price": 399.99,
  "quantity": 47,
  "in_stock": true,
  "brand": "Sony",
  // Electronics-specific attributes
  "bluetooth_version": "5.2",
  "battery_life_hours": 30,
  "noise_cancellation": true
}

// Different schema for clothing - no problem!
{
  "_id": "prod_67890",
  "name": "Levi's 501 Jeans",
  "category": "Clothing",
  "price": 89.99,
  "quantity": 156,
  "in_stock": true,
  "brand": "Levi's",
  // Clothing-specific attributes
  "size": "32x34",
  "color": "Dark Blue",
  "material": "100% Cotton"
}
```

**Key advantage**: No schema migrations when adding new product types or attributes. Electronics can have `bluetooth_version`, clothing can have `size`, and MongoDB doesn't care.

### Query Performance

#### Product ID Lookup

```javascript
db.products.findOne({ _id: "prod_12345" })
// Performance: < 10ms with _id index (O(1) lookup)
```

MongoDB's `_id` field is automatically indexed, making single-product lookups extremely fast.

#### Multi-Column Filtering

```javascript
db.products.find({
  category: "Electronics",
  price: { $lt: 500 },
  brand: "Sony",
  in_stock: true
})

// Create compound index for optimal performance
db.products.createIndex({
  category: 1,
  price: 1,
  brand: 1,
  in_stock: 1
})

// Performance: 50-200ms depending on selectivity
```

**Challenge**: With many possible filter combinations, you need multiple compound indexes. Each index increases storage and write overhead.

**Index strategy for 100M products**:
```javascript
// Core indexes
db.products.createIndex({ category: 1, price: 1 })
db.products.createIndex({ brand: 1, in_stock: 1 })
db.products.createIndex({ category: 1, brand: 1, price: 1 })

// Monitor with explain()
db.products.find({...}).explain("executionStats")
```

#### Faceted Search with Aggregation Pipeline

```javascript
db.products.aggregate([
  {
    $match: {
      category: "Electronics",
      price: { $lt: 500 }
    }
  },
  {
    $facet: {
      "brands": [
        { $group: { _id: "$brand", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ],
      "price_ranges": [
        {
          $bucket: {
            groupBy: "$price",
            boundaries: [0, 100, 250, 500, 1000],
            default: "1000+",
            output: { count: { $sum: 1 } }
          }
        }
      ]
    }
  }
])

// Returns:
// brands: [{ _id: "Sony", count: 1234 }, { _id: "Samsung", count: 987 }]
// price_ranges: [{ _id: 0, count: 543 }, { _id: 100, count: 2341 }]
```

MongoDB's aggregation pipeline is powerful for faceted search, though not as fast as Elasticsearch (we'll cover that in Part 2).

### Write Performance

#### Atomic Inventory Increment

```javascript
db.products.updateOne(
  { _id: "prod_12345" },
  { $inc: { quantity: -1 } }
)

// Performance: 5,000-10,000 writes/sec per shard
// Uses optimistic concurrency control
```

The `$inc` operator is atomic—critical for preventing overselling during concurrent checkouts.

**Handling high concurrency**:
```javascript
// Retry logic for write conflicts
async function decrementInventory(productId, amount) {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await db.products.updateOne(
        { _id: productId, quantity: { $gte: amount } },
        { $inc: { quantity: -amount } }
      );
      
      if (result.modifiedCount === 1) {
        return { success: true };
      }
      return { success: false, reason: "Insufficient inventory" };
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(10 * Math.pow(2, i)); // Exponential backoff
    }
  }
}
```

#### Stock Status Toggle

```javascript
db.products.updateOne(
  { _id: "prod_12345" },
  { $set: { in_stock: false } }
)
// Very fast, simple field update
```

#### Bulk Price Update

```javascript
db.products.updateMany(
  { brand: "Sony" },
  { $mul: { price: 0.9 } } // 10% discount
)

// Efficient for bulk operations
// Can process thousands of updates per second
```

### Scaling Strategy

MongoDB scales horizontally via **sharding**. For 100M products, you'll need to shard.

```javascript
// Enable sharding
sh.enableSharding("ecommerce")

// Choose shard key carefully - this is critical!
sh.shardCollection("ecommerce.products", { category: 1, _id: 1 })
```

**Shard key considerations**:
- **Good**: `{ category: 1, _id: 1 }` - Even distribution, targeted queries
- **Bad**: `{ _id: 1 }` - Random distribution, all queries scatter
- **Bad**: `{ category: 1 }` - Uneven distribution if some categories are huge

**Typical setup for 100M products**:
- 3-5 shards for data distribution
- 3 config servers (for metadata)
- 2 mongos routers (query routing)
- Replica set per shard (3 nodes each for redundancy)

### Cost Analysis (MongoDB Atlas)

For 100M documents (~200GB data + indexes):

**Recommended Tier**: M50 or M60 (dedicated cluster)

**Monthly Cost Breakdown**:
- **Compute**: $1,200 (M50: 32GB RAM, 8 vCPUs)
- **Storage**: $200 (200GB at $0.25/GB-month)
- **Backups**: $100 (automated snapshots)
- **Data transfer**: $50-$200 (variable)
- **Total**: **$1,550-$1,700/month**

**3-year TCO**: ~$55,800-$61,200

**Cost optimization tips**:
- Use online archive for old/inactive products ($0.025/GB vs $0.25/GB)
- Compress indexes (can save 30-40% storage)
- Use reserved capacity for 20% discount

### Maintenance

**Daily operations**:
- ✅ **Backups**: Automated daily snapshots (included)
- ✅ **Monitoring**: Atlas provides built-in monitoring
- ⚠️ **Index management**: Monitor slow queries, create/drop indexes as needed
- ⚠️ **Sharding**: Monitor chunk distribution, occasionally rebalance

**Operational complexity**: Medium
- Atlas handles most infrastructure
- You manage schema design and indexing
- Sharding adds complexity but Atlas automates much of it

### MongoDB Verdict

**Strengths**:
- ✅ Excellent schema flexibility for variable product attributes
- ✅ Good write performance (5-10K writes/sec per shard)
- ✅ Horizontal scaling via sharding
- ✅ Rich query language and aggregation framework
- ✅ Managed service (Atlas) reduces operational overhead

**Weaknesses**:
- ❌ Index management complexity with many filter combinations
- ❌ Write conflicts under extreme concurrency (though rare)
- ❌ Eventual consistency by default (can configure for strong consistency)

**Best for**: Rapidly evolving product catalogs where attributes change frequently, moderate to high write volumes (5-10K writes/sec).

---

## PostgreSQL: The Relational Powerhouse with JSONB

PostgreSQL might seem like an odd choice for variable schemas, but its **JSONB** data type bridges the gap between relational and document models.

### Schema Design

```sql
CREATE TABLE products (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  in_stock BOOLEAN NOT NULL DEFAULT true,
  brand VARCHAR(100),
  attributes JSONB, -- Flexible attributes here!
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for optimal performance
CREATE INDEX idx_category_price ON products(category, price);
CREATE INDEX idx_brand_stock ON products(brand, in_stock);
CREATE INDEX idx_attributes_gin ON products USING GIN (attributes);
```

**Sample data**:
```sql
INSERT INTO products VALUES (
  'prod_12345',
  'Sony WH-1000XM5 Headphones',
  'Electronics',
  399.99,
  47,
  true,
  'Sony',
  '{"bluetooth_version": "5.2", "battery_life_hours": 30, "noise_cancellation": true}',
  NOW(),
  NOW()
);

INSERT INTO products VALUES (
  'prod_67890',
  'Levi''s 501 Jeans',
  'Clothing',
  89.99,
  156,
  true,
  'Levi''s',
  '{"size": "32x34", "color": "Dark Blue", "material": "100% Cotton"}',
  NOW(),
  NOW()
);
```

**Hybrid approach**: Core attributes in columns (for performance), variable attributes in JSONB (for flexibility).

### Query Performance

#### Product ID Lookup

```sql
SELECT * FROM products WHERE id = 'prod_12345';

-- Performance: < 5ms with primary key index
-- Fastest of all databases for single-row lookups
```

PostgreSQL's B-tree indexes are incredibly efficient for primary key lookups.

#### Multi-Column Filtering

```sql
SELECT * FROM products
WHERE category = 'Electronics'
  AND price < 500
  AND brand = 'Sony'
  AND in_stock = true;

-- Performance: 50-150ms with proper indexes
-- Uses index scan on idx_category_price
```

**JSONB queries**:
```sql
-- Query flexible attributes
SELECT * FROM products
WHERE category = 'Electronics'
  AND price < 500
  AND attributes @> '{"brand": "Sony"}' -- JSONB containment
  AND in_stock = true;

-- GIN index on attributes makes this fast
-- Performance: 100-300ms depending on result set size
```

**JSONB operators**:
- `@>`: Contains (e.g., `attributes @> '{"brand": "Sony"}'`)
- `->`: Get JSON field (e.g., `attributes->'brand'`)
- `->>`: Get JSON field as text (e.g., `attributes->>'brand'`)
- `?`: Key exists (e.g., `attributes ? 'bluetooth_version'`)

#### Faceted Search (Aggregations)

```sql
-- Brand facets
SELECT brand, COUNT(*) as count
FROM products
WHERE category = 'Electronics' AND price < 500
GROUP BY brand
ORDER BY count DESC
LIMIT 20;

-- Price range facets
SELECT
  CASE
    WHEN price < 100 THEN '0-100'
    WHEN price < 250 THEN '100-250'
    WHEN price < 500 THEN '250-500'
    ELSE '500+'
  END as price_range,
  COUNT(*) as count
FROM products
WHERE category = 'Electronics'
GROUP BY price_range;
```

PostgreSQL can do faceted search, but it's slower than Elasticsearch for complex aggregations across millions of rows.

### Write Performance

#### Atomic Inventory Increment

```sql
UPDATE products
SET quantity = quantity - 1,
    updated_at = NOW()
WHERE id = 'prod_12345';

-- Performance: 2,000-5,000 writes/sec (single instance)
-- Uses MVCC (Multi-Version Concurrency Control)
```

**Challenge**: **Lock contention** on hot rows (popular products during flash sales).

When multiple transactions try to update the same product simultaneously, PostgreSQL uses row-level locking. This can create contention.

**Solution 1**: Optimistic locking with version check
```sql
UPDATE products
SET quantity = quantity - 1,
    updated_at = NOW()
WHERE id = 'prod_12345'
  AND quantity > 0 -- Ensure sufficient inventory
RETURNING *;
```

**Solution 2**: Queue pattern with SKIP LOCKED
```sql
-- For order processing queues
UPDATE products
SET quantity = quantity - 1
WHERE id = (
  SELECT id FROM products
  WHERE id = 'prod_12345' AND quantity > 0
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

This skips locked rows, reducing contention in high-concurrency scenarios.

#### Stock Status Toggle

```sql
UPDATE products
SET in_stock = false,
    updated_at = NOW()
WHERE id = 'prod_12345';

-- Transactional with ACID guarantees
-- Immediately consistent across all connections
```

**ACID compliance** is PostgreSQL's superpower—no eventual consistency issues.

#### Bulk Update

```sql
UPDATE products
SET price = price * 0.9
WHERE brand = 'Sony';

-- Efficient, but locks rows during update
-- For very large updates, use batching:

DO $$
DECLARE
  batch_size INT := 10000;
  affected INT;
BEGIN
  LOOP
    UPDATE products
    SET price = price * 0.9
    WHERE id IN (
      SELECT id FROM products
      WHERE brand = 'Sony' AND price = price -- Unchanged
      LIMIT batch_size
    );
    
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
    COMMIT;
  END LOOP;
END $$;
```

### Scaling Strategy

PostgreSQL offers both vertical and horizontal scaling options.

#### Vertical Scaling (Easiest)

**Amazon Aurora PostgreSQL**:
- Scales up to 128TB storage (auto-scaling)
- Instance types up to 768GB RAM (db.r6g.16xlarge)
- Storage scales in 10GB increments automatically

For 100M products, a **db.r6g.2xlarge** (64GB RAM, 8 vCPUs) handles the load well.

#### Horizontal Scaling

**Read Replicas**:
```sql
-- Offload read queries to replicas
-- Aurora supports up to 15 read replicas
```

**Citus Extension** (for write scaling):
```sql
-- Shard table across multiple nodes
SELECT create_distributed_table('products', 'category');

-- Queries with category filter hit specific shards
-- Queries without category scatter across all shards
```

**Table Partitioning**:
```sql
-- Partition by category for better query performance
CREATE TABLE products_electronics PARTITION OF products
  FOR VALUES IN ('Electronics');

CREATE TABLE products_clothing PARTITION OF products
  FOR VALUES IN ('Clothing');
```

### Cost Analysis (AWS Aurora PostgreSQL)

For 100M rows (~200GB):

**Recommended Instance**: db.r6g.2xlarge (64GB RAM, 8 vCPUs)

**Monthly Cost Breakdown**:
- **Compute**: $600 (on-demand pricing)
- **Storage**: $100 (200GB at $0.10/GB-month for Aurora Standard)
- **I/O**: $100-$1,000 (depends on workload)
  - Aurora Standard: $0.20 per 1M requests
  - Aurora I/O-Optimized: No I/O charges, but higher storage ($0.225/GB)
- **Backups**: $20 (100% of DB size free, additional for longer retention)
- **Total**: **$820-$1,720/month**

**When to use Aurora I/O-Optimized**: If I/O costs exceed 25% of total Aurora costs.

**3-year TCO**: ~$29,500-$61,900

**Cost optimization tips**:
- Use reserved instances for 40% savings
- Aurora I/O-Optimized for high I/O workloads
- Read replicas for scaling reads (cheaper than scaling writes)

### Maintenance

**Daily operations**:
- ✅ **Vacuuming**: Auto-vacuum handles dead tuples automatically
- ✅ **Backups**: Continuous backup to S3 (Aurora)
- ⚠️ **Connection pooling**: Use PgBouncer for high connection counts (1000+)
- ⚠️ **Index maintenance**: Occasional REINDEX for heavily updated tables

**Operational complexity**: Low to Medium
- Aurora handles most infrastructure (failover, backups, scaling)
- You manage schema, indexes, and query optimization
- VACUUM and connection pooling require monitoring

### PostgreSQL Verdict

**Strengths**:
- ✅ **ACID compliance** - strongest consistency guarantees
- ✅ **Fastest single-row lookups** (< 5ms)
- ✅ **JSONB** provides schema flexibility within relational structure
- ✅ **Mature ecosystem** - extensive tooling and expertise
- ✅ **Cost-effective** - lowest TCO for most workloads

**Weaknesses**:
- ❌ Write throughput limited (2-5K writes/sec) vs MongoDB/ScyllaDB
- ❌ Lock contention on hot rows under extreme concurrency
- ❌ Horizontal write scaling requires Citus (adds complexity)

**Best for**: E-commerce platforms requiring strong consistency, ACID compliance, and complex relational queries. Excellent for inventory accuracy and transactional integrity.

---

## MongoDB vs PostgreSQL: Head-to-Head

| Feature | MongoDB | PostgreSQL |
|---------|---------|------------|
| **Schema Flexibility** | ⭐⭐⭐⭐⭐ Native | ⭐⭐⭐⭐ JSONB |
| **Product ID Lookup** | ⭐⭐⭐⭐ (10ms) | ⭐⭐⭐⭐⭐ (5ms) |
| **Multi-Column Filtering** | ⭐⭐⭐ (50-200ms) | ⭐⭐⭐⭐ (50-150ms) |
| **Write Throughput** | ⭐⭐⭐⭐ (5-10K/sec) | ⭐⭐⭐ (2-5K/sec) |
| **Consistency** | ⭐⭐⭐ (tunable) | ⭐⭐⭐⭐⭐ (ACID) |
| **Horizontal Scaling** | ⭐⭐⭐⭐⭐ (sharding) | ⭐⭐⭐ (Citus/partitioning) |
| **Cost (3-year TCO)** | $55K-$61K | $29K-$62K |
| **Operational Complexity** | ⭐⭐⭐ (medium) | ⭐⭐ (low-medium) |

### When to Choose MongoDB
- ✅ Product schemas evolve rapidly (new categories, attributes)
- ✅ Different product types have vastly different attributes
- ✅ Write volume: 5,000-10,000/sec
- ✅ Horizontal scaling is a priority from day one
- ✅ Team prefers document-oriented thinking

### When to Choose PostgreSQL
- ✅ Inventory accuracy is critical (strong ACID guarantees)
- ✅ Write volume < 5,000/sec
- ✅ You have complex relational queries (orders, payments, products)
- ✅ Team has SQL expertise
- ✅ Cost optimization is important

---

## What's Next

In **Part 2**, we'll explore two specialized databases:
- **ScyllaDB**: For extreme write throughput (50K-100K+ writes/sec)
- **Elasticsearch**: For lightning-fast search and faceted filtering

In **Part 3**, we'll cover:
- Hybrid architectures (using multiple databases together)
- Cost comparison across all four databases
- Decision framework for choosing the right database

**Coming soon!** Subscribe or follow for updates.

---

*Have you used MongoDB or PostgreSQL for large-scale e-commerce? What challenges did you face? Share your experiences in the comments!*
