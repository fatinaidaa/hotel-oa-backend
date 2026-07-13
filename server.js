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

function ensureColumn(table, column, definition) {

    db.query(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
        (err) => {

            if (!err) {
                console.log(`[DB] Added ${table}.${column}`);
                return;
            }

            if (err.code === 'ER_DUP_FIELDNAME') {
                return;
            }

            console.error(
                `[DB] Unable to add ${table}.${column}:`,
                err
            );

        }
    );

}

ensureColumn(
    'rooms',
    'wifi_password',
    'VARCHAR(100) NULL'
);

ensureColumn(
    'rooms',
    'check_in',
    'DATE NULL'
);

ensureColumn(
    'rooms',
    'check_out',
    'DATE NULL'
);

ensureColumn(
    'rooms',
    'default_device_limit',
    'INT NULL'
);

ensureColumn(
    'nodes',
    'latency_ms',
    'INT NULL'
);

ensureColumn(
    'nodes',
    'jitter_ms',
    'INT NULL'
);

ensureColumn(
    'nodes',
    'packet_loss',
    'DECIMAL(5,2) NULL'
);

ensureColumn(
    'nodes',
    'success_rate',
    'DECIMAL(5,2) NULL'
);

ensureColumn(
    'nodes',
    'wifi_latency_ms',
    'INT NULL'
);

ensureColumn(
    'nodes',
    'wifi_jitter_ms',
    'INT NULL'
);

ensureColumn(
    'nodes',
    'wifi_packet_loss',
    'DECIMAL(5,2) NULL'
);

ensureColumn(
    'nodes',
    'wifi_success_rate',
    'DECIMAL(5,2) NULL'
);

db.query(`
CREATE TABLE IF NOT EXISTS node_metrics (

    id INT AUTO_INCREMENT PRIMARY KEY,

    node_id VARCHAR(100),

    room_id INT,

    rssi INT,

    signal_quality VARCHAR(50),

    latency_ms INT,

    jitter_ms INT,

    packet_loss DECIMAL(5,2),

    success_rate DECIMAL(5,2),

    wifi_latency_ms INT,

    wifi_jitter_ms INT,

    wifi_packet_loss DECIMAL(5,2),

    wifi_success_rate DECIMAL(5,2),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_node_metrics_created_at (created_at),

    INDEX idx_node_metrics_node_id (node_id),

    INDEX idx_node_metrics_room_id (room_id)

)
`, (err) => {

    if (err) {
        console.error(
            '[DB] node_metrics table creation failed:',
            err
        );
        return;
    }

    console.log('[DB] node_metrics table ready!');

    ensureColumn(
        'node_metrics',
        'wifi_latency_ms',
        'INT NULL'
    );

    ensureColumn(
        'node_metrics',
        'wifi_jitter_ms',
        'INT NULL'
    );

    ensureColumn(
        'node_metrics',
        'wifi_packet_loss',
        'DECIMAL(5,2) NULL'
    );

    ensureColumn(
        'node_metrics',
        'wifi_success_rate',
        'DECIMAL(5,2) NULL'
    );

});

setTimeout(() => {

    db.query(
        `UPDATE rooms
         SET default_device_limit = device_limit
         WHERE default_device_limit IS NULL`,
        (err) => {

            if (err) {
                console.error(
                    '[DB] Unable to initialize default device limits:',
                    err
                );
            }

        }
    );

}, 3000);

function getMalaysiaDate() {

    return new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone: 'Asia/Kuala_Lumpur',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }
    ).format(new Date());

}

function generateRoomPassword(roomId, checkIn) {

    const rawDate =
        checkIn ||
        getMalaysiaDate();

    const compactDate =
        rawDate.replace(/-/g, '').slice(4);

    return `OA${roomId}-${compactDate}`;

}

function autoResetExpiredCheckouts() {

    const today = getMalaysiaDate();

    db.getConnection((connectionError, connection) => {

        if (connectionError) {
            console.error(
                '[CHECKOUT RESET] Database connection error:',
                connectionError
            );
            return;
        }

        connection.beginTransaction((transactionError) => {

            if (transactionError) {
                connection.release();
                console.error(
                    '[CHECKOUT RESET] Transaction error:',
                    transactionError
                );
                return;
            }

            connection.query(

                `SELECT id
                 FROM rooms
                 WHERE check_out IS NOT NULL
                 AND check_out < ?
                 AND (
                    wifi_password IS NOT NULL
                    OR check_in IS NOT NULL
                    OR check_out IS NOT NULL
                 )
                 FOR UPDATE`,

                [today],

                (lookupError, roomsToReset) => {

                    if (lookupError) {

                        return connection.rollback(() => {
                            connection.release();
                            console.error(
                                '[CHECKOUT RESET] Lookup error:',
                                lookupError
                            );
                        });

                    }

                    if (roomsToReset.length === 0) {

                        return connection.rollback(() => {
                            connection.release();
                        });

                    }

                    const roomIds =
                        roomsToReset.map(room => room.id);

                    connection.query(

                        `UPDATE active_sessions
                         SET status = 'disconnected'
                         WHERE room_id IN (?)
                         AND status = 'connected'`,

                        [roomIds],

                        (sessionError) => {

                            if (sessionError) {

                                return connection.rollback(() => {
                                    connection.release();
                                    console.error(
                                        '[CHECKOUT RESET] Session reset error:',
                                        sessionError
                                    );
                                });

                            }

                            connection.query(

                                `UPDATE connection_requests
                                 SET status = 'rejected'
                                 WHERE room_id IN (?)
                                 AND status IN ('pending', 'approved')`,

                                [roomIds],

                                (requestError) => {

                                    if (requestError) {

                                        return connection.rollback(() => {
                                            connection.release();
                                            console.error(
                                                '[CHECKOUT RESET] Request reset error:',
                                                requestError
                                            );
                                        });

                                    }

                                    connection.query(

                                        `UPDATE rooms
                                         SET wifi_password = NULL,
                                             check_in = NULL,
                                             check_out = NULL,
                                             device_limit =
                                                COALESCE(
                                                    default_device_limit,
                                                    device_limit,
                                                    2
                                                )
                                         WHERE id IN (?)`,

                                        [roomIds],

                                        (roomError) => {

                                            if (roomError) {

                                                return connection.rollback(() => {
                                                    connection.release();
                                                    console.error(
                                                        '[CHECKOUT RESET] Room reset error:',
                                                        roomError
                                                    );
                                                });

                                            }

                                            connection.commit((commitError) => {

                                                if (commitError) {

                                                    return connection.rollback(() => {
                                                        connection.release();
                                                        console.error(
                                                            '[CHECKOUT RESET] Commit error:',
                                                            commitError
                                                        );
                                                    });

                                                }

                                                connection.release();

                                                console.log(
                                                    `[CHECKOUT RESET] Reset rooms: ${roomIds.join(', ')}`
                                                );

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

    });

}

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
    102: { password: 'room102', limit: 3 }
};

function toNumber(value) {

    const numberValue = Number(value);

    return Number.isFinite(numberValue)
        ? numberValue
        : null;

}

function getWorstSeverity(current, next) {

    const order = {
        good: 0,
        warning: 1,
        critical: 2
    };

    return order[next] > order[current]
        ? next
        : current;

}

function buildNetworkInsight(nodes, metrics) {

    const metricsByNode =
        new Map(
            metrics.map((metric) => [
                metric.node_id,
                metric
            ])
        );

    let severity = 'good';
    const findings = [];
    const recommendations = [];

    const rooms =
        nodes.map((node) => {

            const metric =
                metricsByNode.get(node.node_id) || {};

            const rssi =
                toNumber(node.rssi);
            const latency =
                toNumber(metric.wifi_latency_ms ?? node.wifi_latency_ms);
            const jitter =
                toNumber(metric.wifi_jitter_ms ?? node.wifi_jitter_ms);
            const packetLoss =
                toNumber(metric.wifi_packet_loss ?? node.wifi_packet_loss);
            const successRate =
                toNumber(metric.wifi_success_rate ?? node.wifi_success_rate);
            const roomId =
                node.room_id || metric.room_id || 'Unknown';
            const roomLabel =
                `Room ${roomId}`;

            let roomSeverity = 'good';
            const roomIssues = [];

            if (node.status === 'offline') {

                roomSeverity = 'critical';
                roomIssues.push('ESP32 monitor node is offline');
                findings.push(`${roomLabel}: monitor node is offline.`);
                recommendations.push(
                    `${roomLabel}: check ESP32 power supply and WiFi connection.`
                );

            }

            if (rssi !== null && rssi < -70) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'critical');
                roomIssues.push('weak WiFi signal');
                findings.push(
                    `${roomLabel}: weak RSSI detected (${rssi} dBm).`
                );
                recommendations.push(
                    `${roomLabel}: move the router/access point closer or reduce wall obstruction.`
                );

            } else if (rssi !== null && rssi < -60) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'warning');
                roomIssues.push('fair WiFi signal');
                findings.push(
                    `${roomLabel}: RSSI is fair (${rssi} dBm).`
                );
                recommendations.push(
                    `${roomLabel}: monitor signal quality and consider repositioning the node/router if latency increases.`
                );

            }

            if (latency !== null && latency > 80) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'critical');
                roomIssues.push('high WiFi latency');
                findings.push(
                    `${roomLabel}: high WiFi latency detected (${latency} ms).`
                );
                recommendations.push(
                    `${roomLabel}: check router load, interference, and distance from access point.`
                );

            } else if (latency !== null && latency > 30) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'warning');
                roomIssues.push('increased WiFi latency');
                findings.push(
                    `${roomLabel}: WiFi latency is higher than normal (${latency} ms).`
                );

            }

            if (jitter !== null && jitter > 30) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'critical');
                roomIssues.push('unstable latency/jitter');
                findings.push(
                    `${roomLabel}: high jitter detected (${jitter} ms).`
                );
                recommendations.push(
                    `${roomLabel}: reduce WiFi interference or avoid placing the node near electronic devices.`
                );

            } else if (jitter !== null && jitter > 15) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'warning');
                roomIssues.push('moderate jitter');
                findings.push(
                    `${roomLabel}: jitter is moderate (${jitter} ms).`
                );

            }

            if (packetLoss !== null && packetLoss > 5) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'critical');
                roomIssues.push('packet loss detected');
                findings.push(
                    `${roomLabel}: packet loss is high (${packetLoss}%).`
                );
                recommendations.push(
                    `${roomLabel}: inspect WiFi coverage and router stability because packets are being dropped.`
                );

            } else if (packetLoss !== null && packetLoss > 0) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'warning');
                roomIssues.push('minor packet loss');
                findings.push(
                    `${roomLabel}: minor packet loss detected (${packetLoss}%).`
                );

            }

            if (successRate !== null && successRate < 95) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'critical');
                roomIssues.push('low success rate');
                findings.push(
                    `${roomLabel}: success rate is low (${successRate}%).`
                );

            } else if (successRate !== null && successRate < 99) {

                roomSeverity =
                    getWorstSeverity(roomSeverity, 'warning');
                roomIssues.push('reduced success rate');
                findings.push(
                    `${roomLabel}: success rate dropped to ${successRate}%.`
                );

            }

            severity =
                getWorstSeverity(severity, roomSeverity);

            return {
                roomId,
                nodeId: node.node_id,
                severity: roomSeverity,
                issues: roomIssues,
                rssi,
                latency,
                jitter,
                packetLoss,
                successRate
            };

        });

    if (findings.length === 0) {

        findings.push(
            'All monitored rooms show stable WiFi performance.'
        );
        recommendations.push(
            'No immediate action required. Continue monitoring room performance trends.'
        );

    }

    const uniqueRecommendations =
        [...new Set(recommendations)].slice(0, 5);

    const summary =
        severity === 'critical'
            ? 'Critical network issue detected in at least one monitored room.'
            : severity === 'warning'
                ? 'Network performance is usable, but some rooms need attention.'
                : 'Network performance is stable across monitored rooms.';

    return {
        severity,
        summary,
        findings: findings.slice(0, 6),
        recommendations: uniqueRecommendations,
        rooms,
        method: 'rule_based',
        generatedAt: new Date().toISOString()
    };

}

async function improveInsightWithOllama(insight) {

    const ollamaUrl = process.env.OLLAMA_URL;

    if (!ollamaUrl) {
        return insight;
    }

    try {

        const response =
            await axios.post(
                `${ollamaUrl}/api/generate`,
                {
                    model: process.env.OLLAMA_MODEL || 'llama3.2',
                    stream: false,
                    prompt:
                        `You are an assistant for a hotel WiFi monitoring dashboard.
Summarize this network condition for hotel staff in 2 short sentences and give 3 practical actions.
Use simple English.

Data:
${JSON.stringify(insight, null, 2)}`
                },
                {
                    timeout: 8000
                }
            );

        return {
            ...insight,
            aiExplanation:
                response.data?.response?.trim() || null,
            method: 'ollama'
        };

    } catch (err) {

        console.error(
            '[AI INSIGHT] Ollama unavailable, using fallback:',
            err.message
        );

        return insight;

    }

}

function buildAdditionalConnectionSuggestion(request) {

    const currentConnections =
        toNumber(request.current_connections) || 0;
    const deviceLimit =
        toNumber(request.device_limit) || 0;
    const rssi =
        toNumber(request.rssi);
    const latency =
        toNumber(request.wifi_latency_ms);
    const jitter =
        toNumber(request.wifi_jitter_ms);
    const packetLoss =
        toNumber(request.wifi_packet_loss);
    const successRate =
        toNumber(request.wifi_success_rate);
    const nodeStatus =
        request.node_status || 'unknown';

    const reasons = [];
    const warnings = [];

    if (nodeStatus !== 'online') {
        warnings.push('Room monitor node is offline, so current WiFi quality cannot be verified.');
    }

    if (rssi !== null && rssi < -70) {
        reasons.push(`Weak WiFi signal (${rssi} dBm).`);
    } else if (rssi !== null && rssi < -60) {
        warnings.push(`Signal is only fair (${rssi} dBm).`);
    }

    if (latency !== null && latency > 80) {
        reasons.push(`High WiFi latency (${latency} ms).`);
    } else if (latency !== null && latency > 30) {
        warnings.push(`Latency is higher than ideal (${latency} ms).`);
    }

    if (jitter !== null && jitter > 30) {
        reasons.push(`High jitter (${jitter} ms), indicating unstable WiFi.`);
    } else if (jitter !== null && jitter > 15) {
        warnings.push(`Jitter is moderate (${jitter} ms).`);
    }

    if (packetLoss !== null && packetLoss > 5) {
        reasons.push(`High packet loss (${packetLoss}%).`);
    } else if (packetLoss !== null && packetLoss > 0) {
        warnings.push(`Minor packet loss detected (${packetLoss}%).`);
    }

    if (successRate !== null && successRate < 95) {
        reasons.push(`Low success rate (${successRate}%).`);
    } else if (successRate !== null && successRate < 99) {
        warnings.push(`Success rate is slightly reduced (${successRate}%).`);
    }

    if (
        latency === null &&
        jitter === null &&
        packetLoss === null &&
        successRate === null
    ) {
        warnings.push('No recent WiFi performance data is available for this room.');
    }

    if (currentConnections > deviceLimit) {
        warnings.push(
            `Room already has ${currentConnections} connected devices, above the current limit of ${deviceLimit}.`
        );
    }

    if (reasons.length > 0) {

        return {
            decision: 'reject',
            label: 'AI suggests reject',
            severity: 'critical',
            confidence: 'High',
            summary:
                'The room network condition is not suitable for an additional device right now.',
            reasons,
            currentConnections,
            deviceLimit,
            projectedLimit: deviceLimit + 1
        };

    }

    if (warnings.length > 0) {

        return {
            decision: 'review',
            label: 'AI suggests review',
            severity: 'warning',
            confidence: 'Medium',
            summary:
                'The request can be considered, but staff should review the room network condition first.',
            reasons: warnings,
            currentConnections,
            deviceLimit,
            projectedLimit: deviceLimit + 1
        };

    }

    return {
        decision: 'approve',
        label: 'AI suggests approve',
        severity: 'good',
        confidence: 'High',
        summary:
            'The room network is stable and can support one additional device.',
        reasons: [
            'Signal, latency, jitter, packet loss, and success rate are within acceptable range.'
        ],
        currentConnections,
        deviceLimit,
        projectedLimit: deviceLimit + 1
    };

}

// ===== API ROUTES =====
app.post('/api/node-report', (req, res) => {

    const {
        nodeId,
        room,
        rssi,
        signalQuality,
        ip,
        uptime,
        status,
        latencyMs,
        jitterMs,
        packetLoss,
        successRate,
        wifiLatencyMs,
        wifiJitterMs,
        wifiPacketLoss,
        wifiSuccessRate
    } = req.body;

    const measuredLatency =
        Number.isFinite(Number(latencyMs))
            ? Number(latencyMs)
            : null;
    const measuredJitter =
        Number.isFinite(Number(jitterMs))
            ? Number(jitterMs)
            : null;
    const measuredPacketLoss =
        Number.isFinite(Number(packetLoss))
            ? Number(packetLoss)
            : null;
    const measuredSuccessRate =
        Number.isFinite(Number(successRate))
            ? Number(successRate)
            : null;
    const measuredWifiLatency =
        Number.isFinite(Number(wifiLatencyMs))
            ? Number(wifiLatencyMs)
            : measuredLatency;
    const measuredWifiJitter =
        Number.isFinite(Number(wifiJitterMs))
            ? Number(wifiJitterMs)
            : measuredJitter;
    const measuredWifiPacketLoss =
        Number.isFinite(Number(wifiPacketLoss))
            ? Number(wifiPacketLoss)
            : measuredPacketLoss;
    const measuredWifiSuccessRate =
        Number.isFinite(Number(wifiSuccessRate))
            ? Number(wifiSuccessRate)
            : measuredSuccessRate;

    db.query(

        `INSERT INTO nodes
        (
            node_id,
            room_id,
            rssi,
            signal_quality,
            ip_address,
            uptime,
            status,
            latency_ms,
            jitter_ms,
            packet_loss,
            success_rate,
            wifi_latency_ms,
            wifi_jitter_ms,
            wifi_packet_loss,
            wifi_success_rate
        )

        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

        ON DUPLICATE KEY UPDATE

            room_id = VALUES(room_id),
            rssi = VALUES(rssi),
            signal_quality = VALUES(signal_quality),
            ip_address = VALUES(ip_address),
            uptime = VALUES(uptime),
            status = VALUES(status),
            latency_ms = VALUES(latency_ms),
            jitter_ms = VALUES(jitter_ms),
            packet_loss = VALUES(packet_loss),
            success_rate = VALUES(success_rate),
            wifi_latency_ms = VALUES(wifi_latency_ms),
            wifi_jitter_ms = VALUES(wifi_jitter_ms),
            wifi_packet_loss = VALUES(wifi_packet_loss),
            wifi_success_rate = VALUES(wifi_success_rate),
            last_seen = NOW()
        `,

        [
            nodeId,
            room,
            rssi,
            signalQuality,
            ip,
            uptime,
            status,
            measuredLatency,
            measuredJitter,
            measuredPacketLoss,
            measuredSuccessRate,
            measuredWifiLatency,
            measuredWifiJitter,
            measuredWifiPacketLoss,
            measuredWifiSuccessRate
        ],

        (err) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            db.query(

                `INSERT INTO node_metrics
                (
                    node_id,
                    room_id,
                    rssi,
                    signal_quality,
                    latency_ms,
                    jitter_ms,
                    packet_loss,
                    success_rate,
                    wifi_latency_ms,
                    wifi_jitter_ms,
                    wifi_packet_loss,
                    wifi_success_rate
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

                [
                    nodeId,
                    room,
                    rssi,
                    signalQuality,
                    measuredLatency,
                    measuredJitter,
                    measuredPacketLoss,
                    measuredSuccessRate,
                    measuredWifiLatency,
                    measuredWifiJitter,
                    measuredWifiPacketLoss,
                    measuredWifiSuccessRate
                ],

                (metricError) => {

                    if (metricError) {
                        console.error(
                            '[NODE METRIC] Insert failed:',
                            metricError
                        );
                    }

                    res.json({
                        success: true
                    });

                }

            );

        }

    );

});

app.get('/api/health', (req, res) => {

    res.json({
        success: true,
        timestamp: new Date().toISOString()
    });

});


app.post('/api/login', (req, res) => {

    const { room, password, mac } = req.body;

    console.log(`[LOGIN] Room ${room} - MAC ${mac}`);

    if (!mac) {

        return res.status(400).json({
            success: false,
            message: 'Device MAC address is required'
        });

    }

    db.getConnection((connectionError, connection) => {

        if (connectionError) {

            console.error(connectionError);

            return res.status(500).json({
                success: false,
                message: 'Database connection error'
            });

        }

        connection.beginTransaction((transactionError) => {

            if (transactionError) {

                connection.release();
                console.error(transactionError);

                return res.status(500).json({
                    success: false
                });

            }

            connection.query(

                `
                SELECT
                    r.device_limit,
                    r.wifi_password,
                    DATE_FORMAT(r.check_in, '%Y-%m-%d') AS check_in,
                    DATE_FORMAT(r.check_out, '%Y-%m-%d') AS check_out,
                    (
                        SELECT COUNT(*)
                        FROM active_sessions a
                        WHERE a.room_id = r.id
                        AND a.status = 'connected'
                        AND COALESCE(a.device_name, '') <> 'Mesh Node'
                        AND COALESCE(a.mac_address, '') <> 'ESP32'
                    ) AS devices,
                    (
                        SELECT COUNT(*)
                        FROM connection_requests cr
                        WHERE cr.room_id = r.id
                        AND cr.status = 'approved'
                        AND cr.mac_address IS NOT NULL
                        AND cr.mac_address <> ''
                        AND cr.mac_address <> 'unknown'
                    ) AS reserved_slots,
                    (
                        SELECT cr.id
                        FROM connection_requests cr
                        WHERE cr.room_id = r.id
                        AND cr.mac_address = ?
                        AND cr.mac_address <> 'unknown'
                        AND cr.status = 'approved'
                        ORDER BY cr.id
                        LIMIT 1
                    ) AS approval_id,
                    (
                        SELECT cr.phone_number
                        FROM connection_requests cr
                        WHERE cr.room_id = r.id
                        AND cr.mac_address = ?
                        AND cr.mac_address <> 'unknown'
                        AND cr.status = 'approved'
                        ORDER BY cr.id
                        LIMIT 1
                    ) AS approval_phone,
                    (
                        SELECT COUNT(*)
                        FROM active_sessions a
                        WHERE a.room_id = r.id
                        AND a.mac_address = ?
                        AND a.status = 'connected'
                        AND COALESCE(a.device_name, '') <> 'Mesh Node'
                        AND COALESCE(a.mac_address, '') <> 'ESP32'
                    ) AS already_connected
                FROM rooms r
                WHERE r.id = ?
                FOR UPDATE
                `,

                [mac, mac, mac, room],

                (lookupError, results) => {

                    if (lookupError || results.length === 0) {

                        return connection.rollback(() => {
                            connection.release();
                            console.error(
                                lookupError || `Room ${room} not found`
                            );
                            res.status(500).json({
                                success: false,
                                message: 'Unable to check room access'
                            });
                        });

                    }

                    const access = results[0];
                    const fallbackCredentials =
                        roomCredentials[room];
                    const expectedPassword =
                        access.wifi_password ||
                        fallbackCredentials?.password;

                    if (!expectedPassword) {

                        return connection.rollback(() => {
                            connection.release();
                            res.json({
                                success: false,
                                message: 'Room WiFi password is not set'
                            });
                        });

                    }

                    if (expectedPassword !== password) {

                        return connection.rollback(() => {
                            connection.release();
                            res.json({
                                success: false,
                                message: 'Wrong password'
                            });
                        });

                    }

                    const today = getMalaysiaDate();

                    if (
                        access.check_in &&
                        today < access.check_in
                    ) {

                        return connection.rollback(() => {
                            connection.release();
                            res.json({
                                success: false,
                                message: `WiFi access starts on ${access.check_in}`
                            });
                        });

                    }

                    if (
                        access.check_out &&
                        today > access.check_out
                    ) {

                        return connection.rollback(() => {
                            connection.release();
                            res.json({
                                success: false,
                                message: 'WiFi access has expired'
                            });
                        });

                    }

                    const devices = Number(access.devices);
                    const limit = Number(access.device_limit);
                    const reservedSlots =
                        Number(access.reserved_slots);
                    const hasApproval =
                        access.approval_id !== null;
                    const unreservedSlots =
                        limit - devices - reservedSlots;

                    console.log(
                        `[ACCESS CHECK] Room ${room}: ` +
                        `${devices}/${limit}, ` +
                        `reserved=${reservedSlots}, ` +
                        `approvedMAC=${hasApproval}`
                    );

                    if (Number(access.already_connected) > 0) {

                        return connection.rollback(() => {
                            connection.release();
                            res.json({
                                success: true,
                                alreadyConnected: true,
                                message: 'Device already connected',
                                room,
                                devicesConnected: devices,
                                limit
                            });
                        });

                    }

                    if (!hasApproval && unreservedSlots <= 0) {

                        return connection.rollback(() => {
                            connection.release();
                            res.json({
                                success: false,
                                limitExceeded: true,
                                message:
                                'Device limit exceeded or remaining slot is reserved'
                            });
                        });

                    }

                    connection.query(

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
                        VALUES (?, ?, ?, ?, NOW(), NOW(), ?)
                        `,

                        [
                            room,
                            access.approval_phone ||
                                'ESP32 User',
                            mac,
                            'Guest Device',
                            'connected'
                        ],

                        (insertError) => {

                            if (insertError) {

                                return connection.rollback(() => {
                                    connection.release();
                                    console.error(insertError);
                                    res.status(500).json({
                                        success: false
                                    });
                                });

                            }

                            const finishLogin = () => {

                                connection.commit((commitError) => {

                                    if (commitError) {

                                        return connection.rollback(() => {
                                            connection.release();
                                            console.error(commitError);
                                            res.status(500).json({
                                                success: false
                                            });
                                        });

                                    }

                                    connection.release();

                                    console.log(
                                        `[LOGIN SUCCESS] Room ${room} - MAC ${mac}`
                                    );

                                    res.json({
                                        success: true,
                                        message: hasApproval
                                            ? 'Approved device connected'
                                            : 'Access granted',
                                        room,
                                        devicesConnected: devices + 1,
                                        limit
                                    });

                                });

                            };

                            if (!hasApproval) {
                                return finishLogin();
                            }

                            connection.query(

                                `UPDATE connection_requests
                                 SET status = 'used'
                                 WHERE id = ?`,

                                [access.approval_id],

                                (updateError) => {

                                    if (updateError) {

                                        return connection.rollback(() => {
                                            connection.release();
                                            console.error(updateError);
                                            res.status(500).json({
                                                success: false
                                            });
                                        });

                                    }

                                    finishLogin();

                                }

                            );

                        }

                    );

                }

            );

        });

    });

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

            if (mac && mac !== 'unknown') {
                db.query(
                    `UPDATE active_sessions
                     SET status = 'disconnected'
                     WHERE room_id = ?
                     AND mac_address = ?
                     AND status = 'connected'`,
                    [room, mac],
                    (sessionError) => {
                        if (sessionError) {
                            console.error(
                                '[REQUEST] Active session cleanup error:',
                                sessionError
                            );
                        }
                    }
                );
            }

            sendTelegram(

            `📢 NEW DEVICE REQUEST

            Room: ${room}

            Phone: ${phoneNumber}

            Action Required:

            🔗 Open Dashboard:
            https://hotel-oa-dashboard.onrender.com/dashboard
            
            Please review and approve/reject the request.`
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

    console.log(
     `[APPROVED] Request ${requestId} - Room ${roomId} limit: ${roomData.limit}`
    );

    sendTelegram(
    `✅ REQUEST APPROVED

    Room: ${roomId}
    Phone: ${request.phoneNumber}

    Additional device access has been granted.`
    );

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
            r.wifi_password,
            DATE_FORMAT(r.check_in, '%Y-%m-%d') AS check_in,
            DATE_FORMAT(r.check_out, '%Y-%m-%d') AS check_out,
            r.status,
            COUNT(a.id) AS devices
        FROM rooms r
        LEFT JOIN active_sessions a
            ON r.id = a.room_id
            AND a.status = 'connected'
            AND COALESCE(a.device_name, '') <> 'Mesh Node'
            AND COALESCE(a.mac_address, '') <> 'ESP32'
        GROUP BY r.id
        `,

        (err, results) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            const today = getMalaysiaDate();

            const roomsArray = results.map(room => {

                let accessStatus = 'vacant';

                if (
                    room.check_in &&
                    today < room.check_in
                ) {
                    accessStatus = 'upcoming';
                } else if (
                    room.check_out &&
                    today > room.check_out
                ) {
                    accessStatus = 'expired';
                } else if (
                    room.wifi_password &&
                    room.check_in &&
                    room.check_out
                ) {
                    accessStatus = 'active';
                }

                return {

                id: room.id,

                devices: room.devices,

                limit: room.device_limit,

                wifi_password:
                    room.wifi_password || '',

                check_in:
                    room.check_in || '',

                check_out:
                    room.check_out || '',

                access_status:
                    accessStatus,

                bandwidth: calculateBandwidth({
                    devices: room.devices,
                    limit: room.device_limit
                }),

                status: room.status

                };

            });

            res.json(roomsArray);

        }

    );

});

// ===== DASHBOARD ROUTES =====

// Active sessions (REAL Railway DB)
app.get('/api/sessions/active', (req, res) => {

    db.query(

        `
        SELECT *
        FROM active_sessions
        WHERE status = "connected"
        AND COALESCE(device_name, '') <> 'Mesh Node'
        AND COALESCE(mac_address, '') <> 'ESP32'
        `,

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

// Disconnect one device by MAC address
app.delete('/api/sessions/:mac', (req, res) => {

    const macAddress = req.params.mac;

    db.query(

        `UPDATE active_sessions
         SET status = 'disconnected'
         WHERE mac_address = ?
         AND status = 'connected'`,

        [macAddress],

        (err, result) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    success: false,
                    message: 'Failed to disconnect device'
                });

            }

            if (result.affectedRows === 0) {

                return res.status(404).json({
                    success: false,
                    message: 'Connected device not found'
                });

            }

            console.log(
                `[MANUAL DISCONNECT] MAC ${macAddress}`
            );

            res.json({
                success: true,
                message: 'Device disconnected'
            });

        }

    );

});

// Requests
app.get('/api/requests', (req, res) => {

    db.query(

        `
        SELECT
            cr.*,
            COALESCE(r.device_limit, 0) AS device_limit,
            COALESCE(ac.current_connections, 0) AS current_connections,
            n.rssi,
            n.signal_quality,
            n.node_status,
            nm.wifi_latency_ms,
            nm.wifi_jitter_ms,
            nm.wifi_packet_loss,
            nm.wifi_success_rate
        FROM connection_requests cr
        LEFT JOIN rooms r
            ON r.id = cr.room_id
        LEFT JOIN (
            SELECT
                room_id,
                COUNT(*) AS current_connections
            FROM active_sessions
            WHERE status = 'connected'
            GROUP BY room_id
        ) ac
            ON ac.room_id = cr.room_id
        LEFT JOIN (
            SELECT
                room_id,
                rssi,
                signal_quality,
                CASE
                    WHEN TIMESTAMPDIFF(SECOND, last_seen, NOW()) > 30
                    THEN 'offline'
                    ELSE 'online'
                END AS node_status
            FROM nodes
        ) n
            ON n.room_id = cr.room_id
        LEFT JOIN (
            SELECT
                room_id,
                ROUND(AVG(wifi_latency_ms), 1) AS wifi_latency_ms,
                ROUND(AVG(wifi_jitter_ms), 1) AS wifi_jitter_ms,
                ROUND(AVG(wifi_packet_loss), 1) AS wifi_packet_loss,
                ROUND(AVG(wifi_success_rate), 1) AS wifi_success_rate
            FROM node_metrics
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
              AND wifi_latency_ms IS NOT NULL
            GROUP BY room_id
        ) nm
            ON nm.room_id = cr.room_id
        WHERE cr.status = 'pending'
        ORDER BY cr.created_at DESC
        `,

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

    db.getConnection((connectionError, connection) => {

        if (connectionError) {

            console.error(connectionError);

            return res.status(500).json({
                error: 'Database connection error'
            });

        }

        connection.beginTransaction((transactionError) => {

            if (transactionError) {

                connection.release();
                console.error(transactionError);

                return res.status(500).json({
                    error: 'Failed to start transaction'
                });

            }

            connection.query(

                `SELECT room_id, mac_address
                 FROM connection_requests
                 WHERE id = ?
                 AND status = 'pending'
                 FOR UPDATE`,

                [requestId],

                (requestError, requests) => {

                    if (requestError) {

                        return connection.rollback(() => {
                            connection.release();
                            console.error(requestError);
                            res.status(500).json({
                                error: 'Database error'
                            });
                        });

                    }

                    if (requests.length === 0) {

                        return connection.rollback(() => {
                            connection.release();
                            res.status(404).json({
                                error:
                                'Request not found or already processed'
                            });
                        });

                    }

                    const roomId = requests[0].room_id;
                    const requestMac = requests[0].mac_address;

                    connection.query(

                        `UPDATE rooms
                         SET device_limit = device_limit + 1
                         WHERE id = ?`,

                        [roomId],

                        (roomError, roomResult) => {

                            if (roomError || roomResult.affectedRows === 0) {

                                return connection.rollback(() => {
                                    connection.release();
                                    console.error(
                                        roomError ||
                                        `Room ${roomId} not found`
                                    );
                                    res.status(500).json({
                                        error:
                                        'Failed to update room limit'
                                    });
                                });

                            }

                            connection.query(

                                `UPDATE connection_requests
                                 SET status = 'approved',
                                     created_at = NOW()
                                 WHERE id = ?`,

                                [requestId],

                                (updateError) => {

                                    if (updateError) {

                                        return connection.rollback(() => {
                                            connection.release();
                                            console.error(updateError);
                                            res.status(500).json({
                                                error:
                                                'Failed to approve request'
                                            });
                                        });

                                    }

                                    const commitApproval = () => {

                                        connection.commit((commitError) => {

                                        if (commitError) {

                                            return connection.rollback(() => {
                                                connection.release();
                                                console.error(commitError);
                                                res.status(500).json({
                                                    error:
                                                    'Failed to approve request'
                                                });
                                            });

                                        }

                                        connection.release();

                                        console.log(
                                            `[APPROVED] Request ${requestId} - Room ${roomId} limit increased`
                                        );

                                        res.json({
                                            success: true,
                                            roomId,
                                            message:
                                            'Request approved and room limit increased'
                                        });

                                        });

                                    };

                                    if (
                                        requestMac &&
                                        requestMac !== 'unknown'
                                    ) {

                                        return connection.query(

                                            `UPDATE active_sessions
                                             SET status = 'disconnected'
                                             WHERE room_id = ?
                                             AND mac_address = ?
                                             AND status = 'connected'`,

                                            [roomId, requestMac],

                                            (sessionError) => {

                                                if (sessionError) {

                                                    return connection.rollback(() => {
                                                        connection.release();
                                                        console.error(sessionError);
                                                        res.status(500).json({
                                                            error:
                                                            'Failed to approve request'
                                                        });
                                                    });

                                                }

                                                commitApproval();

                                            }

                                        );

                                    }

                                    commitApproval();

                                }

                            );

                        }

                    );

                }

            );

        });

    });

});

// Reject Request
app.put('/api/requests/:id/reject', (req, res) => {

    const requestId = req.params.id;

    db.query(

        `UPDATE connection_requests
         SET status = 'rejected'
         WHERE id = ?
         AND status = 'pending'`,

        [requestId],

        (err, result) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            if (result.affectedRows === 0) {

                return res.status(404).json({
                    error:
                    'Request not found or already processed'
                });

            }

            console.log(
                `[REJECTED] Request ${requestId}`
            );

            res.json({
                success: true,
                message: 'Request rejected'
            });

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

// Network Performance
app.get('/api/traffic', (req, res) => {

    const range = req.query.range || '1h';

    const ranges = {
        '1h': 1,
        '6h': 6,
        '24h': 24
    };

    const selectedHours = ranges[range] || ranges['1h'];

    db.query(

        `
        SELECT
            DATE_FORMAT(
                MIN(COALESCE(
                    CONVERT_TZ(created_at, '+00:00', '+08:00'),
                    DATE_ADD(created_at, INTERVAL 8 HOUR)
                )),
                '%l:%i %p'
            ) AS time,
            ROUND(AVG(wifi_latency_ms), 1) AS latency,
            ROUND(AVG(wifi_jitter_ms), 1) AS jitter,
            ROUND(AVG(wifi_packet_loss), 1) AS packetLoss,
            ROUND(AVG(wifi_success_rate), 1) AS successRate
        FROM node_metrics
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
          AND wifi_latency_ms IS NOT NULL
        GROUP BY DATE_FORMAT(
            COALESCE(
                CONVERT_TZ(created_at, '+00:00', '+08:00'),
                DATE_ADD(created_at, INTERVAL 8 HOUR)
            ),
            '%Y-%m-%d %H:%i'
        )
        ORDER BY MIN(created_at)
        LIMIT 120
        `,

        [selectedHours],

        (err, results) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            res.json(
                results.map((request) => ({
                    ...request,
                    ai_suggestion:
                        buildAdditionalConnectionSuggestion(request)
                }))
            );

        }

    );

});

// AI Network Insight
app.get('/api/ai/network-insight', (req, res) => {

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

        (nodesError, nodes) => {

            if (nodesError) {

                console.error(nodesError);

                return res.status(500).json({
                    error: 'Database error'
                });

            }

            db.query(

                `
                SELECT
                    node_id,
                    room_id,
                    ROUND(AVG(wifi_latency_ms), 1) AS wifi_latency_ms,
                    ROUND(AVG(wifi_jitter_ms), 1) AS wifi_jitter_ms,
                    ROUND(AVG(wifi_packet_loss), 1) AS wifi_packet_loss,
                    ROUND(AVG(wifi_success_rate), 1) AS wifi_success_rate
                FROM node_metrics
                WHERE created_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
                  AND wifi_latency_ms IS NOT NULL
                GROUP BY node_id, room_id
                `,

                async (metricsError, metrics) => {

                    if (metricsError) {

                        console.error(metricsError);

                        return res.status(500).json({
                            error: 'Database error'
                        });

                    }

                    const insight =
                        buildNetworkInsight(nodes, metrics);
                    const improvedInsight =
                        await improveInsightWithOllama(insight);

                    res.json(improvedInsight);

                }

            );

        }

    );

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

        `UPDATE rooms
         SET device_limit = ?,
             default_device_limit = ?
         WHERE id = ?`,

        [limit, limit, roomId],

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

// Update room WiFi access period and password
app.put('/api/rooms/:id/access', (req, res) => {

    const roomId = req.params.id;
    const {
        wifiPassword,
        checkIn,
        checkOut
    } = req.body;

    const cleanCheckIn =
        checkIn || null;
    const cleanCheckOut =
        checkOut || null;

    if (
        cleanCheckIn &&
        cleanCheckOut &&
        cleanCheckOut < cleanCheckIn
    ) {

        return res.status(400).json({
            error: 'Check-out date cannot be before check-in date'
        });

    }

    const cleanPassword =
        (
            wifiPassword ||
            generateRoomPassword(roomId, cleanCheckIn)
        ).trim();

    if (!cleanPassword) {

        return res.status(400).json({
            error: 'WiFi password is required'
        });

    }

    db.query(

        `UPDATE rooms
         SET wifi_password = ?,
             check_in = ?,
             check_out = ?,
             device_limit =
                COALESCE(default_device_limit, device_limit)
         WHERE id = ?`,

        [
            cleanPassword,
            cleanCheckIn,
            cleanCheckOut,
            roomId
        ],

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
                `[UPDATE] Room ${roomId} WiFi access updated`
            );

            res.json({
                success: true,
                roomId,
                wifiPassword: cleanPassword,
                checkIn: cleanCheckIn,
                checkOut: cleanCheckOut
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

app.get(
    '/telegram-test',
    async (req, res) => {

        await sendTelegram(
            '🚀 HOTEL OA Telegram Test Success'
        );

        res.send(
            'Telegram Sent'
        );

    }
);


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

setTimeout(
    autoResetExpiredCheckouts,
    8000
);

setInterval(
    autoResetExpiredCheckouts,
    60000
);

setInterval(() => {

    db.query(

        `
        SELECT *
        FROM active_sessions
        WHERE status = 'connected'
        AND COALESCE(device_name, '') <> 'Mesh Node'
        AND COALESCE(mac_address, '') <> 'ESP32'
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

    const { room, mac } = req.body;

    console.log(
    `[HEARTBEAT] Room ${room} - MAC ${mac}`
    );

    if (!room || !mac) {
        return res.status(400).json({
            success: false,
            message: 'Room and MAC address are required'
        });
    }

    db.query(
        `
        UPDATE active_sessions
        SET last_seen = NOW()
        WHERE room_id = ?
        AND mac_address = ?
        AND status = 'connected'
        `,
        [room, mac],
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

    const { room, mac } = req.body;

    if (!room || !mac) {
        return res.status(400).json({
            success: false,
            message: 'Room and MAC address are required'
        });
    }

    db.query(
        `
        UPDATE active_sessions
        SET status = 'disconnected'
        WHERE room_id = ?
        AND mac_address = ?
        AND status = 'connected'
        `,
        [room, mac],
        (err) => {

            if (err) {

                console.error(err);

                return res.status(500).json({
                    success: false
                });

            }

            console.log(
                `[DISCONNECT] Room ${room} - MAC ${mac}`
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
