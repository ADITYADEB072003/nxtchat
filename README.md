# NexChat — Real-Time Chat with MongoDB + In-Memory Cache

A production-grade real-time chat app built with:

- **Backend**: Node.js · Express · Socket.IO · Mongoose
- **Database**: MongoDB (primary storage)
- **Cache**: Pure JavaScript in-process cache (NO Redis)
- **Frontend**: Vanilla HTML/CSS/JS with a dark terminal aesthetic

---

## Cache Architecture

```
Client Request
     │
     ▼
┌──────────────────────────────────┐
│         MemoryCache Layer        │
│  ┌──────────┐  ┌──────────────┐ │
│  │ roomCache│  │messageCache  │ │
│  │ TTL: 10m │  │ TTL: 5 min   │ │
│  └──────────┘  └──────────────┘ │
│  ┌──────────┐  ┌──────────────┐ │
│  │userCache │  │presenceCache │ │
│  │ TTL: 2m  │  │  no expiry   │ │
│  └──────────┘  └──────────────┘ │
└──────────────────────────────────┘
     │ MISS
     ▼
  MongoDB
```

### MemoryCache Features
| Feature | Details |
|---|---|
| **TTL** | Per-entry expiry, swept every 30s |
| **LRU Eviction** | Least-recently-used entry removed when `maxSize` reached |
| **Prefix Delete** | `delByPrefix('messages:room123:')` for instant cache invalidation |
| **getOrSet** | Atomic "read-through" helper |
| **Stats** | `hits`, `misses`, `hitRate`, `evictions`, `expirations`, `size` |
| **No dependencies** | Pure JavaScript, zero npm packages |

### Cache Keys
```
rooms:all              → all rooms list (TTL 60s)
room:<id>              → single room doc (TTL 300s)
messages:<roomId>:<n>  → paginated messages (TTL 30s)
user:<username>        → user doc (TTL 120s)
online:<username>      → presence (no expiry, deleted on disconnect)
```

---

## Running the App

### With MongoDB
```bash
# 1. Start MongoDB locally
mongod --dbpath ./data

# 2. Copy env file
cp .env.example .env

# 3. Install & run
npm install
npm start
```

Open http://localhost:3000

### Demo Mode (no MongoDB needed)
Just `npm start` without MongoDB running — the server automatically falls
back to in-memory demo mode and logs a friendly warning.

---

## Project Structure
```
chat-app/
├── server/
│   ├── cache.js       ← MemoryCache engine + named buckets
│   ├── models.js      ← Mongoose schemas (Room, Message, User)
│   └── index.js       ← Express + Socket.IO server
├── client/
│   └── index.html     ← Single-file frontend
├── .env.example
└── README.md
```

## Socket Events
| Event | Direction | Payload |
|---|---|---|
| `room:join` | client→server | `{ roomId, username }` |
| `room:leave` | client→server | `{ roomId, username }` |
| `message:send` | client→server | `{ roomId, sender, text }` |
| `message:new` | server→client | full message object |
| `typing:start/stop` | client→server | `{ roomId, username }` |
| `typing:update` | server→client | `{ username, typing }` |
| `presence:update` | server→client | `{ roomId, users[] }` |
| `message:react` | client→server | `{ messageId, emoji, username, roomId }` |
| `room:new` | server→all | room object |
#nxtchat
##Admin creation process
```
via monogo:-
db.users.updateOne(
  { username: "your-username" },
  { $set: { role: "admin" } }
)
POST http://localhost:3000/api/auth/register
Content-Type: application/json

{
  "username": "admin",
  "email": "admin@example.com",
  "password": "yourpassword"
}
```
