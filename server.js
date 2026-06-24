const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const mysql = require('mysql2');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = 3000;

// ===== RAILWAY MYSQL =====
const db = mysql.createPool({
    uri: 'mysql://root:bnZsDdWhZKPOTWDaLSWSVNfyeagsVRHx@acela.proxy.rlwy.net:46443/railway',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, connection) => {

    if (err) {

        console.error(
            '❌ Railway DB Failed:',
            err
        );

        return;
    }

    console.log(
        '✅ Railway MySQL Connected!'
    );

    connection.release();

});

db.query(`
CREATE TABLE IF NOT EXISTS staff_users (

    id INT AUTO_INCREMENT PRIMARY KEY,

    full_name VARCHAR(255),

    staff_id VARCHAR(50) UNIQUE,

    password VARCHAR(255),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

)
`, (err) => {

    if (err) {
        console.error(
            '❌ Table creation failed:',
            err
        );
        return;
    }

    console.log(
        '✅ staff_users table ready!'
    );
});

async function sendTelegram(message) {

    const BOT_TOKEN =
        process.env.TELEGRAM_BOT_TOKEN;

    const CHAT_ID =
        "940687524";

    try {

        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id: CHAT_ID,
                text: message
            }
        );

        console.log(
            '[TELEGRAM] Sent'
        );

    } catch (err) {

        console.error(
            '[TELEGRAM ERROR]',
            err.response?.data || err.message
        );

    }

}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== IN-MEMORY DATABASE =====
const rooms = {
    101: { devices: 0, limit: 1, connectedMACs: [] },
    102: { devices: 0, limit: 3, connectedMACs: [] },
};

const pendingRequests = [];

// ===== HELPER FUNCTIONS =====
function calculateBandwidth(room) {
    const usage = (room.devices / room.limit) * 100;
    if (usage === 0) return 'Idle';
    if (usage >= 100) return 'Con/ling';
    return `${Math.round(usage)}%`;
}

function getTimeAgo(timestamp) {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins === 1) return '1 minute ago';
    if (diffMins < 60) return `${diffMins} minutes ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours === 1) return '1 hour ago';
    return `${diffHours} hours ago`;
}

function sendWhatsAppNotification(phoneNumber, status, roomId) {
    const message = status === 'approved'
        ? `✅ Your request for additional device connection in Room ${roomId} has been APPROVED. You may now connect your device.`
        : `❌ Your request for additional device connection in Room ${roomId} has been REJECTED. Please contact the front desk for assistance.`;
    console.log(`[WHATSAPP] Sending to ${phoneNumber}: ${message}`);
}

// ===== ROOM CREDENTIALS =====
const roomCredentials = {
    101: { password: 'room101', limit: 3 },
    102: { password: 'room102', limit: 3 },
    103: { password: 'room103', limit: 2 }
};

// ===== API ROUTES =====
app.post('/api/node-report', (req, res) => {

    const {
        nodeId,
        room,
        rssi,
        signalQuality,
        ip,
        uptime,
        status
    } = req.body;

    db.query(

        `INSERT INTO nodes
        (
            node_id,
            room_id,
            rssi,
            signal_quality,
            ip_address,
            uptime,
            status
        )

        VALUES (?, ?, ?, ?, ?, ?, ?)

        ON DUPLICATE KEY UPDATE

            room_id = VALUES(room_id),
            rssi = VALUES(rssi),
            signal_quality = VALUES(signal_quality),
            ip_address = VALUES(ip_address),
            uptime = VALUES(uptime),
            status = VALUES(status),
            last_seen = NOW()
        `,

        [
            nodeId,
            room,
            rssi,
            signalQuality,
            ip,
            uptime,
            status
        ],

        (err) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            res.json({
                success: true
            });

        }

    );

});


app.post('/api/login', (req, res) => {

    const { room, password } = req.body;

    console.log(`[LOGIN] Room ${room}`);

    const credentials = roomCredentials[room];

    if (!credentials) {

        return res.json({
            success: false,
            message: 'Room not found'
        });

    }

    if (credentials.password !== password) {

        return res.json({
            success: false,
            message: 'Wrong password'
        });

    }

    db.query(

        `
        SELECT
            COUNT(a.id) AS devices,
            r.device_limit
        FROM rooms r
        LEFT JOIN active_sessions a
            ON r.id = a.room_id
            AND a.status = 'connected'
        WHERE r.id = ?
        GROUP BY r.id
        `,

        [room],

        (err, results) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    success: false
                });

            }

            const devices =
                results[0].devices;

            const limit =
                results[0].device_limit;

            console.log(
                `[DB COUNT] ${devices}/${limit}`
            );

            if (devices >= limit) {

                return res.json({

                    success: false,

                    limitExceeded: true,

                    message:
                    'Device limit exceeded'

                });

            }

            db.query(

                `
                INSERT INTO active_sessions
                (
                    room_id,
                    phone_number,
                    mac_address,
                    device_name,
                    login_time,
                    last_seen,
                    status
                )
                VALUES
                (
                    ?,
                    ?,
                    ?,
                    ?,
                    NOW(),
                    NOW(),
                    ?
                )
                `,

                [
                    room,
                    'ESP32 User',
                    'ESP32',
                    'Mesh Node',
                    'connected'
                ],

                (err) => {

                    if (err) {

                        console.error(err);

                        return res.status(500).json({
                            success: false
                        });

                    }

                    console.log(
                        `[LOGIN SUCCESS] Room ${room}`
                    );

                    res.json({

                        success: true,

                        message:
                        'Access granted',

                        room,

                        devicesConnected:
                        devices + 1,

                        limit

                    });

                }

            );

        }

    );

});

// 1. Check device limit
app.post('/api/check-device-limit', (req, res) => {
    const { room, mac } = req.body;
    console.log(`[CHECK] Room ${room} - MAC ${mac}`);

    if (!rooms[room]) {
        return res.status(404).json({ allowed: false, error: 'Room not found' });
    }

    const roomData = rooms[room];

    if (roomData.connectedMACs.includes(mac)) {
        return res.json({ allowed: true, alreadyConnected: true, message: 'Device already authorized' });
    }

    if (roomData.devices < roomData.limit) {
        roomData.devices++;
        roomData.connectedMACs.push(mac);

        console.log(`[ALLOWED] Room ${room} - ${roomData.devices}/${roomData.limit}`);
        return res.json({ allowed: true, currentDevices: roomData.devices, limit: roomData.limit });
    } else {
        console.log(`[BLOCKED] Room ${room} - Limit exceeded`);
        return res.json({ allowed: false, currentDevices: roomData.devices, limit: roomData.limit });
    }
});

// 2. Submit device request
app.post('/api/request-device', (req, res) => {

    const { room, phoneNumber, mac } = req.body;

    if (!room || !phoneNumber) {

        return res.status(400).json({
            error: 'Room and phone number required'
        });

    }

    // Save request ke Railway DB
    db.query(

        `INSERT INTO connection_requests
        (
            room_id,
            phone_number,
            mac_address,
            status
        )
        VALUES (?, ?, ?, 'pending')`,

        [
            room,
            phoneNumber,
            mac || 'unknown'
        ],

        (err, result) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    success: false,
                    message: 'Database error'
                });

            }

            console.log(
                `[REQUEST] New request from ${phoneNumber} for Room ${room}`
            );

            res.json({

                success: true,

                requestId: result.insertId,

                message: 'Request submitted'

            });

        }

    );

});

// 3. Get pending requests
app.get('/api/pending-requests', (req, res) => {
    const pending = pendingRequests.filter(r => r.status === 'pending');
    res.json({
        requests: pending.map(r => ({
            id: r.id,
            roomId: parseInt(r.room),
            phoneNumber: r.phoneNumber,
            time: getTimeAgo(r.timestamp),
            status: r.status
        }))
    });
});

// 4. Approve request
app.post('/api/approve-request', (req, res) => {
    const { requestId, roomId } = req.body;
    const request = pendingRequests.find(r => r.id === requestId);

    if (!request) return res.status(404).json({ error: 'Request not found' });

    const roomData = rooms[roomId];
    if (!roomData) return res.status(404).json({ error: 'Room not found' });

    roomData.limit++;
    request.status = 'approved';

    console.log(`[APPROVED] Request ${requestId} - Room ${roomId} limit: ${roomData.limit}`);
    sendWhatsAppNotification(request.phoneNumber, 'approved', roomId);

    res.json({ success: true, newLimit: roomData.limit });
});

// 5. Reject request
app.post('/api/reject-request', (req, res) => {
    const { requestId } = req.body;
    const request = pendingRequests.find(r => r.id === requestId);

    if (!request) return res.status(404).json({ error: 'Request not found' });

    request.status = 'rejected';
    console.log(`[REJECTED] Request ${requestId}`);
    sendWhatsAppNotification(request.phoneNumber, 'rejected', request.room);

    res.json({ success: true });
});

// 6. Get all rooms
app.get('/api/rooms', (req, res) => {

    db.query(

        `
        SELECT
            r.id,
            r.device_limit,
            r.status,
            COUNT(a.id) AS devices
        FROM rooms r
        LEFT JOIN active_sessions a
            ON r.id = a.room_id
            AND a.status = 'connected'
        GROUP BY r.id
        `,

        (err, results) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            const roomsArray = results.map(room => ({

                id: room.id,

                devices: room.devices,

                limit: room.device_limit,

                bandwidth: calculateBandwidth({
                    devices: room.devices,
                    limit: room.device_limit
                }),

                status: room.status

            }));

            res.json(roomsArray);

        }

    );

});

// ===== DASHBOARD ROUTES =====

// Active sessions (REAL Railway DB)
app.get('/api/sessions/active', (req, res) => {

    db.query(

        'SELECT * FROM active_sessions WHERE status = "connected"',

        (err, results) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            const sessions = results.map(session => ({

                id: session.id,

                room_id: session.room_id,

                phone_number: session.phone_number,

                mac_address: session.mac_address,

                device_name: session.device_name,

                login_time: session.login_time,

                status: session.status

            }));

            res.json(sessions);

        }

    );

});

// Requests
app.get('/api/requests', (req, res) => {

    db.query(

        `SELECT * FROM
        connection_requests
        WHERE status='pending'`,

        (err, results) => {

            if (err) {

                console.error(err);

                return res.status(500)
                .json({
                    error:
                    'Database error'
                });

            }

            res.json(results);

        }

    );

});

// Allow Request
app.put('/api/requests/:id/allow', (req, res) => {

    const requestId = req.params.id;

    // Ambil request pending
    db.query(

        'SELECT * FROM connection_requests WHERE id = ?',

        [requestId],

        (err, results) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            if (results.length === 0) {

                return res.status(404).json({
                    error: 'Request not found'
                });

            }

            const request = results[0];

            // Add ke active_sessions
            db.query(

                `INSERT INTO active_sessions
                (
                    room_id,
                    phone_number,
                    mac_address,
                    device_name,
                    login_time,
                    status
                )
                VALUES (?, ?, ?, ?, NOW(), ?)`,

                [
                    request.room_id,
                    request.phone_number,
                    request.mac_address,
                    'Guest Device',
                    'connected'
                ],

                (err) => {

                    if (err) {

                        console.error(err);

                        return res.status(500).json({
                            error:
                            'Failed add session'
                        });

                    }

                    // Update room devices +1
                    db.query(

                        `UPDATE rooms
                         SET devices = devices + 1
                         WHERE id = ?`,

                        [request.room_id],

                        (err) => {

                            if (err) {

                                console.error(err);

                                return res.status(500)
                                .json({
                                    error:
                                    'Failed update room'
                                });

                            }

                            // Delete request
                            db.query(

                                `DELETE FROM
                                 connection_requests
                                 WHERE id = ?`,

                                [requestId],

                                (err) => {

                                    if (err) {

                                        console.error(err);

                                        return res.status(500)
                                        .json({
                                            error:
                                            'Failed remove request'
                                        });

                                    }

                                    res.json({
                                        success: true,
                                        message:
                                        'Request approved'
                                    });

                                }

                            );

                        }

                    );

                }

            );

        }

    );

});

// Nodes
app.get('/api/nodes', (req, res) => {

    db.query(

        `
        SELECT
            *,
            CASE
                WHEN TIMESTAMPDIFF(SECOND, last_seen, NOW()) > 30
                THEN 'offline'
                ELSE 'online'
            END AS status
        FROM nodes
        ORDER BY room_id
        `,

        (err, results) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            res.json(results);

        }

    );

});

// Traffic
app.get('/api/traffic', (req, res) => {
    res.json([
        { time: '08:00', usage: 20 },
        { time: '09:00', usage: 35 },
        { time: '10:00', usage: 50 },
        { time: '11:00', usage: 42 }
    ]);
});

// 7. Update room limit (Railway DB)
app.put('/api/rooms/:id/limit', (req, res) => {

    const roomId = req.params.id;
    const { limit } = req.body;

    if (!limit || limit < 1) {

        return res.status(400).json({
            error: 'Limit must be at least 1'
        });

    }

    db.query(

        'UPDATE rooms SET device_limit = ? WHERE id = ?',

        [limit, roomId],

        (err, result) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            if (result.affectedRows === 0) {

                return res.status(404).json({
                    error: 'Room not found'
                });

            }

            console.log(
                `[UPDATE] Room ${roomId} limit updated to ${limit}`
            );

            res.json({
                success: true,
                roomId,
                limit
            });

        }

    );

});

// ===== STAFF SIGNUP =====
app.post('/api/auth/signup', async (req, res) => {

    try {

        const {
            fullName,
            staffId,
            password
        } = req.body;

        // check kosong
        if (
            !fullName ||
            !staffId ||
            !password
        ) {

            return res.status(400).json({
                success: false,
                message: 'Please fill all fields'
            });

        }

        // check duplicate staff id
        db.query(
            'SELECT * FROM staff_users WHERE staff_id = ?',
            [staffId],
            async (err, results) => {

                if (err) {

                    console.error(err);

                    return res.status(500).json({
                        success: false
                    });

                }

                if (results.length > 0) {

                    return res.status(400).json({
                        success: false,
                        message:
                        'Staff ID already exists'
                    });

                }

                // hash password
                const hashedPassword =
                await bcrypt.hash(
                    password,
                    10
                );

                // insert user
                db.query(

                    `INSERT INTO staff_users
                    (full_name, staff_id, password)
                    VALUES (?, ?, ?)`,

                    [
                        fullName,
                        staffId,
                        hashedPassword
                    ],

                    (err) => {

                        if (err) {

                            console.error(err);

                            return res.status(500).json({
                                success: false
                            });

                        }

                        res.json({
                            success: true,
                            message:
                            'Signup successful'
                        });

                    }

                );

            }

        );

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false
        });

    }

});

// ===== STAFF LOGIN =====
app.post('/api/auth/login', (req, res) => {

    const {
        staffId,
        password
    } = req.body;

    console.log(
        'Login request:',
        staffId
    );

    if (
        !staffId ||
        !password
    ) {

        return res.status(400).json({
            success: false,
            message:
            'Please fill all fields'
        });

    }

    db.query(

        'SELECT * FROM staff_users WHERE staff_id = ?',

        [staffId],

        async (
            err,
            results
        ) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    success: false,
                    message:
                    'Database error'
                });

            }

            if (
                results.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                    'Staff not found'
                });

            }

            const user =
            results[0];

            const isMatch =
            await bcrypt.compare(
                password,
                user.password
            );

            if (!isMatch) {

                return res.status(401).json({
                    success: false,
                    message:
                    'Wrong password'
                });

            }

            return res.json({

                success: true,

                token:
                'dummy-token',

                user: {

                    id:
                    user.id,

                    fullName:
                    user.full_name,

                    staffId:
                    user.staff_id

                }

            });

        }

    );

});


// 8. Serve landing page for all non-API routes
app.get('*', (req, res) => {

    // jangan kacau API routes
    if (req.path.startsWith('/api')) {

        return res
        .status(404)
        .json({
            error:
            'API route not found'
        });

    }

    res.sendFile(
        path.join(
            __dirname,
            'public',
            'index.html'
        )
    );

});

setInterval(() => {

    db.query(

        `
        SELECT *
        FROM active_sessions
        WHERE status = 'connected'
        AND TIMESTAMPDIFF(SECOND, last_seen, NOW()) > 30
        `,

        (err, sessions) => {

            if (err) {
                console.error(err);
                return;
            }

            sessions.forEach(session => {

                console.log(
                    `[AUTO DISCONNECT] Room ${session.room_id}`
                );

                db.query(
                    `
                    UPDATE active_sessions
                    SET status = 'disconnected'
                    WHERE id = ?
                    `,
                    [session.id],
                    (err) => {

                        if (err) {
                            console.error(
                                'DISCONNECT SESSION ERROR:',
                                err
                            );
                        }
                    }
                );

                db.query(
                    `
                    UPDATE rooms
                    SET devices = GREATEST(devices - 1, 0)
                    WHERE id = ?
                    `,
                    [session.room_id],
                    (err) => {

                        if (err) {
                            console.error(
                                'UPDATE ROOM ERROR:',
                                err
                            );
                        } else {
                            console.log(
                                `Room ${session.room_id} devices reduced`
                            );
                        }
                    }
                );

            });

        }

    );

}, 5000);


app.post('/api/heartbeat', (req, res) => {

    const { room } = req.body;

    console.log(
    `[HEARTBEAT] Room ${room}`
    );

    db.query(
        `
        UPDATE active_sessions
        SET last_seen = NOW()
        WHERE room_id = ?
        AND status = 'connected'
        `,
        [room],
        (err) => {

            if (err) {
                console.error(err);

                return res.status(500).json({
                    success: false
                });
            }

            res.json({
                success: true
            });

        }
    );

});

app.post('/api/disconnect', (req, res) => {

    const { room } = req.body;

    db.query(
        `
        UPDATE active_sessions
        SET status = 'disconnected'
        WHERE room_id = ?
        AND status = 'connected'
        `,
        [room],
        (err) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    success: false
                });

            }

            console.log(
                `[DISCONNECT] Room ${room}`
            );

            res.json({
                success: true
            });

        }
    );

});

// ===== START SERVER =====
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 Captive Portal Backend running!');
    console.log(`📡 Local:   http://localhost:${PORT}`);
    console.log(`📡 Network: http://192.168.1.100:${PORT}`);
    console.log('\n✅ API Endpoints Ready:');
    console.log('   POST /api/check-device-limit');
    console.log('   POST /api/request-device');
    console.log('   GET  /api/pending-requests');
    console.log('   POST /api/approve-request');
    console.log('   POST /api/reject-request');
    console.log('   GET  /api/rooms');
    console.log('   POST /api/update-limit\n');
});