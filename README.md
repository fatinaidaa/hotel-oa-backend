# Mesh Backend — Node.js + Express + MySQL

## Setup

```bash
npm install
```

Buat file `.env` (copy dari `.env` yang ada, isi password MySQL awak):
```
DB_PASSWORD=your_mysql_password
```

Jalankan `database.sql` dalam phpMyAdmin atau MySQL Workbench.

```bash
npm run dev    # development (auto-restart)
npm start      # production
```

---

## API Endpoints

### Auth (Public)
| Method | Endpoint | Body |
|--------|----------|------|
| POST | `/api/auth/signup` | `{ full_name, staff_id, password }` |
| POST | `/api/auth/login`  | `{ staff_id, password }` → returns `{ user, token }` |

### Rooms (Protected 🔒)
| Method | Endpoint | Fungsi |
|--------|----------|--------|
| GET | `/api/rooms` | Semua rooms |
| GET | `/api/rooms/:room_num` | Single room |
| PUT | `/api/rooms/:room_num/limit` | `{ limit }` → update device limit |

### Requests (Protected 🔒)
| Method | Endpoint | Fungsi |
|--------|----------|--------|
| GET | `/api/requests` | Semua pending requests |
| PUT | `/api/requests/:id/allow` | Approve request |
| PUT | `/api/requests/:id/reject` | Reject request |

### Sessions (Protected 🔒)
| Method | Endpoint | Fungsi |
|--------|----------|--------|
| GET  | `/api/sessions/active` | Active connections |
| POST | `/api/sessions/connect` | ESP32 call masa device connect |
| POST | `/api/sessions/disconnect` | ESP32 call masa device disconnect |

### Devices
| Method | Endpoint | Auth | Fungsi |
|--------|----------|------|--------|
| POST | `/api/devices/request` | ❌ Public | User/ESP32 hantar request tambah device |
| GET  | `/api/devices` | 🔒 | Semua registered devices |
| DELETE | `/api/devices/:mac` | 🔒 | Remove device |

### Health Check
| Method | Endpoint |
|--------|----------|
| GET | `/api/health` |

---

## ESP32 Integration

### 1. User minta tambah device
```
POST http://192.168.4.1:3000/api/devices/request
{
  "room_num": 101,
  "phone_num": "+60123456789",
  "mac_address": "AA:BB:CC:DD:EE:FF"
}
```

### 2. Device connect (ESP32 → Backend)
```
POST http://192.168.4.1:3000/api/sessions/connect
{
  "room_num": 101,
  "mac_address": "AA:BB:CC:DD:EE:FF"
}
```

### 3. Device disconnect
```
POST http://192.168.4.1:3000/api/sessions/disconnect
{
  "room_num": 101,
  "mac_address": "AA:BB:CC:DD:EE:FF"
}
```
