---
title: 'Building Redis from Scratch in Rust'
description: 'A deep dive into implementing a Redis clone in Rust - understanding the RESP protocol and concurrent connection handling.'
date: 2026-01-18
tags: ['rust', 'redis', 'systems-programming', 'networking']
---

I recently built a Redis clone from scratch in Rust as part of the [CodeCrafters](https://codecrafters.io) challenge. It was an incredibly rewarding experience that taught me a lot about network programming, protocol design, and Rust's ownership model. In this post, I'll walk you through the internals of Redis, the RESP protocol, and how to handle concurrent connections.

## Why Build Redis?

Redis is deceptively simple on the surface—it's an in-memory key-value store. But under the hood, it's a masterclass in systems design:

- **Single-threaded event loop** that handles thousands of concurrent connections
- **Custom wire protocol** (RESP) optimized for parsing speed
- **Efficient memory management** for storing diverse data types
- **Persistence strategies** like RDB snapshots and AOF logs

Building one from scratch forces you to understand these concepts deeply rather than just using them as a black box.

## The RESP Protocol

RESP (REdis Serialization Protocol) is how clients communicate with Redis. It's a text-based protocol that's both human-readable and efficient to parse. RESP3 is the latest version, but my implementation focuses on RESP2 which is still widely used.

### Data Types in RESP

RESP uses a prefix byte to identify the data type:

| Prefix | Type | Example |
|--------|------|---------|
| `+` | Simple String | `+OK\r\n` |
| `-` | Error | `-ERR unknown command\r\n` |
| `:` | Integer | `:1000\r\n` |
| `$` | Bulk String | `$5\r\nhello\r\n` |
| `*` | Array | `*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n` |

Every message terminates with `\r\n` (CRLF). This makes parsing straightforward—you read until you hit CRLF.

### Parsing RESP in Rust

Here's how I defined the identifier types:

```rust
#[derive(Debug, PartialEq)]
pub enum Identifier {
    SimpleString,  // +
    SimpleError,   // -
    BulkString,    // $
    Arrays,        // *
    Integer,       // :
    None
}

impl Identifier {
    pub fn from(c: char) -> Self {
        match c {
            '+' => Identifier::SimpleString,
            '-' => Identifier::SimpleError,
            ':' => Identifier::Integer,
            '$' => Identifier::BulkString,
            '*' => Identifier::Arrays,
            _ => Identifier::None
        }
    }
}
```

The beauty of RESP is that a single byte tells you exactly how to parse the rest of the message.

### Parsing Bulk Strings

Bulk strings are length-prefixed, which means you know exactly how many bytes to read:

```rust
impl IdentifierStrategy for BulkStringStrategy {
    fn apply(&self, value: &[u8]) -> Option<ValueWrapper> {
        if value.is_empty() {
            return None;
        }

        // Find where the length ends (at CRLF)
        let length_end_index = CRLFValidator::find(&value)?;

        // Parse the length (skip the $ prefix)
        let length_str = from_utf8(&value[1..length_end_index]).ok()?;
        let length: usize = length_str.parse().ok()?;

        // Calculate where the actual string starts
        let first_crlf_index_end = length_end_index + CRLF.len();

        // Extract the string
        let string = String::from_utf8(
            value[first_crlf_index_end..first_crlf_index_end + length].to_vec()
        ).ok()?;

        Some(ValueWrapper {
            value: Value::String(string),
            end_at: (first_crlf_index_end + length + CRLF.len()) as i32
        })
    }
}
```

For example, parsing `$5\r\nhello\r\n`:
1. Read until first CRLF → length is "5"
2. Skip CRLF (2 bytes)
3. Read exactly 5 bytes → "hello"
4. Skip final CRLF

### Parsing Arrays

Arrays are recursive—they contain other RESP values:

```rust
impl IdentifierStrategy for ArrayStrategy {
    fn apply(&self, value: &[u8]) -> Option<ValueWrapper> {
        // Parse array length
        let length_end_index = CRLFValidator::find(&value)?;
        let length_str = from_utf8(&value[1..length_end_index]).ok()?;
        let num_of_items: usize = length_str.parse().ok()?;

        let first_crlf_index_end = length_end_index + CRLF.len();
        let mut value_index = first_crlf_index_end;
        let mut values = vec![];

        // Recursively parse each element
        for _ in 0..num_of_items {
            if let Some(resp) = Identifier::from(char::from(value[value_index]))
                .apply(&value[value_index..])
            {
                value_index = (resp.end_at + value_index as i32) as usize;
                values.push(resp);
            } else {
                return None;
            }
        }

        Some(ValueWrapper {
            value: Value::List(values.iter().map(|v| v.value.clone()).collect()),
            end_at: value_index as i32
        })
    }
}
```

A command like `SET foo bar` is sent as:
```
*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
```

Breaking it down:
- `*3` → Array with 3 elements
- `$3\r\nSET\r\n` → Bulk string "SET"
- `$3\r\nfoo\r\n` → Bulk string "foo"
- `$3\r\nbar\r\n` → Bulk string "bar"

## Handling Concurrent Connections

### How Real Redis Does It: Event Loop

Real Redis uses a **single-threaded event loop** with I/O multiplexing (epoll on Linux, kqueue on macOS). This means one thread handles thousands of connections by:

1. Monitoring all sockets for readiness (data available to read/write)
2. Processing ready sockets one at a time
3. Never blocking on any single connection

This is incredibly efficient because there's no thread context switching overhead and no need for locks on shared data.

### My Approach: Thread-Per-Connection

For simplicity, my implementation uses a **thread-per-connection** model instead. Each new client connection spawns a dedicated thread. This is easier to understand and implement, though less scalable than an event loop.

Here's how it works:

### Main Server Loop

```rust
fn main() {
    let store = Arc::new(Mutex::new(Store::new()));
    let listener = TcpListener::bind("127.0.0.1:6379").unwrap();

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app_state = Arc::clone(&store);
                thread::spawn(move || {
                    handle_client(app_state, stream);
                });
            }
            Err(e) => println!("Connection failed: {}", e),
        }
    }
}
```

Key points:
- **Shared state**: The `Store` is wrapped in `Arc<Mutex<>>` for thread-safe sharing across threads
- **Thread spawning**: `thread::spawn` creates a new OS thread for each connection
- **Ownership transfer**: The `move` closure takes ownership of `app_state` and `stream`, moving them into the new thread

The trade-off here is clear: this approach is simple but spawning threads is expensive. With thousands of connections, you'd run into OS limits. That's why production Redis uses an event loop—but for learning purposes, thread-per-connection keeps the code approachable.

### Client Handler

Each client connection runs in a loop, reading commands and sending responses:

```rust
fn handle_client(app_state: Arc<Mutex<Store>>, mut stream: TcpStream) {
    let mut buf = [0u8; 1024];

    loop {
        match stream.read(&mut buf) {
            Ok(0) => return, // Client disconnected
            Ok(bytes) => {
                let input = &buf[..bytes];

                // Lock store, execute command, release lock
                let response = {
                    let mut store = app_state.lock().unwrap();
                    Executor::execute(&mut store, input)
                };

                // Send response
                if let Some(out) = response {
                    if let Err(e) = stream.write_all(out.as_bytes()) {
                        println!("Error writing to client: {}", e);
                        return;
                    }
                }
            }
            Err(e) => {
                println!("Error reading from client: {}", e);
                return;
            }
        }
    }
}
```

Notice how the lock scope is minimized—we only hold it during command execution, not while writing the response.

## Command Execution

Commands are parsed into typed structs that implement `CommandExecutor`:

```rust
pub(super) trait CommandExecutor {
    fn execute(&self, store: &mut Store) -> Option<String>;
}
```

### The SET Command

SET supports optional expiration via the `PX` argument:

```rust
#[derive(Debug)]
pub struct SetCommand {
    key: String,
    value: Value,
    px: Option<i64>  // Expiration in milliseconds
}

impl CommandExecutor for SetCommand {
    fn execute(&self, store: &mut Store) -> Option<String> {
        store.put(self.key.as_str(), self.value.clone());

        if let Some(v) = self.px {
            let time = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() + v as u128;
            store.set_expiry(self.key.as_str(), time);
        }

        Some(String::from("+OK\r\n"))
    }
}
```

### The GET Command

GET checks expiration before returning:

```rust
impl CommandExecutor for GetCommand {
    fn execute(&self, store: &mut Store) -> Option<String> {
        if let Some(value) = store.get(self.key.as_str()) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();

            if let Some(expiry_ts) = store.get_expiry(self.key.as_str()) {
                return if expiry_ts > now {
                    Some(value.to_response_string())
                } else {
                    Some(String::from("$-1\r\n")) // Null bulk string
                };
            }

            Some(value.to_response_string())
        } else {
            Some(String::from("$-1\r\n"))
        }
    }
}
```

## The Data Store

The store uses a `HashMap` wrapped in `RwLock` for concurrent access:

```rust
#[derive(Debug)]
pub struct Store {
    map: Arc<RwLock<HashMap<String, Value>>>,
    expiry_map: HashMap<String, u128>
}

impl Store {
    pub fn new() -> Self {
        Store {
            map: Arc::new(RwLock::new(HashMap::new())),
            expiry_map: HashMap::new()
        }
    }

    pub fn put(&mut self, key: &str, value: Value) {
        let mut map = self.map.write().unwrap();
        map.insert(key.to_string(), value);
    }

    pub fn get(&mut self, key: &str) -> Option<Value> {
        let map = self.map.read().unwrap();
        map.get(key).cloned()
    }
}
```

## Testing with redis-cli

Once your server is running, you can test it with the official Redis CLI:

```bash
$ redis-cli -p 6379
127.0.0.1:6379> PING
PONG
127.0.0.1:6379> SET foo bar
OK
127.0.0.1:6379> GET foo
"bar"
127.0.0.1:6379> SET temp value PX 5000
OK
127.0.0.1:6379> GET temp
"value"
# Wait 5 seconds...
127.0.0.1:6379> GET temp
(nil)
```

## Lessons Learned

1. **RESP is brilliant** — The protocol is simple yet expressive. Length-prefixed strings avoid escaping issues, and the type prefix enables fast parsing.

2. **Rust's ownership model shines** — The borrow checker caught several concurrency bugs at compile time that would have been runtime errors in other languages.

3. **Start simple, iterate** — Beginning with PING/PONG, then SET/GET, then adding expiration kept the complexity manageable.

4. **Tests are essential** — Unit tests for the parser and executor caught edge cases early:

```rust
#[test]
pub fn test_set_and_get() {
    let mut s = Store::new();
    let out = Executor::execute(
        &mut s,
        b"*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n"
    );
    assert_eq!("+OK\r\n", out.unwrap().as_str());

    let get_output = Executor::execute(
        &mut s,
        b"*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n"
    );
    assert_eq!("$3\r\nbar\r\n", get_output.unwrap().as_str());
}
```

## What's Next?

This implementation covers the basics, but there's so much more to explore:

- **Event loop with async I/O** — Replace thread-per-connection with tokio or mio for true Redis-like scalability
- **More commands** — INCR, LPUSH, HSET, etc.
- **Persistence** — RDB snapshots or AOF logging
- **Pub/Sub** — Real-time messaging
- **Cluster mode** — Distributed Redis

## Source Code

The complete implementation is available on GitHub: [sswapnil2/redis-rust](https://github.com/sswapnil2/redis-rust)

Feel free to clone it, experiment, and extend it. If you're interested in systems programming, building your own Redis is one of the best exercises out there.

---

*Have questions or suggestions? Feel free to reach out or open an issue on the repository!*
