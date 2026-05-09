const mysql = require('mysql2/promise');
require('dotenv').config();

async function initNewDB() {
    console.log('Connecting to MySQL host...');
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    });

    console.log('Creating database "bookmytaxi"...');
    await conn.query('CREATE DATABASE IF NOT EXISTS bookmytaxi');
    await conn.query('USE bookmytaxi');

    const schema = [
        `CREATE TABLE IF NOT EXISTS admins (
            id int NOT NULL AUTO_INCREMENT,
            email varchar(100) DEFAULT NULL,
            password varchar(255) DEFAULT NULL,
            created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS drivers (
            id int NOT NULL AUTO_INCREMENT,
            name varchar(100) DEFAULT NULL,
            email varchar(100) DEFAULT NULL,
            phone varchar(20) DEFAULT NULL,
            password varchar(255) DEFAULT NULL,
            car_model varchar(100) DEFAULT NULL,
            car_number varchar(50) DEFAULT NULL,
            vehicle_type varchar(50) DEFAULT NULL,
            wallet_balance decimal(10,2) DEFAULT "0.00",
            is_blocked tinyint DEFAULT "0",
            is_online tinyint DEFAULT "0",
            created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY email (email),
            UNIQUE KEY phone (phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS passengers (
            id int NOT NULL AUTO_INCREMENT,
            name varchar(100) DEFAULT NULL,
            email varchar(100) DEFAULT NULL,
            phone varchar(20) DEFAULT NULL,
            password varchar(255) DEFAULT NULL,
            created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY email (email),
            UNIQUE KEY phone (phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS bookings (
            id int NOT NULL AUTO_INCREMENT,
            user_id int DEFAULT NULL,
            driver_id int DEFAULT NULL,
            pickup_loc text,
            pickup_coords varchar(100) DEFAULT NULL,
            drop_loc text,
            drop_coords varchar(100) DEFAULT NULL,
            pickup_date date DEFAULT NULL,
            pickup_time time DEFAULT NULL,
            passengers int DEFAULT "1",
            vehicle_type varchar(50) DEFAULT NULL,
            trip_type varchar(50) DEFAULT NULL,
            fare varchar(50) DEFAULT NULL,
            distance varchar(50) DEFAULT NULL,
            start_odometer int DEFAULT NULL,
            end_odometer int DEFAULT NULL,
            journey_otp varchar(10) DEFAULT NULL,
            status enum("pending","assigned","ongoing","finished","completed","cancelled") DEFAULT "pending",
            created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS tariffs (
            id int NOT NULL AUTO_INCREMENT,
            vehicle_type varchar(50) DEFAULT NULL,
            category varchar(50) DEFAULT NULL,
            config json DEFAULT NULL,
            updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ];

    for (let q of schema) {
        await conn.query(q);
    }
    console.log('Tables created successfully.');

    // Seed data from old DB
    try {
        const oldDB = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: 'railway'
        });

        console.log('Seeding tariffs...');
        const [tariffs] = await oldDB.query('SELECT * FROM tariffs');
        for (let t of tariffs) {
            await conn.query('INSERT INTO tariffs (vehicle_type, category, config) VALUES (?, ?, ?)', 
                [t.vehicle_type, t.category, JSON.stringify(t.config)]);
        }

        console.log('Seeding admin...');
        const [admins] = await oldDB.query('SELECT * FROM admins WHERE email = "admin@ola.com"');
        if (admins.length > 0) {
            // Check if exists first to avoid dupes if re-run
            const [exists] = await conn.query('SELECT id FROM admins WHERE email = "admin@ola.com"');
            if (exists.length === 0) {
                await conn.query('INSERT INTO admins (email, password) VALUES (?, ?)', 
                    ['admin@ola.com', admins[0].password]);
            }
        }
        
        // Also add admin@bookmytaxi.com as a bonus
        const [exists2] = await conn.query('SELECT id FROM admins WHERE email = "admin@bookmytaxi.com"');
        if (exists2.length === 0 && admins.length > 0) {
             await conn.query('INSERT INTO admins (email, password) VALUES (?, ?)', 
                    ['admin@bookmytaxi.com', admins[0].password]);
        }

        console.log('Seeding default driver...');
        const bcrypt = require('bcryptjs');
        const hashedPass = await bcrypt.hash('password123', 10);
        const [driverExists] = await conn.query('SELECT id FROM drivers WHERE phone = "9876543210"');
        if (driverExists.length === 0) {
            await conn.query(`INSERT INTO drivers (name, email, phone, password, car_model, car_number, vehicle_type, wallet_balance, is_online) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                ['Captain BookMyTaxi', 'captain@bookmytaxi.com', '9876543210', hashedPass, 'Toyota Camry', 'TN-01-BK-2024', 'sedan', 500.00, 1]);
            console.log('Default driver created: 9876543210 / password123');
        }

        await oldDB.end();
        console.log('Database seeding complete.');
    } catch (err) {
        console.warn('Could not seed data from old DB, but tables are ready.', err.message);
    }

    await conn.end();
}

initNewDB().catch(console.error);
