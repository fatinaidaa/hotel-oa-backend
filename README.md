# Hotel OA Backend

Current active backend for the Hotel OA dashboard and ESP32 nodes.

## Run

```bash
npm install
npm run dev
```

For production:

```bash
npm start
```

## Environment

Create a `.env` file when running locally:

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=wmn_project
DB_PORT=3306
PORT=3000
```

For deployment, use the public database connection configured in `server.js` or environment variables.

## Main API groups

- `/api/auth/*` - staff login and signup
- `/api/rooms/*` - room status, limits, passwords, and stay dates
- `/api/requests/*` - additional device approval/rejection
- `/api/sessions/*` - active guest connections
- `/api/nodes/*` - ESP32 node monitoring
- `/api/login` - ESP32 captive portal login endpoint

## Notes

This project now uses the single-file backend in `server.js`.
Old modular backend files such as `routes/`, `config/`, and `middleware/` have been removed because they were not used by the current system.
