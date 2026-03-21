---
title: 'Hybrid Database Architectures for E-commerce: The Complete Guide (Part 3/3)'
description: 'How to combine MongoDB, PostgreSQL, ScyllaDB, and Elasticsearch for optimal e-commerce performance - cost comparison and decision framework.'
date: 2026-01-18
tags: ['databases', 'scalability', 'e-commerce', 'architecture', 'series']
---

In [Part 1](/blog/database-comparison-part-1-mongodb-vs-postgresql), we compared MongoDB and PostgreSQL. In [Part 2](/blog/database-comparison-part-2-scylladb-elasticsearch), we explored ScyllaDB and Elasticsearch. Now, let's bring it all together.

The reality is: **most e-commerce platforms don't choose just one database**. They use a **hybrid architecture** that leverages each database's strengths.

In this final part, we'll cover:
- Why hybrid architectures are the norm
- Three recommended architecture patterns
- Complete cost comparison
- Decision framework for choosing the right database(s)

**Series Overview:**
- Part 1: MongoDB vs PostgreSQL ✅
- Part 2: ScyllaDB and Elasticsearch ✅
- **Part 3** (this post): Hybrid architectures and decision framework

---

## Why Hybrid Architectures?

No single database excels at all workloads. Here's what we learned:

| Database | Best For | Worst For |
|----------|----------|-----------|
| **PostgreSQL** | ACID transactions, complex queries | Extreme write volume (> 5K/sec) |
| **MongoDB** | Flexible schemas, moderate writes | Strong consistency requirements |
| **ScyllaDB** | Extreme write throughput (50K+/sec) | Ad-hoc multi-column queries |
| **Elasticsearch** | Search, faceted filtering | Primary data storage, inventory |

**The solution**: Use multiple databases, each for what it does best.

### Real-World Example: Shopify's Architecture

Shopify uses:
- **MySQL (PostgreSQL-like)**: Orders, payments, customer data
- **Redis**: Session storage, caching
- **Elasticsearch**: Product search
- **Kafka**: Event streaming between systems

This is the norm, not the exception.

---

## Architecture Pattern 1: PostgreSQL + Elasticsearch

**Best for**: Most e-commerce platforms (< 50K writes/sec)

### Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│              Application Layer                   │
│  (Product pages, search, checkout)              │
└──────────┬─────────────────────────┬─────────────┘
           │                         │
           ▼                         ▼
┌──────────────────────┐   ┌──────────────────────┐
│   PostgreSQL (RDS)   │   │    Elasticsearch     │
│  Source of Truth     │──▶│   Search Layer       │
│                      │   │                      │
│ • Product catalog    │   │ • Multi-column       │
│ • Inventory          │   │   filtering          │
│ • Stock status       │   │ • Faceted search     │
│ • Orders, payments   │   │ • Full-text search   │
│ • Customer data      │   │ • Autocomplete       │
└──────────────────────┘   └──────────────────────┘
         │                           ▲
         │                           │
         └───────────────────────────┘
              CDC (Debezium/Kafka)
```

### Data Flow

1. **Product created** → PostgreSQL (source of truth)
2. **CDC pipeline** → Elasticsearch (near real-time sync via Debezium)
3. **Inventory update** → PostgreSQL (strong consistency)
4. **Product search** → Elasticsearch
5. **Product detail page** → PostgreSQL (by ID)
6. **Checkout** → PostgreSQL (ACID transaction)

### Implementation Details

**PostgreSQL schema**:
```sql
CREATE TABLE products (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  in_stock BOOLEAN NOT NULL DEFAULT true,
  brand VARCHAR(100),
  attributes JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Trigger to update Elasticsearch on changes
CREATE OR REPLACE FUNCTION notify_product_change()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('product_changes', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_change_trigger
AFTER INSERT OR UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION notify_product_change();
```

**CDC with Debezium** (recommended):
```yaml
# Debezium connector config
{
  "name": "postgres-product-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres.example.com",
    "database.port": "5432",
    "database.user": "debezium",
    "database.dbname": "ecommerce",
    "table.include.list": "public.products",
    "transforms": "route",
    "transforms.route.type": "org.apache.kafka.connect.transforms.RegexRouter",
    "transforms.route.regex": ".*",
    "transforms.route.replacement": "elasticsearch-products"
  }
}
```

**Elasticsearch sync** (consumer):
```javascript
// Kafka consumer that syncs to Elasticsearch
kafka.consumer.on('message', async (message) => {
  const product = JSON.parse(message.value);
  
  await elasticsearch.index({
    index: 'products',
    id: product.id,
    body: {
      product_id: product.id,
      name: product.name,
      category: product.category,
      price: product.price,
      in_stock: product.in_stock,
      brand: product.brand,
      attributes: product.attributes
    }
  });
});
```

### Cost Breakdown (100M Products)

| Component | Monthly Cost |
|-----------|--------------|
| **PostgreSQL Aurora** (db.r6g.2xlarge) | $800-$1,200 |
| **Elasticsearch** (3 nodes, 64GB each) | $1,600-$1,700 |
| **Debezium/Kafka** (managed service) | $200-$400 |
| **Total** | **$2,600-$3,300/month** |

**3-year TCO**: $93,600-$118,800

### Pros and Cons

**Pros**:
- ✅ Strong consistency for critical operations (inventory, orders)
- ✅ Excellent search experience (Elasticsearch)
- ✅ Proven pattern (used by Shopify, Etsy, many others)
- ✅ Relatively simple to implement
- ✅ Cost-effective for most workloads

**Cons**:
- ❌ PostgreSQL write throughput may bottleneck at extreme scale (> 10K writes/sec)
- ❌ CDC lag (typically < 1 second, but not real-time)
- ❌ Operational overhead of managing two databases

**When to use**: Most e-commerce platforms with < 50K inventory writes/sec.

---

## Architecture Pattern 2: MongoDB + Elasticsearch

**Best for**: Rapidly evolving product schemas, flexible attributes

### Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│              Application Layer                   │
└──────────┬─────────────────────────┬─────────────┘
           │                         │
           ▼                         ▼
┌──────────────────────┐   ┌──────────────────────┐
│      MongoDB         │   │    Elasticsearch     │
│  Product Catalog     │──▶│   Search Layer       │
│                      │   │                      │
│ • Flexible schema    │   │ • Search/filtering   │
│ • Inventory          │   │ • Faceted search     │
│ • Product attributes │   │                      │
│ • Orders             │   │                      │
└──────────────────────┘   └──────────────────────┘
         │                           ▲
         │                           │
         └───────────────────────────┘
          Change Streams (real-time)
```

### Data Flow

1. **Product created** → MongoDB
2. **Change stream** → Elasticsearch (real-time sync)
3. **Inventory update** → MongoDB (atomic $inc)
4. **Product search** → Elasticsearch
5. **Product detail** → MongoDB (by _id)

### Implementation Details

**MongoDB Change Streams** (built-in CDC):
```javascript
const changeStream = db.collection('products').watch();

changeStream.on('change', async (change) => {
  if (change.operationType === 'insert' || change.operationType === 'update') {
    const product = change.fullDocument;
    
    await elasticsearch.index({
      index: 'products',
      id: product._id,
      body: {
        product_id: product._id,
        name: product.name,
        category: product.category,
        price: product.price,
        in_stock: product.in_stock,
        brand: product.brand,
        ...product.attributes
      }
    });
  } else if (change.operationType === 'delete') {
    await elasticsearch.delete({
      index: 'products',
      id: change.documentKey._id
    });
  }
});
```

### Cost Breakdown (100M Products)

| Component | Monthly Cost |
|-----------|--------------|
| **MongoDB Atlas** (M50, 3-node replica set) | $4,650-$4,800 |
| **Elasticsearch** (3 nodes) | $1,600-$1,700 |
| **Total** | **$6,250-$6,500/month** |

**3-year TCO**: $225,000-$234,000

### Pros and Cons

**Pros**:
- ✅ Excellent schema flexibility (no migrations for new attributes)
- ✅ Good write performance (5-10K writes/sec per shard)
- ✅ Built-in change streams (no external CDC tool)
- ✅ Horizontal scaling via sharding

**Cons**:
- ❌ Weaker consistency guarantees than PostgreSQL
- ❌ Significantly higher cost than PostgreSQL + Elasticsearch
- ❌ No ACID transactions across collections (multi-document transactions added in MongoDB 4.0+, but with performance overhead)

**When to use**: Rapidly evolving product schemas, new product types frequently added.

---

## Architecture Pattern 3: PostgreSQL + ScyllaDB + Elasticsearch

**Best for**: Extreme scale (> 50K inventory writes/sec), flash sales, high-traffic events

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                     │
│  (Product pages, search, checkout, inventory updates)   │
└──────┬────────────────────────┬──────────────────┬───────┘
       │                        │                  │
       ▼                        ▼                  ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────┐
│  PostgreSQL  │   │    ScyllaDB      │   │Elasticsearch │
│  Catalog     │──▶│  Inventory       │   │  Search      │
│              │   │                  │   │              │
│ • Products   │   │ • Real-time qty  │   │ • Filtering  │
│ • Attributes │   │ • Stock status   │   │ • Faceted    │
│ • Orders     │   │ • Hot products   │   │   search     │
│ • Payments   │   │                  │   │              │
└──────────────┘   └──────────────────┘   └──────────────┘
       │                    ▲                      ▲
       │                    │                      │
       └────────────────────┴──────────────────────┘
                    CDC Pipeline (Kafka)
```

### Data Flow

1. **Product created** → PostgreSQL (source of truth)
2. **CDC** → ScyllaDB (inventory table), Elasticsearch (search index)
3. **Inventory update** → ScyllaDB (real-time, 100K+ writes/sec)
4. **Async sync** → PostgreSQL (eventual consistency for reporting)
5. **Product search** → Elasticsearch
6. **Product detail** → PostgreSQL (attributes) + ScyllaDB (current inventory)
7. **Checkout** → ScyllaDB (decrement inventory), PostgreSQL (create order)

### Implementation Details

**PostgreSQL** (product catalog):
```sql
CREATE TABLE products (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  brand VARCHAR(100),
  attributes JSONB
);
```

**ScyllaDB** (real-time inventory):
```cql
-- Counter table: only counter columns + primary key allowed
CREATE TABLE inventory (
  product_id TEXT PRIMARY KEY,
  quantity COUNTER
);

-- Separate table for stock metadata (non-counter)
CREATE TABLE inventory_status (
  product_id TEXT PRIMARY KEY,
  in_stock BOOLEAN,
  last_updated TIMESTAMP
);

-- Hot products table for flash sales (counter-only)
CREATE TABLE hot_products (
  product_id TEXT PRIMARY KEY,
  quantity COUNTER,
  reserved COUNTER  -- Items in shopping carts
);
-- Note: "available" must be computed at the application layer
-- as (quantity - reserved), not stored as a counter
```

**Inventory update flow**:
```javascript
// High-volume inventory decrement
async function decrementInventory(productId, amount) {
  // 1. Update ScyllaDB (real-time, sub-ms)
  await scylla.execute(
    'UPDATE inventory SET quantity = quantity - ? WHERE product_id = ?',
    [amount, productId]
  );
  
  // 2. Publish event to Kafka (async sync to PostgreSQL)
  await kafka.publish('inventory-updates', {
    product_id: productId,
    quantity_change: -amount,
    timestamp: Date.now()
  });
  
  // 3. PostgreSQL sync happens asynchronously
  // (eventual consistency for reporting/analytics)
}
```

### Cost Breakdown (100M Products, Extreme Scale)

| Component | Monthly Cost |
|-----------|--------------|
| **PostgreSQL Aurora** (db.r6g.xlarge) | $400-$600 |
| **ScyllaDB Cloud** (6 nodes) | $3,000-$3,300 |
| **Elasticsearch** (3 nodes) | $1,600-$1,700 |
| **Kafka** (managed) | $300-$500 |
| **Total** | **$5,300-$6,100/month** |

**3-year TCO**: $190,800-$219,600

### Pros and Cons

**Pros**:
- ✅ Handles extreme write volume (100K+ inventory updates/sec)
- ✅ No bottlenecks during flash sales or high-traffic events
- ✅ Strong consistency where needed (PostgreSQL for orders)
- ✅ Eventual consistency where acceptable (ScyllaDB for inventory)
- ✅ Best-in-class search (Elasticsearch)

**Cons**:
- ❌ High operational complexity (3 databases + Kafka)
- ❌ Data synchronization overhead
- ❌ Higher cost ($5-6K/month vs $2-3K for Pattern 1)
- ❌ Requires expertise in distributed systems

**When to use**: Extreme scale (> 50K inventory writes/sec), flash sales, high-traffic events (Black Friday, product launches).

---

## Complete Cost Comparison

### Single Database Costs (100M Products)

| Database | Monthly Cost | 3-Year TCO | Cost per 1M Writes | Best For |
|----------|--------------|------------|---------------------|----------|
| **PostgreSQL** | $870-$1,870 | $31,300-$67,300 | $0.20-$0.50 | General purpose, ACID |
| **MongoDB** | $4,650-$4,800 | $167,000-$173,000 | $0.50-$1.00 | Flexible schemas |
| **ScyllaDB** | $3,100-$3,300 | $111,600-$118,800 | $0.10-$0.20 | Extreme writes |
| **Elasticsearch** | $1,600-$1,700 | $57,600-$61,200 | N/A | Search only |

### Hybrid Architecture Costs

| Architecture | Monthly Cost | 3-Year TCO | Max Writes/Sec | Complexity |
|--------------|--------------|------------|----------------|------------|
| **PostgreSQL + ES** | $2,600-$3,300 | $93,600-$118,800 | 5,000 | Low-Medium |
| **MongoDB + ES** | $6,250-$6,500 | $225,000-$234,000 | 10,000 | Medium |
| **PG + Scylla + ES** | $5,300-$6,100 | $190,800-$219,600 | 100,000+ | High |

### Cost Optimization Tips

1. **Use reserved instances**: 30-40% savings for PostgreSQL/MongoDB
2. **Tiered storage**: Move old products to cheaper storage tiers
3. **Right-size instances**: Monitor CPU/memory, scale down if underutilized
4. **Compress data**: Enable compression for indexes and storage
5. **Optimize queries**: Reduce I/O costs with proper indexing

---

## Decision Framework

### Step 1: Assess Your Write Volume

**< 5,000 writes/sec**: PostgreSQL alone is sufficient
**5,000-10,000 writes/sec**: MongoDB or PostgreSQL with read replicas
**10,000-50,000 writes/sec**: MongoDB with sharding or PostgreSQL + ScyllaDB
**> 50,000 writes/sec**: ScyllaDB required

### Step 2: Determine Consistency Requirements

**Strong ACID required** (inventory, orders, payments): PostgreSQL
**Tunable consistency acceptable**: MongoDB or ScyllaDB
**Eventual consistency OK**: ScyllaDB or Elasticsearch

### Step 3: Evaluate Schema Flexibility

**Rapidly evolving schemas** (new product types monthly): MongoDB
**Stable schema with some flexibility**: PostgreSQL with JSONB
**Fixed schema**: PostgreSQL

### Step 4: Search Requirements

**Basic filtering** (category, price, brand): Any database
**Full-text search** (product names, descriptions): Add Elasticsearch
**Faceted search** (show counts per filter): Elasticsearch required
**Autocomplete, typo tolerance**: Elasticsearch required

### Step 5: Choose Your Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Decision Tree                          │
└─────────────────────────────────────────────────────────┘

Do you need advanced search (faceted, full-text)?
├─ No  → Single database
│  ├─ Write volume < 5K/sec → PostgreSQL
│  ├─ Write volume 5-10K/sec → MongoDB
│  └─ Write volume > 50K/sec → ScyllaDB
│
└─ Yes → Hybrid architecture
   ├─ Write volume < 5K/sec → PostgreSQL + Elasticsearch
   ├─ Write volume 5-10K/sec → MongoDB + Elasticsearch
   └─ Write volume > 50K/sec → PostgreSQL + ScyllaDB + Elasticsearch
```

---

## Real-World Examples

### Shopify (PostgreSQL + Redis + Elasticsearch)
- **Scale**: 1M+ merchants, billions of products
- **Architecture**: MySQL (PostgreSQL-like) for core data, Redis for caching, Elasticsearch for search
- **Why**: Strong consistency for orders, fast search, proven reliability

### Amazon (DynamoDB + Elasticsearch + custom systems)
- **Scale**: Hundreds of millions of products
- **Architecture**: DynamoDB (similar to ScyllaDB) for product catalog, Elasticsearch for search, custom systems for inventory
- **Why**: Extreme scale, global distribution, high availability

### Etsy (MySQL + Elasticsearch)
- **Scale**: 100M+ products
- **Architecture**: MySQL for product data, Elasticsearch for search
- **Why**: Handmade/vintage items have unique attributes, strong consistency needed for inventory

---

## Migration Strategy

If you're starting with one database and need to add others:

### Phase 1: Start Simple
- Begin with PostgreSQL or MongoDB
- Optimize queries, add indexes
- Scale vertically (bigger instances)

### Phase 2: Add Search Layer
- When search becomes slow (> 500ms), add Elasticsearch
- Implement CDC pipeline (Debezium or change streams)
- Migrate search queries to Elasticsearch

### Phase 3: Add Write Scaling (if needed)
- When write volume exceeds 10K/sec, add ScyllaDB
- Move inventory updates to ScyllaDB
- Keep PostgreSQL/MongoDB as source of truth for product catalog

### Phase 4: Optimize Costs
- Use tiered storage for old data
- Implement caching (Redis) for hot products
- Optimize instance sizes based on actual usage

---

## Conclusion

After analyzing MongoDB, PostgreSQL, ScyllaDB, and Elasticsearch for a 100 million product e-commerce catalog, here are my final recommendations:

### For Most E-commerce Platforms
**PostgreSQL + Elasticsearch** ($2,600-$3,300/month)
- PostgreSQL: Source of truth, inventory, orders
- Elasticsearch: Search and filtering
- Best balance of cost, performance, and complexity

### For Rapidly Evolving Schemas
**MongoDB + Elasticsearch** ($6,250-$6,500/month)
- MongoDB: Flexible product catalog
- Elasticsearch: Search layer
- Best for frequent schema changes

### For Extreme Scale
**PostgreSQL + ScyllaDB + Elasticsearch** ($5,300-$6,100/month)
- PostgreSQL: Product catalog
- ScyllaDB: Real-time inventory (100K+ writes/sec)
- Elasticsearch: Search
- Best for flash sales, high-traffic events

### Key Takeaways

1. **No single database is perfect** - Hybrid architectures are the norm
2. **Start simple, scale strategically** - Don't over-engineer early
3. **PostgreSQL + Elasticsearch** is the most common pattern for good reason
4. **ScyllaDB is worth it** for extreme write volumes (> 50K/sec)
5. **Elasticsearch is essential** for modern e-commerce search UX

### Final Advice

- **Prototype first**: Test with your actual data and query patterns
- **Monitor everything**: Measure before optimizing
- **Plan for growth**: Choose databases that scale with your business
- **Consider operational overhead**: More databases = more complexity
- **Optimize costs**: Right-size instances, use reserved capacity

The database landscape is rich with options. The right choice depends on your specific requirements, team expertise, and growth trajectory. For a 100M product catalog, a hybrid approach leveraging multiple databases is often the most pragmatic solution.

---

## Series Recap

- **[Part 1](/blog/database-comparison-part-1-mongodb-vs-postgresql)**: MongoDB vs PostgreSQL - schema flexibility, query performance, write throughput
- **[Part 2](/blog/database-comparison-part-2-scylladb-elasticsearch)**: ScyllaDB and Elasticsearch - specialized databases for extreme writes and search
- **Part 3** (this post): Hybrid architectures, cost comparison, decision framework

---

*What database architecture are you using for your e-commerce platform? Share your experiences in the comments or reach out on [Twitter](https://twitter.com/sswapnil2)!*

*Found this series helpful? Consider sharing it with your team or on social media. Building the right database architecture can save millions in infrastructure costs and prevent performance bottlenecks as you scale.*
