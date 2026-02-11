import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import crypto from 'crypto';    

// ตั้งค่า Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'your-email@gmail.com', 
        pass: 'your-app-password'    
    }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

const dbConfig = {
    host: 'localhost',
    user: 'rice_admin',
    password: 'rice1234',
    database: 'rice_ai',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};


const pool = mysql.createPool(dbConfig);

// เช็คการเชื่อมต่อ
pool.getConnection()
    .then(conn => {
        console.log('✅ Connected to MySQL Database successfully!');
        conn.release();
    })
    .catch(err => {
        console.error('❌ Database Connection Failed:', err.message);
    });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/uploads', express.static('uploads'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// ==========================================
// 1. API Predict (วิเคราะห์โรค)
// ==========================================
app.post('/predict', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).send("กรุณาอัปโหลดรูปภาพ");

    const imagePath = path.join(__dirname, req.file.path);
    const pythonProcess = spawn('python', ['predict.py', imagePath]);

    let resultData = "";

    pythonProcess.stderr.on('data', (data) => console.error(`🔥 Python Error: ${data}`));
    pythonProcess.stdout.on('data', (data) => resultData += data.toString());

    pythonProcess.on('close', (code) => {
        try { fs.unlinkSync(imagePath); } catch (e) { }

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

        let confidenceValue = 0;
        if (confidence) {
            confidenceValue = parseFloat(confidence.replace('%', ''));
        }

        let status = 'completed';
        if (confidenceValue <= 60) {
            status = 'pending_expert';
        }

        const userIdToSave = user_id ? user_id : null;
        const saveTime = timestamp ? new Date(timestamp) : new Date();

        const sql = `
            INSERT INTO history 
            (user_id, latitude, longitude, location_name, variety_code, disease, confidence, image_base64, status, timestamp, weather) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const [result] = await pool.execute(sql, [
            userIdToSave, latVal, lngVal, location_name, variety_code,
            disease, confidence, image_base64, status, saveTime,
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
    const { username, password, first_name, last_name, email, phone, role } = req.body;

    if (!username || !password || !first_name || !last_name || !email || !phone || !role) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        const sql = "INSERT INTO users (username, password, first_name, last_name, email, phone, role) VALUES (?, ?, ?, ?, ?, ?, ?)";
        await pool.query(sql, [username, hash, first_name, last_name, email, phone, role]);

        res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ' });

    } catch (err) {
        console.error(err);
        if (err.code === 'ER_DUP_ENTRY') {
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
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ success: false, message: "รหัสผ่านไม่ถูกต้อง" });
        }

        res.json({
            success: true,
            message: "เข้าสู่ระบบสำเร็จ",
            user: {
                id: user.id,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                role: user.role
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
            const salt = await bcrypt.genSalt(10);
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
            const salt = await bcrypt.genSalt(10);
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
        const dir = 'uploads/profiles/';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `user-${Date.now()}${path.extname(file.originalname)}`);
    }
});

const uploadProfile = multer({ storage: profileStorage });

// API อัปโหลด
app.post('/upload-profile-image', uploadProfile.single('profile_pic'), async (req, res) => {
    try {
        const userId = req.body.user_id;
        const filename = req.file.filename;

        if (!userId || !req.file) {
            return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
        }

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
        const [dailyScans] = await pool.query("SELECT COUNT(*) as count FROM history WHERE DATE(timestamp) = CURDATE()");

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
            WHERE MONTH(timestamp) = MONTH(CURRENT_DATE()) 
            AND YEAR(timestamp) = YEAR(CURRENT_DATE())
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
        const [rows] = await pool.query("SELECT id, username, first_name, last_name, role, created_at, phone, address FROM users ORDER BY id DESC");
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ลบ User 
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

        // 1. เช็คซ้ำ
        const [existing] = await pool.query("SELECT id FROM users WHERE username = ?", [username]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: "Username นี้มีผู้ใช้งานแล้ว" });
        }
        // 2. เข้ารหัส 
        const hashedPassword = await bcrypt.hash(password, 10);

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
            SELECT DATE_FORMAT(timestamp, '%d/%m') as date, COUNT(*) as count 
            FROM history 
            WHERE timestamp >= DATE(NOW()) - INTERVAL 7 DAY 
            GROUP BY DATE(timestamp) 
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
        cb(null, 'uploads/'); 
    },
    filename: (req, file, cb) => {

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'contact-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadContact = multer({ storage: contactStorage });


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
            LEFT JOIN users u ON m.sender_name COLLATE utf8mb4_unicode_ci = CONCAT(u.first_name, ' ', u.last_name) COLLATE utf8mb4_unicode_ci
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
        cb(null, 'uploads/'); 
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'article-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadArticle = multer({ storage: articleStorage });

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
    let thumbnail = old_image;

    if (req.file) {
        thumbnail = req.file.filename;
    }

    try {
  
        const sql = `UPDATE articles SET title=?, description=?, category=?, content=?, thumbnail=?, updated_at=NOW() WHERE id=?`;
        await pool.query(sql, [title, description, category, content, thumbnail, id]);
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
    console.log(`[Forgot] Request for: ${contact} via ${method}`);

    if (!contact) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูล' });

    try {

        let sql = method === 'phone' ? 'SELECT id FROM users WHERE phone = ?' : 'SELECT id FROM users WHERE email = ?';
        const [users] = await pool.query(sql, [contact]);

        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้งานในระบบ' });
        }

        const userId = users[0].id;
        const otp = Math.floor(100000 + Math.random() * 900000).toString(); // สร้าง OTP 6 หลัก
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // หมดอายุใน 15 นาที


        await pool.query(
            'INSERT INTO password_resets (user_id, token, type, expires_at) VALUES (?, ?, ?, ?)',
            [userId, otp, method, expiresAt]
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
    console.log(`[Reset] Attempt with token: ${token}`);

    try {
        const [rows] = await pool.query(
            'SELECT * FROM password_resets WHERE token = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
            [token]
        );

        if (rows.length === 0) {
            return res.status(400).json({ success: false, message: 'รหัส OTP ไม่ถูกต้องหรือหมดอายุ' });
        }

        const userId = rows[0].user_id;

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
        await pool.query('DELETE FROM password_resets WHERE token = ?', [token]);
        res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});




app.listen(port, () => {
    console.log(`🚀 Server running on http://localhost:${port}`);
});