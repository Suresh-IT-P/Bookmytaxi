const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// --- MULTER STORAGE CONFIGURATION ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/drivers');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- SECURITY & RATE LIMITING ---
// Global Rate Limiter (Prevent DDoS)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per window
    message: { error: 'Security Limit: Too many requests from this IP. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Strict Rate Limiter for Auth (Prevent Brute Force)
const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // Limit each IP to 20 login/register attempts per hour
    message: { error: 'Too many authentication attempts. Please try again in an hour.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(globalLimiter);
app.use(bodyParser.json({ limit: '10kb' })); // DDoS: Limit payload size
app.use(bodyParser.urlencoded({ extended: true, limit: '10kb' }));

// Apply Auth Limiter to Auth routes
app.use('/api/auth/', authLimiter);
app.use('/api/driver/login', authLimiter);
app.use('/api/admin/login', authLimiter);

// Database Global
let db;

async function initDB() {
    const dbConfig = {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'railway',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        charset: 'UTF8MB4_UNICODE_CI'
    };

    try {
        const tempConn = await mysql.createConnection({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password
        });
        await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await tempConn.end();
        db = mysql.createPool(dbConfig);
        console.log('Database Pool initialized.');
        
        // Auto-Migration: Ensure new columns exist
        const ensureColumns = async () => {
            try { await db.query('ALTER TABLE drivers ADD COLUMN is_online tinyint DEFAULT 0'); } catch(e) {}
            try { await db.query('ALTER TABLE bookings ADD COLUMN start_odometer int DEFAULT NULL'); } catch(e) {}
            try { await db.query('ALTER TABLE bookings ADD COLUMN end_odometer int DEFAULT NULL'); } catch(e) {}
            
            // Seed Default Driver (Fail-safe for test login)
            const hashedPass = await bcrypt.hash('password123', 10);
            const [driverExists] = await db.query('SELECT id FROM drivers WHERE phone = "9876543210"');
            if (driverExists.length === 0) {
                await db.query(`INSERT INTO drivers (name, email, phone, password, car_model, car_number, vehicle_type, wallet_balance, is_online) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                    ['Captain BookMyTaxi', 'captain@bookmytaxi.com', '9876543210', hashedPass, 'Toyota Camry', 'TN-01-BK-2024', 'sedan', 500.00, 1]);
                console.log('Default driver seeded successfully.');
            }

            console.log('Schema verification complete.');
        };
        await ensureColumns();
    } catch (err) {
        console.error('Database Initialization Failed:', err.message);
        throw err;
    }
}

// Routes
app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const [users] = await db.query('SELECT id, name, email, phone, password FROM passengers WHERE phone = ?', [phone]);
        if (users.length > 0) {
            const user = users[0];
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) {
                delete user.password;
                return res.json({ success: true, user });
            }
        }
        res.status(401).json({ error: 'Invalid phone or password.' });
    } catch (err) {
        res.status(500).json({ error: 'Auth Failure' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const [result] = await db.query('INSERT INTO passengers (name, email, password, phone) VALUES (?, ?, ?, ?)', [name, email, hashedPassword, phone]);
        res.json({ success: true, userId: result.insertId });
    } catch (err) {
        res.status(500).json({ error: 'Registration Failure' });
    }
});

app.post('/api/bookings/create', async (req, res) => {
    try {
        const booking = req.body;
        const journeyOtp = Math.floor(1000 + Math.random() * 9000).toString();
        const values = [
            booking.userId, booking.pickup, booking.pickupCoords, booking.drop, booking.dropCoords,
            booking.date, booking.time, booking.passengers, booking.vehicle, booking.tripType,
            booking.fare, booking.distance, journeyOtp, 'pending'
        ];
        const [result] = await db.query('INSERT INTO bookings (user_id, pickup_loc, pickup_coords, drop_loc, drop_coords, pickup_date, pickup_time, passengers, vehicle_type, trip_type, fare, distance, journey_otp, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', values);
        res.json({ success: true, bookingId: result.insertId, journeyOtp });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- USER ROUTES ---
app.post('/api/user/update-profile', async (req, res) => {
    console.log('Profile Update Request:', req.body);
    try {
        const { userId, name, email, phone } = req.body;
        await db.query('UPDATE passengers SET name = ?, email = ?, phone = ? WHERE id = ?', [name, email, phone, userId]);
        res.json({ success: true, message: 'Profile updated' });
    } catch (err) {
        console.error('Profile Update Error:', err);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

app.get('/api/user/bookings/:userId', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC', [req.params.userId]);
    res.json(rows);
});
app.get('/api/tariffs', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM tariffs');
    res.json(rows);
});

// Proxy routes for maps (Photon & OSRM)
app.get('/api/proxy/geocode', async (req, res) => {
    try {
        const { q, limit } = req.query;
        if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });
        const response = await axios.get(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit || 5}`);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: 'Geocoding failed' });
    }
});

app.get('/api/proxy/reverse', async (req, res) => {
    try {
        const { lon, lat } = req.query;
        if (!lon || !lat) return res.status(400).json({ error: 'Coordinates required' });
        const response = await axios.get(`https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}`);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: 'Reverse geocoding failed' });
    }
});

app.get('/api/proxy/route', async (req, res) => {
    try {
        const { pickup, drop } = req.query;
        if (!pickup || !drop) return res.status(400).json({ error: 'Pickup and drop coordinates required' });
        const response = await axios.get(`https://router.project-osrm.org/route/v1/driving/${pickup};${drop}?overview=full&geometries=geojson`);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: 'Routing failed' });
    }
});

// Admin & Driver routes (simplified for demonstration)
app.post('/api/driver/login', async (req, res) => {
    const { phone, password } = req.body;
    const [drivers] = await db.query('SELECT * FROM drivers WHERE phone = ?', [phone]);
    if (drivers.length > 0 && await bcrypt.compare(password, drivers[0].password)) {
        delete drivers[0].password;
        return res.json({ success: true, user: drivers[0] });
    }
    res.status(401).json({ error: 'Auth failed' });
});

app.get('/api/driver/info/:id', async (req, res) => {
    const [rows] = await db.query('SELECT id, name, wallet_balance, car_model, car_number, vehicle_type FROM drivers WHERE id = ?', [req.params.id]);
    res.json({ success: true, driver: rows[0] });
});

app.get('/api/driver/jobs/:id', async (req, res) => {
    try {
        // 1. Get driver info & status
        const [drivers] = await db.query('SELECT vehicle_type, is_online FROM drivers WHERE id = ?', [req.params.id]);
        if (drivers.length === 0) return res.status(404).json({ error: 'Driver not found' });
        
        const driver = drivers[0];
        // Driver is now considered always online by default for this simplified workflow

        // 2. Get pending jobs matching driver's vehicle type
        // Enhanced matching: case-insensitive and fallback for unspecified types
        const [rows] = await db.query(
            'SELECT * FROM bookings WHERE status = "pending" AND (LOWER(vehicle_type) = LOWER(?) OR vehicle_type IS NULL OR ? IS NULL)', 
            [driver.vehicle_type, driver.vehicle_type]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});

app.get('/api/driver/my-jobs/:id', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM bookings WHERE driver_id = ? ORDER BY id DESC', [req.params.id]);
    res.json(rows);
});

app.post('/api/bookings/accept', async (req, res) => {
    const { bookingId, driverId } = req.body;
    await db.query('UPDATE bookings SET status = "assigned", driver_id = ? WHERE id = ?', [driverId, bookingId]);
    res.json({ success: true });
});

app.post('/api/bookings/update-status', async (req, res) => {
    const { bookingId, status, otp, odometer } = req.body;
    try {
        const [bookings] = await db.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
        if (bookings.length === 0) return res.status(404).json({ error: 'Booking not found' });
        
        const booking = bookings[0];

        // 1. Handling Start Trip (Ongoing)
        if (status === 'ongoing') {
            if (!odometer) return res.status(400).json({ error: 'Starting odometer reading required' });
            await db.query('UPDATE bookings SET status = ?, start_odometer = ? WHERE id = ?', [status, odometer, bookingId]);
            return res.json({ success: true, message: 'Trip started' });
        }

        // 2. Handling Completion
        if (status === 'completed') {
            if (!odometer) return res.status(400).json({ error: 'Final odometer reading required' });
            if (booking.journey_otp !== otp) {
                return res.status(400).json({ error: 'Invalid OTP. Verification failed.' });
            }

            // Financial Logic
            const fareNum = parseFloat(booking.fare.replace(/[^0-9.]/g, ''));
            if (!isNaN(fareNum) && booking.driver_id) {
                let commissionRate = 0.10;
                if (booking.trip_type === 'outstation') commissionRate = 0.15;
                if (booking.trip_type === 'rental') commissionRate = 0.12;

                const commission = fareNum * commissionRate;
                const netEarning = fareNum - commission;

                await db.query('UPDATE drivers SET wallet_balance = wallet_balance + ? WHERE id = ?', [netEarning, booking.driver_id]);
            }

            await db.query('UPDATE bookings SET status = ?, end_odometer = ? WHERE id = ?', [status, odometer, bookingId]);
            return res.json({ success: true, message: 'Trip completed successfully' });
        }

        // Default Status Update
        await db.query('UPDATE bookings SET status = ? WHERE id = ?', [status, bookingId]);
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (err) {
        console.error('Status Update Error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;
    const [admins] = await db.query('SELECT * FROM admins WHERE email = ?', [email]);
    if (admins.length > 0 && await bcrypt.compare(password, admins[0].password)) {
        delete admins[0].password;
        return res.json({ success: true, user: admins[0] });
    }
    res.status(401).json({ error: 'Access denied' });
});

app.get('/api/admin/stats', async (req, res) => {
    const [b] = await db.query('SELECT COUNT(*) as cnt FROM bookings');
    const [d] = await db.query('SELECT COUNT(*) as cnt FROM drivers');
    const [p] = await db.query('SELECT COUNT(*) as cnt FROM passengers');
    const [r] = await db.query('SELECT SUM(CAST(REPLACE(REPLACE(fare, "₹", ""), ",", "") AS DECIMAL(10,2))) as total FROM bookings WHERE status = "completed"');
    res.json({ 
        totalBookings: b[0].cnt, 
        totalDrivers: d[0].cnt, 
        totalUsers: p[0].cnt, 
        revenue: r[0].total || 0 
    });
});

app.get('/api/admin/bookings', async (req, res) => {
    const [rows] = await db.query('SELECT b.*, p.name as customer_name, d.name as driver_name FROM bookings b LEFT JOIN passengers p ON b.user_id = p.id LEFT JOIN drivers d ON b.driver_id = d.id ORDER BY b.created_at DESC');
    res.json(rows);
});

app.get('/api/admin/drivers', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM drivers ORDER BY created_at DESC');
    res.json(rows);
});

app.get('/api/admin/passengers', async (req, res) => {
    const [rows] = await db.query('SELECT id, name, email, phone, created_at FROM passengers ORDER BY created_at DESC');
    res.json(rows);
});

app.get('/api/admin/tariffs', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM tariffs');
    res.json(rows);
});

app.post('/api/admin/tariffs/update', async (req, res) => {
    const { id, config } = req.body;
    await db.query('UPDATE tariffs SET config = ? WHERE id = ?', [JSON.stringify(config), id]);
    res.json({ success: true });
});

// --- ADDITIONAL TAXI ROUTES ---
app.post('/api/bookings/cancel', async (req, res) => {
    try {
        const { bookingId } = req.body;
        if (!bookingId) return res.status(400).json({ error: 'Booking ID required' });
        await db.query('UPDATE bookings SET status = "cancelled" WHERE id = ?', [bookingId]);
        res.json({ success: true, message: 'Booking cancelled' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to cancel booking' });
    }
});

app.post('/api/driver/duty', async (req, res) => {
    try {
        const { driverId, online } = req.body;
        if (!driverId) return res.status(400).json({ error: 'Driver ID required' });
        // Assuming a column 'is_online' exists or using status
        await db.query('UPDATE drivers SET is_online = ? WHERE id = ?', [online ? 1 : 0, driverId]);
        res.json({ success: true, online });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update duty status' });
    }
});

app.post('/api/admin/drivers/update-wallet', async (req, res) => {
    try {
        const { driverId, amount } = req.body;
        if (!driverId) return res.status(400).json({ error: 'Driver ID required' });
        await db.query('UPDATE drivers SET wallet_balance = wallet_balance + ? WHERE id = ?', [amount, driverId]);
        res.json({ success: true, message: 'Wallet updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update wallet' });
    }
});

async function start() {
    await initDB();
    app.listen(3000, () => console.log('Server running on port 3000'));
}
start();
