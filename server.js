import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';    
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const authSecret = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const aiServicePort = Number(process.env.AI_SERVICE_PORT || 8000);
const aiServiceUrl = `http://127.0.0.1:${aiServicePort}`;

let aiServiceProcess;
if (process.env.AI_SERVICE_ENABLED !== 'false') {
    aiServiceProcess = spawn('python', [
        '-m', 'uvicorn', 'ai_service:app',
        '--host', '127.0.0.1',
        '--port', String(aiServicePort)
    ], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });

    aiServiceProcess.stdout.on('data', data => console.log(`[AI] ${data.toString().trim()}`));
    aiServiceProcess.stderr.on('data', data => console.error(`[AI] ${data.toString().trim()}`));
    aiServiceProcess.on('error', error => console.error('AI service failed to start:', error));
    aiServiceProcess.on('exit', (code, signal) => {
        if (code !== 0) console.error(`AI service stopped (code=${code}, signal=${signal})`);
    });

    const stopAiService = () => aiServiceProcess?.kill('SIGTERM');
    process.once('SIGINT', stopAiService);
    process.once('SIGTERM', stopAiService);
}

if (isProduction) {
    const requiredProductionEnv = ['AUTH_SECRET', 'DATABASE_URL', 'FRONTEND_URL'];
    const missingProductionEnv = requiredProductionEnv.filter(key => !process.env[key]);
    if (missingProductionEnv.length || process.env.AUTH_SECRET.length < 32) {
        throw new Error(`Missing or invalid production environment variables: ${missingProductionEnv.join(', ') || 'AUTH_SECRET'}`);
    }
}

app.set('trust proxy', isProduction ? 1 : false);

const jsonBase64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const createAuthToken = user => {
    const payload = jsonBase64({
        sub: Number(user.id),
        role: user.role,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12
    });
    const signature = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
};

const verifyAuthToken = token => {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature) return null;

    const expected = crypto.createHmac('sha256', authSecret).update(payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.sub || !decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: Number(decoded.sub), role: decoded.role };
};

const authenticate = (req, res, next) => {
    try {
        const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
        const user = verifyAuthToken(token);
        if (!user) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบใหม่' });
        req.user = user;
        next();
    } catch {
        res.status(401).json({ success: false, message: 'ข้อมูลยืนยันตัวตนไม่ถูกต้อง' });
    }
};

const requireRole = (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ใช้งานส่วนนี้' });
    }
    next();
};

const canAccessUser = (req, userId) =>
    ['admin', 'expert'].includes(req.user?.role) || Number(req.user?.id) === Number(userId);

const validPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 128;
const passwordHashRounds = 12;

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const useDatabaseSsl = process.env.DATABASE_SSL === 'true' || isProduction;
const databasePool = new Pool({
    connectionString: databaseUrl || undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: useDatabaseSsl
        ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : undefined
});

// Convert the existing parameterized queries from MySQL's ? syntax to PostgreSQL's $1, $2, ... syntax.
const toPostgresQuery = (sql) => {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
};

// Keep the current [rows] / [result] call shape while using node-postgres underneath.
const databaseQuery = async (sql, values = []) => {
    const result = await databasePool.query(toPostgresQuery(sql), values);
    const isReadQuery = /^\s*(SELECT|WITH|SHOW|EXPLAIN)\b/i.test(sql);
    if (isReadQuery) return [result.rows];
    return [{
        affectedRows: result.rowCount,
        rowCount: result.rowCount,
        insertId: result.rows[0]?.id
    }];
};

const pool = {
    query: databaseQuery,
    execute: databaseQuery
};

// เช็คการเชื่อมต่อเมื่อมีการตั้งค่า DATABASE_URL ครบถ้วน
if (databaseUrl) {
    databasePool.query('SELECT 1')
        .then(() => {
            console.log('✅ Connected to Neon PostgreSQL successfully!');
        })
        .catch(err => {
            console.error('❌ Database Connection Failed:', err.message);
        });
} else {
    console.warn('⚠️ Database credentials are not configured. Set DATABASE_URL.');
}

const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(origin => origin.trim())
    .map(origin => origin.replace(/\/+$/, ''))
    .filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error('Origin is not allowed by CORS'));
    }
}));
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir, { dotfiles: 'deny', index: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/src', express.static(path.join(__dirname, 'src')));

// Serve static HTML pages when the backend is deployed as a Render service.
const htmlPages = new Set(
    fs.readdirSync(__dirname).filter(fileName => fileName.toLowerCase().endsWith('.html'))
);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:page.html', (req, res, next) => {
    const pageName = `${req.params.page}.html`;
    if (!htmlPages.has(pageName)) return next();
    res.sendFile(path.join(__dirname, pageName));
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'คำขอมากเกินไป กรุณาลองใหม่ภายหลัง' }
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'พยายามเข้าสู่ระบบมากเกินไป กรุณารอสักครู่' }
});
app.use(apiLimiter);
app.use(['/login', '/register', '/forgot-password', '/reset-password'], authLimiter);

const publicApiRequest = req => (
    (req.method === 'GET' && req.path === '/health') ||
    (req.method === 'POST' && ['/login', '/register', '/forgot-password', '/reset-password', '/api/contact'].includes(req.path)) ||
    (req.method === 'GET' && req.path === '/get-global-outbreak') ||
    (req.method === 'GET' && /^\/admin\/articles(?:\/\d+)?$/.test(req.path)) ||
    (req.method === 'PUT' && /^\/articles\/increment-view\/\d+$/.test(req.path))
);

app.use((req, res, next) => {
    if (publicApiRequest(req)) return next();
    authenticate(req, res, next);
});

app.use('/admin', (req, res, next) => {
    if (req.method === 'GET' && /^\/articles(?:\/\d+)?$/.test(req.path)) return next();
    requireRole('admin')(req, res, next);
});
app.use('/expert', requireRole('expert', 'admin'));
app.use((req, res, next) => {
    if (['/get-pending-cases', '/review-case'].includes(req.path)) {
        return requireRole('expert', 'admin')(req, res, next);
    }
    next();
});

app.use((req, res, next) => {
    const pathUserMatch = req.path.match(/^\/(?:get-history-list|get-latest-history|get-user-profile|get-notifications|notifications\/unread-count|notifications\/mark-all-read)\/(\d+)$/);
    const bodyUserId = ['/save-history', '/update-user', '/update-user-profile', '/update-account-settings', '/upload-profile-image'].includes(req.path)
        ? (req.body.user_id || req.body.id)
        : null;
    const requestedUserId = pathUserMatch?.[1] || bodyUserId;
    if (requestedUserId && !canAccessUser(req, requestedUserId)) {
        return res.status(403).json({ success: false, message: 'ไม่สามารถเข้าถึงข้อมูลของผู้ใช้อื่นได้' });
    }
    next();
});

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const imageFileFilter = (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    if (!allowedImageTypes.has(file.mimetype) || !allowedExtensions.has(extension)) {
        return cb(new Error('รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP'));
    }
    cb(null, true);
};
const imageUploadOptions = {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: imageFileFilter
};
const upload = multer({ dest: uploadsDir, ...imageUploadOptions });

// ==========================================
// 1. API Predict (วิเคราะห์โรค)
// ==========================================
app.post('/predict', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'กรุณาอัปโหลดรูปภาพ' });

    const imagePath = req.file.path;
    try {
        const imageBytes = fs.readFileSync(imagePath);
        const formData = new FormData();
        formData.append('file', new Blob([imageBytes], { type: req.file.mimetype }), req.file.originalname);

        const aiResponse = await fetch(`${aiServiceUrl}/predict`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(90_000)
        });
        const result = await aiResponse.json().catch(() => ({}));

        if (!aiResponse.ok) {
            return res.status(aiResponse.status).json({
                success: false,
                message: result.detail || 'ระบบ AI ไม่สามารถประมวลผลได้'
            });
        }

        console.log(`✅ AI Result: ${result.disease} (${result.confidence})`);
        res.json(result);
    } catch (error) {
        console.error('AI request error:', error);
        const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
        res.status(isTimeout ? 504 : 503).json({
            success: false,
            message: isTimeout
                ? 'ระบบ AI ใช้เวลาประมวลผลนานเกินไป'
                : 'ระบบ AI ยังไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง'
        });
    } finally {
        try { fs.unlinkSync(imagePath); } catch (error) { }
    }
});

// Legacy CLI endpoint retained temporarily for rollback/debugging.
app.post('/predict-legacy', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).send("กรุณาอัปโหลดรูปภาพ");

    // Multer already stores an absolute path when `dest` is an absolute directory.
    // Do not prefix it with __dirname, otherwise Render gets /app/app/uploads/....
    const imagePath = path.isAbsolute(req.file.path)
        ? req.file.path
        : path.join(__dirname, req.file.path);
    const pythonProcess = spawn('python', ['predict.py', imagePath]);

    let resultData = "";

    pythonProcess.stderr.on('data', (data) => console.error(`🔥 Python Error: ${data}`));
    pythonProcess.stdout.on('data', (data) => resultData += data.toString());

    pythonProcess.on('error', (error) => {
        console.error('❌ Python process failed to start:', error);
        try { fs.unlinkSync(imagePath); } catch (e) { }
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'ไม่สามารถเริ่มระบบ AI ได้' });
        }
    });

    pythonProcess.on('close', (code) => {
        try { fs.unlinkSync(imagePath); } catch (e) { }

        if (code !== 0 && !resultData && !res.headersSent) {
            console.error(`❌ Python process exited with code ${code}`);
            return res.status(500).json({ success: false, message: 'ระบบ AI หยุดทำงานระหว่างประมวลผล กรุณาตรวจสอบ Render logs' });
        }

        try {
            if (!resultData) throw new Error("No data received from Python");
            const resultJson = JSON.parse(resultData);

            if (resultJson.error) return res.status(500).json(resultJson);

            console.log(`✅ AI Result: ${resultJson.disease} (${resultJson.confidence})`);
            res.json(resultJson);

        } catch (e) {
            console.error("Parse Error:", e);
            res.status(500).json({ message: "Error processing AI result" });
        }
    });
});

// ==========================================
// 2. API Save History (บันทึกประวัติ)
// ==========================================
app.post('/save-history', async (req, res) => {
    try {
        let {
            user_id, latitude, longitude, location_name,
            variety_code, disease, confidence, image_base64, timestamp,
            weather
        } = req.body;

        const latVal = (latitude && !isNaN(latitude)) ? parseFloat(latitude) : null;
        const lngVal = (longitude && !isNaN(longitude)) ? parseFloat(longitude) : null;

        const confidenceText = String(confidence ?? '').replace('%', '').trim();
        const parsedConfidence = Number.parseFloat(confidenceText);
        const confidenceValue = Number.isFinite(parsedConfidence)
            ? Math.min(100, Math.max(0, parsedConfidence))
            : 0;

        let status = 'completed';
        if (confidenceValue <= 60) {
            status = 'pending_expert';
        }

        const userIdToSave = ['admin', 'expert'].includes(req.user.role) && user_id
            ? user_id
            : req.user.id;
        const saveTime = timestamp ? new Date(timestamp) : new Date();

        const sql = `
            INSERT INTO history 
            (user_id, latitude, longitude, location_name, variety_code, disease, confidence, image_base64, status, timestamp, weather) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `;

        const [result] = await pool.execute(sql, [
            userIdToSave, latVal, lngVal, location_name, variety_code,
            disease, confidenceValue, image_base64, status, saveTime,
            weather || 'ไม่ระบุ'
        ]);

        console.log(`📝 Saved ID: ${result.insertId} | Status: ${status} | Weather: ${weather}`);

        res.status(200).json({
            success: true,
            message: status === 'pending_expert' ? 'ส่งต่อผู้เชี่ยวชาญ' : 'บันทึกเรียบร้อย',
            id: result.insertId,
            status: status
        });

    } catch (error) {
        console.error("❌ Save Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 3. API ดึงรายการ (User)
// ==========================================

// ดึงประวัติทั้งหมดของ User คนนั้น 
app.get('/get-history-list/:user_id', async (req, res) => {
    try {
        const { user_id } = req.params;
        // ✅ เพิ่ม WHERE user_id = ?
        const [rows] = await pool.query('SELECT * FROM history WHERE user_id = ? ORDER BY id DESC', [user_id]);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching data" });
    }
});

// ดึงประวัติล่าสุดของ User คนนั้น
app.get('/get-latest-history/:user_id', async (req, res) => {
    try {
        const { user_id } = req.params;

        const [rows] = await pool.query('SELECT * FROM history WHERE user_id = ? ORDER BY id DESC LIMIT 1', [user_id]);

        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ message: "No Data" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error fetching data" });
    }
});

// ==========================================
// 4. API ผู้เชี่ยวชาญ (Expert System)
// ==========================================
app.get('/get-pending-cases', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM history WHERE status = 'pending_expert' ORDER BY timestamp ASC");
        res.json(rows);
    } catch (error) {
        console.error("Fetch Pending Error:", error);
        res.status(500).json({ message: "ดึงข้อมูลไม่สำเร็จ" });
    }
});

app.post('/review-case', async (req, res) => {
    try {
        const { history_id, expert_id, final_disease, comment } = req.body;

        const reviewSql = `
            INSERT INTO expert_reviews (history_id, expert_id, final_disease, comment)
            VALUES (?, ?, ?, ?)
        `;
        await pool.execute(reviewSql, [history_id, expert_id || 1, final_disease, comment]);

        const updateSql = "UPDATE history SET status = 'reviewed', disease = ? WHERE id = ?";
        await pool.execute(updateSql, [final_disease, history_id]);

        console.log(`✅ Expert reviewed Case ID: ${history_id} -> Final: ${final_disease}`);
        res.json({ success: true, message: "บันทึกผลการตรวจสอบเรียบร้อย" });

    } catch (error) {
        console.error("Review Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 5. ระบบสมาชิก (Auth System)
// ==========================================

// สมัครสมาชิก
app.post('/register', async (req, res) => {
    const { username, password, first_name, last_name, email, phone } = req.body;

    if (!username || username.length > 50 || !validPassword(password) || !first_name || !last_name || !email || !phone) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    try {
        const hash = await bcrypt.hash(password, passwordHashRounds);
        const sql = "INSERT INTO users (username, password, first_name, last_name, email, phone, role) VALUES (?, ?, ?, ?, ?, ?, ?)";
        await pool.query(sql, [username, hash, first_name, last_name, email, phone, 'farmer']);

        res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ' });

    } catch (err) {
        console.error(err);
        if (err.code === '23505') {
            return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้หรืออีเมลนี้ถูกใช้งานแล้ว' });
        }
        res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});

//เข้าสู่ระบบ
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const [users] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);
        if (users.length === 0) {
            return res.status(400).json({ success: false, message: "ไม่พบชื่อผู้ใช้นี้" });
        }

        const user = users[0];
        if (user.banned) {
            return res.status(403).json({ success: false, message: "บัญชีของคุณถูกระงับการใช้งานแล้ว" });
        }
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ success: false, message: "รหัสผ่านไม่ถูกต้อง" });
        }

        res.json({
            success: true,
            message: "เข้าสู่ระบบสำเร็จ",
            user: {
                token: createAuthToken(user),
                id: user.id,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                role: user.role,
                banned: Boolean(user.banned)
            }
        });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

//อัปเดตข้อมูล
app.post('/update-user', async (req, res) => {
    try {
        const { id, first_name, last_name, new_password } = req.body;

        if (new_password) {
            const salt = await bcrypt.genSalt(passwordHashRounds);
            const hashedPassword = await bcrypt.hash(new_password, salt);
            await pool.execute("UPDATE users SET first_name = ?, last_name = ?, password = ? WHERE id = ?", [first_name, last_name, hashedPassword, id]);
        } else {
            await pool.execute("UPDATE users SET first_name = ?, last_name = ? WHERE id = ?", [first_name, last_name, id]);
        }
        res.json({ success: true, message: "บันทึกข้อมูลเรียบร้อย" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "แก้ไขข้อมูลไม่สำเร็จ" });
    }
});

// ==========================================
// 6. API สำหรับหน้า Setting (ดึงและบันทึกข้อมูล)
// ==========================================

app.get('/get-user-profile/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query("SELECT id, username, first_name, last_name, email, phone, address, role, profile_image FROM users WHERE id = ?", [id]);

        if (rows.length > 0) {
            res.json({ success: true, data: rows[0] });
        } else {
            res.status(404).json({ success: false, message: "User not found" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.post('/update-user-profile', async (req, res) => {
    try {
        const { id, first_name, last_name, phone, address } = req.body;

        const sql = "UPDATE users SET first_name = ?, last_name = ?, phone = ?, address = ? WHERE id = ?";
        await pool.execute(sql, [first_name, last_name, phone, address, id]);

        res.json({ success: true, message: "บันทึกข้อมูลเรียบร้อย" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Update Error" });
    }
});

// ==========================================
// 7. API สำหรับเปลี่ยนรหัสผ่านและอีเมล (Security)
// ==========================================

app.post('/update-account-settings', async (req, res) => {
    try {
        const { id, current_password, new_email, new_password } = req.body;

        // 1. ดึงข้อมูล User เดิมมาเช็ครหัสผ่านก่อน
        const [users] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
        if (users.length === 0) {
            return res.json({ success: false, message: "ไม่พบผู้ใช้งาน" });
        }
        const user = users[0];

        // 2. ตรวจสอบว่ารหัสผ่านปัจจุบันถูกต้องไหม?
        const isMatch = await bcrypt.compare(current_password, user.password);
        if (!isMatch) {
            return res.json({ success: false, message: "❌ รหัสผ่านปัจจุบันไม่ถูกต้อง" });
        }

        // 3. กรณีเปลี่ยนอีเมล
        if (new_email) {
            // เช็คว่าอีเมลซ้ำคนอื่นไหม
            const [check] = await pool.query("SELECT id FROM users WHERE email = ? AND id != ?", [new_email, id]);
            if (check.length > 0) {
                return res.json({ success: false, message: "❌ อีเมลนี้มีผู้ใช้งานแล้ว" });
            }

            await pool.execute("UPDATE users SET email = ? WHERE id = ?", [new_email, id]);
        }

        // 4. กรณีเปลี่ยนรหัสผ่าน
        if (new_password) {
            const salt = await bcrypt.genSalt(passwordHashRounds);
            const hash = await bcrypt.hash(new_password, salt);
            await pool.execute("UPDATE users SET password = ? WHERE id = ?", [hash, id]);
        }

        res.json({ success: true, message: "✅ บันทึกการตั้งค่าเรียบร้อยแล้ว" });

    } catch (error) {
        console.error("Update Account Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});


// ==========================================
// 8. API อัปโหลดรูปโปรไฟล์
// ==========================================

// ตั้งค่าที่เก็บรูปโปรไฟล์ (เก็บในโฟลเดอร์ uploads/profiles)
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(uploadsDir, 'profiles');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
            cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `user-${Date.now()}${path.extname(file.originalname)}`);
    }
});

const uploadProfile = multer({ storage: profileStorage, ...imageUploadOptions });

// API อัปโหลด
app.post('/upload-profile-image', uploadProfile.single('profile_pic'), async (req, res) => {
    try {
        const userId = req.body.user_id;
        if (!userId || !req.file) {
            return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
        }
        const filename = req.file.filename;

        await pool.execute("UPDATE users SET profile_image = ? WHERE id = ?", [filename, userId]);

        res.json({ success: true, filename: filename, message: "อัปโหลดรูปโปรไฟล์เรียบร้อย" });

    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 9. API ดึงข้อมูลโรคระบาด (Global Outbreak)
// ==========================================
app.get('/get-global-outbreak', async (req, res) => {
    try {
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        const sql = `
            SELECT disease, COUNT(*) as count
            FROM history
            WHERE timestamp >= ?
            AND (disease NOT LIKE '%ปกติ%' AND disease NOT LIKE '%Healthy%')
            GROUP BY disease
            ORDER BY count DESC
            LIMIT 1
        `;

        const [rows] = await pool.query(sql, [threeMonthsAgo]);

        if (rows.length > 0) {
            res.json({ success: true, data: rows[0] });
        } else {
            res.json({ success: true, data: null });
        }

    } catch (error) {
        console.error("Global Outbreak Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.delete('/admin/case/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM history WHERE id = ?', [id]);

        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Deleted successfully' });
        } else {
            res.status(404).json({ success: false, message: 'Case not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// ==========================================
// 10. API สำหรับหน้า Admin Dashboard 
// ==========================================
app.get('/admin/dashboard-overview', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];

        // 1. นับจำนวนเกษตรกร 
        const [totalUsers] = await pool.query("SELECT COUNT(*) as count FROM users WHERE role != 'admin'");

        // 2. นับจำนวนวิเคราะห์โรค "วันนี้"
        const [dailyScans] = await pool.query("SELECT COUNT(*) as count FROM history WHERE timestamp::date = CURRENT_DATE");

        // 3. ดึงรายการวิเคราะห์ล่าสุด (Real-time Table) 
        const [recentScans] = await pool.query(`
            SELECT h.id, h.location_name, h.disease, h.confidence, h.timestamp, u.first_name, u.last_name 
            FROM history h 
            JOIN users u ON h.user_id = u.id 
            ORDER BY h.timestamp DESC LIMIT 5
        `);

        // 4. ข้อมูลกราฟวงกลม (สัดส่วนโรคในเดือนนี้)
        const [diseaseStats] = await pool.query(`
            SELECT disease, COUNT(*) as count 
            FROM history 
            WHERE EXTRACT(MONTH FROM timestamp) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM timestamp) = EXTRACT(YEAR FROM CURRENT_DATE)
            -- ❌ ลบบรรทัด AND disease NOT LIKE ออก เพื่อให้ข้อมูลข้าวปกติไหลเข้ามาด้วย
            GROUP BY disease
        `);

        // 5. สมาชิกใหม่ล่าสุด 3 คน
        const [newUsers] = await pool.query(`
            SELECT first_name, last_name, created_at 
            FROM users 
            WHERE role != 'admin' 
            ORDER BY id DESC LIMIT 3
        `);

        res.json({
            success: true,
            stats: {
                total_farmers: totalUsers[0].count,
                daily_analysis: dailyScans[0].count
            },
            recent_table: recentScans,
            chart_data: diseaseStats,
            new_members: newUsers
        });

    } catch (error) {
        console.error("Dashboard Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 11. API ดึงรายละเอียดเคส (ระบุ ID) สำหรับ Admin
// ==========================================
app.get('/admin/get-case-detail/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query(`
            SELECT h.*, u.first_name, u.last_name 
            FROM history h 
            JOIN users u ON h.user_id = u.id 
            WHERE h.id = ?
        `, [id]);

        if (rows.length > 0) {
            res.json({ success: true, data: rows[0] });
        } else {
            res.status(404).json({ success: false, message: "ไม่พบข้อมูล" });
        }

    } catch (error) {
        console.error("Get Detail Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 12. API จัดการผู้ใช้งาน (Admin Manage Users)
// ==========================================

// ดึงรายชื่อ User ทั้งหมด
app.get('/admin/get-all-users', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT id, username, first_name, last_name, role, created_at, phone, address, banned FROM users ORDER BY id DESC");
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ระงับบัญชีผู้ใช้งาน (ไม่อนุญาตให้ระงับ Admin)
app.post('/admin/ban-user/:id', async (req, res) => {
    try {
        const [result] = await pool.query("UPDATE users SET banned = 1 WHERE id = ? AND role != 'admin'", [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "ไม่พบผู้ใช้หรือไม่สามารถระงับบัญชี Admin ได้" });
        }
        res.json({ success: true, message: "ระงับบัญชีเรียบร้อยแล้ว" });
    } catch (error) {
        console.error("Ban User Error:", error);
        res.status(500).json({ success: false, message: "ระงับบัญชีไม่สำเร็จ" });
    }
});

// ลบ User 
// ยกเลิกการระงับบัญชีผู้ใช้ (Admin เท่านั้น)
app.post('/admin/unban-user/:id', async (req, res) => {
    try {
        const [result] = await pool.query("UPDATE users SET banned = 0 WHERE id = ? AND role != 'admin'", [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้หรือไม่สามารถแก้ไขบัญชี Admin ได้' });
        }
        res.json({ success: true, message: 'ยกเลิกการระงับบัญชีเรียบร้อยแล้ว' });
    } catch (error) {
        console.error('Unban User Error:', error);
        res.status(500).json({ success: false, message: 'ยกเลิกการระงับบัญชีไม่สำเร็จ' });
    }
});

// เปลี่ยน Role ผู้ใช้ (Admin เท่านั้น)
app.patch('/admin/update-user-role/:id', async (req, res) => {
    try {
        const { role } = req.body;
        const targetId = Number(req.params.id);
        const allowedRoles = ['farmer', 'expert', 'admin'];

        if (!Number.isInteger(targetId) || !allowedRoles.includes(role)) {
            return res.status(400).json({ success: false, message: 'Role หรือ ID ผู้ใช้ไม่ถูกต้อง' });
        }
        if (targetId === Number(req.user.id)) {
            return res.status(400).json({ success: false, message: 'ไม่สามารถเปลี่ยน Role ของบัญชีตัวเองได้' });
        }

        const [result] = await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, targetId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้รายนี้' });
        }
        res.json({ success: true, message: 'เปลี่ยน Role เรียบร้อยแล้ว' });
    } catch (error) {
        console.error('Update User Role Error:', error);
        res.status(500).json({ success: false, message: 'เปลี่ยน Role ไม่สำเร็จ' });
    }
});

app.delete('/admin/delete-user/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 1. ลบประวัติการตรวจ
        await pool.query("DELETE FROM history WHERE user_id = ?", [id]);

        // 2. ลบผู้ใช้งาน
        const [result] = await pool.query("DELETE FROM users WHERE id = ?", [id]);

        if (result.affectedRows > 0) {
            res.json({ success: true, message: "ลบผู้ใช้เรียบร้อย" });
        } else {
            res.status(404).json({ success: false, message: "ไม่พบผู้ใช้นี้" });
        }
    } catch (error) {
        console.error("Delete User Error:", error);
        res.status(500).json({ success: false, message: "ลบไม่สำเร็จ" });
    }
});

// ==========================================
// 13. API เพิ่มสมาชิกใหม่ (Admin Add User)
// ==========================================
app.post('/admin/add-user', async (req, res) => {
    try {
        const { username, password, first_name, last_name, role } = req.body;

        if (!username || username.length > 50 || !validPassword(password) || !first_name || !last_name || !['farmer', 'expert', 'admin'].includes(role)) {
            return res.status(400).json({ success: false, message: "ข้อมูลผู้ใช้ไม่ถูกต้อง" });
        }

        // 1. เช็คซ้ำ
        const [existing] = await pool.query("SELECT id FROM users WHERE username = ?", [username]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: "Username นี้มีผู้ใช้งานแล้ว" });
        }
        // 2. เข้ารหัส 
        const hashedPassword = await bcrypt.hash(password, passwordHashRounds);

        // 3. บันทึก
        const sql = `INSERT INTO users (username, password, first_name, last_name, role) VALUES (?, ?, ?, ?, ?)`;
        await pool.query(sql, [username, hashedPassword, first_name, last_name, role]);

        res.json({ success: true, message: "เพิ่มสมาชิกสำเร็จ" });

    } catch (error) {
        console.error("Add User Error:", error);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดที่ Server" });
    }
});

// ==========================================
// 14. API ดึงสถิติรายบุคคล (สำหรับ Admin ดู Detail)
// ==========================================

app.get('/admin/user-stats/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query("SELECT COUNT(*) as total_scans FROM history WHERE user_id = ?", [id]);
        res.json({ success: true, total_scans: rows[0].total_scans });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 15. API ส่งข้อความหา User (Admin Send Notification)
// ==========================================
app.post('/admin/send-notification', async (req, res) => {
    try {
        const { user_id, title, message } = req.body;
        await pool.query("INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)", [user_id, title, message]);
        res.json({ success: true, message: "ส่งข้อความเรียบร้อย" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "ส่งไม่สำเร็จ" });
    }
});

// ==========================================
// 16. API ดึงข้อมูลสถิติรวม (Dashboard Stats) 
// ==========================================
app.get('/admin/get-dashboard-stats', async (req, res) => {
    try {
        // 1. นับจำนวนสแกนทั้งหมด
        const [totalScans] = await pool.query("SELECT COUNT(*) as count FROM history");

       // 2. นับจำนวนสมาชิก
        const [totalUsers] = await pool.query("SELECT COUNT(*) as count FROM users WHERE role = 'farmer'");

        // 3. นับจำนวนที่เจอโรค 
        const [totalDiseases] = await pool.query("SELECT COUNT(*) as count FROM history WHERE disease IS NOT NULL AND disease NOT IN ('ข้าวปกติ', 'ปกติ', 'Healthy', 'Normal')");

        // 4. ดึงข้อมูลพิกัดสำหรับแผนที่ (Map Data)
        const [mapData] = await pool.query(`
            SELECT h.id, h.disease, h.latitude, h.longitude, u.username, h.timestamp 
            FROM history h 
            LEFT JOIN users u ON h.user_id = u.id 
            WHERE h.latitude IS NOT NULL 
            ORDER BY h.timestamp DESC LIMIT 100
        `);

        // 5. ข้อมูลสำหรับ Pie Chart (สัดส่วนโรค)
        const [diseasePie] = await pool.query(`
            SELECT disease, COUNT(*) as count 
            FROM history 
            WHERE disease IS NOT NULL AND disease != ''
            GROUP BY disease
        `);

        // 6. ข้อมูลสำหรับ Bar Chart (สถิติย้อนหลัง 7 วัน)
        const [usageBar] = await pool.query(`
            SELECT TO_CHAR(timestamp, 'DD/MM') as date, COUNT(*) as count
            FROM history 
            WHERE timestamp >= CURRENT_DATE - INTERVAL '7 days'
            GROUP BY timestamp::date, TO_CHAR(timestamp, 'DD/MM')
            ORDER BY timestamp ASC
        `);

        res.json({
            success: true,
            stats: {
                scans: totalScans[0].count,
                users: totalUsers[0].count,
                diseases: totalDiseases[0].count
            },
            map: mapData,
            pie: diseasePie,
            bar: usageBar
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// ==========================================
// 17. API ติดต่อเรา (Contact Us) 
// ==========================================
// ตั้งค่า Multer สำหรับอัปโหลดรูป
const contactStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'contact-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadContact = multer({ storage: contactStorage, ...imageUploadOptions });


// API ติดต่อเรา (Contact Us)
app.post('/api/contact', uploadContact.single('image'), async (req, res) => {
    const { name, phone, subject, message, source } = req.body;
    
    const imagePath = req.file ? req.file.filename : null;

    if (!name || !phone || !message) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    try {
        const sql = `
            INSERT INTO messages (sender_name, phone, subject, message, image_path, source, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, NOW())
        `;
        await pool.query(sql, [name, phone, subject, message, imagePath, source || 'General']);

        res.json({ success: true, message: 'ส่งข้อความเรียบร้อยแล้ว' });

    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
    }
});

// ==========================================
// 18. API ระบบกล่องข้อความ (Admin Inbox)
// ==========================================

// 1. ดึงข้อความทั้งหมด (GET) 
app.get('/admin/messages', async (req, res) => {
    try {

        const sql = `
            SELECT m.*, u.id as user_id_from_db 
            FROM messages m 
            LEFT JOIN users u ON m.sender_name = CONCAT_WS(' ', u.first_name, u.last_name)
            ORDER BY m.created_at DESC
        `;
        
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// 2. นับจำนวนข้อความที่ยังไม่อ่าน 
app.get('/admin/messages/unread-count', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT COUNT(*) as count FROM messages WHERE is_read = 0");
        res.json({ success: true, count: rows[0].count });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. เปลี่ยนสถานะเป็น "อ่านแล้ว" (PUT)
app.put('/admin/messages/read/:id', async (req, res) => {
    try {
        await pool.query("UPDATE messages SET is_read = 1 WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. ลบข้อความ (DELETE)
app.delete('/admin/messages/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM messages WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 23. API ตอบกลับข้อความ (ส่งเข้า Notification)
// ==========================================
app.post('/admin/reply-message', async (req, res) => {
    const { userId, title, message } = req.body;

    if (!userId) {
        return res.status(400).json({ success: false, message: 'ไม่พบ ID สมาชิก (Guest ตอบกลับไม่ได้)' });
    }

    try {
        // บันทึกลงตาราง notifications ของ User คนนั้น
        await pool.query(
            "INSERT INTO notifications (user_id, title, message, created_at) VALUES (?, ?, ?, NOW())",
            [userId, title, message]
        );
        res.json({ success: true, message: 'ส่งข้อความตอบกลับเรียบร้อย' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// ==========================================
// 19. API ดึงการแจ้งเตือน (สำหรับ User)
// ==========================================

app.get('/get-notifications/:userId', async (req, res) => {
    const { userId } = req.params;
    try {

        const [rows] = await pool.query(`
            SELECT n.*, h.image_base64 
            FROM notifications n
            LEFT JOIN history h ON n.history_id = h.id 
            WHERE n.user_id = ? 
            ORDER BY n.created_at DESC
        `, [userId]);

        res.json({ success: true, data: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// ==========================================
// 20. API จัดการคลังความรู้ (Knowledge Base)
// ==========================================

// ตั้งค่า Upload สำหรับบทความ
const articleStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'article-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadArticle = multer({ storage: articleStorage, ...imageUploadOptions });

// 1. ดึงบทความทั้งหมด (GET)
app.get('/admin/articles', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM articles ORDER BY created_at DESC");
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// 2. ดึงบทความเพื่อแก้ไข (GET by ID)
app.get('/admin/articles/:id', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM articles WHERE id = ?", [req.params.id]);
        if (rows.length > 0) {
            res.json({ success: true, data: rows[0] });
        } else {
            res.status(404).json({ success: false, message: 'Article not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. เพิ่มบทความใหม่ (POST)
app.post('/admin/articles', uploadArticle.single('image'), async (req, res) => {

    const { title, description, category, content } = req.body; 
    const thumbnail = req.file ? req.file.filename : null;

    if (!title || !category) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกหัวข้อและหมวดหมู่' });
    }

    try {

        const sql = `INSERT INTO articles (title, description, category, content, thumbnail, created_at) VALUES (?, ?, ?, ?, ?, NOW())`;
        await pool.query(sql, [title, description, category, content, thumbnail]);
        res.json({ success: true, message: 'เพิ่มบทความเรียบร้อย' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// 4. แก้ไขบทความ (POST Update)
app.post('/admin/articles/update', uploadArticle.single('image'), async (req, res) => {

    const { id, title, description, category, content, old_image } = req.body;
    try {
        if (!id || !title || !category) {
            return res.status(400).json({ success: false, message: 'ข้อมูลบทความไม่ครบถ้วน' });
        }

        const [existingRows] = await pool.query('SELECT thumbnail FROM articles WHERE id = ?', [id]);
        if (existingRows.length === 0) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, message: 'ไม่พบบทความที่ต้องการแก้ไข' });
        }

        // Use the server/database filename, never a browser-local path.
        const previousThumbnail = existingRows[0].thumbnail || old_image || null;
        const thumbnail = req.file ? req.file.filename : previousThumbnail;
        const sql = `UPDATE articles SET title=?, description=?, category=?, content=?, thumbnail=?, updated_at=NOW() WHERE id=?`;
        await pool.query(sql, [title, description, category, content, thumbnail, id]);
        if (req.file && previousThumbnail && previousThumbnail !== thumbnail) {
            const previousPath = path.join(uploadsDir, path.basename(previousThumbnail));
            try { fs.unlinkSync(previousPath); } catch (error) { }
        }
        res.json({ success: true, message: 'อัปเดตบทความเรียบร้อย' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// 5. ลบบทความ (DELETE)
app.delete('/admin/articles/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM articles WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/articles/increment-view/:id', async (req, res) => {
    try {

        await pool.query("UPDATE articles SET views = views + 1 WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// ==========================================
// 21. ระบบ Badge แจ้งเตือน (User)
// ==========================================

// 1. นับจำนวนแจ้งเตือนที่ยังไม่อ่าน
app.get('/notifications/unread-count/:userId', async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0", 
            [req.params.userId]
        );
        res.json({ success: true, count: rows[0].count });
    } catch (err) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// 2. เปลี่ยนสถานะเป็น "อ่านแล้ว"(เมื่อกดเข้าหน้าแจ้งเตือน)
app.put('/notifications/mark-all-read/:userId', async (req, res) => {
    try {
        await pool.query(
            "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", 
            [req.params.userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'DB Error' });
    }
});

// ==========================================
// 22. EXPERT SYSTEM API (ระบบผู้เชี่ยวชาญ)
// ==========================================

// 1. ดึงสถิติภาพรวม (Dashboard)
app.get('/expert/stats', async (req, res) => {
    try {
        // 1. การวิเคราะห์ทั้งหมด (นับทั้งหมดในตาราง history)
        const [total] = await pool.query("SELECT COUNT(*) as count FROM history");

        // 2. การวิเคราะห์ที่ตรวจสอบแล้ว (รายการที่ตรวจโดยผู้เชี่ยวชาญแล้ว)
        const [verified] = await pool.query("SELECT COUNT(*) as count FROM history WHERE is_verified = 1");
        
        // 3. ความมั่นใจต่ำ (รายการที่ยังไม่ได้ตรวจ และ AI มั่นใจน้อยกว่า 60%)
        const [pending] = await pool.query("SELECT COUNT(*) as count FROM history WHERE is_verified = 0 AND confidence <= 60");

        res.json({
            success: true,
            total: total[0].count,
            verified: verified[0].count,
            pending: pending[0].count
        });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// 2. ดึงรายการที่ต้องตรวจสอบ 
app.get('/expert/cases', async (req, res) => {
    try {
        const filter = req.query.filter || 'pending';
        
        let sql = `
            SELECT h.*, u.first_name, u.last_name, u.profile_image
            FROM history h
            LEFT JOIN users u ON h.user_id = u.id
        `;
        
        if (filter === 'pending') {
            // ดึงเฉพาะรายการที่ "ยังไม่เสร็จ"
            sql += " WHERE h.status != 'completed'"; 
        } else if (filter === 'verified') {
            //ดึงเฉพาะรายการที่ "เสร็จแล้ว"
            sql += " WHERE h.status = 'completed'"; 
        } 
        
        sql += " ORDER BY h.timestamp DESC LIMIT 200";
        
        const [rows] = await pool.query(sql);
        res.json({ success: true, data: rows });
    } catch (err) { 
        console.error(err); 
        res.status(500).json({ success: false, message: 'DB Error' }); 
    }
});

app.post('/expert/verify', async (req, res) => {
    const { history_id, user_id, expert_result, comment, expert_id } = req.body;

    try {

        await pool.query(
            'UPDATE history SET expert_result = ?, status = ?, expert_comment = ?, expert_id = ?, is_verified = 1 WHERE id = ?',
            [expert_result, 'completed', comment, expert_id, history_id]
        );

        await pool.query(
            'INSERT INTO notifications (user_id, title, message, history_id, is_read) VALUES (?, ?, ?, ?, 0)',
            [user_id, 'ผลการตรวจสอบจากผู้เชี่ยวชาญ', `ผู้เชี่ยวชาญตรวจสอบรูปภาพแล้ว ระบุว่าเป็น: "${expert_result}"`, history_id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

app.get('/expert/disease-stats', async (req, res) => {
    try {
        // ดึงชื่อโรคและนับจำนวน เพื่อส่งไปทำกราฟ
        const sql = "SELECT disease, COUNT(*) as count FROM history GROUP BY disease";
        const [rows] = await pool.query(sql);
        
        res.json({ success: true, data: rows });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ success: false, message: 'DB Error' }); 
    }
});

// ==========================================
// 23. API: ขอเปลี่ยนรหัสผ่าน (Forgot Password)
// ==========================================
app.post('/forgot-password', async (req, res) => {
    const { contact, method } = req.body;

    if (!contact) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูล' });
    if (isProduction) {
        return res.status(503).json({ success: false, message: 'ระบบรีเซ็ตรหัสผ่านยังไม่เปิดใช้งานบน Production' });
    }

    try {

        let sql = method === 'phone' ? 'SELECT id FROM users WHERE phone = ?' : 'SELECT id FROM users WHERE email = ?';
        const [users] = await pool.query(sql, [contact]);

        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้งานในระบบ' });
        }

        const userId = users[0].id;
        const otp = crypto.randomInt(100000, 1000000).toString(); // สร้าง OTP 6 หลัก
        const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // หมดอายุใน 15 นาที


        await pool.query(
            'INSERT INTO password_resets (user_id, token, type, expires_at) VALUES (?, ?, ?, ?)',
            [userId, otpHash, method, expiresAt]
        );

        if (method === 'email') {
            // ส่งอีเมลจริง (จำลองการส่ง SMS โดยแสดงใน Console)
            console.log(`=========================================`);
            console.log(`📧 [EMAIL SIMULATION] ส่งไปที่ ${contact}`);
            console.log(`🔑 OTP ของคุณคือ: ${otp}`); 
            console.log(`=========================================`);
        } else {
            // กรณีเบอร์โทร (จำลองการส่ง SMS โดยแสดงใน Console)
            console.log(`=========================================`);
            console.log(`📲 [SMS SIMULATION] ส่งไปที่ ${contact}`);
            console.log(`🔑 OTP คือ: ${otp}`);
            console.log(`=========================================`);
        }

        res.json({ success: true, message: 'ส่งรหัส OTP เรียบร้อยแล้ว' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// ==========================================
// 24. API: เปลี่ยนรหัสผ่านใหม่ (Reset Password)
// ==========================================
app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !validPassword(newPassword)) {
        return res.status(400).json({ success: false, message: 'รหัส OTP หรือรหัสผ่านใหม่ไม่ถูกต้อง' });
    }

    try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const [rows] = await pool.query(
            'SELECT * FROM password_resets WHERE token = ? AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1',
            [tokenHash]
        );

        if (rows.length === 0) {
            return res.status(400).json({ success: false, message: 'รหัส OTP ไม่ถูกต้องหรือหมดอายุ' });
        }

        const userId = rows[0].user_id;

        const hashedPassword = await bcrypt.hash(newPassword, passwordHashRounds);
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
        await pool.query('DELETE FROM password_resets WHERE token = ?', [tokenHash]);
        res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// API สำหรับหน้าแก้ไขบทความ
app.get('/api/articles/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT title, description FROM articles WHERE id = ?",
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Article not found" });
        res.json(rows[0]);
    } catch (error) {
        console.error("Get Article Error:", error);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/articles/edit/:id', async (req, res) => {
    const { title, description } = req.body;
    if (!title || !description) {
        return res.status(400).json({ success: false, message: "กรุณากรอกหัวข้อและรายละเอียด" });
    }
    try {
        const [result] = await pool.query(
            "UPDATE articles SET title = ?, description = ?, updated_at = NOW() WHERE id = ?",
            [title.trim(), description.trim(), req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "ไม่พบบทความ" });
        res.json({ success: true, message: "อัปเดตเรียบร้อย" });
    } catch (error) {
        console.error("Update Article Error:", error);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message?.includes('รองรับเฉพาะไฟล์')) {
        return res.status(400).json({ success: false, message: err.message || 'ไฟล์ไม่ถูกต้อง' });
    }
    if (err.message === 'Origin is not allowed by CORS') {
        return res.status(403).json({ success: false, message: 'Origin is not allowed' });
    }
    console.error('Unhandled server error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
});



app.listen(port, () => {
    console.log(`🚀 Server running on http://localhost:${port}`);
});
