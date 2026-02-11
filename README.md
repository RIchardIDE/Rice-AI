# 🌾 Rice AI Analysis (ระบบวินิจฉัยโรคข้าวด้วย AI)
เว็บแอปพลิเคชันสำหรับเกษตรกรเพื่อใช้วิเคราะห์โรคข้าวจากรูปภาพใบข้าว โดยใช้ Deep Learning ในการประมวลผล 

## 👥  สมาชิกกลุ่ม 

| รหัสนิสิต | ชื่อ - นามสกุล | ตำแหน่ง |
| --------------- | --------------- | --------------- |
67022074 | นาย ภูธฤทธิ์ บุญแรง | BACKEND DEV.
67021387 | นาย กนกศักดิ์ อุปสุขิน| FRONTEND DEV. 
67021804 | นาย ธีรดนย์ ชะนันพล | FRONTEND DEV. 
67021400 | นาย กาณฑ์ ปัญญาวงค์ | FRONTEND DEV. 
67074133 | นางสาว ประภัสสร เจตะนา  | FRONTEND DEV. 


## ✨ ฟีเจอร์หลัก (Key Features)
- **AI Disease Detection:** วิเคราะห์โรคข้าวด้วยโมเดลที่เทรนจาก **Google Teachable Machine** 
- **Real-time Prediction:** รองรับการอัปโหลดรูปภาพและประมวลผลทันที
- **Expert Consultation:** ระบบส่งต่อเคสไปยังผู้เชี่ยวชาญหากผลวิเคราะห์ไม่ชัดเจน
- **User System:** ระบบสมาชิกพร้อม Dashboard สำหรับดูประวัติการตรวจย้อนหลัง
- **Knowledge Base:** คลังความรู้เกี่ยวกับโรคข้าวและการดูแลรักษา

## 🛠️ เทคโนโลยีที่ใช้ (Tech Stack)

โปรเจกต์นี้ทำงานแบบ **Hybrid** โดยแบ่งการทำงานเป็น 2 ส่วนหลัก:

### 1. Web Server & Frontend (Node.js)
- **Framework:** Express.js
- **View Engine:** HTML
- **Styling:** Tailwind CSS (via PostCSS)
- **Database:** MySQL (เชื่อมต่อผ่าน `mysql2`)
- **Tools:** Multer (Upload), Nodemailer (Email), Bcrypt (Security)

### 2. AI & Machine Learning
- **Model Training:** Google Teachable Machine
- **Model Type:** TensorFlow (Keras .h5)
- **Image Processing:** Pillow, NumPy
- **API Service:** Python (FastAPI/Uvicorn)

---

## ⚙️ การติดตั้ง (Installation Guide)

### 1. Clone Project
```bash
git clone 
cd rice-ai-web
